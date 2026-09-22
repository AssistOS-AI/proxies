#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="${OPENCODE_FREE_RUNTIME_DIR:-/var/tmp/opencode-free}"

mkdir -p "${RUNTIME_DIR}/runs" "${RUNTIME_DIR}/slots" "${RUNTIME_DIR}/readiness"
chmod 0700 "${RUNTIME_DIR}" "${RUNTIME_DIR}/runs" "${RUNTIME_DIR}/slots" "${RUNTIME_DIR}/readiness" 2>/dev/null || true

cleanup() {
    if [ -n "${probe_pid:-}" ]; then
        kill -TERM "${probe_pid}" 2>/dev/null || true
    fi
    if [ -n "${agent_server_pid:-}" ]; then
        kill -TERM "${agent_server_pid}" 2>/dev/null || true
    fi
}
trap cleanup INT TERM EXIT

export PORT="${PLOINKY_AGENT_SERVER_PORT:-7000}"
sh /Agent/server/AgentServer.sh &
agent_server_pid="$!"

node /code/scripts/service-probe-loop.mjs &
probe_pid="$!"

# The service probe loop owns the service state; without it the state would
# stay frozen, so the container stops and Ploinky restarts it.
while kill -0 "${agent_server_pid}" 2>/dev/null; do
    if ! kill -0 "${probe_pid}" 2>/dev/null; then
        echo "ERROR: the OpenCode service probe loop exited." >&2
        break
    fi
    sleep 1
done

cleanup
wait "${agent_server_pid}" 2>/dev/null || true
wait "${probe_pid}" 2>/dev/null || true
exit 1
