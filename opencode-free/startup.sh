#!/usr/bin/env bash
set -euo pipefail

RUNTIME_DIR="${OPENCODE_FREE_RUNTIME_DIR:-/var/tmp/opencode-free}"
AGENT_SERVER="${OPENCODE_FREE_AGENT_SERVER:-/Agent/server/AgentServer.sh}"
PROBE_LOOP="${OPENCODE_FREE_PROBE_LOOP:-/code/scripts/service-probe-loop.mjs}"

mkdir -p "${RUNTIME_DIR}/runs" "${RUNTIME_DIR}/slots" "${RUNTIME_DIR}/readiness"
chmod 0700 "${RUNTIME_DIR}" "${RUNTIME_DIR}/runs" "${RUNTIME_DIR}/slots" "${RUNTIME_DIR}/readiness" 2>/dev/null || true

terminating=0

stop_children() {
    if [ -n "${probe_pid:-}" ]; then
        kill -TERM "${probe_pid}" 2>/dev/null || true
    fi
    if [ -n "${agent_server_pid:-}" ]; then
        kill -TERM "${agent_server_pid}" 2>/dev/null || true
    fi
}

# A requested stop (Ploinky's managed drain sends TERM) ends with the
# AgentServer's own exit status, because the drain accepts only exit code 0.
on_stop() {
    terminating=1
    stop_children
}
trap on_stop INT TERM

# Ploinky publishes the implicit AgentServer port from the profile `PORT`, so
# the container keeps whatever it was given and only defaults to 7000.
export PORT="${PORT:-7000}"
sh "${AGENT_SERVER}" &
agent_server_pid="$!"

node "${PROBE_LOOP}" &
probe_pid="$!"

# The service probe loop owns the service state; without it the state would
# stay frozen, so the container stops and Ploinky restarts it.
while [ "${terminating}" = "0" ] && kill -0 "${agent_server_pid}" 2>/dev/null; do
    if ! kill -0 "${probe_pid}" 2>/dev/null; then
        echo "ERROR: the OpenCode service probe loop exited." >&2
        break
    fi
    sleep 1
done

stop_children
# A trapped signal interrupts `wait` with 128+n; keep waiting until the
# AgentServer is really gone so its own exit status is the one reported.
agent_status=0
while :; do
    status=0
    wait "${agent_server_pid}" 2>/dev/null || status=$?
    if ! kill -0 "${agent_server_pid}" 2>/dev/null; then
        agent_status="${status}"
        break
    fi
done
wait "${probe_pid}" 2>/dev/null || true

if [ "${terminating}" = "1" ]; then
    exit "${agent_status}"
fi
exit 1
