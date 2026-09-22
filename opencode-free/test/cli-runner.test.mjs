import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    CHILD_ENV_NAMES,
    abortActiveRuns,
    assertArgvAllowed,
    buildArgv,
    buildChildEnv,
    killProcessGroup,
    runOpencode,
} from '../lib/cli-runner.mjs';
import { FORBIDDEN_CLI_FLAGS, resolveSettings } from '../lib/constants.mjs';
import { evaluateRun } from '../lib/events.mjs';
import { flattenMessages } from '../lib/request.mjs';
import { buildCompletion, sseFrames } from '../lib/response.mjs';
import { makeFakeCli, readCallLog } from './helpers/fake-cli.mjs';

const EXPECTED_ENV_NAMES = [
    'HOME',
    'LANG',
    'NO_COLOR',
    'OPENCODE_API_KEY',
    'OPENCODE_DISABLE_AUTOUPDATE',
    'OPENCODE_DISABLE_CLAUDE_CODE',
    'OPENCODE_DISABLE_LSP_DOWNLOAD',
    'OPENCODE_DISABLE_MODELS_FETCH',
    'OPENCODE_DISABLE_PROJECT_CONFIG',
    'OPENCODE_DISABLE_SHARE',
    'OPENCODE_DISABLE_TERMINAL_TITLE',
    'PATH',
    'TERM',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
];
const TEST_KEY = 'test-key-not-a-secret';
const SKY = 'The sky is a soft, hazy blue today, edged with faint silver clouds.';

function setup(t, mode) {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-runner-'));
    const fake = makeFakeCli({ mode });
    t.after(() => {
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fake.cleanup();
    });
    return { runtimeDir, fake };
}

function run(t, mode, overrides = {}) {
    const { runtimeDir, fake } = setup(t, mode);
    const spawned = [];
    const promise = runOpencode({
        model: 'big-pickle',
        prompt: 'User: Describe the sky in one sentence.',
        deadlineMs: 10000,
        cliPath: fake.cliPath,
        apiKey: TEST_KEY,
        runtimeDir,
        configDir: '/opt/opencode-free/config',
        onSpawn: (info) => spawned.push(info),
        ...overrides,
    });
    return { promise, runtimeDir, fake, spawned };
}

function groupMembers(pgid) {
    const result = spawnSync('/bin/ps', ['-o', 'pid=', '-g', String(pgid)], { encoding: 'utf8' });
    return result.stdout.trim();
}

