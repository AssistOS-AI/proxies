#!/bin/bash
# CLI for Antigravity Gateway authentication

CLI_PROXY_BIN="/app/cli-proxy-api"
# Use WORKSPACE_PATH (already mounted by ploinky) to persist credentials
AUTH_DIR="${WORKSPACE_PATH:-.}/.cli-proxy-api"
GATEWAY_PORT="${PROXY_PORT:-8001}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Wait for CLIProxyAPI to be installed (install.sh may still be running)
if [ ! -f "$CLI_PROXY_BIN" ]; then
    echo -e "${YELLOW}Waiting for CLIProxyAPI to be installed...${NC}"
    for i in {1..60}; do
        if [ -f "$CLI_PROXY_BIN" ]; then
            echo -e "${GREEN}CLIProxyAPI is ready!${NC}"
            break
        fi
        printf "."
        sleep 2
    done
    echo ""
    
    if [ ! -f "$CLI_PROXY_BIN" ]; then
        echo -e "${RED}Error: CLIProxyAPI not found. Install may have failed.${NC}"
        exit 1
    fi
fi

# Configuration
MAX_WAIT_SECONDS=60
CHECK_INTERVAL=2

# Function to check if server is responding
check_server() {
    if command -v curl &> /dev/null; then
        local status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${GATEWAY_PORT}/v1/models" 2>/dev/null)
        [ -n "$status" ] && [ "$status" != "000" ] && return 0
    fi
    return 1
}

# Function to check if credentials exist
has_credentials() {
    # Check for antigravity auth files (format: antigravity-<email>.json)
    ls "${AUTH_DIR}"/antigravity-*.json 2>/dev/null | head -1 | grep -q . && return 0
    # Legacy locations
    [ -f "${AUTH_DIR}/antigravity.json" ] && return 0
    [ -f "${AUTH_DIR}/auths/antigravity.json" ] && return 0
    ls "${AUTH_DIR}"/auths/antigravity*.json 2>/dev/null | head -1 | grep -q . && return 0
    return 1
}

echo ""
echo "================================================"
echo "  Antigravity Gateway Authentication"
echo "================================================"
echo ""

# Run the Antigravity login command
# CLIProxyAPI uses port 51121 for OAuth callback
echo -e "${YELLOW}Starting Antigravity OAuth login...${NC}"
echo -e "${YELLOW}Note: The OAuth callback uses port 51121${NC}"
echo ""

mkdir -p "$AUTH_DIR"
cd "$AUTH_DIR"
"$CLI_PROXY_BIN" -config "$AUTH_DIR/config.yaml" -antigravity-login "$@"
login_status=$?

if [ $login_status -eq 0 ]; then
    echo ""
    echo -e "${GREEN}Authentication successful!${NC}"
    echo -e "${YELLOW}Waiting for Antigravity Gateway to start...${NC}"
    
    elapsed=0
    while [ $elapsed -lt $MAX_WAIT_SECONDS ]; do
        if check_server; then
            echo -e "${GREEN}Antigravity Gateway is ready!${NC}"
            echo ""
            echo "You can now use the gateway at: http://localhost:${GATEWAY_PORT}"
            echo ""
            echo "Example:"
            echo "  curl -H \"Authorization: Bearer ${PROXY_API_KEY:-antigravity-gateway-key}\" \\"
            echo "       http://localhost:${GATEWAY_PORT}/v1/models"
            exit 0
        fi
        printf "."
        sleep $CHECK_INTERVAL
        elapsed=$((elapsed + CHECK_INTERVAL))
    done
    
    echo ""
    echo -e "${YELLOW}Server is still starting. It should be ready shortly.${NC}"
else
    echo ""
    echo -e "${RED}Authentication failed. Please try again.${NC}"
fi

exit $login_status
