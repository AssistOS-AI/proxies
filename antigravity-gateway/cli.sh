#!/bin/bash

APP_DIR="/app"

cd "$APP_DIR"

# If no arguments, show help
if [ $# -eq 0 ]; then
    echo "Antigravity Claude Proxy CLI"
    echo ""
    echo "Usage:"
    echo "  accounts list          - List all linked accounts"
    echo "  accounts add           - Add a new account (opens browser)"
    echo "  accounts add --no-browser  - Add account without browser (manual auth)"
    echo "  accounts remove <id>   - Remove an account"
    echo "  start                  - Start the proxy server"
    echo "  help                   - Show this help"
    echo ""
    exit 0
fi

# Pass all arguments to the CLI
exec npx antigravity-claude-proxy "$@"
