import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeResult, normalizeResults } from '../src/lib/normalize.mjs';

test('normalizes minimal result fields', () => {
    assert.deepEqual(normalizeResult({
        name: 'Example',
        link: 'https://example.com',
        description: 'Snippet',
    }), {
        name: 'Example',
        link: 'https://example.com',
        description: 'Snippet',
        title: 'Example',
        url: 'https://example.com',
        snippet: 'Snippet',
    });
});

test('preserves extra provider fields', () => {
    assert.deepEqual(normalizeResult({
        title: 'Example',
        url: 'https://example.com',
        snippet: 'Snippet',
        publishedDate: '2026-07-06',
        custom: { a: 1 },
    }), {
        title: 'Example',
        url: 'https://example.com',
        snippet: 'Snippet',
        publishedDate: '2026-07-06',
        custom: { a: 1 },
    });
});

test('filters entries without urls and deduplicates urls', () => {
    const results = normalizeResults([
        { title: 'Missing URL', snippet: 'x' },
        { title: 'One', url: 'https://example.com/1', snippet: 'a' },
        { title: 'Duplicate', url: 'https://example.com/1', snippet: 'b' },
        { title: 'Two', url: 'https://example.com/2', snippet: 'c' },
    ]);

    assert.deepEqual(results.map((result) => result.title), ['One', 'Two']);
});
