#!/bin/bash
set -e

###############################################################################
# Add SSH Public Key to Remote Server
###############################################################################
#
# Usage: ./add-ssh-key.sh root@49.12.37.76
#
###############################################################################

REMOTE_HOST="$1"
SSH_KEY="$HOME/.ssh/google_compute_engine"
NEW_PUBLIC_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfci+Tkrh5PLwLyEiGI96X49f8j+nEmddnCI9cPXFW7 Rozalenok"

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║           SSH Key Addition Script                         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Validar argumentos
if [ -z "$REMOTE_HOST" ]; then
    echo -e "${RED}❌ Error: Debes especificar el host remoto${NC}"
    echo ""
    echo -e "${YELLOW}Uso:${NC}"
    echo "  ./add-ssh-key.sh root@49.12.37.76"
    echo ""
    exit 1
fi

echo -e "${YELLOW}🔧 Configuración:${NC}"
echo "  Host remoto: $REMOTE_HOST"
echo "  Nueva key para: Rozalenok"
echo ""

# SSH options para reutilizar conexión
SSH_CONTROL_PATH="/tmp/ssh-add-key-$$"
SSH_OPTS="-i $SSH_KEY -o ControlMaster=auto -o ControlPath=$SSH_CONTROL_PATH -o ControlPersist=300"

# Verificar conexión SSH
echo -e "${BLUE}🔍 Verificando conexión SSH...${NC}"
if ! ssh $SSH_OPTS -o ConnectTimeout=10 "$REMOTE_HOST" "echo 'OK'" > /dev/null 2>&1; then
    echo -e "${RED}❌ No se pudo conectar al servidor remoto${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Conexión SSH establecida${NC}"
echo ""

# Agregar la key
echo -e "${BLUE}📤 Agregando SSH key...${NC}"
ssh $SSH_OPTS "$REMOTE_HOST" bash <<ENDSSH
# Crear directorio .ssh si no existe
mkdir -p ~/.ssh
chmod 700 ~/.ssh

# Crear authorized_keys si no existe
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Verificar si la key ya existe
if grep -q "Rozalenok" ~/.ssh/authorized_keys 2>/dev/null; then
    echo "⚠️  La key de Rozalenok ya existe, actualizando..."
    # Remover la key antigua
    grep -v "Rozalenok" ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp || true
    mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys
fi

# Agregar la nueva key
echo "$NEW_PUBLIC_KEY" >> ~/.ssh/authorized_keys

# Verificar que se agregó
if grep -q "Rozalenok" ~/.ssh/authorized_keys; then
    echo "✅ Key agregada exitosamente"
else
    echo "❌ Error al agregar la key"
    exit 1
fi

# Mostrar resumen
echo ""
echo "📊 Keys autorizadas actualmente:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
grep -o "ssh-[^ ]* [^ ]* .*" ~/.ssh/authorized_keys | awk '{print "  - " \$1 " " \$3}' || echo "  (ninguna encontrada)"
ENDSSH

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  ✅ SSH Key agregada exitosamente                        ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}📝 Nota:${NC}"
echo "  Rozalenok ahora puede conectarse con:"
echo -e "  ${BLUE}ssh -i ~/.ssh/id_ed25519 $REMOTE_HOST${NC}"
echo ""

# Limpiar control socket
ssh -O exit -o ControlPath="$SSH_CONTROL_PATH" "$REMOTE_HOST" 2>/dev/null || true

exit 0
ENDSSH
