#!/bin/bash

cd /app

if [ $# -eq 0 ]; then
    echo "Copilot API Gateway CLI"
    echo ""
    echo "Usage:"
    echo "  auth              - Authenticate with GitHub (OAuth flow)"
    echo "  check-usage       - Check Copilot usage/quota"
    echo "  debug             - Show debug info"
    echo "  debug --json      - Show debug info as JSON"
    echo "  start             - Start the proxy server"
    echo "  help              - Show this help"
    echo ""
    exit 0
fi

exec npx copilot-api@latest "$@"
