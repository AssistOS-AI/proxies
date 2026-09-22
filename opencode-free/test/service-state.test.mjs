import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    applyTransition,
    backoffMs,
    disableModel,
    readState,
    resetAtStartup,
} from '../lib/service-state.mjs';

const WORKER = fileURLToPath(new URL('./helpers/fork-worker.mjs', import.meta.url));

function tempStateFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-state-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'data', 'service-state.json');
}

function writeRaw(file, state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
}

function nextMessage(child, op) {
    return new Promise((resolve, reject) => {
        const onMessage = (message) => {
            if (message.op === 'error') {
                child.off('message', onMessage);
                reject(new Error(message.message));
            } else if (message.op === op) {
                child.off('message', onMessage);
                resolve(message);
            }
        };
        child.on('message', onMessage);
    });
}

test('readState never throws and defaults to unverified', (t) => {
    const file = tempStateFile(t);
    const missingDir = readState(path.join(file, 'nope', 'deeper', 'state.json'));
    assert.equal(missingDir.state, 'unverified');
    assert.equal(missingDir.schemaVersion, 1);
    assert.deepEqual(missingDir.disabledModels, {});
    assert.deepEqual(missingDir.probe, { attempts: 0, lastAt: null, nextAt: null, lastOutcomeType: null });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const raw of ['', 'not json', '[]', '{"schemaVersion":2,"state":"verified"}', '{"schemaVersion":1,"state":"bogus"}']) {
        fs.writeFileSync(file, raw);
        assert.equal(readState(file).state, 'unverified');
    }
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.equal(readState(file).state, 'unverified');
});

test('precedence: a handler cannot write verified or unavailable and never lowers tripped', (t) => {
    const file = tempStateFile(t);
    assert.equal(applyTransition(file, 'verified', {}, { role: 'handler' }).applied, false);
    assert.equal(applyTransition(file, 'unavailable', {}, { role: 'handler' }).applied, false);
    assert.equal(fs.existsSync(file), false);
    const refused = applyTransition(file, 'refused', { reason: 'free_tier_refused' }, { role: 'handler' });
    assert.equal(refused.applied, true);
    assert.equal(readState(file).state, 'refused');
    assert.equal(readState(file).writer.role, 'handler');
    assert.equal(applyTransition(file, 'tripped', { reason: 'confinement_rejected' }, { role: 'handler' }).applied, true);
    const afterRefused = applyTransition(file, 'refused', { reason: 'free_tier_refused' }, { role: 'handler' });
    assert.equal(afterRefused.applied, false);
    const state = readState(file);
    assert.equal(state.state, 'tripped');
    assert.equal(state.reason, 'confinement_rejected');
    assert.equal(applyTransition(file, 'verified', {}, { role: 'probe' }).applied, false);
    assert.equal(readState(file).state, 'tripped');
});

test('the probe may raise freely and lower only along the allowed edges', (t) => {
    const file = tempStateFile(t);
    assert.equal(applyTransition(file, 'unavailable', {}, { role: 'probe' }).applied, true);
    assert.equal(applyTransition(file, 'verified', {}, { role: 'probe' }).applied, true);
    assert.equal(applyTransition(file, 'unverified', {}, { role: 'probe' }).applied, false);
    assert.equal(applyTransition(file, 'refused', {}, { role: 'probe' }).applied, true);
    assert.equal(applyTransition(file, 'unavailable', {}, { role: 'probe' }).applied, false);
    assert.equal(applyTransition(file, 'verified', { probe: { attempts: 0 } }, { role: 'probe' }).applied, true);
    assert.equal(readState(file).state, 'verified');
    writeRaw(file, { ...readState(file), state: 'unavailable' });
    assert.equal(applyTransition(file, 'unverified', {}, { role: 'probe' }).applied, false);
    assert.throws(() => applyTransition(file, 'bogus', {}, { role: 'probe' }));
    assert.throws(() => applyTransition(file, 'refused', {}, { role: 'router' }));
});

test('refused schedules the re-probe 24 h after since', (t) => {
    const file = tempStateFile(t);
    applyTransition(file, 'refused', {}, { role: 'handler' });
    const state = readState(file);
    assert.equal(Date.parse(state.probe.nextAt) - Date.parse(state.since), 24 * 60 * 60 * 1000);
});

test('disableModel adds a disabledModels entry without changing the state', (t) => {
    const file = tempStateFile(t);
    applyTransition(file, 'verified', {}, { role: 'probe' });
    assert.equal(disableModel(file, 'mimo-v2.5-free').applied, true);
    const state = readState(file);
    assert.equal(state.state, 'verified');
    assert.equal(state.disabledModels['mimo-v2.5-free'].reason, 'model_not_found');
    assert.ok(Date.parse(state.disabledModels['mimo-v2.5-free'].since) > 0);
});

test('resetAtStartup: tripped -> unverified, disabledModels cleared', (t) => {
    const file = tempStateFile(t);
    applyTransition(file, 'verified', {}, { role: 'probe' });
    disableModel(file, 'big-pickle');
    applyTransition(file, 'tripped', { reason: 'confinement_rejected' }, { role: 'handler' });
    const reset = resetAtStartup(file);
    assert.equal(reset.state, 'unverified');
    assert.equal(reset.reason, 'reset after restart');
    assert.deepEqual(reset.disabledModels, {});
    assert.deepEqual(readState(file), reset);
});

