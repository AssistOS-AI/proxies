// A12: real AgentServer running the real handlers (fake CLI) -> a relay that
// stands in for the Router (it only strips the route-key prefix and the Soul
// assertion; Router verification is not exercised) -> Soul Gateway's real
// Ploinky agent backend `execute` and `classifyError`.
// Runs only when OPENCODE_FREE_PLOINKY_DIR names a Ploinky checkout; Soul is
// read from SOUL_SRC or, by default, <proxies>/soul-gateway/src.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { agentServerSetup, fillSlots, startAgentServer } from './helpers/agent-server.mjs';

const SOUL_SRC = process.env.SOUL_SRC
    || path.join(fileURLToPath(new URL('../..', import.meta.url)), 'soul-gateway', 'src');
const ROUTE_KEY = 'routekey1';
const SOUL_AGENT_ID = 'agent:test/soulgateway';
const TEST_SECRET = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

let soulModules = null;
async function loadSoul() {
    if (!soulModules) {
        const imp = (relative) => import(pathToFileURL(path.join(SOUL_SRC, relative)).href);
        const { backendModule } = await imp('runtime/backends/builtin/ploinky-agent-openai.backend.mjs');
        const { fakeRouterDescriptorOptions } = await imp('test/helpers/fake-router-descriptor.mjs');
        soulModules = { backendModule, fakeRouterDescriptorOptions };
    }
    return soulModules;
}

async function startRelay(agentPort) {
    const relay = createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const up = httpRequest({
                host: '127.0.0.1',
                port: agentPort,
                method: req.method,
                path: req.url.replace(/^\/[^/]+/, ''),
                headers: { 'content-type': 'application/json' },
            }, (upRes) => {
                res.writeHead(upRes.statusCode, upRes.headers);
                upRes.pipe(res);
            });
            up.on('error', () => res.destroy());
            up.end(Buffer.concat(chunks));
        });
    });
    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    return {
        baseUrl: `http://127.0.0.1:${relay.address().port}`,
        close: () => new Promise((resolve) => {
            relay.closeAllConnections?.();
            relay.close(() => resolve());
        }),
    };
}

async function callSoul(baseUrl, supportsStreaming) {
    const { backendModule, fakeRouterDescriptorOptions } = await loadSoul();
    const descriptor = fakeRouterDescriptorOptions({
        physicalOrigin: baseUrl,
        requestAuthority: `router.test:${new URL(baseUrl).port}`,
        agentPrincipal: SOUL_AGENT_ID,
    });
    const ctx = {
        requestId: 'chain',
        request: { messages: [{ role: 'user', content: 'Describe the sky in one sentence.' }] },
        resolvedModel: { providerModelId: 'big-pickle', modelKey: 'big-pickle', capabilities: { supportsStreaming } },
        providerRecord: {
            baseUrl,
            authStrategy: 'none',
            settings: {},
            metadata: { routeKey: ROUTE_KEY, subjectId: 'agent:proxies/opencode-free', discoverySource: 'ploinky-agent-discovery' },
        },
        env: { PLOINKY_AGENT_ID: SOUL_AGENT_ID, PLOINKY_AGENT_SECRET: TEST_SECRET },
        routerDescriptorEnv: descriptor.descriptorEnv,
        loadDescriptorVerifier: descriptor.loadDescriptorVerifier,
    };
    const events = [];
    try {
        // A buffered failure is only thrown once the stream is iterated.
        const handle = await backendModule.execute(ctx);
        for await (const event of handle.stream) events.push(event);
        return { ok: true, events };
    } catch (error) {
        return { ok: false, error, classified: backendModule.classifyError(error, {}) };
    }
}

async function chain(t, serverOptions, supportsStreaming) {
    const setup = agentServerSetup();
    if (setup.skip) {
        t.skip(setup.skip);
        return null;
    }
    const srv = await startAgentServer(setup, serverOptions);
    const relay = await startRelay(srv.port);
    try {
        return await callSoul(relay.baseUrl, supportsStreaming);
    } finally {
        await relay.close();
        await srv.stop();
    }
}

function assertClassified(result, { status, type, className, retryable, cascade }) {
    assert.equal(result.ok, false, 'the call failed');
    assert.equal(result.error.status, status);
    assert.equal(result.error.body?.error?.type, type);
    assert.equal(result.classified.constructor.name, className);
    assert.equal(result.classified.retryable, retryable);
    assert.equal(result.classified.cascade, cascade);
}

for (const supportsStreaming of [false, true]) {
    const label = supportsStreaming ? 'streamed' : 'buffered';
    test(`A12 ${label}: 403 free_tier_refused -> ProviderAuthError retryable false cascade true`, async (t) => {
        const result = await chain(t, { state: 'refused' }, supportsStreaming);
        if (!result) return;
        assertClassified(result, { status: 403, type: 'free_tier_refused', className: 'ProviderAuthError', retryable: false, cascade: true });
    });
}

test('A12 buffered: 429 slots busy -> ProviderRateLimitError retryable true cascade true', async (t) => {
    const result = await chain(t, {
        env: { OPENCODE_FREE_SLOT_CAP: '2', OPENCODE_FREE_SLOT_WAIT_MS: '300' },
        beforeStart: (agent) => fillSlots(agent.runtimeDir, 2),
    }, false);
    if (!result) return;
    assertClassified(result, { status: 429, type: 'rate_limit_error', className: 'ProviderRateLimitError', retryable: true, cascade: true });
});

test('A12 buffered: 404 model_not_found -> ProviderModelNotFoundError, no cascade', async (t) => {
    const result = await chain(t, { mode: 'replay:model-not-found' }, false);
    if (!result) return;
    assertClassified(result, { status: 404, type: 'model_not_found', className: 'ProviderModelNotFoundError', retryable: false, cascade: false });
});

test('A12 buffered: 502 confinement_rejected -> ProviderServerError retryable true cascade true', async (t) => {
    const result = await chain(t, { mode: 'replay:tool-calls-rejected' }, false);
    if (!result) return;
    assertClassified(result, { status: 502, type: 'confinement_rejected', className: 'ProviderServerError', retryable: true, cascade: true });
});

test('A12 streamed success: message_start -> text_delta -> usage -> done', async (t) => {
    const result = await chain(t, {}, true);
    if (!result) return;
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(result.events.map((event) => event.type), ['message_start', 'text_delta', 'usage', 'done']);
    assert.equal(result.events[1].data.text, 'The sky is a soft, hazy blue today, edged with faint silver clouds.');
    assert.deepEqual(result.events[2].data, { input_tokens: 6241, output_tokens: 19, total_tokens: 6260 });
    assert.equal(result.events[3].data.finish_reason, 'stop');
});
