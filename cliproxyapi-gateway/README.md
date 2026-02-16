# CLIProxyAPI Gateway (Ploinky Agent)

Unified AI proxy supporting Claude, Gemini, Codex, Antigravity, Kimi, Qwen, and iFlow via OAuth and API keys.

## Ports

| Port | Purpose |
|------|---------|
| 8317 | Main API (OpenAI/Claude/Gemini compatible) |
| 1455 | Codex/OpenAI OAuth callback |
| 54545 | Claude/Anthropic OAuth callback |
| 51121 | Antigravity/Google OAuth callback |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_API_KEY` | `cliproxyapi-key` | API key for client authentication |
| `MANAGEMENT_PASSWORD` | `management-secret` | Management API password |
| `PORT` | `8317` | API server port |

## Usage

```bash
# Start the gateway
ploinky start cliproxyapi-gateway

# Access the CLI
ploinky cli cliproxyapi-gateway

# Test the API
curl -H "Authorization: Bearer cliproxyapi-key" http://localhost:8317/v1/models
```
