import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { resolveSettings } from '../lib/constants.mjs';
import { resolveOpencodeApiKey } from '../lib/credential.mjs';
import { abortActiveRuns, runOpencode } from '../lib/cli-runner.mjs';
import { evaluateRun } from '../lib/events.mjs';
import { acquireSlot, releaseSlot } from '../lib/slots.mjs';
import { applyTransition, backoffMs, readState, resetAtStartup } from '../lib/service-state.mjs';

// One live request per probe: the smallest prompt on the model every
// installation has, evaluated by the same rules as a chat request.
export const PROBE_MODEL = 'big-pickle';
export const PROBE_PROMPT = 'Reply with exactly the word OK.';
const REFUSED_REPROBE_MS = 24 * 60 * 60 * 1000;
const IDLE_RECHECK_MS = 60_000;
const SLOT_RETRY_MS = 10_000;
const ERROR_RETRY_MS = 10_000;

let stopping = false;
let wake = null;

function log(message) {
    process.stderr.write(`[opencode-free] probe: ${message}\n`);
}

function sleep(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, ms));
        wake = () => {
            clearTimeout(timer);
            resolve();
        };
    });
}

function dueIn(state, now) {
    if (state.state === 'unverified') return 0;
    if (state.state === 'unavailable' || state.state === 'refused') {
        const nextAt = Date.parse(state.probe?.nextAt || '');
        return Number.isFinite(nextAt) ? Math.max(0, nextAt - now) : 0;
    }
    return null;
}

// Maps one probe outcome to the next service state (DS004, service-state file).
export function probeTransition(outcome, previous, now = Date.now()) {
    const attempts = Number(previous.probe?.attempts) || 0;
    const lastAt = new Date(now).toISOString();
    if (outcome.ok) {
        return { name: 'verified', patch: { reason: 'the probe was answered at zero cost', probe: { attempts: 0, lastAt, nextAt: null, lastOutcomeType: 'ok' } } };
    }
    if (outcome.stateEffect === 'tripped') {
        return { name: 'tripped', patch: { reason: outcome.message, probe: { attempts: attempts + 1, lastAt, nextAt: null, lastOutcomeType: outcome.type } } };
    }
    if (outcome.stateEffect === 'refused') {
        return { name: 'refused', patch: { reason: outcome.message, probe: { attempts: attempts + 1, lastAt, nextAt: new Date(now + REFUSED_REPROBE_MS).toISOString(), lastOutcomeType: outcome.type } } };
    }
    return { name: 'unavailable', patch: { reason: `probe failed: ${outcome.type}`, probe: { attempts: attempts + 1, lastAt, nextAt: new Date(now + backoffMs(attempts + 1)).toISOString(), lastOutcomeType: outcome.type } } };
}

async function probeOnce(settings) {
    const slot = await acquireSlot({
        dir: path.join(settings.runtimeDir, 'slots'),
        cap: settings.slotCap,
        waitMs: settings.slotWaitMs,
        requestId: `probe-${randomBytes(6).toString('hex')}`,
    });
    if (!slot) return null;
    try {
        const run = await runOpencode({
            model: PROBE_MODEL,
            prompt: PROBE_PROMPT,
            deadlineMs: settings.deadlineMs,
            cliPath: settings.cliPath,
            apiKey: resolveOpencodeApiKey(process.env),
            runtimeDir: settings.runtimeDir,
            configDir: settings.configDir,
        });
        if (run.spawnError) return { ok: false, status: 502, type: 'cli_failed', message: `the OpenCode CLI could not start (${run.spawnError})`, stateEffect: null };
        return evaluateRun({ events: run.events, exitCode: run.exitCode, killed: run.killed });
    } finally {
        releaseSlot(slot);
    }
}

function record(settings, previous, outcome) {
    const { name, patch } = probeTransition(outcome, previous);
    const result = applyTransition(settings.stateFile, name, patch, { role: 'probe' });
    if (!result.applied) {
        // A higher state written meanwhile keeps its place; only the schedule moves.
        applyTransition(settings.stateFile, null, { probe: patch.probe }, { role: 'probe' });
    }
    log(`outcome ${outcome.ok ? 'ok' : outcome.type}; state ${readState(settings.stateFile).state}`);
}

export async function runLoop(settings = resolveSettings(process.env)) {
    resetAtStartup(settings.stateFile);
    log(`started; state ${readState(settings.stateFile).state}`);
    while (!stopping) {
        try {
            const state = readState(settings.stateFile);
            const wait = dueIn(state, Date.now());
            if (wait === null) {
                await sleep(IDLE_RECHECK_MS);
                continue;
            }
            if (wait > 0) {
                await sleep(Math.min(wait, IDLE_RECHECK_MS));
                continue;
            }
            const outcome = await probeOnce(settings);
            if (stopping) break;
            if (!outcome) {
                log('all CLI slots are busy; probing later');
                await sleep(SLOT_RETRY_MS);
                continue;
            }
            record(settings, state, outcome);
        } catch (error) {
            log(`iteration failed: ${error?.code || error?.name || 'error'}`);
            await sleep(ERROR_RETRY_MS);
        }
    }
}

function stop() {
    if (stopping) return;
    stopping = true;
    wake?.();
    abortActiveRuns().finally(() => process.exit(0));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    runLoop().catch((error) => {
        log(`stopped: ${error?.code || error?.name || 'error'}`);
        process.exit(1);
    });
}
