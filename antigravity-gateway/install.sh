#!/bin/bash
set -e

# Install CLIProxyAPI for Antigravity OAuth support

CLI_PROXY_DIR="/app"
CLI_PROXY_BIN="${CLI_PROXY_DIR}/cli-proxy-api"
AUTH_DIR="/root/.cli-proxy-api"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        ARCH="amd64"
        ;;
    aarch64|arm64)
        ARCH="arm64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Create directories
mkdir -p "$CLI_PROXY_DIR"
mkdir -p "$AUTH_DIR"

# Download latest CLIProxyAPI release
echo "Downloading CLIProxyAPI for linux_${ARCH}..."
RELEASE_URL=$(curl -s https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest | \
    grep "browser_download_url.*linux_${ARCH}.tar.gz" | \
    head -1 | \
    cut -d '"' -f 4)

if [ -z "$RELEASE_URL" ]; then
    echo "Error: Could not find release for linux_${ARCH}"
    exit 1
fi

echo "Downloading from: $RELEASE_URL"
curl -fsSL "$RELEASE_URL" | tar -xz -C "$CLI_PROXY_DIR"

# Find the binary (it might be in a subdirectory)
if [ ! -f "$CLI_PROXY_BIN" ]; then
    # Look for the binary in extracted files
    FOUND_BIN=$(find "$CLI_PROXY_DIR" -name "cli-proxy-api" -type f | head -1)
    if [ -n "$FOUND_BIN" ]; then
        mv "$FOUND_BIN" "$CLI_PROXY_BIN"
    fi
fi

chmod +x "$CLI_PROXY_BIN"

# Verify installation
if [ -f "$CLI_PROXY_BIN" ]; then
    echo "CLIProxyAPI installed successfully"
    "$CLI_PROXY_BIN" --version 2>/dev/null || echo "Binary ready"
else
    echo "Error: CLIProxyAPI binary not found"
    exit 1
fi

# Create default config file
cat > "${AUTH_DIR}/config.yaml" << 'EOF'
# Antigravity Gateway Configuration
host: ""
port: 8001

# Authentication directory
auth-dir: "/root/.cli-proxy-api"

# API keys for authentication (set via PROXY_API_KEY env var)
api-keys: []

# Enable debug logging
debug: false

# Request retry on failures
request-retry: 3

# Quota exceeded behavior
quota-exceeded:
  switch-project: true
  switch-preview-model: true

# Routing strategy
routing:
  strategy: "round-robin"
EOF

echo "Configuration created at ${AUTH_DIR}/config.yaml"
echo ""
echo "================================================"
echo "  Installation Complete"
echo "================================================"
echo "  Run: ploinky cli antigravity-gateway"
echo "  to authenticate with your Antigravity account"
echo "================================================"
