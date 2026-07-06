import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SETTINGS = Object.freeze({
    maxResults: 20,
    maxQueryChars: 4000,
});

export function settingsPath(env = process.env) {
    const workspacePath = String(env.WORKSPACE_PATH || '').trim();
    if (!workspacePath) {
        throw new Error('WORKSPACE_PATH is required for SearchAgent settings.');
    }
    return path.join(workspacePath, 'search-agent-settings.json');
}

export function normalizeSettings(value = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        maxResults: normalizeInteger(
            input.maxResults,
            DEFAULT_SETTINGS.maxResults,
            1,
            100,
        ),
        maxQueryChars: normalizeInteger(
            input.maxQueryChars,
            DEFAULT_SETTINGS.maxQueryChars,
            1,
            20000,
        ),
    };
}

export async function readSettings({ env = process.env } = {}) {
    try {
        const raw = await fs.readFile(settingsPath(env), 'utf8');
        return normalizeSettings(JSON.parse(raw));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return normalizeSettings();
        }
        throw error;
    }
}

export async function writeSettings(settings, { env = process.env } = {}) {
    const normalized = normalizeSettings(settings);
    const targetPath = settingsPath(env);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`);
    await fs.rename(tempPath, targetPath);
    return normalized;
}

export async function readStdinJson() {
    if (process.stdin.isTTY) {
        return {};
    }
    process.stdin.setEncoding('utf8');
    let data = '';
    for await (const chunk of process.stdin) {
        data += chunk;
    }
    const text = data.trim();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed?.input && typeof parsed.input === 'object' ? parsed.input : parsed;
}

function normalizeInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}
