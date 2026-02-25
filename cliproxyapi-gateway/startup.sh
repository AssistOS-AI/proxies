#!/bin/sh
# Startup script for CLIProxyAPI Gateway

# Ensure Go is in PATH
export PATH="$PATH:/usr/local/go/bin"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

APP_DIR="/app"
SHARED_DIR="/shared/cliproxyapi"
BINARY="$APP_DIR/CLIProxyAPI"

echo -e "${YELLOW}Starting CLIProxyAPI Gateway...${NC}"

# Ensure persistent storage symlinks exist
mkdir -p "$SHARED_DIR/auths"
mkdir -p "$SHARED_DIR/logs"
mkdir -p "$SHARED_DIR/config"

# Re-establish auth directory symlink
if [ ! -L "/root/.cli-proxy-api" ]; then
    rm -rf /root/.cli-proxy-api 2>/dev/null || true
    ln -sf "$SHARED_DIR/auths" /root/.cli-proxy-api
fi

# Wait for binary to be available (install.sh may still be running)
if [ ! -f "$BINARY" ]; then
    echo "Waiting for CLIProxyAPI binary to be built..."
    for i in $(seq 1 120); do
        if [ -f "$BINARY" ]; then
            echo -e "${GREEN}Binary is ready!${NC}"
            break
        fi
        printf "."
        sleep 5
    done
    echo ""
fi

if [ ! -f "$BINARY" ]; then
    echo -e "${RED}Error: CLIProxyAPI binary not found at $BINARY${NC}"
    echo "Installation may have failed. Check install logs."
    exit 1
fi

# Ensure config exists
if [ ! -f "$SHARED_DIR/config/config.yaml" ]; then
    echo -e "${RED}Error: config.yaml not found at $SHARED_DIR/config/config.yaml${NC}"
    echo "Re-run installation or create config manually."
    exit 1
fi

# Symlink config so management API changes persist to shared storage
ln -sf "$SHARED_DIR/config/config.yaml" "$APP_DIR/config.yaml"

echo -e "${GREEN}Configuration loaded from $SHARED_DIR/config/config.yaml${NC}"
echo -e "${GREEN}Auth directory: /root/.cli-proxy-api -> $SHARED_DIR/auths${NC}"
echo -e "${GREEN}Starting CLIProxyAPI on port ${PORT:-8317}...${NC}"
echo ""

# Start CLIProxyAPI
cd "$APP_DIR"
exec "$BINARY"
