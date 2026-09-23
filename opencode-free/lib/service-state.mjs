import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CLI_VERSION } from './constants.mjs';

export const STATE_SCHEMA_VERSION = 1;
export const STATE_PRECEDENCE = Object.freeze({
    unverified: 1,
    verified: 2,
    unavailable: 3,
    refused: 4,
    tripped: 5,
});

const REASON_MAX_CHARS = 200;
const REFUSED_REPROBE_MS = 24 * 60 * 60 * 1000;
export const LOCK_STALE_MS = 10000;
export const LOCK_TIMEOUT_MS = 15000;
const LOCK_RETRY_MS = 10;
const HANDLER_STATES = new Set(['refused', 'tripped']);
const PROBE_LOWERINGS = Object.freeze({
    verified: new Set(['unverified', 'unavailable', 'refused']),
    unavailable: new Set(['unverified']),
});

function nowIso() {
    return new Date().toISOString();
}

function clampReason(reason) {
    const text = typeof reason === 'string' ? reason : '';
    return text.length > REASON_MAX_CHARS ? text.slice(0, REASON_MAX_CHARS) : text;
}

function defaultProbe() {
    return { attempts: 0, lastAt: null, nextAt: null, lastOutcomeType: null };
}

export function defaultState(reason = 'no state recorded') {
    const at = nowIso();
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        state: 'unverified',
        since: at,
        updatedAt: at,
        reason: clampReason(reason),
        cliVersion: CLI_VERSION,
        probe: defaultProbe(),
        disabledModels: {},
        writer: { pid: 0, role: 'probe' },
    };
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeState(parsed) {
    if (!isPlainObject(parsed)) return null;
    if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) return null;
    if (typeof parsed.state !== 'string' || !Object.hasOwn(STATE_PRECEDENCE, parsed.state)) return null;
    const fallback = defaultState();
    const probe = isPlainObject(parsed.probe) ? { ...defaultProbe(), ...parsed.probe } : defaultProbe();
    const disabledModels = isPlainObject(parsed.disabledModels) ? { ...parsed.disabledModels } : {};
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        state: parsed.state,
        since: typeof parsed.since === 'string' ? parsed.since : fallback.since,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : fallback.updatedAt,
        reason: clampReason(parsed.reason),
        cliVersion: typeof parsed.cliVersion === 'string' ? parsed.cliVersion : CLI_VERSION,
        probe,
        disabledModels,
        writer: isPlainObject(parsed.writer) ? { ...parsed.writer } : { ...fallback.writer },
    };
}

function readValidState(file) {
    try {
        return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
        return null;
    }
}

export function readState(file) {
    return readValidState(file) || defaultState();
}

function writeStateAtomic(file, state) {
    const tmp = path.join(
        path.dirname(file),
        `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
        fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
        fs.renameSync(tmp, file);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Only the holder of the reclaim lock (`<lock>.reclaim`) may remove a state
// lock it does not own, and only the exact stale directory it re-checked under
// that reclaim lock; a new lock never matches, because its mtime is new. A
// holder removes only its own lock, so a holder judged dead never deletes its
// successor's lock. The one assumption: a live writer never stays inside the
// one-read-one-rename critical section for LOCK_STALE_MS. LOCK_TIMEOUT_MS
// exceeds LOCK_STALE_MS, so a waiter always outlives an orphaned lock.
export function lockIdentity(dir) {
    try {
        const stat = fs.lstatSync(dir);
        return { ino: stat.ino, mtimeMs: stat.mtimeMs };
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
}

function sameLock(a, b) {
    return Boolean(a) && Boolean(b) && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
}

function isStaleLock(identity) {
    return Boolean(identity) && Date.now() - identity.mtimeMs >= LOCK_STALE_MS;
}

function releaseLock(dir, held) {
    if (!sameLock(lockIdentity(dir), held)) return;
    try {
        fs.rmdirSync(dir);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

export function reclaimStaleLock(lockDir, observed) {
    const reclaimDir = `${lockDir}.reclaim`;
    try {
        fs.mkdirSync(reclaimDir);
    } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const reclaimer = lockIdentity(reclaimDir);
        if (isStaleLock(reclaimer)) releaseLock(reclaimDir, reclaimer);
        return false;
    }
    const reclaiming = lockIdentity(reclaimDir);
    try {
        const current = lockIdentity(lockDir);
        if (!(sameLock(current, observed) && isStaleLock(current))) return false;
        try {
            fs.rmdirSync(lockDir);
        } catch (error) {
            // Already gone: the caller retries mkdir, which has a single winner.
            if (error?.code !== 'ENOENT') throw error;
        }
        return true;
    } finally {
        releaseLock(reclaimDir, reclaiming);
    }
}

export function withLock(file, fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lockDir = `${file}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            fs.mkdirSync(lockDir);
            break;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
        const observed = lockIdentity(lockDir);
        if (isStaleLock(observed) && reclaimStaleLock(lockDir, observed)) continue;
        if (Date.now() > deadline) throw new Error(`timed out waiting for the state lock ${lockDir}`);
        if (observed !== null) sleepSync(LOCK_RETRY_MS);
    }
    const held = lockIdentity(lockDir);
    try {
        return fn();
    } finally {
        releaseLock(lockDir, held);
    }
}

