#!/bin/bash
# CLI for Kiro Gateway authentication

# Ensure kiro-cli is in PATH
export PATH="$PATH:/root/.local/bin:/usr/local/bin"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Configuration
MAX_WAIT_SECONDS=60
CHECK_INTERVAL=2
GATEWAY_PORT=8000

# Function to check if server is responding
check_server() {
    if command -v curl &> /dev/null; then
        local status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${GATEWAY_PORT}/v1/models" 2>/dev/null)
        [ -n "$status" ] && [ "$status" != "000" ] && return 0
    fi
    python3 -c "import socket; s=socket.socket(); s.settimeout(1); s.connect(('localhost',${GATEWAY_PORT})); s.close()" 2>/dev/null && return 0
    return 1
}

echo ""
echo "================================================"
echo "  Kiro Gateway Authentication"
echo "================================================"
echo ""

# Run the login command
kiro-cli login --license pro --identity-provider https://view.awsapps.com/start --region us-east-1 --use-device-flow "$@"
login_status=$?

if [ $login_status -eq 0 ]; then
    echo ""
    echo -e "${YELLOW}Waiting for Kiro Gateway to start...${NC}"
    
    elapsed=0
    while [ $elapsed -lt $MAX_WAIT_SECONDS ]; do
        if check_server; then
            echo -e "${GREEN}Kiro Gateway is ready!${NC}"
            echo ""
            echo "You can now use the gateway at: http://localhost:${GATEWAY_PORT}"
            exit 0
        fi
        printf "."
        sleep $CHECK_INTERVAL
        elapsed=$((elapsed + CHECK_INTERVAL))
    done
    
    echo ""
    echo -e "${YELLOW}Server is still starting. It should be ready shortly.${NC}"
fi

exit $login_status
