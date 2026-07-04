#!/usr/bin/env bash
# =============================================================================
# VpsEasyUploader — Setup Script
#
# Interactive first-run configuration:
#   - Checks Python 3 and pip
#   - Creates virtual environment
#   - Installs dependencies
#   - Configures .env (IP, PORT, SECRET_KEY, etc.)
#   - Optionally installs systemd service
#   - Initializes git repository
#
# Usage: ./setup.sh
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

# ── Banner ──────────────────────────────────────────────────────────────────
echo -e "${BLUE}"
echo "╔══════════════════════════════════════════╗"
echo "║       VpsEasyUploader — Setup           ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ── Check for existing .env ─────────────────────────────────────────────────
if [ -f ".env" ]; then
    echo -e "${YELLOW}[!] An existing .env file was found.${NC}"
    read -rp "Do you want to reconfigure? [y/N] " reconfirm
    if [[ "$reconfirm" =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}[i] Backing up existing .env to .env.bak${NC}"
        cp .env .env.bak
    else
        echo -e "${GREEN}[✓] Keeping existing configuration.${NC}"
        echo -e "${BLUE}[i] Run 'rm .env && ./setup.sh' to force reconfiguration.${NC}"
        exit 0
    fi
fi

# ── Check Python 3 ──────────────────────────────────────────────────────────
echo -e "${CYAN}[1/7] Checking Python 3...${NC}"
if ! command -v python3 &>/dev/null; then
    echo -e "${RED}[✗] Python 3 is not installed. Please install Python 3.8+ and try again.${NC}"
    echo "    Ubuntu/Debian: sudo apt install python3 python3-pip python3-venv"
    echo "    CentOS/RHEL:   sudo dnf install python3 python3-pip"
    exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
echo -e "${GREEN}[✓] Found $PYTHON_VERSION${NC}"

# Check pip
if ! command -v pip3 &>/dev/null && ! python3 -m pip --version &>/dev/null; then
    echo -e "${RED}[✗] pip is not installed. Please install python3-pip.${NC}"
    exit 1
fi
echo -e "${GREEN}[✓] pip available${NC}"

# ── Virtual environment ─────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[2/7] Setting up Python virtual environment...${NC}"

if [ ! -d "venv" ]; then
    python3 -m venv venv
    echo -e "${GREEN}[✓] Virtual environment created in ./venv${NC}"
else
    echo -e "${BLUE}[i] Virtual environment already exists, skipping creation.${NC}"
fi

# Activate and install dependencies
# shellcheck disable=SC1090
source venv/bin/activate 2>/dev/null || source venv/Scripts/activate 2>/dev/null
echo -e "${BLUE}[i] Installing dependencies from requirements.txt...${NC}"
pip install --upgrade pip -q
pip install -r requirements.txt -q
echo -e "${GREEN}[✓] Dependencies installed${NC}"

# ── Interactive configuration ───────────────────────────────────────────────
echo ""
echo -e "${CYAN}[3/7] Configuring server settings...${NC}"

# IP address
echo ""
echo -e "${BLUE}Server IP address (default: 0.0.0.0)${NC}"
echo "  0.0.0.0 = listen on all network interfaces"
echo "  127.0.0.1 = localhost only"
read -rp "IP address [0.0.0.0]: " SERVER_IP
SERVER_IP=${SERVER_IP:-0.0.0.0}

# Port
echo ""
read -rp "Port [8080]: " SERVER_PORT
SERVER_PORT=${SERVER_PORT:-8080}

# Admin password
echo ""
echo -e "${BLUE}Set admin password (for web login)${NC}"
while true; do
    read -rsp "Enter admin password (min 8 characters, hidden): " ADMIN_PASSWORD
    echo ""
    if [ ${#ADMIN_PASSWORD} -lt 8 ]; then
        echo -e "${RED}[!] Password must be at least 8 characters.${NC}"
        continue
    fi
    read -rsp "Confirm password: " ADMIN_CONFIRM
    echo ""
    if [ "$ADMIN_PASSWORD" != "$ADMIN_CONFIRM" ]; then
        echo -e "${RED}[!] Passwords do not match. Please try again.${NC}"
        continue
    fi
    break
done
echo -e "${GREEN}[✓] Password set${NC}"

# Domain / HTTPS
echo ""
echo -e "${BLUE}HTTPS Configuration (optional)${NC}"
read -rp "Do you want to configure HTTPS with a domain name? [y/N] " USE_HTTPS
DOMAIN=""
SSL_CERT=""
SSL_KEY=""

if [[ "$USE_HTTPS" =~ ^[Yy]$ ]]; then
    read -rp "Domain name (e.g., files.example.com): " DOMAIN
    read -rp "Path to SSL certificate file: " SSL_CERT
    read -rp "Path to SSL private key file: " SSL_KEY

    if [ ! -f "$SSL_CERT" ]; then
        echo -e "${YELLOW}[!] Warning: Certificate file not found at $SSL_CERT${NC}"
    fi
    if [ ! -f "$SSL_KEY" ]; then
        echo -e "${YELLOW}[!] Warning: Key file not found at $SSL_KEY${NC}"
    fi
fi

# Chunk size
echo ""
echo -e "${BLUE}Upload chunk size (for resumable uploads)${NC}"
echo "  Larger chunks = fewer HTTP requests but more memory per request."
echo "  5 MB is a good default for most VPS setups."
read -rp "Chunk size in MB [5]: " CHUNK_SIZE
CHUNK_SIZE=${CHUNK_SIZE:-5}

# Log level
echo ""
echo -e "${BLUE}Log level${NC}"
echo "  Options: DEBUG, INFO, WARNING, ERROR, CRITICAL"
read -rp "Log level [WARNING]: " LOG_LEVEL
LOG_LEVEL=${LOG_LEVEL:-WARNING}

# ── Generate .env ───────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[4/7] Generating .env file...${NC}"

# Generate a random secret key
SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")

cat > .env <<EOF
# VpsEasyUploader Configuration — generated by setup.sh
IP=$SERVER_IP
PORT=$SERVER_PORT
SECRET_KEY=$SECRET_KEY
LOG_LEVEL=$LOG_LEVEL
CHUNK_SIZE_MB=$CHUNK_SIZE
EOF

if [ -n "$DOMAIN" ]; then
    cat >> .env <<EOF
DOMAIN=$DOMAIN
SSL_CERT=$SSL_CERT
SSL_KEY=$SSL_KEY
EOF
fi

echo -e "${GREEN}[✓] .env file created${NC}"

# Hash the admin password and save to auth.json
python3 -c "
from werkzeug.security import generate_password_hash
import json, os
hash = generate_password_hash('$ADMIN_PASSWORD')
with open('auth.json', 'w') as f:
    json.dump({'password_hash': hash}, f, indent=2)
os.chmod('auth.json', 0o600)
print('Password hash saved to auth.json')
"
echo -e "${GREEN}[✓] Admin password stored in auth.json${NC}"

# ── Systemd service (optional) ──────────────────────────────────────────────
echo ""
echo -e "${CYAN}[5/7] Systemd service configuration...${NC}"
read -rp "Install systemd service so the server starts on boot? [y/N] " INSTALL_SERVICE

if [[ "$INSTALL_SERVICE" =~ ^[Yy]$ ]]; then
    SERVICE_NAME="vpseasyuploader"
    SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
    CURRENT_USER=$(whoami)
    CURRENT_GROUP=$(id -gn)

    echo -e "${BLUE}[i] Creating systemd service file...${NC}"

    # Generate the service file
    sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=VpsEasyUploader — Personal File Upload Server
After=network.target

[Service]
Type=simple
User=$CURRENT_USER
Group=$CURRENT_GROUP
WorkingDirectory=$SCRIPT_DIR
ExecStart=$SCRIPT_DIR/venv/bin/python -m waitress --host=$SERVER_IP --port=$SERVER_PORT app:app
Restart=always
RestartSec=5
Environment="PATH=$SCRIPT_DIR/venv/bin:/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=multi-user.target
EOF

    echo -e "${GREEN}[✓] Service file created at $SERVICE_FILE${NC}"

    # Reload systemd and enable
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME" 2>/dev/null || true
    echo -e "${GREEN}[✓] Service enabled. Start it with: sudo systemctl start $SERVICE_NAME${NC}"
    echo -e "${BLUE}[i] Or use: ./run.sh --service${NC}"
else
    echo -e "${BLUE}[i] Skipping systemd service installation.${NC}"
fi

# ── UFW firewall configuration (if available) ───────────────────────────────
echo -e "${CYAN}[6/7] UFW firewall configuration...${NC}"
if command -v ufw &>/dev/null && sudo -n true 2>/dev/null; then
    echo -e "${BLUE}[i] UFW firewall detected.${NC}"
    echo -e "${BLUE}[i] Adding rule to allow TCP on port $SERVER_PORT...${NC}"
    sudo ufw allow "$SERVER_PORT/tcp" 2>/dev/null && \
        echo -e "${GREEN}[✓] UFW rule added for port $SERVER_PORT/tcp${NC}" || \
        echo -e "${YELLOW}[!] Could not add UFW rule (maybe not running as root).${NC}"
    echo ""
elif command -v ufw &>/dev/null; then
    echo -e "${YELLOW}[!] UFW is installed but needs sudo to configure.${NC}"
    echo -e "${YELLOW}    Run the following manually after setup:${NC}"
    echo -e "    ${CYAN}sudo ufw allow $SERVER_PORT/tcp${NC}"
    echo ""
fi

# ── Git initialization ──────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[7/7] Initializing git repository...${NC}"

if [ ! -d ".git" ]; then
    git init
    git add -A
    git commit -m "Initial commit: VpsEasyUploader setup

- Flask application with resumable chunked uploads
- Web-based file management dashboard
- Bootstrap 5 responsive UI
- Setup and run scripts for easy deployment
- Pytest test suite"
    echo -e "${GREEN}[✓] Git repository initialized with initial commit${NC}"
else
    echo -e "${BLUE}[i] Git repository already exists, skipping.${NC}"
fi

# ── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║        Setup Complete!                   ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Start the server:  ${YELLOW}./run.sh${NC}"
echo -e "  Service:           ${YELLOW}./run.sh --service${NC}"
echo -e "  Reconfigure:       ${YELLOW}./setup.sh${NC}"
echo ""
echo -e "  Server:  ${CYAN}http://${SERVER_IP}:${SERVER_PORT}${NC}"
echo ""
