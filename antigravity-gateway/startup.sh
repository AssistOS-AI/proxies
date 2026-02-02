#!/bin/bash
# Startup script that waits for credentials before starting the server

CLI_PROXY_BIN="/app/cli-proxy-api"
AUTH_DIR="/root/.cli-proxy-api"
CONFIG_FILE="${AUTH_DIR}/config.yaml"
GATEWAY_PORT="${PROXY_PORT:-8001}"
CHECK_INTERVAL=5

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Function to check if Antigravity credentials are configured
has_credentials() {
    # Check for antigravity auth files
    [ -f "${AUTH_DIR}/antigravity.json" ] && return 0
    [ -f "${AUTH_DIR}/auths/antigravity.json" ] && return 0
    # Check for any antigravity-related auth file
    ls "${AUTH_DIR}"/auths/*.json 2>/dev/null | grep -qi antigravity && return 0
    # Also check if any OAuth tokens exist
    [ -d "${AUTH_DIR}/auths" ] && [ "$(ls -A ${AUTH_DIR}/auths 2>/dev/null)" ] && return 0
    return 1
}

# Wait for binary to be available
while [ ! -f "$CLI_PROXY_BIN" ]; do
    echo "Waiting for CLIProxyAPI binary..."
    sleep 2
done

# Update config with API key if provided
if [ -n "$PROXY_API_KEY" ]; then
    # Create or update config with API key
    if [ -f "$CONFIG_FILE" ]; then
        # Update the api-keys in the config
        if grep -q "^api-keys:" "$CONFIG_FILE"; then
            sed -i "s/^api-keys: \[\]/api-keys:\n  - \"${PROXY_API_KEY}\"/" "$CONFIG_FILE"
        fi
    fi
fi

# Update port in config if needed
if [ -f "$CONFIG_FILE" ] && [ "$GATEWAY_PORT" != "8317" ]; then
    sed -i "s/^port: .*/port: ${GATEWAY_PORT}/" "$CONFIG_FILE"
fi

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
exec "$CLI_PROXY_BIN" --config "$CONFIG_FILE" --auth-dir "$AUTH_DIR" --port "$GATEWAY_PORT"