function sha256(text) {
    return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

test('buildChildEnv returns exactly the 18 C7 names and values', () => {
    const env = buildChildEnv({ root: '/r', configDir: '/cfg', apiKey: 'k' });
    assert.deepEqual(Object.keys(env).sort(), EXPECTED_ENV_NAMES);
    assert.deepEqual([...CHILD_ENV_NAMES].sort(), EXPECTED_ENV_NAMES);
    assert.equal(Object.keys(env).length, 18);
    assert.deepEqual(env, {
        PATH: '/usr/bin:/bin',
        HOME: '/r/home',
        XDG_CONFIG_HOME: '/cfg',
        XDG_DATA_HOME: '/r/data',
        XDG_STATE_HOME: '/r/state',
        XDG_CACHE_HOME: '/r/cache',
        TMPDIR: '/r/tmp',
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        TERM: 'dumb',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_SHARE: '1',
        OPENCODE_DISABLE_TERMINAL_TITLE: '1',
        OPENCODE_API_KEY: 'k',
    });
});

test('buildArgv returns the exact C7 argv and passes assertArgvAllowed', () => {
    const argv = buildArgv({ model: 'big-pickle', root: '/r' });
    assert.deepEqual(argv, ['run', '--pure', '--format', 'json', '-m', 'opencode/big-pickle', '--title', 'chat', '--dir', '/r/work', '--agent', 'chat']);
    assert.doesNotThrow(() => assertArgvAllowed(argv));
});

test('assertArgvAllowed rejects every forbidden flag, including --auto', () => {
    const argv = buildArgv({ model: 'big-pickle', root: '/r' });
    assert.throws(() => assertArgvAllowed([...argv, '--auto']), /--auto/);
    for (const flag of FORBIDDEN_CLI_FLAGS) {
        assert.throws(() => assertArgvAllowed([...argv, flag]), /forbidden/);
    }
    assert.throws(() => assertArgvAllowed([...argv, '--port=4096']), /--port/);
    assert.doesNotThrow(() => assertArgvAllowed([...argv.slice(0, 9), '/tmp/-c/-s/work', '--agent', 'chat']));
});

test('killProcessGroup tolerates a group that does not exist', () => {
    assert.equal(killProcessGroup(999999, 'SIGTERM'), false);
    assert.equal(killProcessGroup(0, 'SIGTERM'), false);
});

test('success: exact argv, 18 env names, prompt on stdin, root created and removed', async (t) => {
    const prompt = flattenMessages([
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Describe the sky in one sentence.' },
    ]);
    const { promise, runtimeDir, fake, spawned } = run(t, 'replay:stop-big-pickle', { prompt });
    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.equal(result.killed, false);
    assert.equal(result.rootRemoved, true);
    assert.equal(fs.existsSync(result.root), false);
    assert.match(result.requestId, /^[0-9a-f]{32}$/);
    assert.equal(result.root, path.join(runtimeDir, 'runs', result.requestId));
    assert.deepEqual(fs.readdirSync(path.join(runtimeDir, 'runs')), []);
    assert.equal(spawned.length, 1);
    assert.deepEqual(result.events.map((event) => event.type), ['step_start', 'text', 'step_finish']);
    const calls = readCallLog(fake.callLog);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual(call.argv, ['run', '--pure', '--format', 'json', '-m', 'opencode/big-pickle', '--title', 'chat', '--dir', path.join(result.root, 'work'), '--agent', 'chat']);
    assert.deepEqual(call.envKeys, EXPECTED_ENV_NAMES);
    assert.equal(fs.realpathSync.native(path.dirname(path.dirname(path.dirname(call.cwd)))), fs.realpathSync.native(runtimeDir));
    assert.equal(path.basename(call.cwd), 'work');
    assert.equal(call.stdinBytes, Buffer.byteLength(prompt, 'utf8'));
    assert.equal(call.stdinSha256, sha256(prompt));
    assert.equal(call.pgid, call.pid);
    assert.equal(JSON.stringify(call).includes(TEST_KEY), false);
    const outcome = evaluateRun(result);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, SKY);
});

test('onStdoutLine receives each parsed event in order', async (t) => {
    const seen = [];
    const { promise } = run(t, 'replay:two-text-events', { onStdoutLine: (event) => seen.push(event.type) });
    await promise;
    assert.deepEqual(seen, ['step_start', 'text', 'text', 'step_finish']);
});

test('unicode prompt reaches the CLI byte-exact and round-trips through the SSE content frame', async (t) => {
    const text = `Za${String.fromCodePoint(0x017c)}ółć gęślą jaźń ${String.fromCodePoint(0x1f30a)}${String.fromCodePoint(0x200b)} koniec`;
    const prompt = flattenMessages([{ role: 'user', content: text }]);
    const { promise, fake } = run(t, 'replay:stop-big-pickle', { prompt });
    await promise;
    const [call] = readCallLog(fake.callLog);
    assert.equal(call.stdinSha256, sha256(prompt));
    assert.equal(call.stdinBytes, Buffer.byteLength(prompt, 'utf8'));
    const frames = sseFrames(buildCompletion({ model: 'big-pickle', text, finishReason: 'stop', usage: {} }));
    assert.equal(JSON.parse(frames[1].slice('data: '.length)).choices[0].delta.content, text);
});

test('a prompt of exactly 65536 bytes is written to the CLI in full', async (t) => {
    const prompt = `User: ${'x'.repeat(65536 - 6)}`;
    assert.equal(Buffer.byteLength(prompt, 'utf8'), 65536);
    const { promise, fake } = run(t, 'replay:stop-big-pickle', { prompt });
    const result = await promise;
    assert.equal(result.exitCode, 0);
    const [call] = readCallLog(fake.callLog);
    assert.equal(call.stdinBytes, 65536);
    assert.equal(call.stdinSha256, sha256(prompt));
});

