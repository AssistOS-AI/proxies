# Kiro Gateway Agent

OpenAI/Anthropic compatible proxy for Kiro API (Claude models via AWS CodeWhisperer).

## Quick Start

### 1. Add the proxies repo to ploinky

```bash
ploinky enable repo proxies
```

### 2. Start the agent

```bash
ploinky start kiro-gateway
```

### 3. Authenticate with Kiro

```bash
ploinky cli kiro-gateway
```

This will start the authentication flow. Follow the prompts to authenticate with your Kiro account.

The gateway will automatically start once credentials are configured.

## Configuration

### PROXY_API_KEY

The API key used to authenticate requests to the gateway. Default: `kiro-gateway-key`

To set a custom key:

```bash
ploinky var PROXY_API_KEY your-secret-key
ploinky restart kiro-gateway
```

## Usage with opencode

Edit `~/.config/opencode/opencode.json` and add the Kiro provider:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "kiro/claude-sonnet-4",
  "provider": {
    "kiro": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kiro Gateway",
      "options": {
        "baseURL": "http://localhost:8000/v1",
        "headers": {
          "Authorization": "Bearer kiro-gateway-key"
        }
      },
      "models": {
        "auto": {
          "id": "auto-kiro",
          "name": "Claude (Auto)"
        },
        "claude-sonnet-4.5": {
          "name": "Claude Sonnet 4.5"
        },
        "claude-sonnet-4": {
          "name": "Claude Sonnet 4"
        },
        "claude-3.7-sonnet": {
          "name": "Claude 3.7 Sonnet"
        },
        "claude-haiku-4.5": {
          "name": "Claude Haiku 4.5"
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

Use `Ctrl+K` to switch models and select a Kiro model.

## Available Models

| Model ID | Description |
|----------|-------------|
| `auto-kiro` | Automatically selects the best model |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-opus-4.5` | Claude Opus 4.5 |
| `claude-3.7-sonnet` | Claude 3.7 Sonnet |
| `claude-haiku-4.5` | Claude Haiku 4.5 (fast) |

## Troubleshooting

### Gateway not starting

Check the container logs:

```bash
podman logs $(podman ps -q --filter "name=kiro-gateway")
```

### Authentication issues

Re-authenticate:

```bash
ploinky cli kiro-gateway
```

### Connection refused in opencode

Ensure the gateway is running and listening on port 8000:

```bash
curl -H "Authorization: Bearer kiro-gateway-key" http://localhost:8000/v1/models
```
