// Starts the real Ploinky AgentServer against a temporary manifest whose
// OpenAI endpoints run this agent's real handlers. Mirrors the pattern of
// ploinky/tests/unit/agentServerOpenAiHandlerFailure.test.mjs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultState } from '../../lib/service-state.mjs';
import { makeFakeCli } from './fake-cli.mjs';

export const AGENT_DIR = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
export const CHAT_HANDLER = path.join(AGENT_DIR, 'openai-api', 'chat-completions.mjs');
export const MODELS_HANDLER = path.join(AGENT_DIR, 'openai-api', 'models.mjs');
export const TEST_KEY = 'test-key-not-a-secret';

const PLOINKY_DIR_ENV = 'OPENCODE_FREE_PLOINKY_DIR';

// Returns a skip message when the Ploinky checkout is not configured, and
// throws when it is configured but AgentLib cannot be found (a setup error).
export function agentServerSetup() {
    const ploinkyDir = String(process.env[PLOINKY_DIR_ENV] || '').trim();
    if (!ploinkyDir) {
        return { skip: `set ${PLOINKY_DIR_ENV} to a Ploinky checkout to run the real AgentServer` };
    }
    const serverPath = path.join(ploinkyDir, 'Agent', 'server', 'AgentServer.mjs');
    if (!fs.existsSync(serverPath)) throw new Error(`${serverPath} does not exist`);
    const candidates = [
        String(process.env.PLOINKY_AGENTLIB_DIR || '').trim(),
        path.join(ploinkyDir, 'node_modules', 'achillesAgentLib'),
    ].filter(Boolean);
    const agentLibDir = candidates.find((dir) => fs.existsSync(path.join(dir, 'package.json')));
    if (!agentLibDir) {
        throw new Error(`AgentServer needs PLOINKY_AGENTLIB_DIR (an achillesAgentLib checkout); checked ${candidates.join(', ')}`);
    }
    return { skip: null, serverPath, agentLibDir };
}

// AgentServer starts from an allow-listed environment: nothing Ploinky-,
// Router- or agent-specific leaks in from the shell that runs the tests.
const INHERITED_ENV = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM']);

export function isolatedAgentServerEnv() {
    const env = {};
    for (const name of INHERITED_ENV) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    return env;
}

export function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

export async function waitForHealth(port, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) return true;
        } catch {
            // server not up yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
}

export function sseFrames(text) {
    return text.split('\n\n').map((frame) => frame.trim()).filter(Boolean).map((frame) => frame.replace(/^data: /, ''));
}

export function writeStateFile(file, state, extra = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...defaultState('test fixture'), state, ...extra }, null, 2)}\n`);
}

// Holds every CLI slot with a live, fresh owner (this test process).
export function fillSlots(runtimeDir, cap) {
    const slots = path.join(runtimeDir, 'slots');
    for (let index = 0; index < cap; index += 1) {
        const dir = path.join(slots, `slot-${index}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), requestId: 'test-holder' })}\n`);
    }
}

/**
 * Starts AgentServer with the real handlers (or `chatHandlerPath`) and an
 * isolated agent installation (fake CLI, state file, runtime and config dirs).
 */
export async function startAgentServer(setup, {
    mode = 'replay:stop-big-pickle',
    state = 'verified',
    env = {},
    chatHandlerPath = CHAT_HANDLER,
    chatTimeoutMs = 30000,
    beforeStart = null,
} = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-agentsrv-'));
    const fake = makeFakeCli({ mode });
    const runtimeDir = path.join(dir, 'runtime');
    const configDir = path.join(dir, 'config');
    const stateFile = path.join(dir, 'data', 'service-state.json');
    fs.mkdirSync(configDir, { recursive: true });
    if (state) writeStateFile(stateFile, state);
    const manifest = {
        name: 'opencode-free',
        endpoints: {
            chatCompletions: { command: process.execPath, args: [chatHandlerPath], cwd: AGENT_DIR, timeoutMs: chatTimeoutMs, supportsStream: true },
            models: { command: process.execPath, args: [MODELS_HANDLER], cwd: AGENT_DIR, timeoutMs: 10000 },
        },
    };
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const agent = { dir, fake, runtimeDir, configDir, stateFile };
    if (typeof beforeStart === 'function') beforeStart(agent);
    const port = await getFreePort();
    const child = spawn(process.execPath, [setup.serverPath], {
        cwd: dir,
        env: {
            ...isolatedAgentServerEnv(),
            PORT: String(port),
            PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_ID: 'agent:Workspace/opencode-free',
            PLOINKY_AGENT_MANIFEST: manifestPath,
            PLOINKY_AGENTLIB_DIR: setup.agentLibDir,
            MCP_CONFIG_FILE: '',
            PLOINKY_CODE_DIR: AGENT_DIR,
            OPENCODE_FREE_CLI_PATH: fake.cliPath,
            OPENCODE_FREE_STATE_FILE: stateFile,
            OPENCODE_FREE_RUNTIME_DIR: runtimeDir,
            OPENCODE_FREE_CONFIG_DIR: configDir,
            OPENCODE_FREE_API_KEY: TEST_KEY,
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const logs = [];
    child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
    child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const cleanup = () => {
        fs.rmSync(dir, { recursive: true, force: true });
        fake.cleanup();
    };
    if (!(await waitForHealth(port))) {
        child.kill('SIGKILL');
        await exited;
        cleanup();
        throw new Error(`AgentServer did not become healthy. Logs:\n${logs.join('')}`);
    }
    const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            let timer;
            await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]);
            clearTimeout(timer);
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await exited;
            }
        }
        cleanup();
    };
    return { port, baseUrl: `http://127.0.0.1:${port}`, agent, logs, stop };
}
