import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUNDLED_OPENCODE_FREE_KEY, resolveOpencodeApiKey } from '../lib/credential.mjs';

const AGENT_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_ROOT = path.dirname(path.resolve(AGENT_DIR));
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
        } else if (entry.isFile()) {
            yield path.join(dir, entry.name);
        }
    }
}

test('the bundled key appears by value in exactly one file of the repository', () => {
    assert.equal(typeof BUNDLED_OPENCODE_FREE_KEY, 'string');
    assert.ok(BUNDLED_OPENCODE_FREE_KEY.length >= 16, 'the bundled key constant is too short to scan for');
    const needle = Buffer.from(BUNDLED_OPENCODE_FREE_KEY, 'utf8');
    const hits = [];
    let scanned = 0;
    for (const file of walk(REPOSITORY_ROOT)) {
        scanned += 1;
        if (fs.readFileSync(file).includes(needle)) hits.push(path.relative(REPOSITORY_ROOT, file));
    }
    console.log(`credential scan: ${scanned} files scanned, ${hits.length} file(s) contain the bundled key`);
    assert.ok(scanned > 0);
    assert.equal(hits.length, 1, `expected exactly 1 file with the bundled key, found ${hits.length}`);
    assert.equal(hits[0], path.join('opencode-free', 'lib', 'credential.mjs'), 'the bundled key is outside lib/credential.mjs');
});

test('a non-empty OPENCODE_FREE_API_KEY overrides the bundled key', () => {
    assert.equal(resolveOpencodeApiKey({}) === BUNDLED_OPENCODE_FREE_KEY, true);
    assert.equal(resolveOpencodeApiKey({ OPENCODE_FREE_API_KEY: '' }) === BUNDLED_OPENCODE_FREE_KEY, true);
    assert.equal(resolveOpencodeApiKey({ OPENCODE_FREE_API_KEY: '   ' }) === BUNDLED_OPENCODE_FREE_KEY, true);
    assert.equal(resolveOpencodeApiKey({ OPENCODE_FREE_API_KEY: ' operator-key ' }), 'operator-key');
});
