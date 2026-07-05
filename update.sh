#!/usr/bin/env bash
# =============================================================================
# VpsEasyUploader — Update Script
#
# Pulls the latest code from git, then restarts the systemd service
# if it's already running.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}[i] Pulling latest code...${NC}"
git fetch
git pull

SERVICE_NAME="vpseasyuploader"

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo -e "${BLUE}[i] Service is running — restarting...${NC}"
    ./run.sh --service
else
    echo -e "${GREEN}[✓] Code updated. Service is not running — nothing to restart.${NC}"
fi
