# Antigravity Gateway Agent

OpenAI/Gemini compatible proxy for Antigravity subscription (Gemini models via Google OAuth).

Powered by [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

## Quick Start

### 1. Add the proxies repo to ploinky

```bash
ploinky enable repo proxies
```

### 2. Start the agent

```bash
ploinky start antigravity-gateway
```

### 3. Authenticate with Antigravity

```bash
ploinky cli antigravity-gateway
```

This will start the OAuth authentication flow. Follow the prompts to authenticate with your Antigravity/Google account.

The gateway will automatically start once credentials are configured.

## Configuration

### PROXY_API_KEY

The API key used to authenticate requests to the gateway. Default: `antigravity-gateway-key`

To set a custom key:

```bash
ploinky var PROXY_API_KEY your-secret-key
ploinky restart antigravity-gateway
```

### PROXY_PORT

The port the gateway listens on. Default: `8001`

Note: This uses port 8001 by default to avoid conflicts with kiro-gateway (which uses 8000).

```bash
ploinky var PROXY_PORT 8080
ploinky restart antigravity-gateway
```

## Usage with opencode

Edit `~/.config/opencode/opencode.json` and add the Antigravity provider:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "antigravity/gemini-2.5-pro",
  "provider": {
    "antigravity": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Antigravity Gateway",
      "options": {
        "baseURL": "http://localhost:8001/v1",
        "headers": {
          "Authorization": "Bearer antigravity-gateway-key"
        }
      },
      "models": {
        "gemini-2.5-pro": {
          "name": "Gemini 2.5 Pro"
        },
        "gemini-2.5-flash": {
          "name": "Gemini 2.5 Flash"
        },
        "gemini-3-pro-preview": {
          "name": "Gemini 3 Pro Preview"
        },
        "gemini-3-flash-preview": {
          "name": "Gemini 3 Flash Preview"
        },
        "gemini-claude-sonnet-4-5-thinking": {
          "name": "Claude Sonnet 4.5 (via Gemini)"
        },
        "gemini-claude-opus-4-5-thinking": {
          "name": "Claude Opus 4.5 (via Gemini)"
        }
      }
    }
  }
}
```

Then start opencode:

```bash
opencode
```

Use `Ctrl+K` to switch models and select an Antigravity model.

## Available Models

Antigravity provides access to Gemini models through your subscription. Common models include:

| Model ID | Description |
|----------|-------------|
| `gemini-2.5-pro` | Gemini 2.5 Pro |
| `gemini-2.5-flash` | Gemini 2.5 Flash (fast) |
| `gemini-3-pro-preview` | Gemini 3 Pro Preview |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview |
| `gemini-3-pro-image-preview` | Gemini 3 Pro with Image Generation |
| `gemini-claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 (via Gemini) |
| `gemini-claude-opus-4-5-thinking` | Claude Opus 4.5 (via Gemini) |

Note: Available models depend on your Antigravity subscription tier.

## API Endpoints

The gateway exposes OpenAI-compatible endpoints:

- `GET /v1/models` - List available models
- `POST /v1/chat/completions` - Chat completions (streaming supported)

Example:

```bash
curl http://localhost:8001/v1/chat/completions \
  -H "Authorization: Bearer antigravity-gateway-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-pro",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Troubleshooting

### Gateway not starting

Check the container logs:

```bash
podman logs $(podman ps -q --filter "name=antigravity-gateway")
```

### Authentication issues

Re-authenticate:

```bash
ploinky cli antigravity-gateway
```

### OAuth callback issues

The CLIProxyAPI OAuth callback uses port 51121. Make sure this port is accessible during the login flow.

### Connection refused

Ensure the gateway is running and listening:

```bash
curl -H "Authorization: Bearer antigravity-gateway-key" http://localhost:8001/v1/models
```

## Credits

This gateway uses [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) by Router-For.ME to provide the Antigravity OAuth integration and API proxy functionality.
