#!/usr/bin/env bash
# =============================================================================
# VpsEasyUploader — Run Script
#
# Checks that setup has been completed, then starts the Flask app in production
# mode using Waitress (multi-threaded WSGI server).
#
# Usage:
#   ./run.sh            Start the server
#   ./run.sh --service  Install/update the systemd service
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

# ── Check .env exists ───────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
    echo -e "${RED}╔══════════════════════════════════════════╗${NC}"
    echo -e "${RED}║  No .env file found!                     ║${NC}"
    echo -e "${RED}║  Please run ./setup.sh first              ║${NC}"
    echo -e "${RED}╚══════════════════════════════════════════╝${NC}"
    exit 1
fi

# ── Load environment variables ──────────────────────────────────────────────
export $(grep -v '^#' .env | grep -v '^$' | xargs)

IP="${IP:-0.0.0.0}"
PORT="${PORT:-8080}"
LOG_LEVEL="${LOG_LEVEL:-WARNING}"

# ── Handle --service flag ───────────────────────────────────────────────────
if [ "${1:-}" = "--service" ]; then
    echo -e "${BLUE}[i] Installing/updating systemd service...${NC}"

    SERVICE_NAME="vpseasyuploader"
    SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
    CURRENT_USER=$(whoami)
    CURRENT_GROUP=$(id -gn)

    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=VpsEasyUploader — Personal File Upload Server
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
Group=$CURRENT_GROUP
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/venv/bin/python -m waitress --host=$IP --port=$PORT --threads=8 app:app
Restart=always
RestartSec=5
Environment="PATH=$SCRIPT_DIR/venv/bin:/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME" 2>/dev/null || true
    sudo systemctl restart "$SERVICE_NAME" 2>/dev/null || true

    echo -e "${GREEN}[✓] Service installed and started.${NC}"
    echo -e "${BLUE}[i] Check status: sudo systemctl status $SERVICE_NAME${NC}"
    echo -e "${BLUE}[i] View logs:   sudo journalctl -u $SERVICE_NAME -f${NC}"
    exit 0
fi

# ── Activate virtual environment ────────────────────────────────────────────
if [ -f "venv/bin/activate" ]; then
    # shellcheck disable=SC1090,SC1091
    source venv/bin/activate
elif [ -f "venv/Scripts/activate" ]; then
    # Windows Git Bash
    # shellcheck disable=SC1090,SC1091
    source venv/Scripts/activate
else
    echo -e "${RED}[✗] Virtual environment not found. Run ./setup.sh first.${NC}"
    exit 1
fi

# ── Start the server ────────────────────────────────────────────────────────
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  VpsEasyUploader — Starting...           ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Server:  ${CYAN}http://${IP}:${PORT}${NC}"
echo -e "  Log:     ${YELLOW}${LOG_LEVEL}${NC}"
echo ""
echo -e "  Press ${RED}Ctrl+C${NC} to stop"
echo ""

# Start Waitress in production mode (multi-threaded)
# Flask's built-in server is NOT used for production.
# Threads=8 to support parallel chunk uploads (4 concurrent
# chunks per upload + dashboard API calls).
python -m waitress \
    --host="$IP" \
    --port="$PORT" \
    --threads=8 \
    --channel-timeout=120 \
    app:app
