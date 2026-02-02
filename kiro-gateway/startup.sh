#!/bin/bash
# Startup script for Kiro Gateway with landing page

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Ensure Python and kiro-cli are ready
echo -e "${YELLOW}Starting Kiro Gateway...${NC}"

# Ensure persistent storage symlink exists
mkdir -p /data/kiro-cli
mkdir -p /root/.local/share
if [ ! -L "/root/.local/share/kiro-cli" ]; then
    rm -rf /root/.local/share/kiro-cli 2>/dev/null || true
    ln -sf /data/kiro-cli /root/.local/share/kiro-cli
fi

# Wait for kiro-cli to be available (install.sh may still be running)
if ! command -v kiro-cli &> /dev/null; then
    echo "Waiting for kiro-cli to be installed..."
    for i in {1..60}; do
        if command -v kiro-cli &> /dev/null; then
            echo -e "${GREEN}kiro-cli is ready!${NC}"
            break
        fi
        printf "."
        sleep 2
    done
    echo ""
fi

# Start the landing page server (handles both browser and API access)
exec python3 /code/landing.py
