# Proxy Gateways

OpenAI-compatible proxy gateways for Claude and Gemini models, deployed via Ploinky containers and exposed through Cloudflare Tunnels.

## Gateways

| Gateway | Models | Backend | Port |
|---------|--------|---------|------|
| **kiro-gateway** | Claude Sonnet 4.5, Claude Sonnet 4, Claude Haiku 4.5 | AWS Kiro CLI | 8000 |
| **antigravity-gateway** | Gemini 2.5 Pro/Flash, Claude (via Antigravity) | Google Cloud Code | 8001 |

## Architecture

```
                                    Cloudflare Tunnel
Internet ──► kiro.axiologic.dev ────────────────────────► VPS:8000 ──► kiro-gateway ──► AWS/Kiro
         ──► antigravity.axiologic.dev ─────────────────► VPS:8001 ──► antigravity-gw ──► Google Cloud Code
```

## Quick Start

### Prerequisites

- VPS with SSH access (Debian/Ubuntu, 1+ vCPU, 1+ GB RAM)
- Cloudflare account with a domain
- Cloudflare Tunnel token

### 1. Configure Deployment

```bash
cd proxies/deploy
cp setEnv.sh.example setEnv.sh
nano setEnv.sh  # Fill in your values
```

### 2. Deploy to VPS

```bash
chmod +x deploy.sh
./deploy.sh
```

### 3. Configure Cloudflare Tunnel Routes

In Cloudflare Dashboard > Zero Trust > Networks > Tunnels > Your Tunnel:

| Subdomain | Domain | Service |
|-----------|--------|---------|
| kiro | yourdomain.com | http://localhost:8000 |
| antigravity | yourdomain.com | http://localhost:8001 |

### 4. Authenticate Gateways

Visit the landing pages in your browser:
- https://kiro.yourdomain.com - Click "Sign in with AWS"
- https://antigravity.yourdomain.com - Click "Add Account" for Google OAuth

### 5. Test

```bash
# Get your API key
cat deploy/.api_key

# Test Kiro
curl -H "Authorization: Bearer YOUR_API_KEY" https://kiro.yourdomain.com/v1/models

# Test Antigravity  
curl -H "Authorization: Bearer YOUR_API_KEY" https://antigravity.yourdomain.com/v1/models
```

## Directory Structure

```
proxies/
├── kiro-gateway/           # Claude via AWS Kiro
│   ├── manifest.json       # Ploinky container config
│   ├── install.sh          # Container setup script
│   ├── startup.sh          # Container startup script
│   ├── landing.py          # Web UI + API proxy
│   └── cli.sh              # Interactive CLI access
│
├── antigravity-gateway/    # Gemini/Claude via Antigravity
│   ├── manifest.json       # Ploinky container config
│   ├── install.sh          # Container setup script
│   ├── startup.sh          # Container startup script
│   └── cli.sh              # Interactive CLI access
│
├── antigravity-claude-proxy/  # Forked proxy source code
│   └── ...                    # (cloned during install)
│
├── deploy/                 # Deployment scripts
│   ├── deploy.sh           # Main deployment script
│   ├── auth-gateways.sh    # Authentication helper
│   ├── setEnv.sh.example   # Environment template
│   └── README.md           # Deployment docs
│
└── README.md               # This file
```

## API Usage

Both gateways expose OpenAI-compatible endpoints:

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/models | List available models |
| POST | /v1/chat/completions | Chat completion (streaming supported) |

### Authentication

```bash
Authorization: Bearer YOUR_API_KEY
```

### Example Request

```bash
curl -X POST https://kiro.yourdomain.com/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 100
  }'
```

## Using with OpenCode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "model": "kiro/claude-sonnet-4",
  "provider": {
    "kiro": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kiro Gateway",
      "options": {
        "baseURL": "https://kiro.yourdomain.com/v1",
        "headers": {
          "Authorization": "Bearer YOUR_API_KEY"
        }
      },
      "models": {
        "claude-sonnet-4.5": { "name": "Claude Sonnet 4.5" },
        "claude-sonnet-4": { "name": "Claude Sonnet 4" },
        "claude-haiku-4.5": { "name": "Claude Haiku 4.5" }
      }
    },
    "antigravity": {
      "npm": "@ai-sdk/openai-compatible", 
      "name": "Antigravity Gateway",
      "options": {
        "baseURL": "https://antigravity.yourdomain.com/v1",
        "headers": {
          "Authorization": "Bearer YOUR_API_KEY"
        }
      },
      "models": {
        "gemini-2.5-pro": { "name": "Gemini 2.5 Pro" },
        "gemini-2.5-flash": { "name": "Gemini 2.5 Flash" }
      }
    }
  }
}
```

## Persistence

Credentials and data are stored in `/shared` (mounted from `workspace/shared/`):

| File | Description |
|------|-------------|
| `/shared/proxy_api_key` | API key for gateway authentication |
| `/shared/kiro-cli/` | Kiro CLI credentials (survives restarts) |
| `/shared/antigravity/` | Antigravity account data |

## Server Management

### SSH into VPS

```bash
ssh -i ~/your_key.pem admin@your-vps-ip
cd ~/proxy-gateway/workspace
```

### Check Status

```bash
ploinky status
```

### View Logs

```bash
podman logs ploinky_proxies_kiro-gateway_workspace_*
podman logs ploinky_proxies_antigravity-gateway_workspace_*
```

### Restart Gateways

```bash
ploinky stop kiro-gateway antigravity-gateway
ploinky start kiro-gateway antigravity-gateway
```

### Regenerate API Key

```bash
# On VPS
cd ~/proxy-gateway/workspace
NEW_KEY=$(openssl rand -hex 32)
ploinky var PROXY_API_KEY=$NEW_KEY
echo "$NEW_KEY" > shared/proxy_api_key

# Restart to apply
ploinky stop && ploinky clean && ploinky start kiro-gateway antigravity-gateway

# Update local opencode.json with new key
```

## Troubleshooting

### Gateway shows "Not Authenticated"

Visit the landing page and complete the OAuth flow:
- Kiro: AWS SSO device flow (click button, enter code)
- Antigravity: Google OAuth (manual callback - copy localhost URL)

### "No accounts available" error

The gateway needs account authentication. Visit the landing page.

### Credentials lost after restart

Ensure `/shared` is properly mounted. Check:
```bash
podman exec <container> ls -la /shared/
```

### API returns 401

Check the API key matches:
```bash
# On VPS
cat ~/proxy-gateway/workspace/shared/proxy_api_key

# Compare with your local config
```

## Security Notes

- API keys are 256-bit random (64 hex chars)
- All traffic encrypted via Cloudflare Tunnel (no direct port exposure)
- OAuth tokens stored only on VPS
- Never commit `setEnv.sh` or `.api_key` to git

## License

MIT
