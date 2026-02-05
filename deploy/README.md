# Proxy Gateway Deployment

Deploy kiro-gateway and antigravity-gateway to a remote VPS with Cloudflare Tunnel access.

## Architecture

```
Internet                     Cloudflare                    Your VPS
   │                            │                            │
   │  kiro.axiologic.dev        │     Tunnel                 │  ┌─────────────────┐
   ├───────────────────────────►├──────────────────────────►├──► kiro-gateway    │
   │                            │                            │  │ :8000           │
   │                            │                            │  └─────────────────┘
   │  antigravity.axiologic.dev │                            │  ┌─────────────────┐
   ├───────────────────────────►├──────────────────────────►├──► antigravity-gw  │
   │                            │                            │  │ :8001           │
   │                            │                            │  └─────────────────┘
```

## Prerequisites

1. **VPS with SSH access**
   - Minimum: 1 vCPU, 1GB RAM, 10GB storage
   - OS: Debian/Ubuntu recommended
   - SSH key authentication configured

2. **Cloudflare Account**
   - Domain added to Cloudflare (e.g., axiologic.dev)
   - Zero Trust plan (free tier works)

3. **Cloudflare Tunnel**
   - Create tunnel at: https://one.dash.cloudflare.com/ → Networks → Tunnels
   - Save the tunnel token

## Quick Start

### 1. Configure Environment

```bash
cd proxies/deploy
cp setEnv.sh.example setEnv.sh
# Edit setEnv.sh with your values
nano setEnv.sh
```

Required values:
- `REMOTE_HOST`: Your VPS IP address
- `REMOTE_USER`: SSH username
- `SSH_KEY_PATH`: Path to SSH private key
- `CLOUDFLARE_TUNNEL_TOKEN`: From Cloudflare dashboard

### 2. Deploy

```bash
chmod +x deploy.sh
./deploy.sh
```

This will:
- Install Node.js, Podman, and dependencies
- Install and configure Ploinky
- Set up both proxy gateways
- Install and start Cloudflared

### 3. Configure Cloudflare Tunnel Routes

In Cloudflare Dashboard → Zero Trust → Networks → Tunnels → Your Tunnel → Public Hostname:

| Subdomain | Domain | Service |
|-----------|--------|---------|
| kiro | axiologic.dev | http://localhost:8000 |
| antigravity | axiologic.dev | http://localhost:8001 |

### 4. Authenticate Gateways

```bash
chmod +x auth-gateways.sh
./auth-gateways.sh
```

This sets up SSH tunnels for OAuth callbacks and runs the authentication flow.

## Manual Authentication (Alternative)

If the helper script doesn't work:

### For Kiro Gateway:

```bash
# Terminal 1: SSH tunnel (keep open)
ssh -i ~/proxies_private_key.pem -L 51120:127.0.0.1:51120 admin@45.136.70.141

# Terminal 2: Run auth
ssh -i ~/proxies_private_key.pem admin@45.136.70.141
cd ~/proxy-gateway/workspace
ploinky cli kiro-gateway
```

### For Antigravity Gateway:

```bash
# Terminal 1: SSH tunnel (keep open)
ssh -i ~/proxies_private_key.pem -L 51121:127.0.0.1:51121 admin@45.136.70.141

# Terminal 2: Run auth
ssh -i ~/proxies_private_key.pem admin@45.136.70.141
cd ~/proxy-gateway/workspace
ploinky cli antigravity-gateway
```

## Testing

```bash
# Get your API key
cat .api_key

# Test Kiro Gateway
curl -H "Authorization: Bearer YOUR_API_KEY" https://kiro.axiologic.dev/v1/models

# Test Antigravity Gateway
curl -H "Authorization: Bearer YOUR_API_KEY" https://antigravity.axiologic.dev/v1/models
```

## Using with OpenCode

Update `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "kiro": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kiro Gateway",
      "options": {
        "baseURL": "https://kiro.axiologic.dev/v1",
        "headers": {
          "Authorization": "Bearer YOUR_API_KEY"
        }
      },
      "models": {
        "claude-sonnet-4": { "name": "Claude Sonnet 4" }
      }
    },
    "antigravity": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Antigravity Gateway",
      "options": {
        "baseURL": "https://antigravity.axiologic.dev/v1",
        "headers": {
          "Authorization": "Bearer YOUR_API_KEY"
        }
      },
      "models": {
        "gemini-2.5-pro": { "name": "Gemini 2.5 Pro" }
      }
    }
  }
}
```

## Troubleshooting

### Check service status on VPS

```bash
ssh -i ~/proxies_private_key.pem admin@45.136.70.141

# Check cloudflared
sudo systemctl status cloudflared

# Check proxy containers
cd ~/proxy-gateway/workspace
ploinky status

# View logs
podman logs ploinky_proxies_kiro-gateway_workspace_*
podman logs ploinky_proxies_antigravity-gateway_workspace_*
```

### Restart services

```bash
# Restart gateways
ploinky restart kiro-gateway
ploinky restart antigravity-gateway

# Restart cloudflared
sudo systemctl restart cloudflared
```

### Re-authenticate

If tokens expire, run authentication again:

```bash
./auth-gateways.sh
```

## Persistent Storage

Credentials are stored in `/shared` (mounted from `workspace/shared/`) to survive container restarts:

| Path | Description |
|------|-------------|
| `/shared/proxy_api_key` | API key file |
| `/shared/kiro-cli/` | Kiro CLI credentials (AWS SSO tokens) |
| `/shared/antigravity/` | Antigravity account data |

To regenerate the API key:
```bash
cd ~/proxy-gateway/workspace
NEW_KEY=$(openssl rand -hex 32)
ploinky var PROXY_API_KEY=$NEW_KEY
echo "$NEW_KEY" > shared/proxy_api_key
ploinky stop && ploinky clean && ploinky start kiro-gateway antigravity-gateway
```

## Security Notes

- API key is auto-generated (32 bytes / 64 hex chars)
- All traffic is encrypted via Cloudflare Tunnel
- OAuth tokens are stored in the VPS workspace `/shared` directory
- Keep `setEnv.sh` and `.api_key` secure (not in git)

## Files

```
deploy/
├── setEnv.sh.example  # Template (commit this)
├── setEnv.sh          # Your config (DO NOT commit)
├── .api_key           # Generated API key (DO NOT commit)
├── deploy.sh          # Main deployment script
├── auth-gateways.sh   # Authentication helper
└── README.md          # This file
```
