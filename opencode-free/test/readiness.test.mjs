// readiness.sh checks local facts only: AgentServer health on the port Ploinky
// gave the container, the CLI against the source contract, an immutable
// configuration directory, and the confined chat agent the CLI resolves.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeFakeCli } from './helpers/fake-cli.mjs';

const READINESS = fileURLToPath(new URL('../readiness.sh', import.meta.url));
// `sha256sum` runs outside the script's `env -i`, so the inherited PATH keeps
// the host's own directories next to the one holding node.
const HOST_PATH = [path.dirname(process.execPath), process.env.PATH || '', '/usr/bin', '/bin', '/sbin']
    .filter(Boolean)
    .join(':');

// contract: match | mismatch | no-sha-line.
// config: readonly | writable (directory) | file-writable (file only) | no-file.
function fixture(t, { mode = 'debug-agent-ok', contract = 'match', config = 'readonly' } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocf-readiness-'));
    const cli = makeFakeCli({ mode });
    const configDir = path.join(dir, 'config');
    const opencodeDir = path.join(configDir, 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    if (config !== 'no-file') {
        const configFile = path.join(opencodeDir, 'opencode.json');
        fs.writeFileSync(configFile, '{}\n', { mode: 0o444 });
        // The write mode is umasked and applies only on create, so set it explicitly.
        fs.chmodSync(configFile, config === 'file-writable' ? 0o644 : 0o444);
    }
    fs.chmodSync(opencodeDir, config === 'writable' ? 0o755 : 0o555);
    t.after(() => {
        fs.chmodSync(opencodeDir, 0o755);
        fs.rmSync(dir, { recursive: true, force: true });
        cli.cleanup();
    });
    const contractPath = path.join(dir, 'source.contract');
    const sha = crypto.createHash('sha256').update(fs.readFileSync(cli.cliPath)).digest('hex');
    const contracts = {
        match: `source=fake\nbinary_sha256=${sha}\n`,
        mismatch: `source=fake\nbinary_sha256=${'0'.repeat(64)}\n`,
        'no-sha-line': 'source=fake\nversion=1.18.31\n',
    };
    fs.writeFileSync(contractPath, contracts[contract]);
    return { dir, cli, configDir, contractPath, runtimeDir: path.join(dir, 'runtime') };
}

async function startHealth(t, payload) {
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return {
        port: server.address().port,
        stop: () => new Promise((resolve) => server.close(resolve)),
    };
}

function envFor(fx, port, extra = {}) {
    return {
        PATH: HOST_PATH,
        PORT: String(port),
        OPENCODE_FREE_CLI_PATH: fx.cli.cliPath,
        OPENCODE_FREE_CONFIG_DIR: fx.configDir,
        OPENCODE_FREE_SOURCE_CONTRACT: fx.contractPath,
        OPENCODE_FREE_RUNTIME_DIR: fx.runtimeDir,
        // macOS has no `timeout` on the image's inner PATH; the wrapper itself
        // is covered by the shim case below.
        OPENCODE_FREE_ALLOW_NO_TIMEOUT: '1',
        ...extra,
    };
}

function runReadiness(env) {
    return new Promise((resolve) => {
        const child = spawn('sh', [READINESS], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
}

function readinessEntries(runtimeDir) {
    const dir = path.join(runtimeDir, 'readiness');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

test('the good shape is ready and leaves no throwaway root behind', async (t) => {
    const fx = fixture(t);
    const health = await startHealth(t, { ok: true });
    const result = await runReadiness(envFor(fx, health.port));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readinessEntries(fx.runtimeDir), []);
});

test('the health check follows PORT rather than a hard-coded 7000', async (t) => {
    const fx = fixture(t);
    const health = await startHealth(t, { ok: true });
    const result = await runReadiness(envFor(fx, health.port, { PORT: String(health.port + 1) }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /AgentServer health failed/);
});

test('the timeout wrapper runs the CLI when the binary resolves', async (t) => {
    const fx = fixture(t);
    const health = await startHealth(t, { ok: true });
    const marker = path.join(fx.dir, 'timeout-used');
    const shim = path.join(fx.dir, 'fake-timeout');
    fs.writeFileSync(shim, `#!/bin/sh\necho "$1" > '${marker}'\nshift\nexec "$@"\n`, { mode: 0o755 });
    const result = await runReadiness(envFor(fx, health.port, {
        OPENCODE_FREE_TIMEOUT_BIN: shim,
        OPENCODE_FREE_ALLOW_NO_TIMEOUT: '0',
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), '10');
});

test('a missing timeout binary is not ready unless the caller allows it', async (t) => {
    const fx = fixture(t);
    const health = await startHealth(t, { ok: true });
    const result = await runReadiness(envFor(fx, health.port, {
        OPENCODE_FREE_TIMEOUT_BIN: 'no-such-timeout-binary',
        OPENCODE_FREE_ALLOW_NO_TIMEOUT: '0',
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no-such-timeout-binary is not available/);
});

test('a health endpoint that is down is not ready', async (t) => {
    const fx = fixture(t);
    const health = await startHealth(t, { ok: true });
    await health.stop();
    const result = await runReadiness(envFor(fx, health.port));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /AgentServer health failed/);
});

test('a health payload without ok: true is not ready', async (t) => {
    const fx = fixture(t);
    const health = await startHealth(t, { ok: false });
    const result = await runReadiness(envFor(fx, health.port));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unexpected payload/);
});

test('a writable configuration directory is not ready', async (t) => {
    const fx = fixture(t, { config: 'writable' });
    const health = await startHealth(t, { ok: true });
    const result = await runReadiness(envFor(fx, health.port));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /configuration directory is writable/);
});

test('a writable configuration file inside a read-only directory is not ready', async (t) => {
    const fx = fixture(t, { config: 'file-writable' });
    const health = await startHealth(t, { ok: true });
    const result = await runReadiness(envFor(fx, health.port));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /configuration file is writable/);
    assert.doesNotMatch(result.stderr, /configuration directory is writable/);
});

test('a missing configuration file is not ready', async (t) => {
    const fx = fixture(t, { config: 'no-file' });
    const health = await startHealth(t, { ok: true });
    const result = await runReadiness(envFor(fx, health.port));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /baked configuration is missing/);
});

test('a CLI that does not match the source contract is not ready', async (t) => {
    const fx = fixture(t, { contract: 'mismatch' });
    const health = await startHealth(t, { ok: true });
    const result = await runReadiness(envFor(fx, health.port));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /sha256 differs/);
});

test('a source contract without binary_sha256 is not ready', async (t) => {
    const fx = fixture(t, { contract: 'no-sha-line' });
    const health = await startHealth(t, { ok: true });
    const result = await runReadiness(envFor(fx, health.port));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /binary_sha256 missing/);
});

test('a wildcard rule that allows instead of asking is not ready', async (t) => {
    const fx = fixture(t, { mode: 'debug-agent-wrong-order' });
    const health = await startHealth(t, { ok: true });
    const result = await runReadiness(envFor(fx, health.port));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /does not resolve the confined chat agent/);
    assert.deepEqual(readinessEntries(fx.runtimeDir), []);
});

// Each fake keeps the good wildcard order and breaks exactly one other
// property of the resolved chat agent.
for (const [mode, description] of [
    ['debug-agent-missing-tool', 'a resolved agent missing one of the 13 tools'],
    ['debug-agent-extra-tool', 'a resolved agent with an extra tool enabled'],
    ['debug-agent-wrong-name', 'a resolved agent whose name is not chat'],
    ['debug-agent-wrong-pattern', 'a last wildcard rule whose pattern is not *'],
    ['debug-agent-rule-after-wildcard', 'a rule other than external_directory after the last wildcard rule'],
]) {
    test(`${description} is not ready`, async (t) => {
        const fx = fixture(t, { mode });
        const health = await startHealth(t, { ok: true });
        const result = await runReadiness(envFor(fx, health.port));
        assert.equal(result.code, 1);
        assert.match(result.stderr, /does not resolve the confined chat agent/);
        assert.deepEqual(readinessEntries(fx.runtimeDir), []);
    });
}

test('sh accepts the script', () => {
    assert.equal(spawnSync('sh', ['-n', READINESS]).status, 0);
});
