import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function runNodeTool(relativePath, input, { env = {}, fetchMock = '' } = {}) {
    const toolPath = new URL(relativePath, import.meta.url).pathname;
    const mockArgs = fetchMock ? ['--import', fetchMock] : [];
    const child = spawn(process.execPath, [...mockArgs, toolPath], {
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
    const payload = stdout ? JSON.parse(stdout) : null;
    return { code, payload, stderr };
}

function cleanNodeTestEnv(env) {
    return Object.fromEntries(
        Object.entries(env).filter(([key]) => !key.startsWith('NODE_TEST')),
    );
}

async function runSearchTool(input, options = {}) {
    return runNodeTool('../tools/search.mjs', input, options);
}

async function runChatCompletionsTool(request, options = {}) {
    return runNodeTool('../openai-api/chat-completions.mjs', { request }, options);
}

function parseChatCompletionContent(payload) {
    return JSON.parse(payload.choices[0].message.content);
}

test('search tool rejects missing provider or query', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-missing-input-'));
    try {
        const result = await runSearchTool({}, { env: { HOME: dir } });
        assert.equal(result.code, 1);
        assert.equal(result.payload.ok, false);
        assert.match(result.payload.error.message, /query is required/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('chat completions endpoint uses configured provider and latest user prompt as query', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-chat-completions-'));
    const fetchMock = new URL('./fixtures/mock-duckduckgo-fetch.mjs', import.meta.url).pathname;
    try {
        await runNodeTool('../tools/update-settings.mjs', {
            currentProvider: 'duckduckgo',
        }, {
            env: { HOME: dir },
        });
        const result = await runChatCompletionsTool({
            model: 'proxies/searchAgent',
            messages: [
                { role: 'system', content: 'Search only.' },
                { role: 'user', content: 'old query' },
                { role: 'assistant', content: 'previous response' },
                { role: 'user', content: 'example' },
            ],
        }, {
            env: { HOME: dir },
            fetchMock,
        });

        assert.equal(result.code, 0);
        assert.equal(result.payload.object, 'chat.completion');
        assert.equal(result.payload.model, 'proxies/searchAgent');
        assert.equal(result.payload.choices[0].message.role, 'assistant');
        assert.equal(typeof result.payload.choices[0].message.content, 'string');

        const content = parseChatCompletionContent(result.payload);
        assert.equal(content.ok, true);
        assert.equal(content.provider, 'duckduckgo');
        assert.equal(content.query, 'example');
        assert.equal(content.maxResults, 10);
        assert.deepEqual(content.results, [
            {
                title: 'Example result',
                url: 'https://example.com/result',
                snippet: 'Example result - useful snippet',
            },
        ]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('chat completions endpoint returns text JSON errors for invalid chat requests', async () => {
    const result = await runChatCompletionsTool({
        model: 'proxies/searchAgent',
        messages: [],
    });

    assert.equal(result.code, 0);
    assert.equal(result.payload.object, 'chat.completion');
    assert.equal(result.payload.model, 'proxies/searchAgent');
    const content = parseChatCompletionContent(result.payload);
    assert.equal(content.ok, false);
    assert.match(content.error.message, /user prompt is required/);
});

test('list-providers tool only includes providers ready to use', async () => {
    const result = await runNodeTool('../tools/list-providers.mjs', {}, {
        env: {
            TAVILY_API_KEY: 'test-key',
            BRAVE_API_KEY: 'test-key',
            EXA_API_KEY: 'test-key',
            SERPER_API_KEY: 'test-key',
            JINA_API_KEY: 'test-key',
            GEMINI_API_KEY: 'test-key',
            GOOGLE_AI_MODE_DISABLED: '1',
        },
    });
    assert.equal(result.code, 0);
    const payload = result.payload;
    const byProvider = new Map(payload.providers.map((provider) => [provider.provider, provider]));

    assert.deepEqual(byProvider.get('duckduckgo'), {
        provider: 'duckduckgo',
        name: 'DuckDuckGo',
    });
    assert.deepEqual(byProvider.get('tavily'), {
        provider: 'tavily',
        name: 'Tavily',
    });
    assert.deepEqual(byProvider.get('jina'), {
        provider: 'jina',
        name: 'Jina Search',
    });
    assert.deepEqual(byProvider.get('searxng'), {
        provider: 'searxng',
        name: 'SearXNG',
    });
    assert.deepEqual(byProvider.get('brave'), {
        provider: 'brave',
        name: 'Brave Search',
    });
    assert.deepEqual(byProvider.get('exa'), {
        provider: 'exa',
        name: 'Exa',
    });
    assert.deepEqual(byProvider.get('serper'), {
        provider: 'serper',
        name: 'Serper',
    });
    assert.deepEqual(byProvider.get('gemini'), {
        provider: 'gemini',
        name: 'Gemini Search',
    });
    assert.deepEqual(byProvider.get('deep-research'), {
        provider: 'deep-research',
        name: 'Deep Research',
    });
    assert.equal(byProvider.has('google-ai-mode'), false);
});

test('search tool rejects unknown provider', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-missing-provider-'));
    try {
        const result = await runSearchTool({ provider: 'missing', query: 'test' }, { env: { HOME: dir } });
        assert.equal(result.code, 1);
        assert.equal(result.payload.ok, false);
        assert.match(result.payload.error.message, /Unknown search provider/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('search tool returns normalized results from duckduckgo provider', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-duckduckgo-'));
    const fetchMock = new URL('./fixtures/mock-duckduckgo-fetch.mjs', import.meta.url).pathname;
    try {
        const result = await runSearchTool({
            provider: 'duckduckgo',
            query: 'example',
            maxResults: 5,
        }, {
            env: { HOME: dir },
            fetchMock,
        });

        assert.equal(result.code, 0);
        assert.deepEqual(result.payload, {
            ok: true,
            provider: 'duckduckgo',
            results: [
                {
                    title: 'Example result',
                    url: 'https://example.com/result',
                    snippet: 'Example result - useful snippet',
                },
            ],
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('search tool uses current provider from settings when provider is omitted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-current-provider-'));
    const fetchMock = new URL('./fixtures/mock-duckduckgo-fetch.mjs', import.meta.url).pathname;
    try {
        await runNodeTool('../tools/update-settings.mjs', {
            currentProvider: 'duckduckgo',
        }, {
            env: { HOME: dir },
        });
        const result = await runSearchTool({
            query: 'example',
            maxResults: 5,
        }, {
            env: { HOME: dir },
            fetchMock,
        });

        assert.equal(result.code, 0);
        assert.deepEqual(result.payload.results, [
            {
                title: 'Example result',
                url: 'https://example.com/result',
                snippet: 'Example result - useful snippet',
            },
        ]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('search tool writes metadata logs to stderr without raw query text', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-search-logs-'));
    const fetchMock = new URL('./fixtures/mock-duckduckgo-fetch.mjs', import.meta.url).pathname;
    const query = 'private customer query';
    try {
        const result = await runSearchTool({
            provider: 'duckduckgo',
            query,
            maxResults: 5,
        }, {
            env: { HOME: dir },
            fetchMock,
        });

        assert.equal(result.code, 0);
        assert.equal(result.stderr.includes(query), false);
        const logs = result.stderr
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        assert.deepEqual(logs.map((entry) => entry.event), ['search_start', 'search_finish']);
        assert.equal(logs[0].provider, 'duckduckgo');
        assert.equal(logs[0].queryLength, query.length);
        assert.equal(logs[1].resultCount, 1);
        assert.equal(typeof logs[1].durationMs, 'number');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('search tool uses local SearXNG JSON API', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-searxng-'));
    const fetchMock = new URL('./fixtures/mock-searxng-fetch.mjs', import.meta.url).pathname;
    try {
        const result = await runSearchTool({
            provider: 'searxng',
            query: 'local search',
            maxResults: 5,
        }, {
            env: { HOME: dir },
            fetchMock,
        });

        assert.equal(result.code, 0);
        assert.deepEqual(result.payload, {
            ok: true,
            provider: 'searxng',
            results: [
                {
                    title: 'SearXNG result',
                    url: 'https://example.com/searxng',
                    snippet: 'SearXNG useful snippet',
                    content: 'SearXNG useful snippet',
                    observedQuery: 'local search',
                    observedFormat: 'json',
                    observedCategories: null,
                    observedLanguage: null,
                    observedTimeRange: null,
                    observedSafeSearch: null,
                    observedPage: null,
                    observedAccept: 'application/json',
                },
            ],
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('search tool includes provider HTTP details for Tavily failures', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-tavily-failure-'));
    const fetchMock = new URL('./fixtures/mock-tavily-failure-fetch.mjs', import.meta.url).pathname;
    try {
        const result = await runSearchTool({
            provider: 'tavily',
            query: 'example',
            maxResults: 5,
        }, {
            env: {
                HOME: dir,
                TAVILY_API_KEY: 'test-key',
            },
            fetchMock,
        });

        assert.equal(result.code, 1);
        assert.equal(result.payload.error.code, 'PROVIDER_HTTP_ERROR');
        assert.equal(result.payload.error.details.providerStatus, 401);
        assert.match(result.payload.error.details.providerBodyPreview, /invalid api key/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('search tool limits Tavily provider query length', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-tavily-context-'));
    const fetchMock = new URL('./fixtures/mock-tavily-success-fetch.mjs', import.meta.url).pathname;
    const longQuery = 'x'.repeat(450);
    try {
        const result = await runSearchTool({
            provider: 'tavily',
            query: longQuery,
            maxResults: 5,
        }, {
            env: {
                HOME: dir,
                TAVILY_API_KEY: 'test-key',
            },
            fetchMock,
        });

        assert.equal(result.code, 0);
        assert.equal(result.payload.results[0].observedQueryLength, 400);
        assert.deepEqual(result.payload.results, [
            {
                title: 'Dogs',
                url: 'https://example.com/dogs',
                snippet: 'Dog breeds overview',
                content: 'Dog breeds overview',
                observedQueryLength: 400,
            },
        ]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('search tool returns normalized results from Gemini grounding provider', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-gemini-'));
    const fetchMock = new URL('./fixtures/mock-gemini-fetch.mjs', import.meta.url).pathname;
    try {
        const result = await runSearchTool({
            provider: 'gemini',
            query: 'grounded answer',
            maxResults: 5,
        }, {
            env: {
                HOME: dir,
                GEMINI_API_KEY: 'test-key',
            },
            fetchMock,
        });

        assert.equal(result.code, 0);
        assert.deepEqual(result.payload.results, [
            {
                title: 'Gemini source',
                url: 'https://example.com/gemini',
                snippet: 'Grounded Gemini snippet',
            },
        ]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('search tool runs deep-research as a provider and deduplicates results', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-deep-research-'));
    const fetchMock = new URL('./fixtures/mock-deep-research-fetch.mjs', import.meta.url).pathname;
    try {
        const result = await runSearchTool({
            provider: 'deep-research',
            query: 'aggregate this',
            maxResults: 5,
        }, {
            env: {
                HOME: dir,
                DEEP_RESEARCH_PROVIDERS: 'tavily,brave',
                TAVILY_API_KEY: 'test-key',
                BRAVE_API_KEY: 'test-key',
            },
            fetchMock,
        });

        assert.equal(result.code, 0);
        assert.deepEqual(result.payload.results, [
            {
                title: 'Shared result',
                url: 'https://example.com/shared',
                snippet: 'Tavily saw aggregate this',
                content: 'Tavily saw aggregate this',
                sourceProvider: 'tavily',
            },
            {
                title: 'Brave unique',
                url: 'https://example.com/brave',
                snippet: 'Brave unique snippet',
                description: 'Brave unique snippet',
                sourceProvider: 'brave',
            },
        ]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('search tool uses Google AI Mode browser pool provider', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-google-ai-mode-pool-'));
    const server = createServer((request, response) => {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/search/google-ai-mode');
        let raw = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            raw += chunk;
        });
        request.on('end', () => {
            const body = JSON.parse(raw);
            assert.equal(body.query, 'browser search');
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                ok: true,
                results: [{
                    title: 'AI Mode result',
                    url: 'https://example.com/ai-mode',
                    snippet: 'AI Mode snippet',
                }],
            }));
        });
    });

    try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address();
        const result = await runSearchTool({
            provider: 'google-ai-mode',
            query: 'browser search',
            maxResults: 5,
        }, {
            env: {
                HOME: dir,
                GOOGLE_AI_MODE_POOL_URL: `http://127.0.0.1:${port}`,
            },
        });

        assert.equal(result.code, 0);
        assert.deepEqual(result.payload.results, [{
            title: 'AI Mode result',
            url: 'https://example.com/ai-mode',
            snippet: 'AI Mode snippet',
        }]);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await rm(dir, { recursive: true, force: true });
    }
});

test('search tool reports google-ai-mode as not configured without a browser', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-google-ai-mode-'));
    try {
        const result = await runSearchTool({
            provider: 'google-ai-mode',
            query: 'browser search',
            maxResults: 5,
        }, {
            env: {
                HOME: dir,
                BROWSER_EXECUTABLE_PATH: '',
                BROWSER_POOL_SIZE: '0',
            },
        });

        assert.equal(result.code, 1);
        assert.equal(result.payload.error.code, 'PROVIDER_NOT_CONFIGURED');
        assert.match(result.payload.error.message, /BROWSER_EXECUTABLE_PATH|Chromium|puppeteer-core/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
