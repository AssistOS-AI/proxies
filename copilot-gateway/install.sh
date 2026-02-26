#!/bin/bash
set -e

APP_DIR="/app"

mkdir -p "$APP_DIR"
cd "$APP_DIR"

# Install copilot-api
echo "Installing copilot-api..."
bun add copilot-api@latest

# Create persistent storage for GitHub tokens
# /shared is mounted from the workspace and survives container restarts
mkdir -p /shared/copilot-api/data
mkdir -p /root/.local/share

# Symlink copilot-api's data directory to persistent storage
if [ ! -L "/root/.local/share/copilot-api" ]; then
    rm -rf /root/.local/share/copilot-api 2>/dev/null || true
    ln -sf /shared/copilot-api/data /root/.local/share/copilot-api
fi

echo ""
echo "================================================"
echo "  Copilot API Gateway - Installation Complete"
echo "================================================"
echo "  The proxy will start on port ${PORT:-4141}"
echo ""
echo "  Authentication:"
echo "    Option 1: Set COPILOT_GITHUB_TOKEN in ploinky secrets"
echo "    Option 2: Run 'ploinky cli copilot-gateway auth'"
echo "              to complete GitHub OAuth flow"
echo ""
echo "  Endpoints:"
echo "    POST /v1/chat/completions  (OpenAI-compatible)"
echo "    POST /v1/messages          (Anthropic-compatible)"
echo "    GET  /v1/models            (model listing)"
echo "================================================"
