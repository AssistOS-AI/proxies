#!/usr/bin/env bash
set -euo pipefail

MODEL_PATH="${LLAMA_MODEL_PATH:-/opt/models/qwen2.5-1.5b-instruct-q4_k_m.gguf}"
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

"$LLAMA_BIN" --model "$MODEL_PATH" --host 127.0.0.1 --port "$LLAMA_PORT" \
    --ctx-size "$CTX" "${threads_arg[@]}" >/dev/null 2>&1 &
llama_pid="$!"

echo "[default-local-llm] waiting for llama-server on 127.0.0.1:${LLAMA_PORT}..."
for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:${LLAMA_PORT}/health" >/dev/null 2>&1; then
        echo "[default-local-llm] llama-server ready."
        break
    fi
    if ! kill -0 "$llama_pid" 2>/dev/null; then
        echo "[default-local-llm] llama-server exited during startup" >&2
        exit 1
    fi
    sleep 1
done

echo "[default-local-llm] starting AgentServer..."
exec bash "${PLOINKY_AGENT_LIB_DIR:-/Agent}/server/AgentServer.sh"
