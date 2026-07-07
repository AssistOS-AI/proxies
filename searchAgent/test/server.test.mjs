import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function runNodeTool(relativePath, input, { env = {}, fetchMock = '' } = {}) {
    const toolPath = new URL(relativePath, import.meta.url).pathname;
    const mockArgs = fetchMock ? ['--import', fetchMock] : [];
    const child = spawn(process.execPath, [...mockArgs, toolPath], {
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
    const payload = stdout ? JSON.parse(stdout) : null;
    return { code, payload, stderr };
}

async function runSearchTool(input, options = {}) {
    return runNodeTool('../tools/search.mjs', input, options);
}

test('search tool rejects missing provider or query', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'search-agent-test-missing-input-'));
    try {
        const result = await runSearchTool({ provider: 'duckduckgo' }, { env: { HOME: dir } });
        assert.equal(result.code, 1);
        assert.equal(result.payload.ok, false);
        assert.match(result.payload.error.message, /provider and query are required/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('list-providers tool only includes providers ready to use', async () => {
    const result = await runNodeTool('../tools/list-providers.mjs', {}, {
        env: {
            TAVILY_API_KEY: 'test-key',
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
    assert.equal(byProvider.has('brave'), false);
    assert.equal(byProvider.has('exa'), false);
    assert.equal(byProvider.has('serper'), false);
    assert.equal(byProvider.has('searxng'), false);
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
