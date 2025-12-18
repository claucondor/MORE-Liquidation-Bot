#!/bin/bash

# 🚀 Automated Liquidation Bot Deploy Script
# Usage: ./deploy.sh USER@HOST [--update]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_NAME="liquidation-bot"
LOCAL_DIR="/home/oydual3/MORE-Liquidation-Bot"
REMOTE_DIR="/opt/liquidation-bot"
SSH_KEY="$HOME/.ssh/google_compute_engine"
SERVICE_NAME="liquidation-bot"
SSH_CONTROL_PATH="/tmp/ssh-deploy-$$"

# SSH options for connection reuse (only ask passphrase once)
SSH_OPTS="-i $SSH_KEY -o ControlMaster=auto -o ControlPath=$SSH_CONTROL_PATH -o ControlPersist=300"

# Check arguments
if [ $# -eq 0 ]; then
    echo -e "${RED}Error: No remote host specified${NC}"
    echo "Usage: $0 USER@HOST [--update]"
    echo "Example: $0 root@49.12.37.76"
    exit 1
fi

REMOTE_HOST="$1"
UPDATE_MODE="${2:-}"

echo -e "${BLUE}💰 Liquidation Bot Deployment Script${NC}"
echo "======================================"
echo ""

# Function to print status
print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Check if SSH key exists
if [ ! -f "$SSH_KEY" ]; then
    print_error "SSH key not found at $SSH_KEY"
    exit 1
fi

print_status "SSH key found"

# Test SSH connection
echo -n "Testing SSH connection (enter passphrase if prompted)... "
if ssh $SSH_OPTS -o ConnectTimeout=10 "$REMOTE_HOST" "echo 'OK'" > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
    print_status "SSH connection established (connection will be reused)"
else
    print_error "Cannot connect to $REMOTE_HOST"
    echo "Make sure:"
    echo "  - Server is running"
    echo "  - SSH key has correct permissions (chmod 600)"
    echo "  - You have access to the server"
    echo "  - You entered the correct passphrase"
    exit 1
fi

# Copy files to remote
echo ""
echo -e "${BLUE}📤 Copying files to remote server...${NC}"

rsync -avz --progress \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '.gitignore' \
    --exclude 'logs/*.log' \
    --exclude 'deploy.sh' \
    --exclude 'bot_state.json' \
    -e "ssh $SSH_OPTS" \
    "$LOCAL_DIR/" \
    "$REMOTE_HOST:$REMOTE_DIR/"

if [ $? -eq 0 ]; then
    print_status "Files copied successfully"
else
    print_error "File copy failed"
    exit 1
fi

# Remote setup
echo ""
echo -e "${BLUE}🔧 Configuring remote server...${NC}"

ssh $SSH_OPTS "$REMOTE_HOST" bash <<'ENDSSH'
set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

cd /opt/liquidation-bot

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    print_warning "Node.js not found. Installing..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
    print_status "Node.js installed"
else
    print_status "Node.js already installed ($(node --version))"
fi

# Install dependencies
print_status "Installing npm dependencies..."
npm install --legacy-peer-deps --silent
print_status "Dependencies installed"

# Create logs directory
mkdir -p logs
print_status "Logs directory ready"

# Check if config.json exists
if [ ! -f "config.json" ]; then
    print_warning "config.json file not found!"
    echo "You need to create config.json with your configuration"
else
    print_status "config.json exists"
fi

# Create systemd service
cat > /etc/systemd/system/liquidation-bot.service << 'EOF'
[Unit]
Description=MORE Liquidation Bot - Flow EVM
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/liquidation-bot
ExecStart=/usr/bin/node /opt/liquidation-bot/index.js
Restart=always
RestartSec=10
StandardOutput=append:/opt/liquidation-bot/logs/liquidation-bot.log
StandardError=append:/opt/liquidation-bot/logs/liquidation-bot.error.log

[Install]
WantedBy=multi-user.target
EOF

print_status "Systemd service created"

# Reload systemd
systemctl daemon-reload
print_status "Systemd reloaded"

# Enable service
systemctl enable liquidation-bot
print_status "Service enabled"

# Check if service is already running
if systemctl is-active --quiet liquidation-bot; then
    print_warning "Service is running. Restarting..."
    systemctl restart liquidation-bot
else
    print_status "Starting service..."
    systemctl start liquidation-bot
fi

# Wait a moment for service to start
sleep 3

# Check service status
if systemctl is-active --quiet liquidation-bot; then
    print_status "Service is running!"
else
    print_warning "Service may have failed to start"
    echo "Check logs with: journalctl -u liquidation-bot -n 50"
fi

ENDSSH

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════${NC}"
    echo -e "${GREEN}   🎉 Deployment Successful!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════${NC}"
    echo ""
    echo "Management commands (on remote server):"
    echo "  • systemctl status liquidation-bot   - Check status"
    echo "  • systemctl restart liquidation-bot  - Restart service"
    echo "  • systemctl stop liquidation-bot     - Stop service"
    echo ""
    echo "View logs:"
    echo "  • tail -f /opt/liquidation-bot/logs/liquidation-bot.log"
    echo "  • tail -f /opt/liquidation-bot/logs/liquidation-bot.error.log"
    echo ""
    echo "Quick commands from local:"
    echo "  ssh -i $SSH_KEY $REMOTE_HOST 'systemctl status liquidation-bot'"
    echo "  ssh -i $SSH_KEY $REMOTE_HOST 'tail -f /opt/liquidation-bot/logs/liquidation-bot.log'"
    echo ""
else
    print_error "Deployment failed"
    # Cleanup SSH control socket
    ssh -O exit $SSH_OPTS "$REMOTE_HOST" 2>/dev/null || true
    exit 1
fi

# Cleanup SSH control socket
echo ""
print_status "Closing SSH connection..."
ssh -O exit $SSH_OPTS "$REMOTE_HOST" 2>/dev/null || true
