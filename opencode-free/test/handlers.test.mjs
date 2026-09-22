import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALLOW_LIST } from '../lib/allow-list.mjs';
import { CHILD_ENV_NAMES } from '../lib/cli-runner.mjs';
import { flattenMessages } from '../lib/request.mjs';
import { defaultState, readState } from '../lib/service-state.mjs';
import { makeFakeCli, readCallLog } from './helpers/fake-cli.mjs';

const CHAT_HANDLER = fileURLToPath(new URL('../openai-api/chat-completions.mjs', import.meta.url));
const MODELS_HANDLER = fileURLToPath(new URL('../openai-api/models.mjs', import.meta.url));
const TEST_KEY = 'test-key-not-a-secret';
const SKY = 'The sky is a soft, hazy blue today, edged with faint silver clouds.';
const USER_MESSAGES = Object.freeze([{ role: 'user', content: 'Describe the sky in one sentence.' }]);
const EXPECTED_ENV_KEYS = [...CHILD_ENV_NAMES].sort();
const KEEPALIVE_ONLY_RE = /^(: keepalive\n\n)*$/;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(text) {
    return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function writeStateFile(file, state, extra = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...defaultState('test fixture'), state, ...extra }, null, 2)}\n`);
}

// One temporary agent installation: fake CLI, runtime/config dirs, state file.
function setupAgent(t, { mode = 'replay:stop-big-pickle', state = 'verified', stateExtra = {}, env = {} } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-handler-'));
    const fake = makeFakeCli({ mode });
    const runtimeDir = path.join(dir, 'runtime');
    const configDir = path.join(dir, 'config');
    const stateFile = path.join(dir, 'data', 'service-state.json');
    fs.mkdirSync(configDir, { recursive: true });
    if (state) writeStateFile(stateFile, state, stateExtra);
    const children = new Set();
    t.after(async () => {
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        fs.rmSync(dir, { recursive: true, force: true });
        fake.cleanup();
    });
    const agent = {
        dir,
        fake,
        runtimeDir,
        configDir,
        stateFile,
        children,
        env: {
            PATH: process.env.PATH,
            OPENCODE_FREE_CLI_PATH: fake.cliPath,
            OPENCODE_FREE_STATE_FILE: stateFile,
            OPENCODE_FREE_RUNTIME_DIR: runtimeDir,
            OPENCODE_FREE_CONFIG_DIR: configDir,
            OPENCODE_FREE_API_KEY: TEST_KEY,
            ...env,
        },
        calls: () => readCallLog(fake.callLog),
    };
    return agent;
}

function startHandler(agent, { script = CHAT_HANDLER, payload, raw, env = {} } = {}) {
    const child = spawn(process.execPath, [script], {
        cwd: path.dirname(path.dirname(script)),
        env: { ...agent.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    agent.children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const done = new Promise((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(raw ?? `${JSON.stringify(payload)}\n`);
    return { child, done };
}

function chatPayload(request) {
    return { endpoint: 'openai.chat.completions', request, metadata: { agent: 'opencode-free', authInfo: null } };
}

function chatRequest(overrides = {}) {
    return { model: 'big-pickle', messages: USER_MESSAGES, ...overrides };
}

function runChat(agent, request, env) {
    return startHandler(agent, { payload: chatPayload(request), env }).done;
}

function runModels(agent) {
    return startHandler(agent, {
        script: MODELS_HANDLER,
        payload: { endpoint: 'openai.models', metadata: { agent: 'opencode-free', authInfo: null } },
    }).done;
}

function stdoutEnvelope(result) {
    assert.ok(result.stdout.endsWith('\n'), 'the buffered envelope ends with LF');
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error, envelope.type);
    return envelope;
}

// Streamed failures: the envelope is the last stderr line, followed by exactly one LF.
function stderrEnvelope(result) {
    assert.ok(result.stderr.endsWith('}\n'), `stderr ends with the envelope and one LF: ${JSON.stringify(result.stderr.slice(-80))}`);
    assert.ok(!result.stderr.endsWith('\n\n'));
    const lines = result.stderr.slice(0, -1).split('\n');
    const envelope = JSON.parse(lines[lines.length - 1]);
    assert.equal(envelope.ok, false);
    return envelope;
}

function sseDataFrames(stdout) {
    assert.ok(stdout.endsWith('\n\n'), 'every SSE event ends with a blank line');
    return stdout.split('\n\n').filter(Boolean).map((frame) => {
        assert.ok(frame.startsWith('data: '), `frame is a data line: ${frame.slice(0, 40)}`);
        assert.ok(!frame.includes('\n'), 'one line per frame');
        return frame.slice('data: '.length);
    });
}

function lastLine(text) {
    const lines = text.split('\n').filter((line) => line.trim());
    return lines.length ? lines[lines.length - 1] : '';
}

function isJsonObjectLine(line) {
    try {
        const parsed = JSON.parse(line);
        return Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
        return false;
    }
}

function groupGone(pgid) {
    try {
        process.kill(-pgid, 0);
        return false;
    } catch (error) {
        return error.code === 'ESRCH';
    }
}

function runsDirEntries(agent) {
    const runs = path.join(agent.runtimeDir, 'runs');
    return fs.existsSync(runs) ? fs.readdirSync(runs) : [];
}

function slotEntries(agent) {
    const slots = path.join(agent.runtimeDir, 'slots');
    return fs.existsSync(slots) ? fs.readdirSync(slots) : [];
}

async function waitForCalls(agent, count, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const calls = agent.calls();
        if (calls.length >= count) return calls;
        await sleep(25);
    }
    throw new Error(`the fake CLI was not called ${count} time(s) within ${timeoutMs} ms`);
}

// --- A6 (a), (b): request validation happens before any CLI spawn -----------

const BIG_PROMPT_TEXT = 'x'.repeat(65536 - 'User: '.length + 1);

const INVALID_REQUESTS = [
    ['tools', chatRequest({ tools: [{ type: 'function', function: { name: 'read', parameters: {} } }] })],
    ['tool_choice auto', chatRequest({ tool_choice: 'auto' })],
    ['functions', chatRequest({ functions: [{ name: 'read', parameters: {} }] })],
    ['response_format json_object', chatRequest({ response_format: { type: 'json_object' } })],
    ['an image_url part', chatRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } }] }] })],
    ['n: 2', chatRequest({ n: 2 })],
    ['role tool', chatRequest({ messages: [{ role: 'user', content: 'hi' }, { role: 'tool', content: 'result', tool_call_id: 'call_1' }] })],
    ['empty messages', chatRequest({ messages: [] })],
    ['a 65 537-byte prompt', chatRequest({ messages: [{ role: 'user', content: BIG_PROMPT_TEXT }] })],
    ['a NUL byte', chatRequest({ messages: [{ role: 'user', content: 'hello\u0000world' }] })],
    ['a model outside the allow-list', chatRequest({ model: 'gpt-4o' })],
    ['model opencode/does-not-exist', chatRequest({ model: 'opencode/does-not-exist' })],
    ['a NUL byte inside the model', chatRequest({ model: 'big-pickle\u0000' })],
];

for (const stream of [false, true]) {
    const label = stream ? 'streamed' : 'buffered';
    for (const [name, request] of INVALID_REQUESTS) {
        test(`A6 (a/b) ${label}: ${name} -> 400 invalid_request_error with no CLI spawn`, async (t) => {
            const agent = setupAgent(t);
            const result = await runChat(agent, { ...request, stream });
            assert.equal(result.code, 1);
            const envelope = stream ? stderrEnvelope(result) : stdoutEnvelope(result);
            assert.equal(stream ? result.stdout : '', '', 'a streamed validation failure writes no stdout bytes');
            assert.equal(envelope.status, 400);
            assert.equal(envelope.type, 'invalid_request_error');
            assert.equal(agent.calls().length, 0);
            assert.ok(!fs.existsSync(path.join(agent.runtimeDir, 'runs')), 'no run root was created');
        });
    }
}

test('A6 (b): the 65 537-byte prompt message names the cap', async (t) => {
    const agent = setupAgent(t);
    const envelope = stdoutEnvelope(await runChat(agent, INVALID_REQUESTS[8][1]));
    assert.equal(envelope.message, 'prompt exceeds 65536 bytes');
});

test('a prompt of exactly 65 536 bytes is accepted', async (t) => {
    const agent = setupAgent(t);
    const text = 'x'.repeat(65536 - 'User: '.length);
    const result = await runChat(agent, chatRequest({ messages: [{ role: 'user', content: text }] }));
    assert.equal(result.code, 0, result.stdout);
    const [call] = agent.calls();
    assert.equal(call.stdinBytes, 65536);
});

test('a payload without a request object -> 400', async (t) => {
    const agent = setupAgent(t);
    const result = await startHandler(agent, { payload: { endpoint: 'openai.chat.completions', metadata: {} } }).done;
    assert.equal(result.code, 1);
    assert.equal(stdoutEnvelope(result).status, 400);
    assert.equal(agent.calls().length, 0);
});

// --- A6 (c), (d), (e): success ----------------------------------------------

test('A6 (c): buffered success -> one chat.completion with mapped usage', async (t) => {
    const agent = setupAgent(t);
    const result = await runChat(agent, chatRequest());
    assert.equal(result.code, 0, result.stderr);
    const completion = JSON.parse(result.stdout);
    assert.equal(completion.object, 'chat.completion');
    assert.match(completion.id, /^chatcmpl-ocf-[0-9a-z]{22}$/);
    assert.equal(completion.model, 'big-pickle');
    assert.equal(completion.choices.length, 1);
    assert.equal(completion.choices[0].message.role, 'assistant');
    assert.equal(completion.choices[0].message.content, SKY);
    assert.equal(completion.choices[0].finish_reason, 'stop');
    assert.equal(completion.usage.prompt_tokens, 6241);
    assert.equal(completion.usage.completion_tokens, 19);
    assert.equal(completion.usage.total_tokens, 6260);
    assert.ok(!isJsonObjectLine(lastLine(result.stderr)), 'a successful request never ends stderr with a JSON object');
    assert.deepEqual(runsDirEntries(agent), []);
    assert.deepEqual(slotEntries(agent), []);
});

test('A6 (d): streamed success -> exactly the four C4 frames', async (t) => {
    const agent = setupAgent(t);
    const result = await runChat(agent, chatRequest({ stream: true }));
    assert.equal(result.code, 0, result.stderr);
    const frames = sseDataFrames(result.stdout);
    assert.equal(frames.length, 4);
    assert.equal(frames[3], '[DONE]');
    const [first, second, third] = frames.slice(0, 3).map((frame) => JSON.parse(frame));
    for (const chunk of [first, second, third]) {
        assert.equal(chunk.object, 'chat.completion.chunk');
        assert.equal(chunk.id, first.id);
        assert.equal(chunk.created, first.created);
        assert.equal(chunk.model, 'big-pickle');
    }
    assert.match(first.id, /^chatcmpl-ocf-[0-9a-z]{22}$/);
    assert.deepEqual(first.choices, [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
    assert.deepEqual(second.choices, [{ index: 0, delta: { content: SKY }, finish_reason: null }]);
    assert.deepEqual(third.choices, [{ index: 0, delta: {}, finish_reason: 'stop' }]);
    assert.deepEqual(third.usage, { prompt_tokens: 6241, completion_tokens: 19, total_tokens: 6260 });
    assert.ok(!isJsonObjectLine(lastLine(result.stderr)), 'a successful request never ends stderr with a JSON object');
});

test('A6 (e): the CLI receives the confined argv, the allow-listed env and the flattened prompt', async (t) => {
    const agent = setupAgent(t);
    const messages = [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi.' },
        { role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'text', text: 'the sky.' }] },
    ];
    const result = await runChat(agent, chatRequest({ messages }));
    assert.equal(result.code, 0, result.stderr);
    const calls = agent.calls();
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.argv.length, 12);
    const workDir = call.argv[9];
    assert.match(workDir, new RegExp(`^${agent.runtimeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/runs/[0-9a-f]{32}/work$`));
    assert.deepEqual(call.argv, ['run', '--pure', '--format', 'json', '-m', 'opencode/big-pickle', '--title', 'chat', '--dir', workDir, '--agent', 'chat']);
    // The fake reports its real cwd (macOS resolves /var to /private/var).
    assert.ok(call.cwd.endsWith(`/runs/${path.basename(path.dirname(workDir))}/work`), call.cwd);
    assert.deepEqual(call.envKeys, EXPECTED_ENV_KEYS);
    assert.equal(call.envKeys.length, 18);
    assert.equal(call.stdinSha256, sha256(flattenMessages(messages)));
    assert.equal(call.stdinSha256, sha256('System instructions:\nBe brief.\n\nUser: Hello\n\nAssistant: Hi.\n\nUser: Describe\nthe sky.'));
    assert.ok(Number.isInteger(call.pgid) && call.pgid === call.pid, 'the CLI leads its own process group');
});

test('ignored sampling options are accepted', async (t) => {
    const agent = setupAgent(t);
    const result = await runChat(agent, chatRequest({ max_tokens: 2147483647, temperature: -5, n: 1, tool_choice: 'none', tools: [], response_format: { type: 'text' } }));
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).choices[0].message.content, SKY);
});

// --- A6 (f)-(j): classified run failures --------------------------------------

test('A6 (f): a rejected tool call -> 502 confinement_rejected and no content', async (t) => {
    const agent = setupAgent(t, { mode: 'replay:tool-calls-rejected' });
    const result = await runChat(agent, chatRequest());
    assert.equal(result.code, 1);
    const envelope = stdoutEnvelope(result);
    assert.equal(envelope.status, 502);
    assert.equal(envelope.type, 'confinement_rejected');
    assert.ok(!result.stdout.includes('"content"'));
    assert.equal(readState(agent.stateFile).state, 'verified', 'a rejected (not completed) tool call does not trip');
});

test('A6 (g) + repeat: FreeTierError -> 403 and state refused; the second request spawns nothing', async (t) => {
    const agent = setupAgent(t, { mode: 'replay:free-tier-403' });
    const first = await runChat(agent, chatRequest());
    assert.equal(first.code, 1);
    const firstEnvelope = stdoutEnvelope(first);
    assert.equal(firstEnvelope.status, 403);
    assert.equal(firstEnvelope.type, 'free_tier_refused');
    assert.equal(readState(agent.stateFile).state, 'refused');
    assert.equal(agent.calls().length, 1);

    const second = await runChat(agent, chatRequest());
    assert.equal(second.code, 1);
    const secondEnvelope = stdoutEnvelope(second);
    assert.equal(secondEnvelope.status, 403);
    assert.equal(secondEnvelope.type, 'free_tier_refused');
    assert.equal(agent.calls().length, 1, 'the second request made 0 new CLI calls');
});

for (const fixture of ['tool-completed', 'cost-positive', 'cost-string']) {
    test(`A6 (h): replay:${fixture} -> 502 confinement_rejected and state tripped`, async (t) => {
        const agent = setupAgent(t, { mode: `replay:${fixture}` });
        const result = await runChat(agent, chatRequest());
        assert.equal(result.code, 1);
        const envelope = stdoutEnvelope(result);
        assert.equal(envelope.status, 502);
        assert.equal(envelope.type, 'confinement_rejected');
        assert.ok(!result.stdout.includes(SKY), 'no text returned');
        assert.equal(readState(agent.stateFile).state, 'tripped');
    });
}

test('A6 (i): upstream 429 -> 429 rate_limit_error with the upstream retry-after', async (t) => {
    const agent = setupAgent(t, { mode: 'replay:rate-limit-429' });
    const envelope = stdoutEnvelope(await runChat(agent, chatRequest()));
    assert.equal(envelope.status, 429);
    assert.equal(envelope.type, 'rate_limit_error');
    assert.equal(envelope.retryAfter, 17);
    assert.equal(readState(agent.stateFile).state, 'verified');
});

test('A6 (j) + repeat: model not found -> 404, then 404 with no spawn', async (t) => {
    const agent = setupAgent(t, { mode: 'replay:model-not-found' });
    const request = chatRequest({ model: 'opencode/mimo-v2.5-free' });
    const first = await runChat(agent, request);
    const firstEnvelope = stdoutEnvelope(first);
    assert.equal(firstEnvelope.status, 404);
    assert.equal(firstEnvelope.type, 'model_not_found');
    assert.ok(Object.hasOwn(readState(agent.stateFile).disabledModels, 'mimo-v2.5-free'));
    assert.equal(agent.calls().length, 1);

    const second = await runChat(agent, request);
    const secondEnvelope = stdoutEnvelope(second);
    assert.equal(secondEnvelope.status, 404);
    assert.equal(secondEnvelope.type, 'model_not_found');
    assert.equal(agent.calls().length, 1, 'the second request made 0 new CLI calls');

    const models = JSON.parse((await runModels(agent)).stdout);
    assert.ok(!models.data.some((row) => row.id === 'mimo-v2.5-free'));
});

test('error-500 / exit codes / empty answers map to 502', async (t) => {
    const cases = [
        ['replay:error-500', 'upstream_error'],
        ['exit:3', 'cli_failed'],
        ['replay:no-text', 'empty_answer'],
        ['replay:tool-calls-rejected:exit=0', 'confinement_rejected'],
    ];
    for (const [mode, type] of cases) {
        const agent = setupAgent(t, { mode });
        const envelope = stdoutEnvelope(await runChat(agent, chatRequest()));
        assert.equal(envelope.status, 502, mode);
        assert.equal(envelope.type, type, mode);
    }
});

test('an error event followed by exit 0 is still classified by the event', async (t) => {
    const agent = setupAgent(t, { mode: 'replay:error-exit0' });
    const envelope = stdoutEnvelope(await runChat(agent, chatRequest()));
    assert.equal(envelope.status, 403);
    assert.equal(envelope.type, 'free_tier_refused');
});

test('zero events and exit 0 -> 502 empty_answer', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-empty-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const empty = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    const agent = setupAgent(t, { mode: `replay:${empty}` });
    const envelope = stdoutEnvelope(await runChat(agent, chatRequest()));
    assert.equal(envelope.status, 502);
    assert.equal(envelope.type, 'empty_answer');
});

test('a non-JSON CLI line is logged truncated and the answer still succeeds', async (t) => {
    const agent = setupAgent(t, { mode: 'replay:nonjson-then-stop' });
    const result = await runChat(agent, chatRequest());
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).choices[0].message.content, SKY);
    const logged = result.stderr.split('\n').find((line) => line.includes('ignored non-JSON CLI line'));
    assert.ok(logged, result.stderr);
    assert.ok(logged.length < 300, 'the logged line is truncated');
    assert.ok(!isJsonObjectLine(lastLine(result.stderr)));
});

test('finish reason length -> finish_reason length', async (t) => {
    const agent = setupAgent(t, { mode: 'replay:finish-length' });
    const completion = JSON.parse((await runChat(agent, chatRequest())).stdout);
    assert.equal(completion.choices[0].finish_reason, 'length');
});

// --- A6 (k): service-state gate ----------------------------------------------

const GATED = [
    ['unverified', 'service_unverified', 30],
    ['unavailable', 'service_unavailable', 60],
    ['tripped', 'service_tripped', 3600],
];

for (const [state, type, retryAfter] of GATED) {
    for (const stream of [false, true]) {
        test(`A6 (k): state ${state} ${stream ? 'streamed' : 'buffered'} -> 503 ${type} with no spawn`, async (t) => {
            const agent = setupAgent(t, { state });
            const result = await runChat(agent, chatRequest({ stream }));
            assert.equal(result.code, 1);
            const envelope = stream ? stderrEnvelope(result) : stdoutEnvelope(result);
            if (stream) assert.equal(result.stdout, '');
            assert.equal(envelope.status, 503);
            assert.equal(envelope.type, type);
            assert.equal(envelope.retryAfter, retryAfter);
            assert.equal(agent.calls().length, 0);
        });
    }
}

test('a missing state file -> 503 service_unverified', async (t) => {
    const agent = setupAgent(t, { state: null });
    const envelope = stdoutEnvelope(await runChat(agent, chatRequest()));
    assert.equal(envelope.status, 503);
    assert.equal(envelope.type, 'service_unverified');
    assert.equal(agent.calls().length, 0);
});

test('OPENCODE_FREE_STATE_FILE in a missing directory -> 503 service_unverified envelope', async (t) => {
    const agent = setupAgent(t);
    const missing = path.join(agent.dir, 'no', 'such', 'dir', 'service-state.json');
    const result = await runChat(agent, chatRequest(), { OPENCODE_FREE_STATE_FILE: missing });
    assert.equal(result.code, 1);
    const envelope = stdoutEnvelope(result);
    assert.equal(envelope.status, 503);
    assert.equal(envelope.type, 'service_unverified');
    assert.equal(agent.calls().length, 0);
});

// --- A6 (l): deadline ---------------------------------------------------------

test('A6 (l): a CLI that never exits -> 504 within 4 s, group and run root gone', async (t) => {
    const agent = setupAgent(t, { mode: 'hang', env: { OPENCODE_FREE_CLI_DEADLINE_MS: '1500' } });
    const started = Date.now();
    const result = await runChat(agent, chatRequest());
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4000, `answered in ${elapsed} ms`);
    const envelope = stdoutEnvelope(result);
    assert.equal(envelope.status, 504);
    assert.equal(envelope.type, 'deadline_exceeded');
    const [call] = agent.calls();
    assert.ok(Number.isInteger(call.pgid));
    assert.ok(groupGone(call.pgid), `process group ${call.pgid} is gone`);
    assert.deepEqual(runsDirEntries(agent), [], 'the run root was removed');
    assert.deepEqual(slotEntries(agent), []);
});

// --- A6 (m): streamed failure --------------------------------------------------

test('A6 (m): a failing streamed run writes only keepalives on stdout and the envelope last on stderr', async (t) => {
    // 11 s makes the handler emit at least one keepalive before the failure.
    const agent = setupAgent(t, { mode: 'slow:11000:error-500' });
    const result = await runChat(agent, chatRequest({ stream: true }));
    assert.equal(result.code, 1);
    assert.match(result.stdout, KEEPALIVE_ONLY_RE);
    assert.ok(result.stdout.length > 0, 'at least one keepalive was written');
    assert.ok(!result.stdout.includes('data:'));
    const envelope = stderrEnvelope(result);
    assert.equal(envelope.status, 502);
    assert.equal(envelope.type, 'upstream_error');
});

test('A6 (m): a quickly failing streamed run writes no stdout at all', async (t) => {
    const agent = setupAgent(t, { mode: 'replay:tool-calls-rejected' });
    const result = await runChat(agent, chatRequest({ stream: true }));
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(stderrEnvelope(result).type, 'confinement_rejected');
});

// --- probes: streaming edge cases ---------------------------------------------

test('stream: "true" (a string) is buffered', async (t) => {
    const agent = setupAgent(t);
    const result = await runChat(agent, chatRequest({ stream: 'true' }));
    assert.equal(result.code, 0);
    const completion = JSON.parse(result.stdout);
    assert.equal(completion.object, 'chat.completion');
    assert.equal(completion.choices[0].message.content, SKY);
});

test('data: [DONE] inside the answer text is escaped; the terminator is the only [DONE] line', async (t) => {
    const agent = setupAgent(t, { mode: 'replay:done-inside-text' });
    const result = await runChat(agent, chatRequest({ stream: true }));
    assert.equal(result.code, 0);
    const doneLines = result.stdout.split('\n').filter((line) => /^data:\s*\[DONE\]/.test(line));
    assert.deepEqual(doneLines, ['data: [DONE]']);
    assert.ok(result.stdout.endsWith('data: [DONE]\n\n'));
    const frames = sseDataFrames(result.stdout);
    assert.equal(frames.length, 4);
    assert.equal(JSON.parse(frames[1]).choices[0].delta.content, 'Line one\n\ndata: [DONE]\n\nLine two');
});

test('Unicode round trip (U+017C, U+1F30A, U+200B) through stdin and the streamed content frame', async (t) => {
    const text = 'Za\u017C\u00F3\u0142\u0107 g\u0119\u015Bl\u0105 ja\u017A\u0144 \u{1F30A}\u200Bkoniec';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-unicode-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = fs.readFileSync(new URL('./fixtures/events/stop-big-pickle.jsonl', import.meta.url), 'utf8');
    const events = source.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    events.find((event) => event.type === 'text').part.text = text;
    const fixture = path.join(dir, 'unicode.jsonl');
    fs.writeFileSync(fixture, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    const agent = setupAgent(t, { mode: `replay:${fixture}` });
    const messages = [{ role: 'user', content: text }];
    const result = await runChat(agent, chatRequest({ messages, stream: true }));
    assert.equal(result.code, 0, result.stderr);
    const [call] = agent.calls();
    assert.equal(call.stdinSha256, sha256(flattenMessages(messages)));
    assert.equal(call.stdinBytes, Buffer.byteLength(`User: ${text}`, 'utf8'));
    const frames = sseDataFrames(result.stdout);
    assert.equal(JSON.parse(frames[1]).choices[0].delta.content, text);
});

// --- probes: concurrency, orphans, termination ---------------------------------

test('three parallel requests with cap 2 -> exactly one 429 retryAfter 10 and two successes', async (t) => {
    const agent = setupAgent(t, {
        mode: 'slow:3000:stop-big-pickle',
        env: { OPENCODE_FREE_SLOT_CAP: '2', OPENCODE_FREE_SLOT_WAIT_MS: '300' },
    });
    const results = await Promise.all([0, 1, 2].map(() => runChat(agent, chatRequest())));
    const successes = results.filter((result) => result.code === 0);
    const failures = results.filter((result) => result.code !== 0);
    assert.equal(successes.length, 2);
    assert.equal(failures.length, 1);
    for (const success of successes) assert.equal(JSON.parse(success.stdout).choices[0].message.content, SKY);
    const envelope = stdoutEnvelope(failures[0]);
    assert.equal(envelope.status, 429);
    assert.equal(envelope.type, 'rate_limit_error');
    assert.equal(envelope.retryAfter, 10);
    assert.equal(agent.calls().length, 2);
    assert.deepEqual(slotEntries(agent), [], 'slots/ is empty afterwards');
    assert.deepEqual(runsDirEntries(agent), []);
});

test('a stale run root under runs/ is not touched by a new request', async (t) => {
    const agent = setupAgent(t);
    const stale = path.join(agent.runtimeDir, 'runs', 'ffffffffffffffffffffffffffffffff');
    fs.mkdirSync(path.join(stale, 'work'), { recursive: true });
    fs.writeFileSync(path.join(stale, 'work', 'left-behind.txt'), 'stale');
    const result = await runChat(agent, chatRequest());
    assert.equal(result.code, 0);
    assert.deepEqual(runsDirEntries(agent), ['ffffffffffffffffffffffffffffffff']);
    assert.equal(fs.readFileSync(path.join(stale, 'work', 'left-behind.txt'), 'utf8'), 'stale');
});

test('SIGTERM to the handler while the CLI hangs -> exit 143, group and run root gone', async (t) => {
    const agent = setupAgent(t, { mode: 'hang', env: { OPENCODE_FREE_CLI_DEADLINE_MS: '60000' } });
    const { child, done } = startHandler(agent, { payload: chatPayload(chatRequest({ stream: true })) });
    const [call] = await waitForCalls(agent, 1);
    assert.ok(Number.isInteger(call.pgid));
    assert.ok(!groupGone(call.pgid), 'the fake is running');
    child.kill('SIGTERM');
    const result = await done;
    assert.ok(result.code === 143 || result.signal === 'SIGTERM', `exit ${result.code} signal ${result.signal}`);
    assert.ok(groupGone(call.pgid), `process group ${call.pgid} is gone`);
    assert.deepEqual(runsDirEntries(agent), [], 'the run root was removed');
    assert.deepEqual(slotEntries(agent), [], 'the slot was released');
});

for (const gapMs of [200, 1500]) {
    test(`two SIGTERMs ${gapMs} ms apart while a grandchild ignores TERM -> group, run root and slot still cleaned`, async (t) => {
        const agent = setupAgent(t, { mode: 'grandchild-ignores-term', env: { OPENCODE_FREE_CLI_DEADLINE_MS: '60000' } });
        const { child, done } = startHandler(agent, { payload: chatPayload(chatRequest({ stream: true })) });
        const [call] = await waitForCalls(agent, 1);
        assert.ok(Number.isInteger(call.pgid));
        await sleep(200);
        child.kill('SIGTERM');
        await sleep(gapMs);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const result = await done;
        assert.equal(result.code, 143, `exit ${result.code} signal ${result.signal}`);
        assert.ok(groupGone(call.pgid), `process group ${call.pgid} is gone`);
        assert.deepEqual(runsDirEntries(agent), [], 'the run root was removed');
        assert.deepEqual(slotEntries(agent), [], 'the slot was released');
    });
}

test('a state file whose state is an array is not verified: 503, no spawn', async (t) => {
    const agent = setupAgent(t, { state: ['verified'] });
    const result = await runChat(agent, chatRequest());
    assert.equal(result.code, 1);
    assert.equal(stdoutEnvelope(result).type, 'service_unverified');
    assert.equal(agent.calls().length, 0);
    const models = await runModels(agent);
    assert.equal(JSON.parse(models.stdout).data.length, 0);
});

// --- models handler ------------------------------------------------------------

test('models: verified -> the seven allow-listed rows, tools off', async (t) => {
    const agent = setupAgent(t);
    const result = await runModels(agent);
    assert.equal(result.code, 0);
    const body = JSON.parse(result.stdout);
    assert.equal(body.object, 'list');
    assert.equal(body.data.length, 7);
    assert.deepEqual(body.data.map((row) => row.id), ALLOW_LIST.map((entry) => entry.id));
    for (const row of body.data) {
        assert.equal(row.supports_tools, false);
        assert.equal(row.supportsTools, false);
        assert.equal(row.capabilities.supportsTools, false);
        assert.equal(row.supportsStreaming, true);
        assert.equal(row.metadata.serviceState, 'verified');
    }
});

for (const state of ['refused', 'unverified', 'unavailable', 'tripped', null]) {
    test(`models: ${state === null ? 'missing state file' : state} -> empty list, exit 0`, async (t) => {
        const agent = setupAgent(t, { state });
        const result = await runModels(agent);
        assert.equal(result.code, 0);
        assert.deepEqual(JSON.parse(result.stdout), { object: 'list', data: [] });
    });
}

test('models: a state file in a missing directory or a corrupt file -> empty list, exit 0', async (t) => {
    const agent = setupAgent(t);
    const missing = await startHandler(agent, {
        script: MODELS_HANDLER,
        payload: { endpoint: 'openai.models', metadata: {} },
        env: { OPENCODE_FREE_STATE_FILE: path.join(agent.dir, 'nope', 'state.json') },
    }).done;
    assert.equal(missing.code, 0);
    assert.deepEqual(JSON.parse(missing.stdout), { object: 'list', data: [] });
    fs.writeFileSync(agent.stateFile, '{ not json');
    const corrupt = await runModels(agent);
    assert.equal(corrupt.code, 0);
    assert.deepEqual(JSON.parse(corrupt.stdout), { object: 'list', data: [] });
});

test('models: a disabledModels entry removes that row', async (t) => {
    const agent = setupAgent(t, {
        stateExtra: { disabledModels: { 'nemotron-3-ultra-free': { since: new Date().toISOString(), reason: 'model_not_found' } } },
    });
    const result = await runModels(agent);
    assert.equal(result.code, 0);
    const ids = JSON.parse(result.stdout).data.map((row) => row.id);
    assert.equal(ids.length, 6);
    assert.ok(!ids.includes('nemotron-3-ultra-free'));
});

test('models: an empty stdin is fine', async (t) => {
    const agent = setupAgent(t);
    const result = await startHandler(agent, { script: MODELS_HANDLER, raw: '' }).done;
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).data.length, 7);
});
