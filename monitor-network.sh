#!/bin/bash

###############################################################################
# Flow Network Monitor - Auto-restart bot when network recovers
###############################################################################
#
# Este script monitorea la red de Flow y automáticamente reinicia el bot
# cuando detecta que la red ha vuelto después del rollback.
#
# Uso: ./monitor-network.sh
#
###############################################################################

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PUBLIC_RPC="https://mainnet.evm.nodes.onflow.org"
ROLLBACK_BLOCK=51358233
MAX_BLOCK_DIFF=500  # Maximum 500 blocks difference from rollback (~83 min window)
CHECK_INTERVAL=5    # Seconds between checks
BOT_NAME="liquidation-bot"

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         FLOW NETWORK RECOVERY MONITOR                      ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Target rollback block: ${ROLLBACK_BLOCK}${NC}"
echo -e "${YELLOW}Check interval: ${CHECK_INTERVAL}s (every 5 seconds)${NC}"
echo -e "${YELLOW}Detection window: ±${MAX_BLOCK_DIFF} blocks${NC}"
echo ""

# Función para obtener el bloque actual
get_current_block() {
    curl -s -X POST $PUBLIC_RPC \
        -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
        | grep -o '"result":"[^"]*"' \
        | cut -d'"' -f4
}

# Función para convertir hex a decimal
hex_to_dec() {
    echo $((16#${1#0x}))
}

# Función para verificar estado del bot
check_bot_status() {
    systemctl is-active --quiet $BOT_NAME
    return $?
}

# Function to stop bot if running
stop_bot_if_running() {
    if check_bot_status; then
        echo -e "${YELLOW}Stopping bot before monitoring...${NC}"
        systemctl stop $BOT_NAME
        echo -e "${GREEN}Bot stopped${NC}"
        echo ""
    fi
}

# Detener bot si está corriendo
stop_bot_if_running

# Variables de estado
network_down=true
last_block=0
check_count=0

echo -e "${BLUE}Starting network monitoring...${NC}"
echo ""

# Loop principal
while true; do
    check_count=$((check_count + 1))

    # Obtener bloque actual
    hex_block=$(get_current_block)

    if [ -z "$hex_block" ] || [ "$hex_block" = "null" ]; then
        # Could not get block - network probably down
        if [ "$network_down" = false ]; then
            echo ""
            echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] Network down - Cannot get block${NC}"
            network_down=true
        else
            # Only show every 12 checks (1 minute if interval is 5s)
            if [ $((check_count % 12)) -eq 0 ]; then
                echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] Waiting for network... (check #$check_count)${NC}"
            fi
        fi
    else
        # Convertir a decimal
        current_block=$(hex_to_dec $hex_block)

        # Calcular diferencia con bloque de rollback
        diff=$((current_block - ROLLBACK_BLOCK))
        abs_diff=${diff#-}  # Valor absoluto

        if [ "$network_down" = true ]; then
            echo ""
            echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] Network detected!${NC}"
            echo -e "${GREEN}   Current block: $current_block${NC}"
            echo -e "${GREEN}   Rollback target: $ROLLBACK_BLOCK${NC}"
            echo -e "${GREEN}   Difference: $diff blocks${NC}"
            network_down=false
        fi

        # Verificar si estamos cerca del bloque de rollback
        if [ $abs_diff -le $MAX_BLOCK_DIFF ]; then
            echo ""
            echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
            echo -e "${GREEN}║  FLOW NETWORK RECOVERED - STARTING BOT                    ║${NC}"
            echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
            echo ""
            echo -e "${BLUE}Network information:${NC}"
            echo -e "   Current block: ${GREEN}$current_block${NC}"
            echo -e "   Rollback target: ${YELLOW}$ROLLBACK_BLOCK${NC}"
            echo -e "   Difference: ${GREEN}$diff blocks${NC}"
            echo ""
            echo -e "${YELLOW}Starting bot...${NC}"

            # Reiniciar bot
            systemctl restart $BOT_NAME
            sleep 2

            # Verify bot started correctly
            if check_bot_status; then
                echo -e "${GREEN}Bot started successfully!${NC}"
                echo ""
                echo -e "${BLUE}View logs:${NC}"
                echo -e "   tail -f /opt/liquidation-bot/logs/liquidation-bot.log"
                echo -e "   OR: journalctl -u $BOT_NAME -f"
                echo ""
                echo -e "${BLUE}View status:${NC}"
                echo -e "   systemctl status $BOT_NAME"
                echo ""

                # Show first log lines
                echo -e "${BLUE}Recent log lines:${NC}"
                echo -e "${YELLOW}────────────────────────────────────────────────────────────${NC}"
                journalctl -u $BOT_NAME -n 10 --no-pager

                exit 0
            else
                echo -e "${RED}Error starting bot${NC}"
                echo -e "${YELLOW}Try manually: systemctl restart $BOT_NAME${NC}"
                exit 1
            fi
        else
            # Network active but not at rollback block yet
            if [ $current_block -gt $((ROLLBACK_BLOCK + MAX_BLOCK_DIFF)) ]; then
                echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] Block $current_block too high (expected ~$ROLLBACK_BLOCK)${NC}"
                echo -e "${YELLOW}   Network may not have rolled back yet. Waiting...${NC}"
            else
                echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')] Block: $current_block (diff: $diff)${NC}"
            fi
        fi

        last_block=$current_block
    fi

    # Esperar antes del siguiente check
    sleep $CHECK_INTERVAL
done
