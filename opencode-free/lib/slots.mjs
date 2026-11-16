import fs from 'node:fs';
import path from 'node:path';

import { SLOT_POLL_MS } from './constants.mjs';

const MISSING_OWNER_STALE_MS = 5000;
const OWNER_MAX_AGE_MS = 130000;

function slotDir(dir, index) {
    return path.join(dir, `slot-${index}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH') return false;
        return true;
    }
}

function readOwner(dir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
    } catch {
        return null;
    }
}

function isStale(dir, now) {
    let stat;
    try {
        stat = fs.statSync(dir);
    } catch {
        return false;
    }
    const owner = readOwner(dir);
    if (!owner) return now - stat.mtimeMs > MISSING_OWNER_STALE_MS;
    if (!isPidAlive(owner.pid)) return true;
    return Number.isFinite(owner.startedAt) && now - owner.startedAt > OWNER_MAX_AGE_MS;
}

function tryCreate(dir, cap, requestId) {
    for (let index = 0; index < cap; index += 1) {
        const candidate = slotDir(dir, index);
        try {
            fs.mkdirSync(candidate);
        } catch (error) {
            if (error?.code === 'EEXIST') continue;
            throw error;
        }
        const owner = { pid: process.pid, startedAt: Date.now(), requestId: String(requestId ?? '') };
        fs.writeFileSync(path.join(candidate, 'owner.json'), `${JSON.stringify(owner)}\n`);
        return { dir: candidate, index, requestId: owner.requestId, released: false };
    }
    return null;
}

function reclaimStale(dir, cap) {
    let reclaimed = false;
    const now = Date.now();
    for (let index = 0; index < cap; index += 1) {
        const candidate = slotDir(dir, index);
        if (isStale(candidate, now)) {
            fs.rmSync(candidate, { recursive: true, force: true });
            reclaimed = true;
        }
    }
    return reclaimed;
}

export async function acquireSlot({ dir, cap, waitMs, pollMs = SLOT_POLL_MS, requestId } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
    for (;;) {
        let slot = tryCreate(dir, cap, requestId);
        if (slot) return slot;
        if (reclaimStale(dir, cap)) {
            slot = tryCreate(dir, cap, requestId);
            if (slot) return slot;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return null;
        await sleep(Math.min(pollMs, remaining));
    }
}

export function releaseSlot(slot) {
    if (!slot || slot.released) return;
    slot.released = true;
    fs.rmSync(slot.dir, { recursive: true, force: true });
}
