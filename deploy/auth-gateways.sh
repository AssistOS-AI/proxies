#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load environment variables
if [ -f "$SCRIPT_DIR/setEnv.sh" ]; then
    source "$SCRIPT_DIR/setEnv.sh"
else
    echo -e "${RED}Error: setEnv.sh not found!${NC}"
    exit 1
fi

SSH_OPTS="-i $SSH_KEY_PATH -o StrictHostKeyChecking=accept-new"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Gateway Authentication Helper${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Default ports
KIRO_OAUTH_PORT="${KIRO_OAUTH_PORT:-51120}"
ANTIGRAVITY_OAUTH_PORT="${ANTIGRAVITY_OAUTH_PORT:-51121}"

PS3="Select gateway to authenticate: "
options=("Kiro Gateway" "Antigravity Gateway" "Both (sequential)" "Exit")

select opt in "${options[@]}"; do
    case $opt in
        "Kiro Gateway")
            GATEWAY="kiro-gateway"
            OAUTH_PORT="$KIRO_OAUTH_PORT"
            break
            ;;
        "Antigravity Gateway")
            GATEWAY="antigravity-gateway"
            OAUTH_PORT="$ANTIGRAVITY_OAUTH_PORT"
            break
            ;;
        "Both (sequential)")
            GATEWAY="both"
            break
            ;;
        "Exit")
            exit 0
            ;;
        *)
            echo "Invalid option"
            ;;
    esac
done

authenticate_gateway() {
    local gateway=$1
    local oauth_port=$2
    
    echo ""
    echo -e "${YELLOW}Authenticating $gateway...${NC}"
    echo ""
    echo -e "${BLUE}Setting up SSH tunnel for OAuth callback on port $oauth_port...${NC}"
    echo "Keep this terminal open during authentication."
    echo ""
    
    # Start SSH tunnel in background for OAuth callback
    ssh $SSH_OPTS -L "$oauth_port:127.0.0.1:$oauth_port" -N "$REMOTE_USER@$REMOTE_HOST" &
    TUNNEL_PID=$!
    
    # Wait for tunnel to establish
    sleep 2
    
    echo -e "${GREEN}SSH tunnel established (PID: $TUNNEL_PID)${NC}"
    echo ""
    echo -e "${YELLOW}Starting authentication flow...${NC}"
    echo "A browser window should open. If not, copy the URL shown below."
    echo ""
    
    # Run the CLI authentication on remote server
    ssh $SSH_OPTS "$REMOTE_USER@$REMOTE_HOST" "cd ~/proxy-gateway/workspace && ploinky cli $gateway"
    
    # Kill the tunnel
    kill $TUNNEL_PID 2>/dev/null || true
    
    echo ""
    echo -e "${GREEN}$gateway authentication complete!${NC}"
}

if [ "$GATEWAY" = "both" ]; then
    authenticate_gateway "kiro-gateway" "$KIRO_OAUTH_PORT"
    authenticate_gateway "antigravity-gateway" "$ANTIGRAVITY_OAUTH_PORT"
else
    authenticate_gateway "$GATEWAY" "$OAUTH_PORT"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Authentication Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Test your gateways:"
echo "  curl -H 'Authorization: Bearer \$PROXY_API_KEY' https://${KIRO_DOMAIN:-kiro.axiologic.dev}/v1/models"
echo "  curl -H 'Authorization: Bearer \$PROXY_API_KEY' https://${ANTIGRAVITY_DOMAIN:-antigravity.axiologic.dev}/v1/models"