test('a non-JSON line is logged truncated to stderr and ignored', async (t) => {
    const writes = [];
    const original = process.stderr.write;
    process.stderr.write = function capture(chunk, ...rest) {
        writes.push(String(chunk));
        return original.call(process.stderr, chunk, ...rest);
    };
    let result;
    try {
        const { promise } = run(t, 'replay:nonjson-then-stop');
        result = await promise;
    } finally {
        process.stderr.write = original;
    }
    const logged = writes.find((line) => line.includes('non-JSON CLI line'));
    assert.ok(logged, 'no non-JSON log line');
    const payload = logged.slice(logged.indexOf(': ', logged.indexOf('line')) + 2).replace(/\n$/, '');
    assert.equal(payload.length, 200);
    assert.ok(payload.startsWith('Performing one time database migration'));
    const outcome = evaluateRun(result);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, SKY);
});

test('zero events and exit 0 -> empty_answer', async (t) => {
    const { runtimeDir } = setup(t, 'unused');
    const empty = path.join(runtimeDir, 'empty.jsonl');
    fs.writeFileSync(empty, '');
    const { promise } = run(t, `replay:${empty}`);
    const result = await promise;
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.events, []);
    const outcome = evaluateRun(result);
    assert.equal(outcome.type, 'empty_answer');
    assert.equal(outcome.status, 502);
});

test('an error event with exit 0 is classified by the error event', async (t) => {
    const { promise } = run(t, 'replay:error-exit0');
    const result = await promise;
    assert.equal(result.exitCode, 0);
    const outcome = evaluateRun(result);
    assert.equal(outcome.status, 403);
    assert.equal(outcome.type, 'free_tier_refused');
});

test('replay with :exit=1 keeps the exit code', async (t) => {
    const { promise } = run(t, 'replay:free-tier-403:exit=1');
    const result = await promise;
    assert.equal(result.exitCode, 1);
    assert.equal(evaluateRun(result).type, 'free_tier_refused');
});

test('exit:3 -> cli_failed and the root is removed', async (t) => {
    const { promise } = run(t, 'exit:3');
    const result = await promise;
    assert.equal(result.exitCode, 3);
    assert.equal(result.killed, false);
    assert.equal(result.rootRemoved, true);
    assert.match(result.stderr, /failing on purpose/);
    const outcome = evaluateRun(result);
    assert.equal(outcome.status, 502);
    assert.equal(outcome.type, 'cli_failed');
});

test('a missing CLI binary resolves as a failed run and removes the root', async (t) => {
    const { runtimeDir } = setup(t, 'unused');
    const result = await runOpencode({
        model: 'big-pickle',
        prompt: 'User: hi',
        deadlineMs: 5000,
        cliPath: path.join(runtimeDir, 'no-such-opencode'),
        apiKey: TEST_KEY,
        runtimeDir,
        configDir: '/opt/opencode-free/config',
    });
    assert.equal(result.spawnError, 'ENOENT');
    assert.equal(result.rootRemoved, true);
    assert.equal(evaluateRun(result).type, 'cli_failed');
});

test('hang with a 1500 ms deadline: killed, group gone and root gone within 4 s', async (t) => {
    const started = Date.now();
    const { promise, fake } = run(t, 'hang', { deadlineMs: 1500 });
    const result = await promise;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4000, `took ${elapsed} ms`);
    assert.equal(result.killed, true);
    assert.equal(result.rootRemoved, true);
    assert.equal(fs.existsSync(result.root), false);
    const [call] = readCallLog(fake.callLog);
    assert.equal(call.pgid, result.pid);
    assert.equal(groupMembers(call.pgid), '');
    const outcome = evaluateRun(result);
    assert.equal(outcome.status, 504);
    assert.equal(outcome.type, 'deadline_exceeded');
});

