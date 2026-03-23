#!/bin/bash
set -e

APP_DIR="/app"
CODE_DIR="/code"
SHARED_DIR="/shared/search-gateway"

echo "=== Search Gateway: Starting ==="

# Ensure directories exist
mkdir -p "$SHARED_DIR/config"

# Copy/update application from code mount
if [ -d "$CODE_DIR/app/src" ]; then
    cp -r "$CODE_DIR/app/"* "$APP_DIR/"
elif [ -n "$WORKSPACE_PATH" ] && [ -d "$WORKSPACE_PATH/.ploinky/repos/proxies/search-gateway/app/src" ]; then
    cp -r "$WORKSPACE_PATH/.ploinky/repos/proxies/search-gateway/app/"* "$APP_DIR/"
fi

# Install deps if needed
if [ -f "$APP_DIR/package.json" ] && [ ! -d "$APP_DIR/node_modules" ]; then
    cd "$APP_DIR"
    npm install --production
fi

# Load encryption key from shared storage if ENCRYPTION_KEY not set
if [ -z "$ENCRYPTION_KEY" ] && [ -f "$SHARED_DIR/config/encryption.key" ]; then
    export ENCRYPTION_KEY=$(cat "$SHARED_DIR/config/encryption.key")
fi

export PORT="${PORT:-8043}"

cd "$APP_DIR"
exec node src/index.mjs