test('resetAtStartup keeps refused with a future nextAt and clears disabledModels', (t) => {
    const file = tempStateFile(t);
    applyTransition(file, 'refused', { reason: 'free_tier_refused' }, { role: 'handler' });
    disableModel(file, 'big-pickle');
    const before = readState(file);
    assert.ok(Date.parse(before.probe.nextAt) > Date.now());
    const reset = resetAtStartup(file);
    assert.equal(reset.state, 'refused');
    assert.equal(reset.since, before.since);
    assert.equal(reset.reason, 'free_tier_refused');
    assert.deepEqual(reset.probe, before.probe);
    assert.deepEqual(reset.disabledModels, {});
});

test('resetAtStartup turns verified and unavailable into unverified so the start probe runs', (t) => {
    for (const name of ['verified', 'unavailable']) {
        const file = tempStateFile(t);
        applyTransition(file, name, { probe: { attempts: 3, nextAt: new Date(Date.now() + 3600000).toISOString() } }, { role: 'probe' });
        const reset = resetAtStartup(file);
        assert.equal(reset.state, 'unverified', name);
        assert.equal(reset.reason, 'reset after restart');
        assert.equal(reset.probe.nextAt, null);
        assert.equal(reset.probe.attempts, 0);
    }
});

test('resetAtStartup re-probes a refused state recorded by another CLI version or already due', (t) => {
    const other = tempStateFile(t);
    applyTransition(other, 'refused', { reason: 'free_tier_refused' }, { role: 'handler' });
    const stored = JSON.parse(fs.readFileSync(other, 'utf8'));
    fs.writeFileSync(other, JSON.stringify({ ...stored, cliVersion: '1.0.0' }));
    assert.equal(resetAtStartup(other).state, 'unverified');
    const due = tempStateFile(t);
    applyTransition(due, 'refused', { reason: 'free_tier_refused' }, { role: 'handler' });
    const record = JSON.parse(fs.readFileSync(due, 'utf8'));
    fs.writeFileSync(due, JSON.stringify({ ...record, probe: { ...record.probe, nextAt: new Date(Date.now() - 1000).toISOString() } }));
    assert.equal(resetAtStartup(due).state, 'unverified');
});

test('resetAtStartup on a missing or invalid file writes unverified', (t) => {
    const file = tempStateFile(t);
    assert.equal(resetAtStartup(file).state, 'unverified');
    fs.writeFileSync(file, '{broken');
    assert.equal(resetAtStartup(file).state, 'unverified');
    assert.equal(readState(file).state, 'unverified');
});

test('resetAtStartup twice gives identical content except updatedAt', async (t) => {
    const file = tempStateFile(t);
    applyTransition(file, 'tripped', { reason: 'confinement_rejected' }, { role: 'handler' });
    resetAtStartup(file);
    const first = JSON.parse(fs.readFileSync(file, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    resetAtStartup(file);
    const second = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.notEqual(first.updatedAt, second.updatedAt);
    delete first.updatedAt;
    delete second.updatedAt;
    assert.deepEqual(second, first);
});

test('an atomic write leaves no *.tmp file and no lock directory', (t) => {
    const file = tempStateFile(t);
    applyTransition(file, 'refused', {}, { role: 'handler' });
    disableModel(file, 'big-pickle');
    resetAtStartup(file);
    const entries = fs.readdirSync(path.dirname(file));
    assert.deepEqual(entries, ['service-state.json']);
    assert.equal(entries.some((name) => name.endsWith('.tmp')), false);
});

test('a stale lock directory is reclaimed', (t) => {
    const file = tempStateFile(t);
    fs.mkdirSync(`${file}.lock`, { recursive: true });
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(`${file}.lock`, old, old);
    assert.equal(applyTransition(file, 'refused', {}, { role: 'handler' }).applied, true);
    assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('backoffMs doubles from 1 min and caps at 1 h', () => {
    assert.deepEqual(
        [1, 2, 3, 4, 5, 6, 7].map(backoffMs),
        [60000, 120000, 240000, 480000, 960000, 1920000, 3600000],
    );
    assert.equal(backoffMs(20), 3600000);
});

test('two processes racing refused and tripped always end tripped', async (t) => {
    const file = tempStateFile(t);
    for (let round = 0; round < 10; round += 1) {
        fs.rmSync(file, { force: true });
        const children = [fork(WORKER), fork(WORKER)];
        t.after(() => children.forEach((child) => child.kill('SIGKILL')));
        await Promise.all(children.map((child) => nextMessage(child, 'ready')));
        const names = round % 2 === 0 ? ['refused', 'tripped'] : ['tripped', 'refused'];
        const results = await Promise.all(children.map((child, index) => {
            const reply = nextMessage(child, 'transitioned');
            child.send({ op: 'transition', file, name: names[index], role: 'handler', patch: { reason: names[index] } });
            return reply;
        }));
        assert.equal(readState(file).state, 'tripped', `round ${round}: ${JSON.stringify(results)}`);
        await Promise.all(children.map((child) => new Promise((resolve) => {
            child.once('exit', resolve);
            child.send({ op: 'exit' });
        })));
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ['service-state.json']);
    }
});