function transitionAllowed(current, next, role) {
    if (role === 'handler') {
        return HANDLER_STATES.has(next) && STATE_PRECEDENCE[next] >= STATE_PRECEDENCE[current];
    }
    if (role === 'probe') {
        if (STATE_PRECEDENCE[next] >= STATE_PRECEDENCE[current]) return true;
        return PROBE_LOWERINGS[next]?.has(current) === true;
    }
    return false;
}

function mergePatch(state, patch, role) {
    if (typeof patch.reason === 'string') state.reason = clampReason(patch.reason);
    if (role === 'probe' && isPlainObject(patch.probe)) state.probe = { ...state.probe, ...patch.probe };
    if (isPlainObject(patch.disabledModels)) {
        for (const [id, entry] of Object.entries(patch.disabledModels)) {
            if (!Object.hasOwn(state.disabledModels, id)) {
                state.disabledModels[id] = isPlainObject(entry)
                    ? { since: entry.since || nowIso(), reason: clampReason(entry.reason || 'model_not_found') }
                    : { since: nowIso(), reason: 'model_not_found' };
            }
        }
    }
}

export function applyTransition(file, name, patch = {}, { role = 'handler' } = {}) {
    if (role !== 'handler' && role !== 'probe') throw new Error(`unknown state writer role: ${role}`);
    if (name !== null && name !== undefined && !Object.hasOwn(STATE_PRECEDENCE, name)) {
        throw new Error(`unknown service state: ${name}`);
    }
    const safePatch = isPlainObject(patch) ? patch : {};
    return withLock(file, () => {
        const current = readState(file);
        const next = structuredClone(current);
        let applied = false;
        if (name !== null && name !== undefined) {
            if (!transitionAllowed(current.state, name, role)) {
                return { applied: false, state: current };
            }
            if (name !== current.state) {
                next.state = name;
                next.since = nowIso();
                if (name === 'refused') {
                    next.probe = {
                        ...next.probe,
                        nextAt: new Date(Date.parse(next.since) + REFUSED_REPROBE_MS).toISOString(),
                    };
                }
            }
            applied = true;
        }
        mergePatch(next, safePatch, role);
        if (isPlainObject(safePatch.disabledModels)) applied = true;
        if (!applied && role === 'probe' && (isPlainObject(safePatch.probe) || typeof safePatch.reason === 'string')) {
            applied = true;
        }
        if (!applied) return { applied: false, state: current };
        next.updatedAt = nowIso();
        next.cliVersion = CLI_VERSION;
        next.writer = { pid: process.pid, role };
        writeStateAtomic(file, next);
        return { applied: true, state: next };
    });
}

export function disableModel(file, id, reason = 'model_not_found') {
    return applyTransition(file, null, {
        disabledModels: { [id]: { since: nowIso(), reason } },
    }, { role: 'handler' });
}

// Every container start re-establishes the service state with a live probe,
// except a refusal whose next probe is still due later under the same CLI.
function mustReprobeAtStartup(current) {
    if (current.cliVersion !== CLI_VERSION) return current.state !== 'unverified' || Boolean(current.probe?.nextAt);
    if (current.state === 'refused') {
        const nextAt = Date.parse(current.probe?.nextAt || '');
        return !(Number.isFinite(nextAt) && nextAt > Date.now());
    }
    return current.state !== 'unverified';
}

export function resetAtStartup(file) {
    return withLock(file, () => {
        const current = readValidState(file);
        let next;
        if (!current) {
            next = defaultState('no valid state file at startup');
        } else if (mustReprobeAtStartup(current)) {
            next = {
                ...current,
                state: 'unverified',
                since: nowIso(),
                reason: 'reset after restart',
                probe: defaultProbe(),
                disabledModels: {},
            };
        } else {
            next = { ...current, disabledModels: {} };
        }
        next.updatedAt = nowIso();
        next.cliVersion = CLI_VERSION;
        next.writer = { pid: process.pid, role: 'probe' };
        writeStateAtomic(file, next);
        return next;
    });
}

export function backoffMs(attempts) {
    const count = Math.max(1, Math.floor(Number(attempts) || 1));
    return Math.min(60000 * 2 ** (count - 1), 3600000);
}
