#!/bin/sh
set -eu

# Allow-list maintenance (DS004): lists the models the official CLI reports for
# the key, in a throwaway root, and prints model ids only. It makes one live
# listing request through the CLI; run it on every CLI version bump and compare
# the output with lib/allow-list.mjs.
AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${OPENCODE_FREE_CLI_PATH:-/opt/opencode/bin/opencode}"
CONFIG_DIR="${OPENCODE_FREE_CONFIG_DIR:-/opt/opencode-free/config}"
root="$(mktemp -d "${TMPDIR:-/tmp}/opencode-free-survey.XXXXXX")"
trap 'rm -rf "${root}"' EXIT INT TERM
mkdir -p "${root}/home" "${root}/data" "${root}/state" "${root}/cache" "${root}/tmp" "${root}/work"

node --input-type=module - "${AGENT_DIR}" "${CLI}" "${CONFIG_DIR}" "${root}" <<'NODE'
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [agentDir, cli, configDir, root] = process.argv.slice(2);
const { resolveOpencodeApiKey } = await import(pathToFileURL(path.join(agentDir, 'lib/credential.mjs')).href);
const { buildChildEnv } = await import(pathToFileURL(path.join(agentDir, 'lib/cli-runner.mjs')).href);
const env = buildChildEnv({ root, configDir, apiKey: resolveOpencodeApiKey(process.env) });
const result = spawnSync(cli, ['models', 'opencode', '--refresh', '--pure'], {
    cwd: path.join(root, 'work'),
    env,
    encoding: 'utf8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
});
if (result.status !== 0) {
    console.error(`opencode models exited with ${result.status ?? result.signal}`);
    process.exit(1);
}
const ids = result.stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^opencode\/[A-Za-z0-9._-]+$/.test(line))
    .map((line) => line.slice('opencode/'.length));
process.stdout.write(`${ids.join('\n')}\n`);
NODE
