import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifestUrl = new URL('../manifest.json', import.meta.url);

test('SearchAgent remains an explicitly launched worker', async () => {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.equal(manifest.startup, 'manual');
});
