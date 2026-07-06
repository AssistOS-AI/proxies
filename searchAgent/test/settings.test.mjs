import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeSettings, readSettings, writeSettings } from '../src/lib/settings.mjs';

test('normalizes persisted search settings', () => {
    assert.deepEqual(normalizeSettings({
        maxResults: 200,
        maxQueryChars: 0,
    }), {
        maxResults: 100,
        maxQueryChars: 1,
    });
});

test('writes and reads settings from home path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-settings-'));
    try {
        const env = { HOME: dir };
        const settings = await writeSettings({
            maxResults: 12,
            maxQueryChars: 900,
        }, { env });

        assert.deepEqual(settings, {
            maxResults: 12,
            maxQueryChars: 900,
        });
        assert.deepEqual(await readSettings({ env }), settings);
        assert.match(await readFile(path.join(dir, 'search-agent-settings.json'), 'utf8'), /maxResults/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('requires HOME for settings storage', async () => {
    await assert.rejects(
        () => readSettings({ env: {} }),
        /HOME is required/,
    );
});
