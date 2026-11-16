import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    LOCK_STALE_MS,
    LOCK_TIMEOUT_MS,
    applyTransition,
    backoffMs,
    disableModel,
    lockIdentity,
    readState,
    reclaimStaleLock,
    resetAtStartup,
    withLock,
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

function makeOld(dir, ageMs = 60000) {
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, old, old);
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
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['service-state.json']);
});

test('the lock timeout outlasts the stale window', () => {
    assert.ok(LOCK_TIMEOUT_MS > LOCK_STALE_MS, `${LOCK_TIMEOUT_MS} > ${LOCK_STALE_MS}`);
});

test('a waiter acting on an old stale observation leaves the lock another waiter took', (t) => {
    const file = tempStateFile(t);
    const lockDir = `${file}.lock`;
    makeOld(lockDir);
    const observed = lockIdentity(lockDir);
    assert.equal(reclaimStaleLock(lockDir, observed), true, 'the first waiter reclaims the stale lock');
    fs.mkdirSync(lockDir);
    const fresh = lockIdentity(lockDir);
    assert.equal(reclaimStaleLock(lockDir, observed), false, 'the second waiter acts on the same old observation');
    assert.deepEqual(lockIdentity(lockDir), fresh, 'the fresh lock is still the one the first waiter took');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['service-state.json.lock']);
});

test('a held reclaim lock keeps other waiters away from a stale lock', (t) => {
    const file = tempStateFile(t);
    const lockDir = `${file}.lock`;
    const reclaimDir = `${lockDir}.reclaim`;
    makeOld(lockDir);
    fs.mkdirSync(reclaimDir);
    const stale = lockIdentity(lockDir);
    const reclaimer = lockIdentity(reclaimDir);
    assert.equal(reclaimStaleLock(lockDir, stale), false);
    assert.deepEqual(lockIdentity(lockDir), stale, 'the stale lock is untouched');
    assert.deepEqual(lockIdentity(reclaimDir), reclaimer, 'the reclaim lock is untouched');
    fs.rmdirSync(reclaimDir);
    assert.equal(reclaimStaleLock(lockDir, stale), true);
    assert.equal(lockIdentity(lockDir), null);
    assert.equal(lockIdentity(reclaimDir), null);
});

test('a stale lock that vanishes between the re-check and the removal counts as reclaimed', (t) => {
    const file = tempStateFile(t);
    const lockDir = `${file}.lock`;
    makeOld(lockDir);
    const observed = lockIdentity(lockDir);
    const original = fs.rmdirSync;
    t.after(() => {
        fs.rmdirSync = original;
    });
    let vanished = 0;
    fs.rmdirSync = function rmdirSyncRacingForTheLock(target, ...rest) {
        if (target === lockDir) {
            // Another party removes the lock first; the module's own call then
            // meets the real ENOENT.
            vanished += 1;
            original.call(fs, target);
        }
        return original.call(fs, target, ...rest);
    };
    let result;
    assert.doesNotThrow(() => {
        result = reclaimStaleLock(lockDir, observed);
    });
    fs.rmdirSync = original;
    assert.equal(vanished, 1, 'the lock was removed exactly at the reclaimer\'s rmdir');
    assert.equal(result, true);
    assert.equal(lockIdentity(lockDir), null);
    assert.equal(lockIdentity(`${lockDir}.reclaim`), null, 'no .lock.reclaim is left behind');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
});

test('a reclaim never removes a lock that is not stale', (t) => {
    const file = tempStateFile(t);
    const lockDir = `${file}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    const observed = lockIdentity(lockDir);
    assert.equal(reclaimStaleLock(lockDir, observed), false);
    assert.deepEqual(lockIdentity(lockDir), observed);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['service-state.json.lock']);
});

test('an orphaned reclaim lock is cleared, then the orphaned state lock is reclaimed', (t) => {
    const file = tempStateFile(t);
    const lockDir = `${file}.lock`;
    makeOld(lockDir);
    makeOld(`${lockDir}.reclaim`);
    const result = applyTransition(file, 'tripped', { reason: 'confinement_rejected' }, { role: 'handler' });
    assert.equal(result.applied, true);
    assert.equal(readState(file).state, 'tripped');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['service-state.json']);
});

test('a holder releases only its own lock', (t) => {
    const file = tempStateFile(t);
    const lockDir = `${file}.lock`;
    let held = null;
    let successor = null;
    withLock(file, () => {
        held = lockIdentity(lockDir);
        // This holder was judged dead and reclaimed; the next writer took the lock.
        fs.rmdirSync(lockDir);
        fs.mkdirSync(lockDir);
        const later = new Date(held.mtimeMs + 20000);
        fs.utimesSync(lockDir, later, later);
        successor = lockIdentity(lockDir);
    });
    assert.notDeepEqual(successor, held);
    assert.deepEqual(lockIdentity(lockDir), successor, 'the successor still holds its lock');
    fs.rmdirSync(lockDir);
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

test('an orphan younger than the stale window is reclaimed once it goes stale, before the deadline', (t) => {
    const file = tempStateFile(t);
    const lockDir = `${file}.lock`;
    // 4 s old: the waiter must keep waiting until the orphan is 10 s old, and
    // its deadline must still be ahead of it then.
    makeOld(lockDir, 4000);
    const started = Date.now();
    const result = applyTransition(file, 'tripped', { reason: 'confinement_rejected' }, { role: 'handler' });
    const elapsed = Date.now() - started;
    assert.equal(result.applied, true);
    assert.ok(elapsed >= 5900, `the waiter never reclaims a lock younger than the stale window (waited ${elapsed} ms)`);
    assert.ok(elapsed < LOCK_TIMEOUT_MS, `the waiter reclaims before its deadline (waited ${elapsed} ms)`);
    assert.equal(readState(file).state, 'tripped');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['service-state.json']);
});

test('a fresh lock held by a live writer is not stolen: the waiter waits for the release', async (t) => {
    const file = tempStateFile(t);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lockDir = `${file}.lock`;
    fs.mkdirSync(lockDir);
    const held = fs.statSync(lockDir).ino;
    const child = fork(WORKER);
    t.after(() => child.kill('SIGKILL'));
    await nextMessage(child, 'ready');
    const reply = nextMessage(child, 'transitioned');
    child.send({ op: 'transition', file, name: 'refused', role: 'handler', patch: { reason: 'free_tier_refused' } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(fs.existsSync(lockDir), 'the live holder still owns a lock directory');
    assert.equal(fs.statSync(lockDir).ino, held, 'the live holder still owns the same lock directory');
    assert.equal(fs.existsSync(file), false, 'the waiter wrote nothing while the lock was held');
    fs.rmSync(lockDir, { recursive: true, force: true });
    const result = await reply;
    assert.equal(result.applied, true);
    assert.equal(readState(file).state, 'refused');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['service-state.json']);
});

test('several waiters behind one stale lock never lower tripped', async (t) => {
    const file = tempStateFile(t);
    const workers = 4;
    for (let round = 0; round < 10; round += 1) {
        fs.rmSync(file, { force: true });
        makeOld(`${file}.lock`);
        const children = Array.from({ length: workers }, () => fork(WORKER));
        t.after(() => children.forEach((child) => child.kill('SIGKILL')));
        await Promise.all(children.map((child) => nextMessage(child, 'ready')));
        const names = children.map((_, index) => (index === round % workers ? 'tripped' : 'refused'));
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
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ['service-state.json'], `round ${round}: ${JSON.stringify(results)}`);
    }
});
