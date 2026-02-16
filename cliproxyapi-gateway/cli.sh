#!/bin/sh
# Interactive CLI for CLIProxyAPI Gateway

APP_DIR="/app"
SHARED_DIR="/shared/cliproxyapi"
BINARY="$APP_DIR/CLIProxyAPI"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# If arguments provided, handle them directly
if [ $# -gt 0 ]; then
    case "$1" in
        status)
            echo -e "${CYAN}CLIProxyAPI Status${NC}"
            echo ""
            if [ -f "$BINARY" ]; then
                echo -e "Binary: ${GREEN}installed${NC}"
            else
                echo -e "Binary: ${YELLOW}not installed${NC}"
            fi
            if [ -f "$SHARED_DIR/config/config.yaml" ]; then
                echo -e "Config: ${GREEN}present${NC}"
            else
                echo -e "Config: ${YELLOW}missing${NC}"
            fi
            echo "Auth files:"
            ls -la /root/.cli-proxy-api/ 2>/dev/null || echo "  (none)"
            echo ""
            # Try to reach the API
            if curl -s -o /dev/null -w "%{http_code}" http://localhost:${PORT:-8317}/ 2>/dev/null | grep -q "200"; then
                echo -e "API: ${GREEN}running${NC}"
            else
                echo -e "API: ${YELLOW}not reachable${NC}"
            fi
            ;;
        config)
            if [ -f "$SHARED_DIR/config/config.yaml" ]; then
                cat "$SHARED_DIR/config/config.yaml"
            else
                echo "No config found."
            fi
            ;;
        edit-config)
            if command -v vi &> /dev/null; then
                vi "$SHARED_DIR/config/config.yaml"
            elif command -v nano &> /dev/null; then
                nano "$SHARED_DIR/config/config.yaml"
            else
                echo "No editor available. Edit $SHARED_DIR/config/config.yaml manually."
            fi
            ;;
        models)
            curl -s -H "Authorization: Bearer ${PROXY_API_KEY:-cliproxyapi-key}" \
                "http://localhost:${PORT:-8317}/v1/models" 2>/dev/null | head -100
            ;;
        *)
            echo "Unknown command: $1"
            echo "Use without arguments for interactive menu."
            ;;
    esac
    exit 0
fi

# Interactive menu
while true; do
    echo ""
    echo -e "${CYAN}============================================${NC}"
    echo -e "${CYAN}  CLIProxyAPI Gateway - Management CLI${NC}"
    echo -e "${CYAN}============================================${NC}"
    echo ""
    echo "  1) Show status"
    echo "  2) View config"
    echo "  3) Edit config"
    echo "  4) List models"
    echo "  5) List auth files"
    echo "  6) Open shell"
    echo "  0) Exit"
    echo ""
    echo -n "  Choice: "
    read -r choice

    case "$choice" in
        1)
            bash /code/cli.sh status
            ;;
        2)
            bash /code/cli.sh config
            ;;
        3)
            bash /code/cli.sh edit-config
            ;;
        4)
            echo ""
            echo -e "${YELLOW}Available models:${NC}"
            bash /code/cli.sh models
            ;;
        5)
            echo ""
            echo -e "${YELLOW}Auth files in $SHARED_DIR/auths:${NC}"
            ls -la "$SHARED_DIR/auths/" 2>/dev/null || echo "  (none)"
            ;;
        6)
            echo "Dropping to shell (type 'exit' to return)..."
            /bin/bash || /bin/sh
            ;;
        0|q|exit)
            echo "Goodbye!"
            exit 0
            ;;
        *)
            echo "Invalid choice."
            ;;
    esac
done
