// A11: the real Ploinky AgentServer runs this agent's real handlers (with the
// fake CLI) and must turn their envelopes into the documented HTTP answers.
// Runs only when OPENCODE_FREE_PLOINKY_DIR names a Ploinky checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentServerSetup, fillSlots, sseFrames, startAgentServer } from './helpers/agent-server.mjs';

const SKY = 'The sky is a soft, hazy blue today, edged with faint silver clouds.';
const CHAT_BODY = { model: 'big-pickle', messages: [{ role: 'user', content: 'Describe the sky in one sentence.' }] };

// A handler whose last stderr line is a structured log line, not an envelope.
const JSON_LOG_HANDLER = 'let raw = "";\n'
    + 'process.stdin.on("data", (c) => { raw += c; });\n'
    + 'process.stdin.on("end", () => {\n'
    + '    process.stderr.write("starting handler\\n" + JSON.stringify({ level: "error", error: "ECONNRESET", status: 503 }) + "\\n");\n'
    + '    process.exitCode = 1;\n'
    + '});\n';

function setupOrSkip(t) {
    const setup = agentServerSetup();
    if (setup.skip) {
        t.skip(setup.skip);
        return null;
    }
    return setup;
}

async function withServer(t, options, fn) {
    const setup = setupOrSkip(t);
    if (!setup) return;
    const srv = await startAgentServer(setup, options);
    try {
        await fn(srv);
    } finally {
        await srv.stop();
    }
}

async function postChat(srv, body) {
    const res = await fetch(`${srv.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { res, text: await res.text() };
}

async function getModels(srv) {
    const res = await fetch(`${srv.baseUrl}/v1/models`);
    return { res, text: await res.text() };
}

test('A11 buffered: all slots busy -> HTTP 429, Retry-After 10, rate_limit_error', async (t) => {
    await withServer(t, {
        env: { OPENCODE_FREE_SLOT_CAP: '2', OPENCODE_FREE_SLOT_WAIT_MS: '300' },
        beforeStart: (agent) => fillSlots(agent.runtimeDir, 2),
    }, async (srv) => {
        const { res, text } = await postChat(srv, CHAT_BODY);
        assert.equal(res.status, 429);
        assert.equal(res.headers.get('retry-after'), '10');
        const body = JSON.parse(text);
        assert.deepEqual(Object.keys(body), ['error']);
        assert.deepEqual(Object.keys(body.error).sort(), ['message', 'type']);
        assert.equal(body.error.type, 'rate_limit_error');
        assert.equal(typeof body.error.message, 'string');
        assert.ok(body.error.message.includes('slots are busy'), body.error.message);
        assert.equal(fs.readdirSync(srv.agent.fake.dir).includes('calls.jsonl'), false, 'no CLI spawn');
    });
});

test('A11 streamed: state refused -> HTTP 200 with the 403 error frame and [DONE]', async (t) => {
    await withServer(t, { state: 'refused' }, async (srv) => {
        const { res, text } = await postChat(srv, { ...CHAT_BODY, stream: true });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /^text\/event-stream/);
        assert.ok(text.startsWith('data: '), 'no leading blank line: the handler wrote no stdout');
        const frames = sseFrames(text);
        assert.equal(frames.length, 2);
        assert.equal(frames[1], '[DONE]');
        const frame = JSON.parse(frames[0]);
        assert.deepEqual(Object.keys(frame), ['error']);
        assert.deepEqual(Object.keys(frame.error).sort(), ['message', 'status', 'type']);
        assert.equal(frame.error.type, 'free_tier_refused');
        assert.equal(frame.error.status, 403);
        assert.equal(typeof frame.error.message, 'string');
    });
});

test('A11 streamed success: keepalive, then exactly the four C4 frames', async (t) => {
    await withServer(t, {
        mode: 'slow:11000:stop-big-pickle',
        env: { OPENCODE_FREE_CLI_DEADLINE_MS: '20000' },
    }, async (srv) => {
        const { res, text } = await postChat(srv, { ...CHAT_BODY, stream: true });
        assert.equal(res.status, 200);
        const keepalive = text.indexOf(': keepalive');
        assert.ok(keepalive >= 0, 'a keepalive comment was relayed');
        assert.ok(keepalive < text.indexOf('data: '), 'the keepalive precedes the first data frame');
        const frames = sseFrames(text).filter((frame) => !frame.startsWith(':'));
        assert.equal(frames.length, 4);
        assert.equal(frames[3], '[DONE]');
        const [first, second, third] = frames.slice(0, 3).map((frame) => JSON.parse(frame));
        assert.equal(first.object, 'chat.completion.chunk');
        assert.deepEqual(first.choices, [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
        assert.deepEqual(second.choices, [{ index: 0, delta: { content: SKY }, finish_reason: null }]);
        assert.deepEqual(third.choices, [{ index: 0, delta: {}, finish_reason: 'stop' }]);
        assert.deepEqual(third.usage, { prompt_tokens: 6241, completion_tokens: 19, total_tokens: 6260 });
        assert.ok(text.endsWith('data: [DONE]\n\n'), 'nothing follows the handler terminator');
    });
});

test('A11 buffered success: one chat.completion', async (t) => {
    await withServer(t, {}, async (srv) => {
        const { res, text } = await postChat(srv, CHAT_BODY);
        assert.equal(res.status, 200);
        const completion = JSON.parse(text);
        assert.equal(completion.object, 'chat.completion');
        assert.equal(completion.choices[0].message.content, SKY);
    });
});

test('A11 models: verified -> seven rows, every supports_tools false', async (t) => {
    await withServer(t, {}, async (srv) => {
        const { res, text } = await getModels(srv);
        assert.equal(res.status, 200);
        const body = JSON.parse(text);
        assert.equal(body.data.length, 7);
        assert.deepEqual([...new Set(body.data.map((row) => row.supports_tools))], [false]);
        assert.deepEqual([...new Set(body.data.map((row) => row.supportsTools))], [false]);
    });
});

test('A11 models: refused -> HTTP 200 and no rows', async (t) => {
    await withServer(t, { state: 'refused' }, async (srv) => {
        const { res, text } = await getModels(srv);
        assert.equal(res.status, 200);
        assert.deepEqual(JSON.parse(text), { object: 'list', data: [] });
    });
});

test('A11: a structured log line without "ok": false is not an envelope -> HTTP 500', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-jsonlog-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const handlerPath = path.join(dir, 'json-log-line.mjs');
    fs.writeFileSync(handlerPath, JSON_LOG_HANDLER);
    await withServer(t, { chatHandlerPath: handlerPath }, async (srv) => {
        const { res, text } = await postChat(srv, CHAT_BODY);
        assert.equal(res.status, 500);
        assert.equal(res.headers.get('retry-after'), null);
        assert.equal(JSON.parse(text).error.type, 'server_error');
    });
});
