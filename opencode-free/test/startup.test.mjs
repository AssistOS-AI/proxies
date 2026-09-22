// startup.sh exit status: Ploinky's managed drain sends TERM and accepts only
// exit code 0, while an unexpected child exit must stop the container with 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const STARTUP = fileURLToPath(new URL('../startup.sh', import.meta.url));

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// agentServerOnTerm: exit code the fake AgentServer uses on TERM.
// agentServerExitAfterMs / probeExitAfterMs: make a child die on its own.
function setup(t, { agentServerOnTerm = 0, agentServerExitAfterMs = 0, probeExitAfterMs = 0 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-startup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const pids = path.join(dir, 'pids');
    fs.mkdirSync(pids);
    const agentServer = path.join(dir, 'AgentServer.sh');
    const selfExit = agentServerExitAfterMs ? `sleep ${agentServerExitAfterMs / 1000}; exit 3` : 'while :; do sleep 0.1; done';
    fs.writeFileSync(agentServer, [
        '#!/bin/sh',
        `echo $$ > '${pids}/agent-server'`,
        `trap 'exit ${agentServerOnTerm}' TERM INT`,
        selfExit,
        '',
    ].join('\n'));
    const probe = path.join(dir, 'probe.mjs');
    fs.writeFileSync(probe, [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(path.join(pids, 'probe'))}, String(process.pid));`,
        "process.on('SIGTERM', () => process.exit(0));",
        probeExitAfterMs ? `setTimeout(() => process.exit(1), ${probeExitAfterMs});` : 'setInterval(() => {}, 1000);',
        '',
    ].join('\n'));
    const child = spawn('bash', [STARTUP], {
        env: {
            PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
            OPENCODE_FREE_RUNTIME_DIR: path.join(dir, 'runtime'),
            OPENCODE_FREE_AGENT_SERVER: agentServer,
            OPENCODE_FREE_PROBE_LOOP: probe,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal, stderr })));
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const childPids = async () => {
        for (let i = 0; i < 100; i += 1) {
            const files = ['agent-server', 'probe'].map((name) => path.join(pids, name));
            if (files.every((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim())) {
                return files.map((file) => Number(fs.readFileSync(file, 'utf8').trim()));
            }
            await sleep(50);
        }
        throw new Error('children did not start');
    };
    return { child, exited, childPids, dir };
}

test('a requested stop (TERM) exits 0 when AgentServer shuts down cleanly', async (t) => {
    const { child, exited, childPids, dir } = setup(t);
    const pids = await childPids();
    child.kill('SIGTERM');
    const result = await exited;
    assert.equal(result.code, 0, `exit ${result.code} signal ${result.signal}: ${result.stderr}`);
    await sleep(200);
    assert.deepEqual(pids.filter(alive), [], 'both children are gone');
    assert.ok(fs.existsSync(path.join(dir, 'runtime', 'runs')));
});

test('a requested stop (INT) exits 0 as well', async (t) => {
    const { child, exited, childPids } = setup(t);
    await childPids();
    child.kill('SIGINT');
    assert.equal((await exited).code, 0);
});

test('a requested stop reports an AgentServer that did not shut down cleanly', async (t) => {
    const { child, exited, childPids } = setup(t, { agentServerOnTerm: 5 });
    await childPids();
    child.kill('SIGTERM');
    assert.equal((await exited).code, 5);
});

test('AgentServer exiting on its own stops the container with 1', async (t) => {
    const { exited, childPids } = setup(t, { agentServerExitAfterMs: 500 });
    const [, probePid] = await childPids();
    const result = await exited;
    assert.equal(result.code, 1);
    await sleep(200);
    assert.equal(alive(probePid), false, 'the probe loop was stopped');
});

test('the probe loop exiting stops the container with 1', async (t) => {
    const { exited, childPids } = setup(t, { probeExitAfterMs: 500 });
    const [agentPid] = await childPids();
    const result = await exited;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /probe loop exited/);
    await sleep(200);
    assert.equal(alive(agentPid), false, 'AgentServer was stopped');
});

test('bash accepts the script', () => {
    assert.equal(spawnSync('bash', ['-n', STARTUP]).status, 0);
});
