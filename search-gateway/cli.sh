#!/bin/bash
APP_DIR="/app"

if [ $# -eq 0 ]; then
    echo "Search Gateway CLI"
    echo ""
    echo "Usage:"
    echo "  status          Show gateway status"
    echo "  keys            List API keys"
    echo "  models          List search models"
    echo "  providers       List search providers"
    echo "  logs [n]        Show recent logs (default: 20)"
    echo "  health          Check health endpoint"
    echo ""
    exit 0
fi

PORT="${PORT:-8043}"
BASE="http://localhost:$PORT"

ppjson() {
    node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
}

case "$1" in
    status|health)
        curl -s "$BASE/health" | ppjson
        ;;
    keys)
        curl -s "$BASE/api/v1/keys" | ppjson
        ;;
    models)
        curl -s "$BASE/v1/models" | ppjson
        ;;
    providers)
        curl -s "$BASE/api/v1/providers" | ppjson
        ;;
    logs)
        LIMIT="${2:-20}"
        curl -s "$BASE/api/v1/logs?limit=$LIMIT" | ppjson
        ;;
    *)
        echo "Unknown command: $1"
        exit 1
        ;;
esac
