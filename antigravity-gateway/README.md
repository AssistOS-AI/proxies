# Antigravity Gateway

Anthropic-compatible API proxy backed by **Antigravity Cloud Code**, providing access to Claude and Gemini models.

Based on [antigravity-claude-proxy](https://github.com/AssistOS-AI/antigravity-claude-proxy).

## Features

- **Web Dashboard** for account management at https://antigravity.axiologic.dev
- **Manual Authorization** - copy callback URL to complete OAuth on remote server
- **Multi-account load balancing** support
- **Claude and Gemini models** via Antigravity subscription

## Quick Start

### 1. Start the Gateway

```bash
ploinky start antigravity-gateway
```

### 2. Add an Account (Manual Authorization)

1. Open the Web Dashboard at https://antigravity.axiologic.dev
2. Go to **Accounts** tab
3. Click **Add Account** - a popup opens with Google sign-in
4. Complete Google sign-in with your Antigravity account
5. Google redirects to `http://localhost:51121/oauth-callback?code=xxx&state=xxx`
6. **This will fail** (page won't load) - that's expected!
7. **Copy the entire URL** from your browser's address bar
8. **Paste it** in the dashboard's manual completion field
9. Click Submit - account is added!

### Why Manual Authorization?

The Antigravity Cloud Code API is a **private Google API** that only works with Google's official OAuth client. This client uses `localhost:51121` as the redirect URI, which doesn't work on remote servers. The manual flow lets you complete auth locally and paste the code back to the server.

## CLI Access

```bash
ploinky cli antigravity-gateway

# Add account (headless mode)
npm run accounts add --no-browser

# List accounts
npm run accounts list
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/messages` | POST | Anthropic Messages API |
| `/v1/models` | GET | List available models |
| `/health` | GET | Health check |
| `/account-limits` | GET | Account status & quotas |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `8001` | Server port |
| `PROXY_API_KEY` | No | `antigravity-gateway-key` | API key for authentication |
| `OAUTH_MODE` | No | `manual` | OAuth mode (manual recommended) |

## Usage with Claude Code

```bash
export ANTHROPIC_BASE_URL=https://antigravity.axiologic.dev
export ANTHROPIC_API_KEY=dummy
claude
```

## Persistence

Account data is stored in `/shared/antigravity/` (symlinked from `/root/.config/antigravity-proxy/`).

This ensures credentials survive container restarts. The `/shared` directory is mounted from the host's `workspace/shared/`.

## Troubleshooting

### "403 Forbidden" on Cloud Code API
- Make sure you're using a Google account that has access to Antigravity/Gemini Code Assist
- Try opening https://idx.google.com and starting a chat first to provision your account

### OAuth callback fails
- This is expected! Copy the failed URL and paste it in the dashboard
- Make sure you copy the **entire URL** including the `code=` and `state=` parameters
