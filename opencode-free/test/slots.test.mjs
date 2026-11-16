import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquireSlot, releaseSlot } from '../lib/slots.mjs';

const WORKER = fileURLToPath(new URL('./helpers/fork-worker.mjs', import.meta.url));

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-slots-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'slots');
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

function writeOwner(dir, index, owner) {
    const slotDir = path.join(dir, `slot-${index}`);
    fs.mkdirSync(slotDir, { recursive: true });
    fs.writeFileSync(path.join(slotDir, 'owner.json'), JSON.stringify(owner));
    return slotDir;
}

test('cap 2: the third acquire with waitMs 300 returns null, release frees a slot', async (t) => {
    const dir = tempDir(t);
    const first = await acquireSlot({ dir, cap: 2, waitMs: 300, requestId: 'a' });
    const second = await acquireSlot({ dir, cap: 2, waitMs: 300, requestId: 'b' });
    assert.deepEqual([first.index, second.index], [0, 1]);
    const owner = JSON.parse(fs.readFileSync(path.join(first.dir, 'owner.json'), 'utf8'));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.requestId, 'a');
    assert.ok(Number.isFinite(owner.startedAt));
    const started = Date.now();
    const third = await acquireSlot({ dir, cap: 2, waitMs: 300, pollMs: 50, requestId: 'c' });
    const waited = Date.now() - started;
    assert.equal(third, null);
    assert.ok(waited >= 280 && waited < 2000, `waited ${waited} ms`);
    releaseSlot(first);
    releaseSlot(first);
    const fourth = await acquireSlot({ dir, cap: 2, waitMs: 300, requestId: 'd' });
    assert.equal(fourth.index, 0);
    releaseSlot(second);
    releaseSlot(fourth);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('a waiting acquire gets the slot released during its wait', async (t) => {
    const dir = tempDir(t);
    const held = await acquireSlot({ dir, cap: 1, waitMs: 0 });
    setTimeout(() => releaseSlot(held), 100);
    const next = await acquireSlot({ dir, cap: 1, waitMs: 2000, pollMs: 25 });
    assert.equal(next.index, 0);
    releaseSlot(next);
});

test('a slot owned by a dead pid is reclaimed within one poll', async (t) => {
    const dir = tempDir(t);
    writeOwner(dir, 0, { pid: 999999, startedAt: Date.now(), requestId: 'dead' });
    const started = Date.now();
    const slot = await acquireSlot({ dir, cap: 1, waitMs: 1000, pollMs: 250 });
    assert.ok(slot);
    assert.equal(slot.index, 0);
    assert.ok(Date.now() - started < 250, 'reclaim took longer than one poll');
    assert.equal(JSON.parse(fs.readFileSync(path.join(slot.dir, 'owner.json'), 'utf8')).pid, process.pid);
    releaseSlot(slot);
});

test('a slot older than 130 s is reclaimed; a live young owner is not', async (t) => {
    const dir = tempDir(t);
    writeOwner(dir, 0, { pid: process.pid, startedAt: Date.now() - 131000, requestId: 'old' });
    const reclaimed = await acquireSlot({ dir, cap: 1, waitMs: 0 });
    assert.ok(reclaimed);
    assert.equal(await acquireSlot({ dir, cap: 1, waitMs: 100, pollMs: 25 }), null);
    releaseSlot(reclaimed);
});

test('a slot without owner.json is reclaimed only after 5 s of mtime age', async (t) => {
    const dir = tempDir(t);
    const young = path.join(dir, 'slot-0');
    fs.mkdirSync(young, { recursive: true });
    assert.equal(await acquireSlot({ dir, cap: 1, waitMs: 100, pollMs: 25 }), null);
    const old = new Date(Date.now() - 6000);
    fs.utimesSync(young, old, old);
    const slot = await acquireSlot({ dir, cap: 1, waitMs: 0 });
    assert.ok(slot);
    releaseSlot(slot);
});

test('a pid that exists but is not signalable (EPERM) counts as alive', async (t) => {
    const dir = tempDir(t);
    writeOwner(dir, 0, { pid: 1, startedAt: Date.now(), requestId: 'init' });
    assert.equal(await acquireSlot({ dir, cap: 1, waitMs: 100, pollMs: 25 }), null);
});

test('two processes acquiring concurrently never get the same slot', async (t) => {
    const dir = tempDir(t);
    for (let round = 0; round < 5; round += 1) {
        const children = [fork(WORKER), fork(WORKER)];
        t.after(() => children.forEach((child) => child.kill('SIGKILL')));
        await Promise.all(children.map((child) => nextMessage(child, 'ready')));
        const acquired = await Promise.all(children.map((child) => {
            const reply = nextMessage(child, 'acquired');
            child.send({ op: 'acquire', options: { dir, cap: 2, waitMs: 1000, pollMs: 25, requestId: `r${round}` } });
            return reply;
        }));
        const indexes = acquired.map((message) => message.index);
        assert.ok(indexes.every((index) => index === 0 || index === 1), `indexes ${indexes}`);
        assert.notEqual(indexes[0], indexes[1]);
        await Promise.all(children.map((child) => {
            const reply = nextMessage(child, 'released');
            child.send({ op: 'release' });
            return reply;
        }));
        await Promise.all(children.map((child) => new Promise((resolve) => {
            child.once('exit', resolve);
            child.send({ op: 'exit' });
        })));
        assert.deepEqual(fs.readdirSync(dir), []);
    }
});
