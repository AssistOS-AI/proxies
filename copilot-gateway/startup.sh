#!/bin/bash
set -e

APP_DIR="/app"
CODE_DIR="/code"
SHARED_DIR="/shared/copilot-gateway"

export PORT="${PORT:-4141}"

# Ensure persistent storage
mkdir -p "$SHARED_DIR/data"

# Update application code (hot-reload on restart)
if [ -d "$CODE_DIR/app" ]; then
    mkdir -p "$APP_DIR"
    cp -r "$CODE_DIR/app/"* "$APP_DIR/" 2>/dev/null || true
fi

# Write env token to file if set (allows ploinky secret to override stored token)
if [ -n "$COPILOT_GITHUB_TOKEN" ]; then
    echo -n "$COPILOT_GITHUB_TOKEN" > "$SHARED_DIR/data/github_token"
fi

echo "Starting Copilot Gateway on port $PORT..."

cd "$APP_DIR"
exec node src/index.mjs
