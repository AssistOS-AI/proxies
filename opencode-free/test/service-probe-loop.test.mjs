import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { backoffMs, readState } from '../lib/service-state.mjs';
import { PROBE_MODEL, PROBE_PROMPT, probeTransition } from '../scripts/service-probe-loop.mjs';
import { makeFakeCli, readCallLog } from './helpers/fake-cli.mjs';

const LOOP_SCRIPT = fileURLToPath(new URL('../scripts/service-probe-loop.mjs', import.meta.url));
const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function previousState(attempts) {
    return { state: 'unverified', probe: { attempts, lastAt: null, nextAt: null, lastOutcomeType: null } };
}

test('the probe uses big-pickle and a one-word prompt', () => {
    assert.equal(PROBE_MODEL, 'big-pickle');
    assert.equal(PROBE_PROMPT, 'Reply with exactly the word OK.');
});

test('probeTransition: success -> verified with attempts reset', () => {
    const { name, patch } = probeTransition({ ok: true, text: 'OK' }, previousState(4), NOW);
    assert.equal(name, 'verified');
    assert.equal(patch.probe.attempts, 0);
    assert.equal(patch.probe.nextAt, null);
    assert.equal(patch.probe.lastAt, new Date(NOW).toISOString());
    assert.equal(patch.probe.lastOutcomeType, 'ok');
});

test('probeTransition: a tripped effect -> tripped', () => {
    const outcome = { ok: false, status: 502, type: 'confinement_rejected', message: 'guard', stateEffect: 'tripped' };
    const { name, patch } = probeTransition(outcome, previousState(1), NOW);
    assert.equal(name, 'tripped');
    assert.equal(patch.probe.attempts, 2);
    assert.equal(patch.probe.nextAt, null);
    assert.equal(patch.probe.lastOutcomeType, 'confinement_rejected');
    assert.equal(patch.reason, 'guard');
});

test('probeTransition: a refused effect -> refused, next probe in 24 h', () => {
    const outcome = { ok: false, status: 403, type: 'free_tier_refused', message: 'refused', stateEffect: 'refused' };
    const { name, patch } = probeTransition(outcome, previousState(0), NOW);
    assert.equal(name, 'refused');
    assert.equal(patch.probe.attempts, 1);
    assert.equal(patch.probe.nextAt, new Date(NOW + DAY_MS).toISOString());
    assert.equal(patch.probe.lastOutcomeType, 'free_tier_refused');
});

test('probeTransition: any other failure -> unavailable with exponential backoff', () => {
    for (const attempts of [0, 1, 3, 9]) {
        const outcome = { ok: false, status: 502, type: 'upstream_error', message: 'x', stateEffect: null };
        const { name, patch } = probeTransition(outcome, previousState(attempts), NOW);
        assert.equal(name, 'unavailable');
        assert.equal(patch.probe.attempts, attempts + 1);
        assert.equal(patch.probe.nextAt, new Date(NOW + backoffMs(attempts + 1)).toISOString());
        assert.equal(patch.probe.lastOutcomeType, 'upstream_error');
    }
    // A disable-model effect is not a service-level effect.
    const notFound = { ok: false, status: 404, type: 'model_not_found', message: 'x', stateEffect: 'disable-model' };
    assert.equal(probeTransition(notFound, previousState(0), NOW).name, 'unavailable');
});

test('probeTransition: a missing previous probe counts as zero attempts', () => {
    const outcome = { ok: false, status: 504, type: 'deadline_exceeded', message: 'x', stateEffect: null };
    const { patch } = probeTransition(outcome, { state: 'unverified' }, NOW);
    assert.equal(patch.probe.attempts, 1);
    assert.equal(patch.probe.nextAt, new Date(NOW + backoffMs(1)).toISOString());
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoopUntil(t, mode, predicate, timeoutMs = 5000) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-probe-loop-'));
    const fake = makeFakeCli({ mode });
    const stateFile = path.join(dir, 'data', 'service-state.json');
    const runtimeDir = path.join(dir, 'runtime');
    const configDir = path.join(dir, 'config');
    fs.mkdirSync(configDir);
    // Running the module as the main script starts runLoop, which begins with
    // resetAtStartup on the fresh state file.
    const child = spawn(process.execPath, [LOOP_SCRIPT], {
        env: {
            PATH: process.env.PATH,
            OPENCODE_FREE_CLI_PATH: fake.cliPath,
            OPENCODE_FREE_STATE_FILE: stateFile,
            OPENCODE_FREE_RUNTIME_DIR: runtimeDir,
            OPENCODE_FREE_CONFIG_DIR: configDir,
            OPENCODE_FREE_API_KEY: 'test-key-not-a-secret',
            OPENCODE_FREE_CLI_DEADLINE_MS: '4000',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
        }
        fs.rmSync(dir, { recursive: true, force: true });
        fake.cleanup();
    });
    const deadline = Date.now() + timeoutMs;
    let state = null;
    while (Date.now() < deadline) {
        if (fs.existsSync(stateFile)) {
            state = readState(stateFile);
            if (predicate(state)) break;
        }
        await sleep(50);
    }
    child.kill('SIGTERM');
    let timer;
    const exit = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000); })]);
    clearTimeout(timer);
    return { state, stderr, exit, callLog: readCallLog(fake.callLog), runtimeDir };
}

test('runLoop: a zero-cost answer verifies the service within 5 s', async (t) => {
    const started = Date.now();
    const { state, stderr, exit, callLog, runtimeDir } = await runLoopUntil(t, 'replay:stop-big-pickle', (s) => s.state === 'verified');
    assert.equal(state?.state, 'verified', `state never became verified; stderr:\n${stderr}`);
    assert.ok(Date.now() - started < 6000);
    assert.equal(state.probe.attempts, 0);
    assert.equal(state.probe.lastOutcomeType, 'ok');
    assert.equal(state.writer.role, 'probe');
    assert.equal(callLog.length, 1, 'one probe request');
    assert.equal(callLog[0].argv[5], 'opencode/big-pickle');
    assert.deepEqual(exit, { code: 0, signal: null }, 'SIGTERM stops the loop cleanly');
    assert.deepEqual(fs.readdirSync(path.join(runtimeDir, 'slots')), [], 'the probe released its slot');
    assert.deepEqual(fs.readdirSync(path.join(runtimeDir, 'runs')), [], 'the probe removed its run root');
});

test('runLoop: a FreeTierError refuses the service with a future re-probe', async (t) => {
    const started = Date.now();
    const { state, stderr, callLog } = await runLoopUntil(t, 'replay:free-tier-403', (s) => s.state === 'refused');
    assert.equal(state?.state, 'refused', `state never became refused; stderr:\n${stderr}`);
    const nextAt = Date.parse(state.probe.nextAt);
    assert.ok(Number.isFinite(nextAt));
    assert.ok(nextAt > started + DAY_MS - 60000, `nextAt ${state.probe.nextAt} is about 24 h ahead`);
    assert.equal(state.probe.lastOutcomeType, 'free_tier_refused');
    assert.equal(callLog.length, 1, 'no second probe while refused');
});
