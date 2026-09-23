import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { DEFAULT_CLI_DEADLINE_MS, DEFAULT_SLOT_WAIT_MS } from '../lib/constants.mjs';

// Packet 6 replaces null with the published multi-architecture index digest
// ("sha256:<64 hex>"); this is the only place the digest is written in this file.
const PUBLISHED_INDEX_DIGEST = 'sha256:b56aa886c1d47fa0cfdc5fbd9b15bd0d26d135ed8b879842baa433cc6923f1c5';

const MANIFEST = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const STARTUP = fs.readFileSync(new URL('../startup.sh', import.meta.url), 'utf8');
const READINESS = fs.readFileSync(new URL('../readiness.sh', import.meta.url), 'utf8');
const AGENT_SERVER_LIMIT_MS = 120000;

test('the container is pinned by digest', () => {
    assert.match(MANIFEST.container, /^docker[.]io\/assistos\/opencode-free-agent@sha256:[0-9a-f]{64}$/);
});

test('the container digest is the published index digest', {
    skip: PUBLISHED_INDEX_DIGEST === null && 'packet 6 sets PUBLISHED_INDEX_DIGEST',
}, () => {
    assert.ok(MANIFEST.container.endsWith(`@${PUBLISHED_INDEX_DIGEST}`));
    assert.ok(!MANIFEST.container.endsWith(`@sha256:${'0'.repeat(64)}`));
});

test('the chat completions endpoint streams from /code with a 115 s budget', () => {
    const chat = MANIFEST.endpoints.chatCompletions;
    assert.equal(chat.cwd, '/code');
    assert.equal(chat.timeoutMs, 115000);
    assert.equal(chat.supportsStream, true);
    assert.equal(chat.command, '/usr/local/bin/node');
    assert.deepEqual(chat.args, ['/code/openai-api/chat-completions.mjs']);
});

test('the models endpoint runs from /code with a 10 s budget', () => {
    const models = MANIFEST.endpoints.models;
    assert.equal(models.cwd, '/code');
    assert.equal(models.timeoutMs, 10000);
    assert.equal(models.command, '/usr/local/bin/node');
    assert.deepEqual(models.args, ['/code/openai-api/models.mjs']);
});

test('the slot wait plus the CLI deadline fit inside the endpoint budget', () => {
    const { timeoutMs } = MANIFEST.endpoints.chatCompletions;
    assert.ok(DEFAULT_SLOT_WAIT_MS + DEFAULT_CLI_DEADLINE_MS < timeoutMs);
    assert.ok(timeoutMs < AGENT_SERVER_LIMIT_MS);
});

test('readiness, storage, startup and profile settings', () => {
    assert.equal(MANIFEST.health.readiness.script, 'readiness.sh');
    assert.deepEqual(MANIFEST.runtime.resources.persistentStorage, { key: 'opencode-free', containerPath: '/data' });
    assert.equal(Object.hasOwn(MANIFEST, 'startup'), false);
    // An explicit readiness.protocol would win over the script and leave the
    // binary and configuration checks out of the activation and restart gates.
    assert.equal(Object.hasOwn(MANIFEST, 'readiness'), false);
    const probe = MANIFEST.health.readiness;
    assert.deepEqual(
        { interval: probe.interval, timeout: probe.timeout, failureThreshold: probe.failureThreshold, successThreshold: probe.successThreshold },
        { interval: 1, timeout: 15, failureThreshold: 60, successThreshold: 1 },
    );
    // Worst case before a terminal readiness failure, and the QA gate waits longer.
    assert.ok(probe.failureThreshold * (probe.interval + probe.timeout) * 1000 <= 960000);
    assert.equal(MANIFEST.agent, 'bash /code/startup.sh');
    const keyEnv = MANIFEST.profiles.default.env.OPENCODE_FREE_API_KEY;
    assert.equal(keyEnv.required, false);
    assert.equal(keyEnv.default, '');
});

test('startup.sh starts AgentServer in the background and the probe loop', () => {
    assert.ok(STARTUP.includes('AGENT_SERVER="${OPENCODE_FREE_AGENT_SERVER:-/Agent/server/AgentServer.sh}"'));
    assert.ok(STARTUP.includes('sh "${AGENT_SERVER}" &'));
    assert.ok(STARTUP.includes('/code/scripts/service-probe-loop.mjs'));
});

// Ploinky itself must resolve the manifest to the script protocol; only then do
// the no-wait activation and the managed restart run readiness.sh as their gate.
test('Ploinky resolves this manifest to the script readiness protocol', async (t) => {
    const ploinkyDir = String(process.env.OPENCODE_FREE_PLOINKY_DIR || '').trim();
    if (!ploinkyDir) return t.skip('set OPENCODE_FREE_PLOINKY_DIR to a Ploinky checkout');
    const module = await import(pathToFileURL(path.join(ploinkyDir, 'cli/utils/runtime/startupReadiness.js')).href);
    assert.equal(module.resolveAgentReadinessProtocol(MANIFEST), 'script');
    assert.equal(module.resolveManifestReadinessWaitOptions(MANIFEST).timeoutMs, 960000);
});

test('readiness.sh checks the chat agent and the source contract without the key', () => {
    assert.ok(READINESS.includes('debug agent chat --pure'));
    assert.ok(READINESS.includes('source.contract'));
    assert.ok(!READINESS.includes('OPENCODE_API_KEY'));
});
