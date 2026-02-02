#!/bin/bash
# Startup script that waits for credentials before starting the server

CLI_PROXY_BIN="/app/cli-proxy-api"
# Use WORKSPACE_PATH (already mounted by ploinky) to persist credentials
AUTH_DIR="${WORKSPACE_PATH:-.}/.cli-proxy-api"
CONFIG_FILE="${AUTH_DIR}/config.yaml"
GATEWAY_PORT="${PROXY_PORT:-8001}"
API_KEY="${PROXY_API_KEY:-antigravity-gateway-key}"
CHECK_INTERVAL=5

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Function to check if Antigravity credentials are configured
has_credentials() {
    # Check for antigravity auth files (format: antigravity-<email>.json)
    ls "${AUTH_DIR}"/antigravity-*.json 2>/dev/null | head -1 | grep -q . && return 0
    # Legacy locations
    [ -f "${AUTH_DIR}/antigravity.json" ] && return 0
    [ -f "${AUTH_DIR}/auths/antigravity.json" ] && return 0
    ls "${AUTH_DIR}"/auths/antigravity*.json 2>/dev/null | head -1 | grep -q . && return 0
    return 1
}

# Wait for binary to be available
while [ ! -f "$CLI_PROXY_BIN" ]; do
    echo "Waiting for CLIProxyAPI binary..."
    sleep 2
done

# Generate config file with current environment variables
mkdir -p "$AUTH_DIR"
cat > "$CONFIG_FILE" << EOF
# Antigravity Gateway Configuration (auto-generated)
host: ""
port: ${GATEWAY_PORT}

# Authentication directory
auth-dir: "${AUTH_DIR}"

# API keys for authentication
api-keys:
  - "${API_KEY}"

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

echo "Configuration generated at ${CONFIG_FILE}"

# Wait for credentials if not present
if ! has_credentials; then
    echo ""
    echo -e "${YELLOW}================================================${NC}"
    echo -e "${YELLOW}  Waiting for Antigravity credentials...${NC}"
    echo -e "${YELLOW}================================================${NC}"
    echo -e "${YELLOW}  Run: ploinky cli antigravity-gateway${NC}"
    echo -e "${YELLOW}  to authenticate with your Antigravity account${NC}"
    echo -e "${YELLOW}================================================${NC}"
    echo ""
    
    while ! has_credentials; do
        sleep $CHECK_INTERVAL
    done
    
    echo -e "${GREEN}Credentials detected! Starting server...${NC}"
    echo ""
fi

# Start the CLIProxyAPI server
echo "Starting Antigravity Gateway on port ${GATEWAY_PORT}..."
exec "$CLI_PROXY_BIN" -config "$CONFIG_FILE"
