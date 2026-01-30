#!/bin/bash
# Startup script that waits for credentials before starting the server

KIRO_DB="/root/.local/share/kiro-cli/data.sqlite3"
CHECK_INTERVAL=5

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Function to check if credentials are configured
has_credentials() {
    [ -f "$KIRO_DB" ] && return 0
    [ -n "$REFRESH_TOKEN" ] && return 0
    [ -f "$KIRO_CREDS_FILE" ] && return 0
    return 1
}

# Wait for credentials if not present
if ! has_credentials; then
    echo ""
    echo -e "${YELLOW}================================================${NC}"
    echo -e "${YELLOW}  Waiting for Kiro credentials...${NC}"
    echo -e "${YELLOW}================================================${NC}"
    echo -e "${YELLOW}  Run: ploinky cli kiro-gateway${NC}"
    echo -e "${YELLOW}  to authenticate with your Kiro account${NC}"
    echo -e "${YELLOW}================================================${NC}"
    echo ""
    
    while ! has_credentials; do
        sleep $CHECK_INTERVAL
    done
    
    echo -e "${GREEN}Credentials detected! Starting server...${NC}"
    echo ""
fi

# Start the Python server
exec python /app/main.py
