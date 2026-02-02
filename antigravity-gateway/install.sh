#!/bin/bash
set -e

APP_DIR="/app"
REPO_URL="https://github.com/AssistOS-AI/antigravity-claude-proxy.git"

# Clone antigravity-claude-proxy if not exists, or pull latest
if [ ! -d "$APP_DIR" ]; then
    echo "Cloning antigravity-claude-proxy from forked repo..."
    git clone "$REPO_URL" "$APP_DIR"
else
    echo "Updating antigravity-claude-proxy..."
    cd "$APP_DIR"
    git pull origin main || true
fi

cd "$APP_DIR"

# Install dependencies
echo "Installing dependencies..."
npm install

# Create data directory for persistent storage
# Use /shared (mounted from workspace/shared) so credentials survive container restarts
mkdir -p /shared/antigravity/accounts
mkdir -p /shared/antigravity/config

# Create the .config directory structure for accounts.json
mkdir -p /root/.config/antigravity-proxy

# Link accounts config to persistent storage
if [ ! -L "/root/.config/antigravity-proxy/accounts.json" ]; then
    rm -f /root/.config/antigravity-proxy/accounts.json 2>/dev/null || true
    touch /shared/antigravity/accounts/accounts.json
    ln -sf /shared/antigravity/accounts/accounts.json /root/.config/antigravity-proxy/accounts.json
fi

echo ""
echo "================================================"
echo "  Installation Complete"
echo "================================================"
echo "  The proxy will start on port ${PORT:-8001}"
echo "  Web Dashboard: https://antigravity.axiologic.dev"
echo ""
echo "  To add an account (Manual Authorization):"
echo "    1. Open the Web Dashboard"
echo "    2. Click 'Add Account'"
echo "    3. Complete Google sign-in"
echo "    4. Copy the failed localhost URL"
echo "    5. Paste it back in the dashboard"
echo "================================================"
