import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { KEEPALIVE_INTERVAL_MS, resolveSettings } from '../lib/constants.mjs';
import { resolveOpencodeApiKey } from '../lib/credential.mjs';
import { extractOpenAiRequest, validateChatRequest } from '../lib/request.mjs';
import { abortActiveRuns, runOpencode } from '../lib/cli-runner.mjs';
import { confinementLogLines, evaluateRun } from '../lib/events.mjs';
import { buildCompletion, newCompletionId, startKeepalive, writeEnvelope, writeSseCompletion } from '../lib/response.mjs';
import { acquireSlot, releaseSlot } from '../lib/slots.mjs';
import { applyTransition, disableModel, readState } from '../lib/service-state.mjs';

const SLOT_BUSY_RETRY_AFTER_SECONDS = 10;

// Where a failure envelope goes depends on the request's stream mode.
let requestStream = false;

// Chat requests are answered only while the service is verified; every other
// state is refused before a CLI run so no quota is spent.
const STATE_GATE = Object.freeze({
    unverified: { status: 503, type: 'service_unverified', retryAfter: 30, message: 'the OpenCode free service has not been verified yet' },
    unavailable: { status: 503, type: 'service_unavailable', retryAfter: 60, message: 'the OpenCode free service is unavailable' },
    refused: { status: 403, type: 'free_tier_refused', message: 'the OpenCode free tier refused this agent' },
    tripped: { status: 503, type: 'service_tripped', retryAfter: 3600, message: 'the confinement guard took the agent out of service until restart' },
});

function log(message) {
    process.stderr.write(`[opencode-free] ${message}\n`);
}

function readStdin() {
    return new Promise((resolve, reject) => {
        let raw = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { raw += chunk; });
        process.stdin.on('end', () => resolve(raw));
        process.stdin.on('error', reject);
    });
}

function parsePayload(raw) {
    try {
        return JSON.parse(raw || '{}');
    } catch {
        return null;
    }
}

// A latch that cannot be persisted is a fail-open: the state file keeps the
// old value and the next request spawns the CLI again, so the drop gets its
// own greppable line naming the latch that was lost.
function applyStateEffect(stateFile, outcome, model) {
    const latch = outcome.stateEffect === 'disable-model' ? `disabled-model:${model}` : outcome.stateEffect;
    try {
        if (outcome.stateEffect === 'tripped') {
            applyTransition(stateFile, 'tripped', { reason: outcome.message }, { role: 'handler' });
            log(`service tripped: ${outcome.message}`);
        } else if (outcome.stateEffect === 'refused') {
            applyTransition(stateFile, 'refused', { reason: outcome.message }, { role: 'handler' });
            log(`service refused: ${outcome.type}`);
        } else if (outcome.stateEffect === 'disable-model') {
            disableModel(stateFile, model);
            log(`model disabled until restart: ${model}`);
        }
    } catch (error) {
        log(`service state latch not persisted: state=${latch} file=${stateFile} error=${error?.code || error?.message || error}`);
    }
}

async function main() {
    const settings = resolveSettings(process.env);
    const raw = await readStdin();
    const request = extractOpenAiRequest(parsePayload(raw));
    const stream = request?.stream === true;
    requestStream = stream;
    const fail = ({ status, type, message, retryAfter }) => {
        writeEnvelope({ out: process.stdout, err: process.stderr, stream, status, type, message, retryAfter });
        process.exitCode = 1;
    };

    if (!request) {
        fail({ status: 400, type: 'invalid_request_error', message: 'request is missing or is not a JSON object' });
        return;
    }
    const validated = validateChatRequest(request);
    if (!validated.ok) {
        fail({ status: 400, type: 'invalid_request_error', message: validated.message });
        return;
    }
    const { model, prompt } = validated;

    const state = readState(settings.stateFile);
    if (state.state !== 'verified') {
        fail(STATE_GATE[state.state] || STATE_GATE.unverified);
        return;
    }
    if (state.disabledModels && Object.hasOwn(state.disabledModels, model)) {
        fail({ status: 404, type: 'model_not_found', message: `the OpenCode free service does not serve ${model}` });
        return;
    }

    const stopKeepalive = stream ? startKeepalive(process.stdout, KEEPALIVE_INTERVAL_MS) : () => {};
    let slot = null;
    let terminating = false;
    // AgentServer signals only this process (deadline or a dropped stream);
    // the CLI lives in its own process group, so it is stopped here.
    // AgentServer may signal twice (deadline and client abort); the handler
    // stays registered so a second signal cannot interrupt the cleanup.
    process.on('SIGTERM', () => {
        if (terminating) return;
        terminating = true;
        stopKeepalive();
        abortActiveRuns().finally(() => {
            releaseSlot(slot);
            process.exit(143);
        });
    });

    const requestId = randomBytes(8).toString('hex');
    try {
        slot = await acquireSlot({
            dir: path.join(settings.runtimeDir, 'slots'),
            cap: settings.slotCap,
            waitMs: settings.slotWaitMs,
            requestId,
        });
        if (terminating) return;
        if (!slot) {
            stopKeepalive();
            fail({ status: 429, type: 'rate_limit_error', message: 'all OpenCode CLI slots are busy', retryAfter: SLOT_BUSY_RETRY_AFTER_SECONDS });
            return;
        }
        const run = await runOpencode({
            model,
            prompt,
            deadlineMs: settings.deadlineMs,
            cliPath: settings.cliPath,
            apiKey: resolveOpencodeApiKey(process.env),
            runtimeDir: settings.runtimeDir,
            configDir: settings.configDir,
        });
        if (terminating) return;
        for (const line of confinementLogLines(run.stderr)) process.stderr.write(`${line}\n`);
        if (!run.rootRemoved || fs.existsSync(run.root)) log('run root was not removed');
        stopKeepalive();
        if (run.spawnError) {
            fail({ status: 502, type: 'cli_failed', message: `the OpenCode CLI could not start (${run.spawnError})` });
            return;
        }
        const outcome = evaluateRun({ events: run.events, exitCode: run.exitCode, killed: run.killed });
        if (!outcome.ok) {
            applyStateEffect(settings.stateFile, outcome, model);
            fail(outcome);
            return;
        }
        const completion = buildCompletion({
            id: newCompletionId(),
            model,
            text: outcome.text,
            finishReason: outcome.finishReason,
            usage: outcome.usage,
        });
        if (stream) writeSseCompletion(process.stdout, completion);
        else process.stdout.write(JSON.stringify(completion));
        process.exitCode = 0;
    } finally {
        stopKeepalive();
        releaseSlot(slot);
    }
}

main().catch(async (error) => {
    log(`handler failure: ${error?.code || error?.name || 'error'}`);
    await abortActiveRuns().catch(() => {});
    writeEnvelope({
        out: process.stdout,
        err: process.stderr,
        stream: requestStream,
        status: 502,
        type: 'upstream_error',
        message: 'the OpenCode Free handler failed',
    });
    process.exitCode = 1;
});
