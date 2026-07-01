#!/usr/bin/env bash
set -euo pipefail

MODEL_PATH="${LLAMA_MODEL_PATH:-/opt/models/Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf}"
LLAMA_PORT="${LLAMA_SERVER_PORT:-8080}"
LLAMA_BIN="${LLAMA_SERVER_BIN:-llama-server}"
CTX="${LLAMA_CTX_SIZE:-4096}"

if [[ ! -f "$MODEL_PATH" ]]; then
    echo "[default-local-llm] model file missing: $MODEL_PATH" >&2
    exit 1
fi

llama_pid=""
cleanup() { [[ -n "$llama_pid" ]] && kill "$llama_pid" 2>/dev/null || true; }
trap cleanup INT TERM EXIT

threads_arg=()
[[ -n "${LLAMA_THREADS:-}" ]] && threads_arg=(--threads "$LLAMA_THREADS")

LLAMA_LOG="${LLAMA_LOG:-/tmp/llama-server.log}"
"$LLAMA_BIN" --model "$MODEL_PATH" --host 127.0.0.1 --port "$LLAMA_PORT" \
    --ctx-size "$CTX" "${threads_arg[@]}" >"$LLAMA_LOG" 2>&1 &
llama_pid="$!"

echo "[default-local-llm] waiting for llama-server on 127.0.0.1:${LLAMA_PORT}..."
for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:${LLAMA_PORT}/health" >/dev/null 2>&1; then
        echo "[default-local-llm] llama-server ready."
        break
    fi
    if ! kill -0 "$llama_pid" 2>/dev/null; then
        echo "[default-local-llm] llama-server exited during startup" >&2
        echo "[default-local-llm] --- llama-server log tail ---" >&2
        tail -n 40 "$LLAMA_LOG" >&2 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

echo "[default-local-llm] starting AgentServer..."
exec bash "${PLOINKY_AGENT_LIB_DIR:-/Agent}/server/AgentServer.sh"