test('grandchild-ignores-term: no process of the group survives and the root is removed', async (t) => {
    const started = Date.now();
    const { promise, fake } = run(t, 'grandchild-ignores-term', { deadlineMs: 1000 });
    const result = await promise;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 6000, `took ${elapsed} ms`);
    assert.equal(result.killed, true);
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.rootRemoved, true);
    const [call] = readCallLog(fake.callLog);
    assert.equal(groupMembers(call.pgid), '');
    assert.equal(evaluateRun(result).type, 'deadline_exceeded');
});

test('abortActiveRuns kills the group of every active run and removes the roots', async (t) => {
    const { promise, fake } = run(t, 'grandchild-ignores-term', { deadlineMs: 60000 });
    for (let attempt = 0; attempt < 100 && readCallLog(fake.callLog).length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const [call] = readCallLog(fake.callLog);
    assert.ok(call, 'the fake never started');
    assert.notEqual(groupMembers(call.pgid), '');
    const aborted = await abortActiveRuns();
    assert.equal(aborted, 1);
    const result = await promise;
    assert.equal(result.killed, true);
    assert.equal(result.rootRemoved, true);
    assert.equal(groupMembers(call.pgid), '');
    assert.equal(await abortActiveRuns(), 0);
});

test('a stale run root from a previous process is not touched', async (t) => {
    const { runtimeDir } = setup(t, 'unused');
    const foreign = path.join(runtimeDir, 'runs', 'foreign-previous-process');
    fs.mkdirSync(path.join(foreign, 'work'), { recursive: true });
    fs.writeFileSync(path.join(foreign, 'work', 'left-behind.txt'), 'x');
    const fake = makeFakeCli({ mode: 'replay:stop-big-pickle' });
    t.after(() => fake.cleanup());
    const result = await runOpencode({
        model: 'big-pickle',
        prompt: 'User: hi',
        deadlineMs: 10000,
        cliPath: fake.cliPath,
        apiKey: TEST_KEY,
        runtimeDir,
        configDir: '/opt/opencode-free/config',
    });
    assert.equal(result.rootRemoved, true);
    assert.deepEqual(fs.readdirSync(path.join(runtimeDir, 'runs')), ['foreign-previous-process']);
    assert.equal(fs.readFileSync(path.join(foreign, 'work', 'left-behind.txt'), 'utf8'), 'x');
});

test('slow mode delays the replay and still succeeds', async (t) => {
    const started = Date.now();
    const { promise } = run(t, 'slow:300:stop-big-pickle');
    const result = await promise;
    assert.ok(Date.now() - started >= 300);
    assert.equal(result.exitCode, 0);
    assert.equal(evaluateRun(result).text, SKY);
});

test('resolveSettings reads the OPENCODE_FREE_* overrides with C1 defaults', () => {
    assert.deepEqual(resolveSettings({}), {
        cliPath: '/opt/opencode/bin/opencode',
        configDir: '/opt/opencode-free/config',
        runtimeDir: '/var/tmp/opencode-free',
        stateFile: '/data/service-state.json',
        deadlineMs: 90000,
        slotCap: 2,
        slotWaitMs: 20000,
    });
    assert.deepEqual(resolveSettings({
        OPENCODE_FREE_CLI_PATH: '/x/opencode',
        OPENCODE_FREE_CONFIG_DIR: '/x/config',
        OPENCODE_FREE_RUNTIME_DIR: '/x/runtime',
        OPENCODE_FREE_STATE_FILE: '/x/state.json',
        OPENCODE_FREE_CLI_DEADLINE_MS: '1500',
        OPENCODE_FREE_SLOT_CAP: '3',
        OPENCODE_FREE_SLOT_WAIT_MS: '300',
    }), {
        cliPath: '/x/opencode',
        configDir: '/x/config',
        runtimeDir: '/x/runtime',
        stateFile: '/x/state.json',
        deadlineMs: 1500,
        slotCap: 3,
        slotWaitMs: 300,
    });
    const invalid = resolveSettings({ OPENCODE_FREE_CLI_DEADLINE_MS: '-1', OPENCODE_FREE_SLOT_CAP: '0', OPENCODE_FREE_SLOT_WAIT_MS: 'abc' });
    assert.equal(invalid.deadlineMs, 90000);
    assert.equal(invalid.slotCap, 2);
    assert.equal(invalid.slotWaitMs, 20000);
});
