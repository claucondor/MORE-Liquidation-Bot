#!/bin/bash
# Stop the liquidation bot on remote server

SSH_KEY="$HOME/.ssh/google_compute_engine"

if [ -z "$1" ]; then
    echo "Usage: ./stop-bot.sh USER@HOST"
    echo "Example: ./stop-bot.sh root@49.12.37.76"
    exit 1
fi

REMOTE_HOST="$1"

echo "Stopping liquidation-bot on $REMOTE_HOST..."
ssh -i "$SSH_KEY" "$REMOTE_HOST" "systemctl stop liquidation-bot && echo 'Bot stopped!' || echo 'Failed to stop bot'"
