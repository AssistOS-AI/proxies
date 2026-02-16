# Axiologic AI Gateway Documentation

## Overview

This document describes how to use the Kiro and Antigravity proxy gateways to access Claude and Gemini models from both OpenCode and achillesAgentLib.

---

## Gateway URLs & Credentials

### Kiro Gateway (Claude models via AWS)

| Setting | Value |
|---------|-------|
| **URL** | `https://kiro.axiologic.dev` |
| **API Key** | `c63a1044d0381757a1808a8bf970c13bf437f913a618811cd990553f6d2bd7b6` |
| **Authentication** | Bearer token in Authorization header |
| **Password Protection** | None |

### Antigravity Gateway (Gemini & Claude via Google Cloud Code)

| Setting | Value |
|---------|-------|
| **URL** | `https://antigravity.axiologic.dev` |
| **API Key** | `c63a1044d0381757a1808a8bf970c13bf437f913a618811cd990553f6d2bd7b6` |
| **Authentication** | Bearer token in Authorization header |
| **Web UI Password** | `antigravity!Proxy` |

---

## Available Models

### Kiro Gateway Models

| Model ID | Description | Context Window |
|----------|-------------|----------------|
| `auto-kiro` | Auto-select best model | 200K |
| `claude-sonnet-4.5` | Claude Sonnet 4.5 | 200K |
| `claude-sonnet-4` | Claude Sonnet 4 | 200K |
| `claude-3.7-sonnet` | Claude 3.7 Sonnet | 200K |
| `claude-haiku-4.5` | Claude Haiku 4.5 (fast) | 200K |

### Antigravity Gateway Models

| Model ID | Description | Context Window |
|----------|-------------|----------------|
| `gemini-2.5-pro` | Gemini 2.5 Pro | 1M |
| `gemini-2.5-flash` | Gemini 2.5 Flash | 1M |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | 1M |
| `gemini-2.5-flash-thinking` | Gemini 2.5 Flash with Thinking | 1M |
| `gemini-3-flash` | Gemini 3 Flash | 1M |
| `gemini-3-pro-low` | Gemini 3 Pro (Low) | 1M |
| `gemini-3-pro-high` | Gemini 3 Pro (High) | 1M |
| `gemini-3-pro-image` | Gemini 3 Pro Image | 1M |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | ~128K |
| `claude-sonnet-4-5-thinking` | Claude Sonnet 4.5 with Thinking | ~128K |
| `claude-opus-4-5-thinking` | Claude Opus 4.5 with Thinking | ~128K |

**Note:** Claude models via Antigravity have smaller context windows (~128K) compared to direct API (200K).

---

## Using with OpenCode

### Configuration File Location

```
~/.config/opencode/opencode.json
```

### Full Configuration

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "kiro/claude-sonnet-4.5",
  "compaction": {
    "auto": true,
    "prune": true
  },
  "provider": {
    "kiro": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kiro Gateway",
      "options": {
        "baseURL": "https://kiro.axiologic.dev/v1",
        "headers": {
          "Authorization": "Bearer c63a1044d0381757a1808a8bf970c13bf437f913a618811cd990553f6d2bd7b6"
        }
      },
      "models": {
        "auto-kiro": {
          "name": "Claude (Auto)",
          "id": "auto-kiro"
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
    },
    "antigravity": {
      "npm": "@ai-sdk/anthropic",
      "name": "Antigravity Gateway",
      "options": {
        "baseURL": "https://antigravity.axiologic.dev/v1",
        "apiKey": "c63a1044d0381757a1808a8bf970c13bf437f913a618811cd990553f6d2bd7b6"
      },
      "models": {
        "gemini-2.5-pro": {
          "name": "Gemini 2.5 Pro"
        },
        "gemini-2.5-flash": {
          "name": "Gemini 2.5 Flash"
        },
        "gemini-3-flash": {
          "name": "Gemini 3 Flash"
        },
        "gemini-3-pro-high": {
          "name": "Gemini 3 Pro High"
        },
        "claude-sonnet-4-5-thinking": {
          "name": "Claude Sonnet 4.5 Thinking"
        },
        "claude-opus-4-5-thinking": {
          "name": "Claude Opus 4.5 Thinking"
        }
      }
    }
  }
}
```

### Switching Models in OpenCode

Use the `/models` command or press `Ctrl+K` to switch between models:

```
/models
```

Select from:
- `kiro/claude-sonnet-4.5` - Best for coding tasks
- `kiro/claude-haiku-4.5` - Fast responses
- `antigravity/gemini-3-flash` - Free, fast Gemini
- `antigravity/claude-opus-4-5-thinking` - Deep reasoning (may have capacity limits)

### Important Notes

1. **Compaction**: Enabled by default to manage context size
2. **Kiro uses OpenAI format**: `@ai-sdk/openai-compatible`
3. **Antigravity uses Anthropic format**: `@ai-sdk/anthropic`
4. **Context limits**: Claude via Antigravity has ~128K limit (use Kiro for 200K)

---

## Using with achillesAgentLib

### Environment Variables

Add to `~/.bashrc` or `~/.zshrc`:

```bash
export KIRO_API_KEY="c63a1044d0381757a1808a8bf970c13bf437f913a618811cd990553f6d2bd7b6"
export ANTIGRAVITY_API_KEY="c63a1044d0381757a1808a8bf970c13bf437f913a618811cd990553f6d2bd7b6"
```

Then run:
```bash
source ~/.bashrc
```

### LLMConfig.json Location

```
ploinky/node_modules/achillesAgentLib/LLMConfig.json
```

### Provider Configuration

The providers are configured as:

```json
{
  "providers": {
    "kiro": {
      "baseURL": "https://kiro.axiologic.dev/v1/chat/completions",
      "apiKeyEnv": "KIRO_API_KEY",
      "module": "./utils/LLMProviders/providers/openai.mjs"
    },
    "antigravity": {
      "baseURL": "https://antigravity.axiologic.dev/v1/messages",
      "apiKeyEnv": "ANTIGRAVITY_API_KEY",
      "module": "./utils/LLMProviders/providers/anthropic.mjs"
    }
  }
}
```

**Important:** Kiro uses OpenAI format (`/v1/chat/completions`), while Antigravity uses Anthropic format (`/v1/messages`).

### Model Entries

Models reference their provider by name:

```json
{
  "models": [
    {
      "name": "claude-sonnet-4.5",
      "provider": "kiro",
      "mode": "deep",
      "inputPrice": 3,
      "outputPrice": 15,
      "context": "200k"
    },
    {
      "name": "gemini-3-flash",
      "provider": "antigravity",
      "mode": "fast",
      "inputPrice": 0,
      "outputPrice": 0,
      "context": "1mill"
    }
  ]
}
```