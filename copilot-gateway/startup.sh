#!/bin/bash

export PORT="${PORT:-4141}"

# Ensure persistent storage symlink exists
mkdir -p /shared/copilot-api/data
mkdir -p /root/.local/share
if [ ! -L "/root/.local/share/copilot-api" ]; then
    rm -rf /root/.local/share/copilot-api 2>/dev/null || true
    ln -sf /shared/copilot-api/data /root/.local/share/copilot-api
fi

echo "Starting Copilot API Gateway on port $PORT..."

# Build args
ARGS="start --port $PORT"

if [ "$COPILOT_VERBOSE" = "true" ]; then
    ARGS="$ARGS --verbose"
fi

if [ -n "$COPILOT_ACCOUNT_TYPE" ]; then
    ARGS="$ARGS --account-type $COPILOT_ACCOUNT_TYPE"
fi

if [ -n "$GITHUB_TOKEN" ]; then
    ARGS="$ARGS --github-token $GITHUB_TOKEN"
fi

cd /app
exec bunx copilot-api@latest $ARGS
