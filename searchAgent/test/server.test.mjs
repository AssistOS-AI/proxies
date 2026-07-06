import assert from 'node:assert/strict';
import test from 'node:test';

import { handleSearch, normalizeSearchRequest } from '../src/server.mjs';

test('normalizes search request', () => {
    assert.deepEqual(normalizeSearchRequest({
        provider: 'duckduckgo',
        query: ' test ',
        maxResults: 50,
    }, {
        maxQueryChars: 100,
        maxResults: 20,
    }, {
        maxResults: 20,
        maxQueryChars: 100,
    }), {
        provider: 'duckduckgo',
        query: 'test',
        maxResults: 20,
    });
});

test('rejects missing provider or query', () => {
    assert.throws(
        () => normalizeSearchRequest({ provider: 'duckduckgo' }),
        /provider and query are required/,
    );
});

test('handleSearch rejects unknown provider', async () => {
    await assert.rejects(
        () => handleSearch({ provider: 'missing', query: 'test' }, { env: { HOME: '/tmp/search-agent-test-missing' } }),
        /Unknown search provider/,
    );
});

test('handleSearch returns normalized results from duckduckgo provider', async () => {
    const fetchImpl = async () => ({
        ok: true,
        async json() {
            return {
                RelatedTopics: [
                    {
                        FirstURL: 'https://example.com/result',
                        Text: 'Example result - useful snippet',
                    },
                ],
            };
        },
    });

    const result = await handleSearch({
        provider: 'duckduckgo',
        query: 'example',
        maxResults: 5,
    }, {
        fetchImpl,
        env: { HOME: '/tmp/search-agent-test-duckduckgo' },
    });

    assert.deepEqual(result, {
        results: [
            {
                title: 'Example result',
                url: 'https://example.com/result',
                snippet: 'Example result - useful snippet',
            },
        ],
    });
});

test('handleSearch includes provider HTTP details for Tavily failures', async () => {
    const fetchImpl = async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        async text() {
            return '{"error":"invalid api key"}';
        },
    });

    await assert.rejects(
        () => handleSearch({
            provider: 'tavily',
            query: 'example',
            maxResults: 5,
        }, {
            fetchImpl,
            env: {
                HOME: '/tmp/search-agent-test-tavily',
                TAVILY_API_KEY: 'test-key',
            },
        }),
        (error) => {
            assert.equal(error.code, 'PROVIDER_HTTP_ERROR');
            assert.equal(error.statusCode, 502);
            assert.equal(error.details.providerStatus, 401);
            assert.match(error.details.providerBodyPreview, /invalid api key/);
            return true;
        },
    );
});

test('handleSearch limits Tavily provider query length', async () => {
    let providerBody = null;
    const fetchImpl = async (_url, options) => {
        providerBody = JSON.parse(options.body);
        return {
            ok: true,
            async json() {
                return {
                    results: [
                        {
                            title: 'Dogs',
                            url: 'https://example.com/dogs',
                            content: 'Dog breeds overview',
                        },
                    ],
                };
            },
        };
    };

    const longQuery = 'x'.repeat(450);
    const result = await handleSearch({
        provider: 'tavily',
        query: longQuery,
        maxResults: 5,
    }, {
        fetchImpl,
        env: {
            HOME: '/tmp/search-agent-test-tavily-context',
            TAVILY_API_KEY: 'test-key',
        },
    });

    assert.equal(providerBody.query.length, 400);
    assert.deepEqual(result.results, [
        {
            title: 'Dogs',
            url: 'https://example.com/dogs',
            snippet: 'Dog breeds overview',
            content: 'Dog breeds overview',
        },
    ]);
});
