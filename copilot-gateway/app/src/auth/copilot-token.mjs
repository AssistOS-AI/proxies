import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.mjs';
import { config } from '../config.mjs';
import { ensureDataDir, readGithubToken, writeGithubToken } from './token-store.mjs';
import { runDeviceFlow } from './github-device-flow.mjs';

const log = createLogger('copilot-token');

let githubToken = '';
let copilotToken = '';
let vsCodeVersion = '';
let models = null;
let refreshTimer = null;

export function githubHeaders() {
  return {
    'content-type': 'application/json',
    'accept': 'application/json',
    'authorization': `token ${githubToken}`,
    'editor-version': `vscode/${vsCodeVersion}`,
    'editor-plugin-version': `copilot-chat/${config.copilotVersion}`,
    'user-agent': `GitHubCopilotChat/${config.copilotVersion}`,
    'x-github-api-version': config.apiVersion,
  };
}

export function copilotHeaders() {
  return {
    'Authorization': `Bearer ${copilotToken}`,
    'content-type': 'application/json',
    'copilot-integration-id': 'vscode-chat',
    'editor-version': `vscode/${vsCodeVersion}`,
    'editor-plugin-version': `copilot-chat/${config.copilotVersion}`,
    'user-agent': `GitHubCopilotChat/${config.copilotVersion}`,
    'openai-intent': 'conversation-panel',
    'x-github-api-version': config.apiVersion,
    'x-request-id': randomUUID(),
  };
}

async function cacheVSCodeVersion() {
  try {
    const res = await fetch(
      'https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin',
      { signal: AbortSignal.timeout(5000) }
    );
    const text = await res.text();
    const match = text.match(/pkgver=(\S+)/);
    if (match) {
      vsCodeVersion = match[1];
      log.debug('VS Code version fetched', { version: vsCodeVersion });
      return;
    }
  } catch (err) {
    log.warn('Failed to fetch VS Code version, using fallback', { error: err.message });
  }
  vsCodeVersion = config.vsCodeVersionFallback;
  log.debug('Using VS Code version fallback', { version: vsCodeVersion });
}

async function getCopilotToken() {
  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: githubHeaders(),
  });
  if (!res.ok) {
    throw new Error(`Failed to get Copilot token: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function setupCopilotToken() {
  const result = await getCopilotToken();
  copilotToken = result.token;
  log.info('Copilot token acquired');

  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  const refreshMs = (result.refresh_in - 60) * 1000;
  refreshTimer = setInterval(async () => {
    try {
      const refreshed = await getCopilotToken();
      copilotToken = refreshed.token;
      log.debug('Copilot token refreshed');
    } catch (err) {
      log.error('Failed to refresh Copilot token', { error: err.message });
    }
  }, refreshMs);
  refreshTimer.unref();
}

async function cacheModels() {
  const res = await fetch(`${config.copilotBaseUrl}/models`, {
    headers: copilotHeaders(),
  });
  models = await res.json();
  const count = Array.isArray(models?.data) ? models.data.length : '?';
  log.info('Cached Copilot models', { count });
}

export async function initialize() {
  await ensureDataDir();
  await cacheVSCodeVersion();

  if (config.githubToken) {
    githubToken = config.githubToken;
    await writeGithubToken(githubToken);
    log.info('Using GitHub token from environment');
  } else {
    githubToken = await readGithubToken();
    if (!githubToken) {
      log.info('No GitHub token found, starting device flow');
      githubToken = await runDeviceFlow();
      await writeGithubToken(githubToken);
    } else {
      log.info('Loaded GitHub token from store');
    }
  }

  await setupCopilotToken();
  await cacheModels();
}

export function getState() {
  return { copilotToken, githubToken, models, vsCodeVersion };
}

export function getCachedModels() {
  return models;
}
