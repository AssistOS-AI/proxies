#!/usr/bin/env sh
set -eu

SEARXNG_BIND="127.0.0.1"
SEARXNG_PORT="8888"
SEARXNG_SETTINGS_PATH="/etc/searxng/settings.yml"
SEARXNG_VENV="/usr/local/searxng/searx-pyenv"
SEARXNG_APP_DIR="/usr/local/searxng/searxng-src"

if [ ! -f "${SEARXNG_SETTINGS_PATH}" ]; then
    echo "ERROR: ${SEARXNG_SETTINGS_PATH} is missing. Run the SearchAgent install hook." >&2
    exit 1
fi

if [ ! -x "${SEARXNG_VENV}/bin/python" ]; then
    echo "ERROR: ${SEARXNG_VENV}/bin/python is missing. Run the SearchAgent install hook." >&2
    exit 1
fi

cleanup() {
    if [ -n "${agent_server_pid:-}" ]; then
        kill "${agent_server_pid}" 2>/dev/null || true
    fi
    if [ -n "${searxng_pid:-}" ]; then
        kill "${searxng_pid}" 2>/dev/null || true
    fi
}
trap cleanup INT TERM EXIT

export SEARXNG_SETTINGS_PATH

cd "${SEARXNG_APP_DIR}"
"${SEARXNG_VENV}/bin/python" -m searx.webapp &
searxng_pid="$!"

ready=0
for _ in $(seq 1 60); do
    if curl -fsS -H 'accept: application/json' "http://${SEARXNG_BIND}:${SEARXNG_PORT}/search?q=ploinky&format=json" >/dev/null 2>&1; then
        ready=1
        break
    fi
    if ! kill -0 "${searxng_pid}" 2>/dev/null; then
        echo "ERROR: SearXNG exited before becoming ready." >&2
        wait "${searxng_pid}" || true
        exit 1
    fi
    sleep 1
done

if [ "${ready}" != "1" ]; then
    echo "ERROR: timed out waiting for SearXNG on ${SEARXNG_BIND}:${SEARXNG_PORT}." >&2
    exit 1
fi

export PORT="${PLOINKY_AGENT_SERVER_PORT:-7000}"
sh /Agent/server/AgentServer.sh &
agent_server_pid="$!"

while kill -0 "${searxng_pid}" 2>/dev/null && kill -0 "${agent_server_pid}" 2>/dev/null; do
    sleep 1
done

cleanup
wait "${agent_server_pid}" 2>/dev/null || true
wait "${searxng_pid}" 2>/dev/null || true
