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

    TUSD_BIN_PATH="$SCRIPT_DIR/.bin/tusd"
TUSD_DATA_DIR="$SCRIPT_DIR/uploads/.tusd"
# Read hook secret from .env (safer than inline grep in ExecStart)
TUSD_HOOK_SECRET_VAL=$(grep '^TUSD_HOOK_SECRET=' "$SCRIPT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | head -1 || echo "")

sudo tee "$SERVICE_FILE" > /dev/null <<SERVICEEOF
[Unit]
Description=VpsEasyUploader — Personal File Upload Server
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
Group=$CURRENT_GROUP
WorkingDirectory=$SCRIPT_DIR
ExecStartPre=/bin/mkdir -p $TUSD_DATA_DIR
ExecStart=/bin/sh -c '\
  $TUSD_BIN_PATH -host=0.0.0.0 -port=1080 -dir=$TUSD_DATA_DIR -hooks-http=http://127.0.0.1:$PORT/tus-hook -hooks-http-forward-headers=Hook-Secret:$TUSD_HOOK_SECRET_VAL -hooks-enabled-events=post-finish & \
  TUSD_PID=\$! ; \
  trap "kill \$TUSD_PID 2>/dev/null" EXIT ; \
  $SCRIPT_DIR/venv/bin/python -m waitress --host=$IP --port=$PORT --threads=8 app:app'
Restart=always
RestartSec=5
Environment="PATH=$SCRIPT_DIR/venv/bin:/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=multi-user.target
SERVICEEOF

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

# ── Ensure tusd is available ────────────────────────────────────────────────
TUSD_DIR_BIN="$SCRIPT_DIR/.bin"
TUSD_BIN="$TUSD_DIR_BIN/tusd"
TUSD_PORT=1080
TUSD_HOOK_URL="http://127.0.0.1:${PORT}/tus-hook"

# Load TUSD_HOOK_SECRET from .env if present (generated on first run)
TUSD_HOOK_SECRET="${TUSD_HOOK_SECRET:-}"
if [ -z "$TUSD_HOOK_SECRET" ]; then
    TUSD_HOOK_SECRET=$(grep -oP 'TUSD_HOOK_SECRET=\K.*' .env 2>/dev/null || echo "")
fi

install_tusd() {
    local os_name arch suffix
    case "$(uname -s)" in
        Linux)  os_name="linux" ;;
        Darwin) os_name="darwin" ;;
        *)      echo -e "${RED}[✗] Unsupported OS for tusd${NC}"; exit 1 ;;
    esac
    case "$(uname -m)" in
        x86_64)  arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)       echo -e "${RED}[✗] Unsupported arch for tusd${NC}"; exit 1 ;;
    esac

    local version="v2.5.0"
    local tarball="tusd_${os_name}_${arch}.tar.gz"
    local url="https://github.com/tus/tusd/releases/download/${version}/${tarball}"

    mkdir -p "$TUSD_DIR_BIN"
    echo -e "${BLUE}[i] Downloading tusd ${version}...${NC}"
    if command -v curl &>/dev/null; then
        curl -sSL "$url" -o "${TUSD_DIR_BIN}/${tarball}"
    elif command -v wget &>/dev/null; then
        wget -q "$url" -O "${TUSD_DIR_BIN}/${tarball}"
    else
        echo -e "${RED}[✗] curl or wget required to download tusd${NC}"
        exit 1
    fi

    tar -xzf "${TUSD_DIR_BIN}/${tarball}" -C "$TUSD_DIR_BIN"
    rm -f "${TUSD_DIR_BIN}/${tarball}"
    chmod +x "$TUSD_DIR_BIN/tusd_${os_name}_${arch}/tusd" 2>/dev/null || true

    # The binary is inside a subdirectory; move it up
    local extracted_dir="${TUSD_DIR_BIN}/tusd_${os_name}_${arch}"
    if [ -f "${extracted_dir}/tusd" ]; then
        mv "${extracted_dir}/tusd" "$TUSD_BIN"
        rm -rf "$extracted_dir"
    fi

    echo -e "${GREEN}[✓] tusd installed at $TUSD_BIN${NC}"
}

if [ ! -f "$TUSD_BIN" ]; then
    install_tusd
fi

TUSD_DATA="${TUSD_DATA:-${UPLOAD_DIR:-./uploads}/.tusd}"
mkdir -p "$TUSD_DATA"

# ── Start tusd in background ────────────────────────────────────────────────
echo -e "${BLUE}[i] Starting tusd on port ${TUSD_PORT}...${NC}"
if [ -n "$TUSD_HOOK_SECRET" ]; then
    "$TUSD_BIN" \
        -host="0.0.0.0" \
        -port="$TUSD_PORT" \
        -dir="$TUSD_DATA" \
        -hooks-http="$TUSD_HOOK_URL" \
        -hooks-http-forward-headers="Hook-Secret:${TUSD_HOOK_SECRET}" \
        -hooks-enabled-events="post-finish" \
        &
else
    "$TUSD_BIN" \
        -host="0.0.0.0" \
        -port="$TUSD_PORT" \
        -dir="$TUSD_DATA" \
        &
fi
TUSD_PID=$!
echo -e "${GREEN}[✓] tusd running (PID $TUSD_PID)${NC}"

# Cleanup on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}[i] Shutting down...${NC}"
    if [ -n "$TUSD_PID" ] && kill -0 "$TUSD_PID" 2>/dev/null; then
        kill "$TUSD_PID" 2>/dev/null || true
        echo -e "${GREEN}[✓] tusd stopped${NC}"
    fi
    exit 0
}
trap cleanup SIGINT SIGTERM

# ── Start the Flask server ──────────────────────────────────────────────────
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  VpsEasyUploader — Starting...           ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Flask:   ${CYAN}http://${IP}:${PORT}${NC}"
echo -e "  tusd:    ${CYAN}http://127.0.0.1:${TUSD_PORT}${NC}"
echo -e "  Log:     ${YELLOW}${LOG_LEVEL}${NC}"
echo ""
echo -e "  Press ${RED}Ctrl+C${NC} to stop"
echo ""

# Start Waitress in production mode
python -m waitress \
    --host="$IP" \
    --port="$PORT" \
    --threads=8 \
    --channel-timeout=120 \
    app:app
