#!/bin/bash
set -e

APP_DIR="/app"
CODE_DIR="/code"
SHARED_DIR="/shared/copilot-gateway"

echo "============================================"
echo "  Copilot Gateway - Installation"
echo "============================================"
echo ""

# Create persistent storage
mkdir -p "$SHARED_DIR/data"

# Copy application code
mkdir -p "$APP_DIR"
if [ -d "$CODE_DIR/app" ]; then
    cp -r "$CODE_DIR/app/"* "$APP_DIR/" 2>/dev/null || true
    echo "Application code copied to $APP_DIR"
fi

# Migrate tokens from old copilot-api gateway (if upgrading)
OLD_TOKEN="/shared/copilot-api/data/github_token"
NEW_TOKEN="$SHARED_DIR/data/github_token"
if [ -f "$OLD_TOKEN" ] && [ ! -f "$NEW_TOKEN" ]; then
    cp "$OLD_TOKEN" "$NEW_TOKEN"
    echo "Migrated GitHub token from previous copilot-api gateway"
fi

echo ""
echo "============================================"
echo "  Installation Complete"
echo "============================================"
echo "  The gateway will start on port ${PORT:-4141}"
echo ""
echo "  Authentication:"
echo "    Option 1: Set COPILOT_GITHUB_TOKEN in ploinky secrets"
echo "    Option 2: Run 'ploinky cli copilot-gateway auth'"
echo "              to complete GitHub OAuth device flow"
echo ""
echo "  Endpoints:"
echo "    POST /v1/chat/completions  (auto-routes to completions or responses)"
echo "    POST /v1/responses         (direct Responses API passthrough)"
echo "    GET  /v1/models            (model listing)"
echo "    GET  /health               (health check)"
echo "============================================"
