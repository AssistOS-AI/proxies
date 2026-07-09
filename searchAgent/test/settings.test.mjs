import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildSecretHint } from '../src/lib/secrets.mjs';

async function runTool(relativePath, input, env = {}) {
    const toolPath = new URL(relativePath, import.meta.url).pathname;
    const child = spawn(process.execPath, [toolPath], {
        env: { ...cleanNodeTestEnv(process.env), ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(JSON.stringify({ input }));
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    return {
        code,
        stderr,
        payload: stdout ? JSON.parse(stdout) : null,
    };
}

function cleanNodeTestEnv(env) {
    return Object.fromEntries(
        Object.entries(env).filter(([key]) => !key.startsWith('NODE_TEST')),
    );
}

test('update-settings tool normalizes persisted search settings', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-settings-'));
    try {
        const result = await runTool('../tools/update-settings.mjs', {
            maxResults: 200,
            maxQueryChars: 0,
        }, {
            HOME: dir,
        });

        assert.equal(result.code, 0);
        assert.deepEqual(result.payload.settings, {
            maxResults: 100,
            maxQueryChars: 1,
            currentProvider: 'searxng',
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('update-settings and get-settings tools persist through the home path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-settings-'));
    try {
        const update = await runTool('../tools/update-settings.mjs', {
            maxResults: 12,
            maxQueryChars: 900,
            currentProvider: 'duckduckgo',
        }, {
            HOME: dir,
        });
        assert.equal(update.code, 0);
        assert.deepEqual(update.payload.settings, {
            maxResults: 12,
            maxQueryChars: 900,
            currentProvider: 'duckduckgo',
        });

        const get = await runTool('../tools/get-settings.mjs', {}, { HOME: dir });
        assert.equal(get.code, 0);
        assert.deepEqual(get.payload.settings, update.payload.settings);
        assert.deepEqual(get.payload.secrets, {
            TAVILY_API_KEY: '',
            BRAVE_API_KEY: '',
            EXA_API_KEY: '',
            SERPER_API_KEY: '',
            JINA_API_KEY: '',
            GEMINI_API_KEY: '',
        });
        assert.match(await readFile(path.join(dir, 'search-agent-settings.json'), 'utf8'), /maxResults/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('get-settings tool requires HOME for settings storage', async () => {
    const result = await runTool('../tools/get-settings.mjs', {}, { HOME: '' });
    assert.equal(result.code, 1);
    assert.equal(result.payload.ok, false);
    assert.match(result.payload.error.message, /HOME is required/);
});

test('settings UI does not expose local SearXNG as a secret field', async () => {
    const source = await readFile(new URL('../IDE-plugins/search-agent-settings/search-agent-settings.js', import.meta.url), 'utf8');
    assert.ok(!source.includes('SEARXNG_URL'));
});

test('settings UI includes Gemini as a provider secret field', async () => {
    const source = await readFile(new URL('../IDE-plugins/search-agent-settings/search-agent-settings.js', import.meta.url), 'utf8');
    assert.match(source, /GEMINI_API_KEY/);
});

test('settings UI includes current provider control', async () => {
    const html = await readFile(new URL('../IDE-plugins/search-agent-settings/search-agent-settings.html', import.meta.url), 'utf8');
    const source = await readFile(new URL('../IDE-plugins/search-agent-settings/search-agent-settings.js', import.meta.url), 'utf8');
    assert.match(html, /sagCurrentProvider/);
    assert.match(source, /currentProvider/);
    assert.match(source, /search_agent_list_providers/);
});

test('settings backend builds API key hints without exposing raw keys to UI', () => {
    assert.equal(buildSecretHint('1234567890'), '********');
    assert.equal(buildSecretHint('abcdef1234567890'), 'abcdef******7890');
    assert.equal(buildSecretHint('abcdef1234567890').length, 'abcdef1234567890'.length);
    assert.equal(buildSecretHint(''), '');
});

test('settings UI uses backend API key hints without configured status text', async () => {
    const source = await readFile(new URL('../IDE-plugins/search-agent-settings/search-agent-settings.js', import.meta.url), 'utf8');
    const styles = await readFile(new URL('../IDE-plugins/search-agent-settings/search-agent-settings.css', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /function buildSecretHint/);
    assert.doesNotMatch(source, /dpu_secret_get/);
    assert.match(source, /input\.placeholder = hint \|\| 'API key'/);
    assert.match(source, /reloadSecretHints\(payload\.secrets\)/);
    assert.doesNotMatch(source, /Configured/);
    assert.doesNotMatch(source, /Not configured/);
    assert.doesNotMatch(source, /dataSecretState/);
    assert.doesNotMatch(styles, /sag-secret-state/);
});

test('configure-searxng-settings generates only minimal yaml config', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-searxng-config-'));
    try {
        const result = await runTool('../scripts/configure-searxng-settings.mjs', {}, { HOME: dir });
        assert.equal(result.code, 0);
        const yaml = await readFile(path.join(dir, 'searxng', 'settings.yml'), 'utf8');
        assert.match(yaml, /use_default_settings: true/);
        assert.match(yaml, /formats:\n    - html\n    - json/);
        assert.match(yaml, /bind_address: "127\.0\.0\.1"/);
        assert.match(yaml, /port: 8888/);
        assert.match(yaml, /limiter: false/);
        assert.match(yaml, /secret_key: "/);
        assert.doesNotMatch(yaml, /safe_search/);
        assert.doesNotMatch(yaml, /default_lang/);
        assert.doesNotMatch(yaml, /max_page/);
        await assert.rejects(
            readFile(path.join(dir, 'searxng', 'settings.json'), 'utf8'),
            /ENOENT/,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('settings UI has only general settings, provider credentials, and no SearXNG tab', async () => {
    const html = await readFile(new URL('../IDE-plugins/search-agent-settings/search-agent-settings.html', import.meta.url), 'utf8');
    const source = await readFile(new URL('../IDE-plugins/search-agent-settings/search-agent-settings.js', import.meta.url), 'utf8');
    assert.match(html, /sagMaxResults/);
    assert.match(html, /sagMaxQueryChars/);
    assert.match(html, /sagSecretsGrid/);
    assert.doesNotMatch(html, /data-sag-tab/);
    assert.doesNotMatch(html, /SearXNG/);
    assert.doesNotMatch(html, /data-searxng-category/);
    assert.doesNotMatch(source, /search_agent_get_searxng_settings/);
    assert.doesNotMatch(source, /search_agent_update_searxng_settings/);
});
