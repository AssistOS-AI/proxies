#!/bin/sh
set -eu

# Local facts only: this script never contacts OpenCode's service and never
# reads the key. Whether the service answers is the service state's concern.
CLI="${OPENCODE_FREE_CLI_PATH:-/opt/opencode/bin/opencode}"
CONFIG_DIR="${OPENCODE_FREE_CONFIG_DIR:-/opt/opencode-free/config}"
SOURCE_CONTRACT="${OPENCODE_FREE_SOURCE_CONTRACT:-/opt/opencode-free/source.contract}"
RUNTIME_DIR="${OPENCODE_FREE_RUNTIME_DIR:-/var/tmp/opencode-free}"

fail() {
    echo "opencode-free is not ready: $*" >&2
    exit 1
}

node --input-type=module <<'NODE' || exit 1
try {
    const response = await fetch('http://127.0.0.1:7000/health', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.ok !== true) throw new Error(`unexpected payload ${JSON.stringify(payload).slice(0, 500)}`);
} catch (error) {
    console.error(`opencode-free is not ready: AgentServer health failed: ${error?.message || error}`);
    process.exit(1);
}
NODE

[ -x "${CLI}" ] || fail "CLI ${CLI} is not executable"
expected_sha="$(sed -n 's/^binary_sha256=//p' "${SOURCE_CONTRACT}" 2>/dev/null || true)"
[ -n "${expected_sha}" ] || fail "binary_sha256 missing from ${SOURCE_CONTRACT}"
actual_sha="$(sha256sum "${CLI}" | cut -c1-64)"
[ "${actual_sha}" = "${expected_sha}" ] || fail "CLI sha256 differs from ${SOURCE_CONTRACT}"

[ -f "${CONFIG_DIR}/opencode/opencode.json" ] || fail "baked configuration is missing"
[ ! -w "${CONFIG_DIR}/opencode" ] || fail "configuration directory is writable"
[ ! -w "${CONFIG_DIR}/opencode/opencode.json" ] || fail "configuration file is writable"

root="${RUNTIME_DIR}/readiness/$$"
rm -rf "${root}"
mkdir -p "${root}/home" "${root}/data" "${root}/state" "${root}/cache" "${root}/tmp" "${root}/work"
trap 'rm -rf "${root}"' EXIT INT TERM

status=0
(
    cd "${root}/work"
    exec env -i \
        PATH=/usr/bin:/bin \
        HOME="${root}/home" \
        XDG_CONFIG_HOME="${CONFIG_DIR}" \
        XDG_DATA_HOME="${root}/data" \
        XDG_STATE_HOME="${root}/state" \
        XDG_CACHE_HOME="${root}/cache" \
        TMPDIR="${root}/tmp" \
        LANG=C.UTF-8 NO_COLOR=1 TERM=dumb \
        OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_CLAUDE_CODE=1 \
        OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1 \
        OPENCODE_DISABLE_LSP_DOWNLOAD=1 OPENCODE_DISABLE_SHARE=1 \
        OPENCODE_DISABLE_TERMINAL_TITLE=1 \
        timeout 10 "${CLI}" debug agent chat --pure
) > "${root}/agent.json" 2> "${root}/agent.err" || status=$?
[ "${status}" -eq 0 ] || fail "debug agent chat exited ${status}"

# The CLI appends its own external_directory rules after the configured ones,
# so the check reads the last wildcard rule rather than the last rule.
node --input-type=module - "${root}/agent.json" <<'NODE' || fail "debug agent chat does not resolve the confined chat agent"
import fs from 'node:fs';

const TOOLS = 'bash,edit,glob,grep,invalid,question,read,skill,task,todowrite,webfetch,websearch,write';
const agent = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const tools = Object.entries(agent.tools || {}).filter(([, enabled]) => enabled === true).map(([name]) => name).sort().join(',');
const rules = Array.isArray(agent.permission) ? agent.permission : [];
const index = rules.findLastIndex((rule) => rule?.permission === '*');
const last = rules[index];
const ok = agent.name === 'chat'
    && tools === TOOLS
    && index >= 0
    && last.action === 'ask'
    && last.pattern === '*'
    && rules.slice(index + 1).every((rule) => rule?.permission === 'external_directory');
process.exit(ok ? 0 : 1);
NODE
