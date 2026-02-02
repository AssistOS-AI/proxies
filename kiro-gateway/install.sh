#!/bin/bash
set -e

# Add local bin to PATH
export PATH="$PATH:/root/.local/bin"

# Set up persistent storage for kiro-cli credentials
# Use /shared (mounted from workspace/shared) so credentials survive container restarts
mkdir -p /shared/kiro-cli
mkdir -p /root/.local/share

# Create symlink for kiro-cli data directory
if [ ! -L "/root/.local/share/kiro-cli" ]; then
    rm -rf /root/.local/share/kiro-cli 2>/dev/null || true
    ln -sf /shared/kiro-cli /root/.local/share/kiro-cli
fi

# Install kiro-cli if not exists
if ! command -v kiro-cli &> /dev/null; then
    echo "Installing kiro-cli..."
    curl -fsSL https://cli.kiro.dev/install | bash
    # Create symlink so kiro-cli is in default PATH
    ln -sf /root/.local/bin/kiro-cli /usr/local/bin/kiro-cli
fi

# Clone kiro-gateway repo if not exists
if [ ! -d "/app" ]; then
    git clone https://github.com/jwadow/kiro-gateway.git /app
fi

# Check if already logged in
KIRO_DB="/root/.local/share/kiro-cli/data.sqlite3"
if [ ! -f "$KIRO_DB" ]; then
    echo ""
    echo "================================================"
    echo "  Authentication Required"
    echo "================================================"
    echo "  Run: ploinky cli kiro-gateway"
    echo "  to authenticate with your Kiro account"
    echo "================================================"
    echo ""
fi

# Create .env in /code (CWD when python runs via ploinky)
cat > /code/.env << EOF
KIRO_CLI_DB_FILE=/root/.local/share/kiro-cli/data.sqlite3
EOF
[ -n "$PROXY_API_KEY" ] && echo "PROXY_API_KEY=$PROXY_API_KEY" >> /code/.env

# Install python dependencies
cd /app
pip install -q -r requirements.txt
