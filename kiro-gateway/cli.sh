#!/bin/bash
# CLI wrapper that waits for kiro-gateway to be ready before running the login command

set -e

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

echo -e "${YELLOW}Waiting for Kiro Gateway to be ready...${NC}"

# Wait for the gateway to be ready
elapsed=0
while [ $elapsed -lt $MAX_WAIT_SECONDS ]; do
    # Check if the server is responding
    if curl -s -o /dev/null -w "%{http_code}" "http://${GATEWAY_HOST}:${GATEWAY_PORT}/health" 2>/dev/null | grep -q "200\|401\|403"; then
        echo -e "${GREEN}Kiro Gateway is ready!${NC}"
        break
    fi
    
    # Also check /v1/models endpoint (returns 401 without auth, but that means server is up)
    if curl -s -o /dev/null -w "%{http_code}" "http://${GATEWAY_HOST}:${GATEWAY_PORT}/v1/models" 2>/dev/null | grep -q "200\|401\|403"; then
        echo -e "${GREEN}Kiro Gateway is ready!${NC}"
        break
    fi
    
    printf "."
    sleep $CHECK_INTERVAL
    elapsed=$((elapsed + CHECK_INTERVAL))
done

if [ $elapsed -ge $MAX_WAIT_SECONDS ]; then
    echo -e "\n${RED}Timeout waiting for Kiro Gateway to start.${NC}"
    echo -e "${YELLOW}The server may still be installing dependencies.${NC}"
    echo -e "${YELLOW}Check logs with: podman logs <container_name>${NC}"
    exit 1
fi

echo ""
echo "================================================"
echo "  Starting Kiro Authentication"
echo "================================================"
echo ""

# Run the actual login command with all passed arguments
exec kiro-cli login --license pro --identity-provider https://view.awsapps.com/start --region us-east-1 --use-device-flow "$@"
