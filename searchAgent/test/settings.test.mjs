import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function runTool(relativePath, input, env = {}) {
    const toolPath = new URL(relativePath, import.meta.url).pathname;
    const child = spawn(process.execPath, [toolPath], {
        env: { ...process.env, ...env },
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
        }, {
            HOME: dir,
        });
        assert.equal(update.code, 0);
        assert.deepEqual(update.payload.settings, {
            maxResults: 12,
            maxQueryChars: 900,
        });

        const get = await runTool('../tools/get-settings.mjs', {}, { HOME: dir });
        assert.equal(get.code, 0);
        assert.deepEqual(get.payload.settings, update.payload.settings);
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

test('get-searxng-settings tool returns defaults from home storage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-searxng-settings-'));
    try {
        const result = await runTool('../tools/get-searxng-settings.mjs', {}, { HOME: dir });
        assert.equal(result.code, 0);
        assert.deepEqual(result.payload.settings, {
            categories: 'general,scientific_publications',
            language: 'en',
            timeRange: '',
            safeSearch: 1,
            page: 1,
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('update-searxng-settings tool persists structured settings and generated yaml', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-searxng-settings-'));
    try {
        const result = await runTool('../tools/update-searxng-settings.mjs', {
            categories: 'general, scientific_publications, general',
            language: 'en-US',
            timeRange: 'year',
            safeSearch: 9,
            page: 99,
        }, {
            HOME: dir,
        });

        assert.equal(result.code, 0);
        assert.deepEqual(result.payload.settings, {
            categories: 'general,scientific_publications',
            language: 'en-US',
            timeRange: 'year',
            safeSearch: 2,
            page: 10,
        });
        assert.deepEqual(
            JSON.parse(await readFile(path.join(dir, 'searxng', 'settings.json'), 'utf8')),
            result.payload.settings,
        );
        const yaml = await readFile(path.join(dir, 'searxng', 'settings.yml'), 'utf8');
        assert.match(yaml, /formats:\n    - html\n    - json/);
        assert.match(yaml, /safe_search: 2/);
        assert.match(yaml, /default_lang: "en-US"/);
        assert.match(yaml, /max_page: 10/);
        assert.match(yaml, /bind_address: "127\.0\.0\.1"/);
        assert.match(yaml, /port: 8888/);
        assert.match(yaml, /secret_key: "/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('settings UI has a separate SearXNG tab without removed fields', async () => {
    const html = await readFile(new URL('../IDE-plugins/search-agent-settings/search-agent-settings.html', import.meta.url), 'utf8');
    const source = await readFile(new URL('../IDE-plugins/search-agent-settings/search-agent-settings.js', import.meta.url), 'utf8');
    assert.match(html, /data-sag-tab="searxng"/);
    assert.match(html, /data-searxng-category/);
    assert.match(html, /value="scientific_publications"/);
    assert.match(html, /id="sagSearxngLanguage"[\s\S]*<option value="en">English<\/option>/);
    assert.match(source, /search_agent_get_searxng_settings/);
    assert.match(source, /search_agent_update_searxng_settings/);
    assert.ok(!source.includes('requestTimeout'));
    assert.ok(!source.includes('enableHttp2'));
});
