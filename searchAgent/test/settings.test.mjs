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
