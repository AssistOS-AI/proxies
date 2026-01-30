#!/bin/bash
# CLI wrapper that waits for kiro-gateway to be ready before running the login command

# Don't use set -e as we need to handle failures gracefully

# Configuration
MAX_WAIT_SECONDS=120
CHECK_INTERVAL=2
GATEWAY_PORT=8000
GATEWAY_HOST="localhost"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to check if server is responding
check_server() {
    # Try using curl if available
    if command -v curl &> /dev/null; then
        local status=$(curl -s -o /dev/null -w "%{http_code}" "http://${GATEWAY_HOST}:${GATEWAY_PORT}/v1/models" 2>/dev/null)
        # Any HTTP response means server is up (even 401/403)
        if [ -n "$status" ] && [ "$status" != "000" ]; then
            return 0
        fi
    fi
    
    # Fallback: try using python to check the port
    if command -v python3 &> /dev/null; then
        python3 -c "
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(1)
try:
    s.connect(('${GATEWAY_HOST}', ${GATEWAY_PORT}))
    s.close()
    exit(0)
except:
    exit(1)
" 2>/dev/null && return 0
    fi
    
    # Fallback: check if port is listening using /dev/tcp (bash built-in)
    (echo >/dev/tcp/${GATEWAY_HOST}/${GATEWAY_PORT}) 2>/dev/null && return 0
    
    return 1
}

echo -e "${YELLOW}Waiting for Kiro Gateway to be ready...${NC}"

# Wait for the gateway to be ready
elapsed=0
gateway_ready=false

while [ $elapsed -lt $MAX_WAIT_SECONDS ]; do
    if check_server; then
        echo -e "\n${GREEN}Kiro Gateway is ready!${NC}"
        gateway_ready=true
        break
    fi
    
    printf "."
    sleep $CHECK_INTERVAL
    elapsed=$((elapsed + CHECK_INTERVAL))
done

if [ "$gateway_ready" = false ]; then
    echo -e "\n${RED}Timeout waiting for Kiro Gateway to start.${NC}"
    echo -e "${YELLOW}The server may still be installing dependencies or failed to start.${NC}"
    echo -e "${YELLOW}You can still try to authenticate - the credentials will be used when the server starts.${NC}"
    echo ""
fi

echo ""
echo "================================================"
echo "  Starting Kiro Authentication"
echo "================================================"
echo ""

# Run the actual login command with all passed arguments
exec kiro-cli login --license pro --identity-provider https://view.awsapps.com/start --region us-east-1 --use-device-flow "$@"
