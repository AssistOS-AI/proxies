import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    FORBIDDEN_CLI_FLAGS,
    KILL_GRACE_MS,
    NON_JSON_LINE_LOG_CHARS,
    RUN_SUBDIRS,
    STDERR_CAPTURE_BYTES,
} from './constants.mjs';

const GROUP_POLL_MS = 50;
const activeRuns = new Set();

export const CHILD_ENV_NAMES = Object.freeze([
    'PATH',
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'TMPDIR',
    'LANG',
    'NO_COLOR',
    'TERM',
    'OPENCODE_DISABLE_PROJECT_CONFIG',
    'OPENCODE_DISABLE_CLAUDE_CODE',
    'OPENCODE_DISABLE_MODELS_FETCH',
    'OPENCODE_DISABLE_AUTOUPDATE',
    'OPENCODE_DISABLE_LSP_DOWNLOAD',
    'OPENCODE_DISABLE_SHARE',
    'OPENCODE_DISABLE_TERMINAL_TITLE',
    'OPENCODE_API_KEY',
]);

export function buildChildEnv({ root, configDir, apiKey }) {
    return {
        PATH: '/usr/bin:/bin',
        HOME: path.join(root, 'home'),
        XDG_CONFIG_HOME: configDir,
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_STATE_HOME: path.join(root, 'state'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        TMPDIR: path.join(root, 'tmp'),
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        TERM: 'dumb',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_CLAUDE_CODE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
        OPENCODE_DISABLE_SHARE: '1',
        OPENCODE_DISABLE_TERMINAL_TITLE: '1',
        OPENCODE_API_KEY: apiKey,
    };
}

export function buildArgv({ model, root }) {
    return [
        'run',
        '--pure',
        '--format',
        'json',
        '-m',
        `opencode/${model}`,
        '--title',
        'chat',
        '--dir',
        path.join(root, 'work'),
        '--agent',
        'chat',
    ];
}

export function assertArgvAllowed(argv) {
    if (!Array.isArray(argv)) throw new Error('argv must be an array');
    for (const token of argv) {
        const flag = String(token).split('=')[0];
        if (FORBIDDEN_CLI_FLAGS.includes(flag)) {
            throw new Error(`forbidden OpenCode CLI flag in argv: ${flag}`);
        }
    }
}

export function killProcessGroup(pid, signal) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(-pid, signal);
        return true;
    } catch (error) {
        if (error?.code === 'ESRCH' || error?.code === 'EPERM') return false;
        throw error;
    }
}

function groupExists(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        return error?.code !== 'ESRCH';
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateGroup(run) {
    if (run.terminating) return run.terminating;
    run.terminating = (async () => {
        killProcessGroup(run.pid, 'SIGTERM');
        const deadline = Date.now() + KILL_GRACE_MS;
        while (Date.now() < deadline && groupExists(run.pid)) {
            await sleep(GROUP_POLL_MS);
        }
        killProcessGroup(run.pid, 'SIGKILL');
    })();
    return run.terminating;
}

function createRunRoot(runtimeDir) {
    const requestId = crypto.randomBytes(16).toString('hex');
    const root = path.join(runtimeDir, 'runs', requestId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of RUN_SUBDIRS) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    return { requestId, root };
}

function removeRoot(root) {
    fs.rmSync(root, { recursive: true, force: true });
    return !fs.existsSync(root);
}

export async function runOpencode({
    model,
    prompt,
    deadlineMs,
    cliPath,
    apiKey,
    runtimeDir,
    configDir,
    onStdoutLine,
    onSpawn,
} = {}) {
    const { requestId, root } = createRunRoot(runtimeDir);
    const run = { root, pid: null, child: null, killed: false, terminating: null, closed: null };
    activeRuns.add(run);
    const events = [];
    let stderr = '';
    let stderrBytes = 0;
    let exitCode = null;
    let signal = null;
    let spawnError = null;
    let deadlineTimer = null;
    let rootRemoved = false;
    try {
        const argv = buildArgv({ model, root });
        assertArgvAllowed(argv);
        const env = buildChildEnv({ root, configDir, apiKey });
        await new Promise((resolve) => {
            let child;
            try {
                child = spawn(cliPath, argv, {
                    cwd: path.join(root, 'work'),
                    env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: true,
                });
            } catch (error) {
                spawnError = error;
                resolve();
                return;
            }
            run.child = child;
            run.pid = Number.isInteger(child.pid) ? child.pid : null;
            run.closed = new Promise((closeResolve) => child.once('close', closeResolve));
            let buffered = '';
            const handleLine = (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                let event;
                try {
                    event = JSON.parse(trimmed);
                } catch {
                    event = null;
                }
                if (!event || typeof event !== 'object' || Array.isArray(event)) {
                    process.stderr.write(`[opencode-free] ignored non-JSON CLI line: ${trimmed.slice(0, NON_JSON_LINE_LOG_CHARS)}\n`);
                    return;
                }
                events.push(event);
                if (typeof onStdoutLine === 'function') onStdoutLine(event, trimmed);
            };
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
                buffered += chunk;
                let index = buffered.indexOf('\n');
                while (index !== -1) {
                    handleLine(buffered.slice(0, index));
                    buffered = buffered.slice(index + 1);
                    index = buffered.indexOf('\n');
                }
            });
            child.stdout.on('end', () => {
                if (buffered) handleLine(buffered);
                buffered = '';
            });
            child.stderr.on('data', (chunk) => {
                if (stderrBytes >= STDERR_CAPTURE_BYTES) return;
                const slice = chunk.subarray(0, STDERR_CAPTURE_BYTES - stderrBytes);
                stderrBytes += slice.length;
                stderr += slice.toString('utf8');
            });
            child.stdin.on('error', () => {});
            child.once('error', (error) => {
                spawnError = error;
                resolve();
            });
            child.once('close', (code, closeSignal) => {
                exitCode = code;
                signal = closeSignal;
                resolve();
            });
            if (run.pid !== null) {
                if (typeof onSpawn === 'function') onSpawn({ pid: run.pid, root, requestId });
                deadlineTimer = setTimeout(() => {
                    run.killed = true;
                    terminateGroup(run);
                }, deadlineMs);
            }
            child.stdin.end(prompt, 'utf8');
        });
        if (run.terminating) await run.terminating;
    } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (run.pid !== null) killProcessGroup(run.pid, 'SIGKILL');
        activeRuns.delete(run);
        rootRemoved = removeRoot(root);
    }
    return {
        events,
        exitCode,
        signal,
        killed: run.killed,
        stderr,
        rootRemoved,
        requestId,
        root,
        pid: run.pid,
        spawnError: spawnError ? String(spawnError.code || spawnError.message || spawnError) : null,
    };
}

export async function abortActiveRuns() {
    const runs = [...activeRuns];
    await Promise.all(runs.map(async (run) => {
        run.killed = true;
        if (run.pid !== null) {
            await terminateGroup(run);
            if (run.closed) {
                await Promise.race([run.closed, sleep(KILL_GRACE_MS)]);
            }
            killProcessGroup(run.pid, 'SIGKILL');
        }
        removeRoot(run.root);
    }));
    return runs.length;
}
