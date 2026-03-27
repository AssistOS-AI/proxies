#!/bin/bash

APP_DIR="/app"
COMMAND="${1:-help}"
PORT="${PORT:-4141}"

case "$COMMAND" in
    auth)
        echo "Starting GitHub device flow authentication..."
        cd "$APP_DIR"
        node -e "
import { runDeviceFlow } from './src/auth/github-device-flow.mjs';
import { writeGithubToken } from './src/auth/token-store.mjs';
const token = await runDeviceFlow();
await writeGithubToken(token);
console.log('Token saved. Restart the gateway to use it.');
"
        ;;
    models)
        curl -s "http://localhost:$PORT/v1/models" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
if(d.data) d.data.forEach(m => console.log(m.id));
else console.log(JSON.stringify(d,null,2));
"
        ;;
    health)
        curl -sf "http://localhost:$PORT/health" && echo "" || echo "Gateway not responding"
        ;;
    test)
        MODEL="${2:-gpt-4o}"
        echo "Testing model: $MODEL"
        curl -s -X POST "http://localhost:$PORT/v1/chat/completions" \
            -H "Content-Type: application/json" \
            -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: hello\"}],\"max_tokens\":20}" | node -e "
const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
if(d.choices) console.log('OK:', d.choices[0]?.message?.content);
else console.log('Error:', JSON.stringify(d.error || d));
"
        ;;
    *)
        echo "Copilot Gateway CLI"
        echo ""
        echo "Commands:"
        echo "  auth           Run GitHub device flow authentication"
        echo "  models         List available models"
        echo "  health         Check gateway health"
        echo "  test [model]   Send a test completion (default: gpt-4o)"
        echo ""
        ;;
esac
