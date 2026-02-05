#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXIES_DIR="$(dirname "$SCRIPT_DIR")"
PLOINKY_DIR="$(dirname "$PROXIES_DIR")/ploinky"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Proxy Gateway Deployment Script${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Load environment variables
if [ -f "$SCRIPT_DIR/setEnv.sh" ]; then
    source "$SCRIPT_DIR/setEnv.sh"
else
    echo -e "${RED}Error: setEnv.sh not found!${NC}"
    echo "Copy setEnv.sh.example to setEnv.sh and configure your values."
    exit 1
fi

# Validate required variables
required_vars=(
    "REMOTE_HOST"
    "REMOTE_USER"
    "SSH_KEY_PATH"
    "CLOUDFLARE_TUNNEL_TOKEN"
    "PROXY_API_KEY"
)

for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo -e "${RED}Error: $var is not set in setEnv.sh${NC}"
        exit 1
    fi
done

# Validate SSH key exists
if [ ! -f "$SSH_KEY_PATH" ]; then
    echo -e "${RED}Error: SSH key not found at $SSH_KEY_PATH${NC}"
    exit 1
fi

# Validate local directories exist
if [ ! -d "$PLOINKY_DIR" ]; then
    echo -e "${RED}Error: Ploinky directory not found at $PLOINKY_DIR${NC}"
    exit 1
fi

if [ ! -d "$PROXIES_DIR" ]; then
    echo -e "${RED}Error: Proxies directory not found at $PROXIES_DIR${NC}"
    exit 1
fi

# Set SSH options
SSH_OPTS="-i $SSH_KEY_PATH -o StrictHostKeyChecking=accept-new"
SSH_CMD="ssh $SSH_OPTS $REMOTE_USER@$REMOTE_HOST"
SCP_CMD="scp -r $SSH_OPTS"
RSYNC_CMD="rsync -avz --progress -e \"ssh $SSH_OPTS\""

echo -e "${GREEN}Configuration:${NC}"
echo "  Remote: $REMOTE_USER@$REMOTE_HOST"
echo "  Kiro Domain: ${KIRO_DOMAIN:-kiro.axiologic.dev}"
echo "  Antigravity Domain: ${ANTIGRAVITY_DOMAIN:-antigravity.axiologic.dev}"
echo "  API Key: ${PROXY_API_KEY:0:8}...${PROXY_API_KEY: -8}"
echo "  Local Ploinky: $PLOINKY_DIR"
echo "  Local Proxies: $PROXIES_DIR"
echo ""

# Test SSH connection
echo -e "${YELLOW}Testing SSH connection...${NC}"
if ! $SSH_CMD "echo 'SSH connection successful'" 2>/dev/null; then
    echo -e "${RED}Error: Cannot connect to remote server${NC}"
    exit 1
fi
echo -e "${GREEN}SSH connection OK${NC}"
echo ""

# Create remote workspace
echo -e "${YELLOW}[1/7] Creating remote workspace...${NC}"
$SSH_CMD "mkdir -p ~/proxy-gateway"

# Copy ploinky to remote
echo -e "${YELLOW}[2/7] Copying Ploinky to remote server...${NC}"
rsync -avz --progress --exclude 'node_modules' --exclude '.git' --exclude 'tests' \
    -e "ssh $SSH_OPTS" \
    "$PLOINKY_DIR/" "$REMOTE_USER@$REMOTE_HOST:~/proxy-gateway/ploinky/"

# Copy proxies to remote
echo -e "${YELLOW}[3/7] Copying Proxies to remote server...${NC}"
rsync -avz --progress --exclude 'node_modules' --exclude '.git' --exclude 'deploy/setEnv.sh' --exclude 'deploy/.api_key' \
    -e "ssh $SSH_OPTS" \
    "$PROXIES_DIR/" "$REMOTE_USER@$REMOTE_HOST:~/proxy-gateway/proxies/"

# Create remote setup script
echo -e "${YELLOW}[4/7] Preparing remote setup script...${NC}"

cat > /tmp/remote-setup.sh << 'REMOTE_SCRIPT'
#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

WORKSPACE="$HOME/proxy-gateway"

echo -e "${YELLOW}[A] Installing system dependencies...${NC}"

# Detect package manager and install deps
if command -v apt-get &> /dev/null; then
    sudo apt-get update
    sudo apt-get install -y curl git podman rsync
    
    # Install Node.js if not present
    if ! command -v node &> /dev/null; then
        echo -e "${YELLOW}Installing Node.js...${NC}"
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
else
    echo -e "${RED}Error: apt-get not found. Only Debian/Ubuntu supported.${NC}"
    exit 1
fi

echo -e "${GREEN}Node.js version: $(node --version)${NC}"
echo -e "${GREEN}Podman version: $(podman --version)${NC}"

echo -e "${YELLOW}[B] Installing Ploinky...${NC}"

cd "$WORKSPACE/ploinky"
npm install --production
sudo npm link 2>/dev/null || npm link

# Verify ploinky is in PATH
if ! command -v ploinky &> /dev/null; then
    export PATH="$PATH:$(npm bin -g)"
    echo "export PATH=\"\$PATH:$(npm bin -g)\"" >> ~/.bashrc
fi

echo -e "${GREEN}Ploinky installed: $(which ploinky)${NC}"

echo -e "${YELLOW}[C] Setting up Ploinky workspace...${NC}"

mkdir -p "$WORKSPACE/workspace"
cd "$WORKSPACE/workspace"

# Initialize ploinky workspace structure
mkdir -p .ploinky/repos
mkdir -p shared

# Link the proxies repo
ln -sf "$WORKSPACE/proxies" .ploinky/repos/proxies

# Set the API key in ploinky secrets
ploinky var PROXY_API_KEY "$PROXY_API_KEY"

# Also save API key to shared volume for persistence
echo "$PROXY_API_KEY" > shared/proxy_api_key
chmod 644 shared/proxy_api_key
echo -e "${GREEN}API key saved to shared/proxy_api_key${NC}"

echo -e "${YELLOW}[D] Installing Cloudflared...${NC}"

if ! command -v cloudflared &> /dev/null; then
    curl -L --output /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    sudo dpkg -i /tmp/cloudflared.deb || sudo apt-get install -f -y
    rm -f /tmp/cloudflared.deb
fi

echo -e "${GREEN}Cloudflared version: $(cloudflared --version)${NC}"

# Stop existing cloudflared service if running
sudo systemctl stop cloudflared 2>/dev/null || true
sudo cloudflared service uninstall 2>/dev/null || true

# Install cloudflared as a service with the tunnel token
sudo cloudflared service install "$CLOUDFLARE_TUNNEL_TOKEN"

echo -e "${YELLOW}[E] Starting proxy agents...${NC}"

cd "$WORKSPACE/workspace"

# Start the proxy agents
ploinky start kiro-gateway || echo "Note: kiro-gateway may need manual start"
ploinky start antigravity-gateway || echo "Note: antigravity-gateway may need manual start"

# Start cloudflared service
sudo systemctl enable cloudflared
sudo systemctl start cloudflared

# Check status
sleep 3

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Services Status:"
echo "  - Cloudflared: $(sudo systemctl is-active cloudflared 2>/dev/null || echo 'unknown')"
podman ps --format "table {{.Names}}\t{{.Status}}" 2>/dev/null || echo "  - Containers: check with 'podman ps'"
echo ""
echo "Workspace: $WORKSPACE/workspace"
echo ""
echo "Next Steps - Authenticate the gateways:"
echo "  cd $WORKSPACE/workspace"
echo "  ploinky cli kiro-gateway"
echo "  ploinky cli antigravity-gateway"
echo ""
echo "API Key: $PROXY_API_KEY"
echo ""
REMOTE_SCRIPT

# Inject environment variables into the script
sed -i "2i export PROXY_API_KEY=\"$PROXY_API_KEY\"" /tmp/remote-setup.sh
sed -i "3i export CLOUDFLARE_TUNNEL_TOKEN=\"$CLOUDFLARE_TUNNEL_TOKEN\"" /tmp/remote-setup.sh

# Copy and execute remote script
echo -e "${YELLOW}[5/7] Copying setup script to remote server...${NC}"
scp $SSH_OPTS /tmp/remote-setup.sh "$REMOTE_USER@$REMOTE_HOST:/tmp/remote-setup.sh"

echo -e "${YELLOW}[6/7] Executing remote setup (this may take a few minutes)...${NC}"
$SSH_CMD "chmod +x /tmp/remote-setup.sh && /tmp/remote-setup.sh"

echo -e "${YELLOW}[7/7] Verifying deployment...${NC}"
$SSH_CMD "cd ~/proxy-gateway/workspace && ploinky status" || true

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${BLUE}Your API Key:${NC}"
echo "  $PROXY_API_KEY"
echo ""
echo -e "${BLUE}Next Steps:${NC}"
echo ""
echo "1. SSH into the server and authenticate the gateways:"
echo "   ssh $SSH_OPTS $REMOTE_USER@$REMOTE_HOST"
echo "   cd ~/proxy-gateway/workspace"
echo "   ploinky cli kiro-gateway"
echo "   ploinky cli antigravity-gateway"
echo ""
echo "2. Or use the auth helper script:"
echo "   ./auth-gateways.sh"
echo ""
echo "3. Configure Cloudflare Tunnel hostnames (if not done):"
echo "   - ${KIRO_DOMAIN:-kiro.axiologic.dev} -> http://localhost:8000"
echo "   - ${ANTIGRAVITY_DOMAIN:-antigravity.axiologic.dev} -> http://localhost:8001"
echo ""
echo "4. Test the endpoints:"
echo "   curl -H 'Authorization: Bearer $PROXY_API_KEY' https://${KIRO_DOMAIN:-kiro.axiologic.dev}/v1/models"
echo "   curl -H 'Authorization: Bearer $PROXY_API_KEY' https://${ANTIGRAVITY_DOMAIN:-antigravity.axiologic.dev}/v1/models"
echo ""

# Save API key locally
echo "$PROXY_API_KEY" > "$SCRIPT_DIR/.api_key"
chmod 600 "$SCRIPT_DIR/.api_key"
echo -e "${GREEN}API key saved to: $SCRIPT_DIR/.api_key${NC}"
