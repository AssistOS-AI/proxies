#!/bin/bash

APP_DIR="/app"
export PORT="${PORT:-8001}"

echo -e "\033[1;33mStarting Antigravity Claude Proxy on port $PORT...\033[0m"

cd "$APP_DIR"

# Ensure data directories exist
mkdir -p /data/accounts
mkdir -p /data/config
mkdir -p /root/.config/antigravity-proxy

# Ensure accounts.json symlink exists
if [ ! -L "/root/.config/antigravity-proxy/accounts.json" ]; then
    rm -f /root/.config/antigravity-proxy/accounts.json 2>/dev/null || true
    touch /data/accounts/accounts.json
    ln -sf /data/accounts/accounts.json /root/.config/antigravity-proxy/accounts.json
fi

# Create symlink for persistent data if not exists
if [ ! -L "$APP_DIR/data" ]; then
    rm -rf "$APP_DIR/data" 2>/dev/null || true
    ln -sf /data "$APP_DIR/data"
fi

# Log OAuth configuration
if [ -n "$OAUTH_REDIRECT_URI" ]; then
    echo -e "\033[0;36mOAuth Redirect URI: $OAUTH_REDIRECT_URI\033[0m"
fi

echo -e "\033[0;32mWeb Dashboard available at configured URL\033[0m"
echo ""

# Start the proxy server
exec node src/index.js
