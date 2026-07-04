#!/usr/bin/env bash
# =============================================================================
# VpsEasyUploader — Stop Script
#
# Stops the server if it was started as a systemd service.
#
# Usage:
#   ./stop.sh            Stop the service
#   ./stop.sh --disable  Stop and disable auto-start on boot
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

SERVICE_NAME="vpseasyuploader"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# ── Check if service is installed ───────────────────────────────────────────
if [ ! -f "$SERVICE_FILE" ]; then
    echo -e "${YELLOW}╔══════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║  Service not installed.                   ║${NC}"
    echo -e "${YELLOW}╚══════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  The '${SERVICE_NAME}' systemd service was not found."
    echo -e "  Install it with: ${CYAN}./run.sh --service${NC}"
    echo ""
    exit 0
fi

# ── Stop the service ────────────────────────────────────────────────────────
echo -e "${BLUE}[i] Stopping ${SERVICE_NAME}...${NC}"
sudo systemctl stop "$SERVICE_NAME" 2>/dev/null && \
    echo -e "${GREEN}[✓] Service stopped.${NC}" || \
    echo -e "${YELLOW}[!] Service was not running.${NC}"

# ── Optionally disable ──────────────────────────────────────────────────────
if [ "${1:-}" = "--disable" ]; then
    sudo systemctl disable "$SERVICE_NAME" 2>/dev/null && \
        echo -e "${GREEN}[✓] Auto-start disabled.${NC}" || \
        echo -e "${YELLOW}[!] Service was not enabled.${NC}"
fi

# ── Show status ─────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}[i] Current status:${NC}"
systemctl is-active "$SERVICE_NAME" 2>/dev/null || true
echo ""
echo -e "  Start again:   ${CYAN}./run.sh --service${NC}"
echo -e "  Or directly:   ${CYAN}./run.sh${NC}"
echo ""
