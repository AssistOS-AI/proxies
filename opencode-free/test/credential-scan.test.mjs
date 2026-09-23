import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUNDLED_OPENCODE_FREE_KEY, resolveOpencodeApiKey } from '../lib/credential.mjs';

const AGENT_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY_ROOT = path.dirname(path.resolve(AGENT_DIR));
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const OPENCODE_KEY_PATTERN = /oc_sk_[0-9a-f]{12}_[A-Za-z0-9]{32}/;

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
        } else if (entry.isFile()) {
            yield path.join(dir, entry.name);
        }
    }
}

test('the bundled key unmasks to a well-formed OpenCode key', () => {
    assert.match(BUNDLED_OPENCODE_FREE_KEY, new RegExp(`^${OPENCODE_KEY_PATTERN.source}$`));
});

test('no repository file contains the bundled key or any other OpenCode key in plain text', () => {
    const needle = Buffer.from(BUNDLED_OPENCODE_FREE_KEY, 'utf8');
    const hits = [];
    let scanned = 0;
    for (const file of walk(REPOSITORY_ROOT)) {
        scanned += 1;
        const bytes = fs.readFileSync(file);
        if (bytes.includes(needle) || OPENCODE_KEY_PATTERN.test(bytes.toString('latin1'))) {
            hits.push(path.relative(REPOSITORY_ROOT, file));
        }
    }
    console.log(`credential scan: ${scanned} files scanned, ${hits.length} file(s) contain a plaintext OpenCode key`);
    assert.ok(scanned > 0);
    assert.deepEqual(hits, [], `plaintext OpenCode key found in: ${hits.join(', ')}`);
});

test('a non-empty OPENCODE_FREE_API_KEY overrides the bundled key', () => {
    assert.equal(resolveOpencodeApiKey({}) === BUNDLED_OPENCODE_FREE_KEY, true);
    assert.equal(resolveOpencodeApiKey({ OPENCODE_FREE_API_KEY: '' }) === BUNDLED_OPENCODE_FREE_KEY, true);
    assert.equal(resolveOpencodeApiKey({ OPENCODE_FREE_API_KEY: '   ' }) === BUNDLED_OPENCODE_FREE_KEY, true);
    assert.equal(resolveOpencodeApiKey({ OPENCODE_FREE_API_KEY: ' operator-key ' }), 'operator-key');
});
