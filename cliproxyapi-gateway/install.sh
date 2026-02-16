#!/bin/sh
set -e

# Ensure Go is in PATH (golang:alpine puts it at /usr/local/go/bin)
export PATH="$PATH:/usr/local/go/bin"

APP_DIR="/app"
REPO_URL="https://github.com/router-for-me/CLIProxyAPI.git"
SHARED_DIR="/shared/cliproxyapi"

echo "============================================"
echo "  CLIProxyAPI Gateway - Installation"
echo "============================================"
echo ""

# Create persistent storage directories
mkdir -p "$SHARED_DIR/auths"
mkdir -p "$SHARED_DIR/logs"
mkdir -p "$SHARED_DIR/config"

# Clone CLIProxyAPI if not present, or pull latest
if [ ! -d "$APP_DIR" ]; then
    echo "Cloning CLIProxyAPI..."
    git clone "$REPO_URL" "$APP_DIR"
else
    echo "Updating CLIProxyAPI..."
    cd "$APP_DIR"
    git pull origin main || true
fi

cd "$APP_DIR"

# Build the Go binary
echo "Building CLIProxyAPI (this may take a few minutes on first run)..."
CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X 'main.Version=ploinky-dev' -X 'main.BuildDate=$(date -u +%Y-%m-%dT%H:%M:%SZ)'" \
    -o "$APP_DIR/CLIProxyAPI" \
    ./cmd/server/

echo "Build complete: $APP_DIR/CLIProxyAPI"

# Set up auth directory symlink for persistence
mkdir -p /root/.cli-proxy-api
if [ ! -L "/root/.cli-proxy-api" ]; then
    rm -rf /root/.cli-proxy-api 2>/dev/null || true
    ln -sf "$SHARED_DIR/auths" /root/.cli-proxy-api
fi

# Generate config.yaml if not already persisted
if [ ! -f "$SHARED_DIR/config/config.yaml" ]; then
    echo "Generating config.yaml..."

    API_KEY="${PROXY_API_KEY:-cliproxyapi-key}"
    MGMT_KEY="${MANAGEMENT_PASSWORD:-management-secret}"

    cat > "$SHARED_DIR/config/config.yaml" << EOF
# CLIProxyAPI Configuration (Ploinky-managed)
host: ""
port: ${PORT:-8317}

tls:
  enable: false

remote-management:
  allow-remote: true
  secret-key: "$MGMT_KEY"
  disable-control-panel: false

auth-dir: "~/.cli-proxy-api"

api-keys:
  - "$API_KEY"

debug: false
logging-to-file: false
usage-statistics-enabled: true

proxy-url: ""
force-model-prefix: false
request-retry: 3
max-retry-interval: 30

quota-exceeded:
  switch-project: true
  switch-preview-model: true

routing:
  strategy: "round-robin"

ws-auth: false
nonstream-keepalive-interval: 0
EOF

    echo "Config generated at $SHARED_DIR/config/config.yaml"
else
    echo "Using existing config from $SHARED_DIR/config/config.yaml"
fi

echo ""
echo "============================================"
echo "  Installation Complete"
echo "============================================"
echo "  API will be available on port ${PORT:-8317}"
echo "  Management API: /v0/management"
echo "  Management UI:  /management.html"
echo ""
echo "  To authenticate providers, run:"
echo "    ploinky cli cliproxyapi-gateway"
echo "============================================"
echo ""
