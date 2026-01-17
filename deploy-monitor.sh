#!/bin/bash

###############################################################################
# Deploy Network Monitor - Similar to deploy.sh
# Usage: ./deploy-monitor.sh root@49.12.37.76
###############################################################################

set -e

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Check arguments
if [ $# -eq 0 ]; then
    echo -e "${RED}Error: No remote host specified${NC}"
    echo "Usage: $0 USER@HOST"
    echo "Example: $0 root@49.12.37.76"
    exit 1
fi

# Configuración
REMOTE_HOST="$1"
SSH_KEY="$HOME/.ssh/google_compute_engine"
REMOTE_DIR="/opt/liquidation-bot"
MONITOR_SCRIPT="monitor-network.sh"
SSH_CONTROL_PATH="/tmp/ssh-monitor-deploy-$$"
SSH_OPTS="-i $SSH_KEY -o ControlMaster=auto -o ControlPath=$SSH_CONTROL_PATH -o ControlPersist=300"

echo -e "${BLUE}🔍 Network Monitor Deployment${NC}"
echo "======================================"
echo ""

# Verificar archivos
if [ ! -f "$MONITOR_SCRIPT" ]; then
    echo -e "${RED}❌ Error: $MONITOR_SCRIPT no encontrado${NC}"
    exit 1
fi

if [ ! -f "$SSH_KEY" ]; then
    echo -e "${RED}❌ Error: SSH key no encontrada${NC}"
    exit 1
fi

echo -e "${GREEN}✓${NC} Files ready"

# Test SSH
echo -n "Testing SSH connection (enter passphrase if prompted)... "
if ssh $SSH_OPTS -o ConnectTimeout=10 "$REMOTE_HOST" "echo 'OK'" > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
    echo -e "${GREEN}✓${NC} SSH connection established"
else
    echo -e "${RED}✗${NC} Cannot connect to $REMOTE_HOST"
    exit 1
fi

# Copiar script
echo ""
echo -e "${BLUE}📤 Copying monitor script...${NC}"
scp $SSH_OPTS "$MONITOR_SCRIPT" "$REMOTE_HOST:$REMOTE_DIR/" > /dev/null 2>&1

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} Script copied"
else
    echo -e "${RED}✗${NC} Copy failed"
    exit 1
fi

# Configurar permisos y detener bot
echo ""
echo -e "${BLUE}🔧 Configuring remote server...${NC}"

ssh $SSH_OPTS "$REMOTE_HOST" bash <<'ENDSSH'
set -e
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cd /opt/liquidation-bot

# Dar permisos
chmod +x monitor-network.sh
echo -e "${GREEN}✓${NC} Permissions set"

# Detener bot
if systemctl is-active --quiet liquidation-bot; then
    echo -e "${YELLOW}⏸${NC}  Stopping bot..."
    systemctl stop liquidation-bot
    echo -e "${GREEN}✓${NC} Bot stopped"
else
    echo -e "${GREEN}✓${NC} Bot already stopped"
fi

ENDSSH

echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}   🎉 Monitor Deployed!${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo ""
echo "To start monitoring:"
echo "  ssh -i $SSH_KEY $REMOTE_HOST 'cd $REMOTE_DIR && ./monitor-network.sh'"
echo ""
echo "Or interactively:"
echo "  ssh -i $SSH_KEY $REMOTE_HOST"
echo "  cd $REMOTE_DIR"
echo "  ./monitor-network.sh"
echo ""

# Cleanup
ssh -O exit $SSH_OPTS "$REMOTE_HOST" 2>/dev/null || true
