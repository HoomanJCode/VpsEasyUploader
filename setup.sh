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

# ── OS Detection & Package Manager ──────────────────────────────────────────
DISTRO="unknown"
PKG_MANAGER=""
PKG_INSTALL_CMD=""

if [[ "$OSTYPE" == "linux-gnu"* ]] || [[ "$OSTYPE" == "linux"* ]]; then
    # Check for Debian/Ubuntu (apt)
    if command -v apt-get &>/dev/null; then
        DISTRO="debian"
        PKG_MANAGER="apt"
        PKG_INSTALL_CMD="sudo apt-get install -y"
    # Check for RHEL/CentOS/Fedora (dnf)
    elif command -v dnf &>/dev/null; then
        DISTRO="rhel"
        PKG_MANAGER="dnf"
        PKG_INSTALL_CMD="sudo dnf install -y"
    # Check for older RHEL/CentOS (yum)
    elif command -v yum &>/dev/null; then
        DISTRO="rhel"
        PKG_MANAGER="yum"
        PKG_INSTALL_CMD="sudo yum install -y"
    # Check for Arch (pacman)
    elif command -v pacman &>/dev/null; then
        DISTRO="arch"
        PKG_MANAGER="pacman"
        PKG_INSTALL_CMD="sudo pacman -S --noconfirm"
    # Check for Alpine (apk)
    elif command -v apk &>/dev/null; then
        DISTRO="alpine"
        PKG_MANAGER="apk"
        PKG_INSTALL_CMD="sudo apk add"
    fi
fi

# Parse --yes flag for non-interactive mode
SKIP_CONFIRM=false
for arg in "$@"; do
    if [[ "$arg" == "-y" ]] || [[ "$arg" == "--yes" ]]; then
        SKIP_CONFIRM=true
    fi
done

has_sudo() {
    # Check if we can run sudo without a password (or with cached credentials)
    sudo -n true 2>/dev/null
}

install_system_packages() {
    local description="$1"
    shift
    local pkgs=("$@")
    local missing=()

    # Determine which packages are actually missing
    # First try binary detection (works on all distros), then package-manager queries
    for pkg in "${pkgs[@]}"; do
        local found=false
        # Map common package names to their binaries for quick detection
        case "$pkg" in
            python3|python)   command -v python3 &>/dev/null && found=true ;;
            python3-pip|python-pip|py3-pip) command -v pip3 &>/dev/null && found=true ;;
            python3-venv)     python3 -m venv --help &>/dev/null 2>&1 && found=true ;;
            ffmpeg)           command -v ffmpeg &>/dev/null && found=true ;;
        esac

        if $found; then
            continue  # Already available, skip
        fi

        # Fall back to package-manager queries (Debian/RHEL)
        if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed"; then
            if ! rpm -q "$pkg" &>/dev/null 2>&1; then
                missing+=("$pkg")
            fi
        fi
    done

    # If nothing is missing, we're done
    if [ ${#missing[@]} -eq 0 ]; then
        return 0
    fi

    echo -e "${YELLOW}[!] Missing ${description}: ${missing[*]}${NC}"

    if [ -z "$PKG_INSTALL_CMD" ]; then
        echo -e "${RED}[✗] Cannot auto-install — no supported package manager detected.${NC}"
        echo -e "${RED}    Please install manually: ${missing[*]}${NC}"
        return 1
    fi

    # Ask for confirmation (unless --yes flag)
    if ! $SKIP_CONFIRM; then
        echo -e "${BLUE}[i] Will run: ${PKG_INSTALL_CMD} ${missing[*]}${NC}"
        read -rp "Proceed with installation? [Y/n] " confirm
        if [[ "$confirm" =~ ^[Nn]$ ]]; then
            echo -e "${YELLOW}[!] Skipped. Please install ${missing[*]} manually and re-run setup.${NC}"
            return 1
        fi
    fi

    # Check if we have sudo access
    if [[ "$PKG_INSTALL_CMD" == sudo* ]] && ! has_sudo; then
        echo -e "${YELLOW}[!] Sudo required. You may be prompted for your password.${NC}"
    fi

    # Update apt cache first if on Debian
    if [ "$PKG_MANAGER" = "apt" ]; then
        echo -e "${BLUE}[i] Updating apt package cache...${NC}"
        sudo apt-get update -qq 2>/dev/null || true
    fi

    echo -e "${BLUE}[i] Installing: ${missing[*]}...${NC}"
    if $PKG_INSTALL_CMD "${missing[@]}"; then
        echo -e "${GREEN}[✓] ${description} installed successfully${NC}"
        return 0
    else
        echo -e "${RED}[✗] Failed to install ${description}. Please install manually.${NC}"
        return 1
    fi
}

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

# ── Install System Dependencies ──────────────────────────────────────────────
echo -e "${CYAN}[1/7] Installing system dependencies...${NC}"

# Map package names per distro for Python
PYTHON3_PKG="python3"
PIP_PKG="python3-pip"
VENV_PKG="python3-venv"
FFMPEG_PKG="ffmpeg"

case "$PKG_MANAGER" in
    dnf|yum)
        PYTHON3_PKG="python3"
        PIP_PKG="python3-pip"
        VENV_PKG="python3"  # venv is bundled with python3 on RHEL
        ;;
    pacman)
        PYTHON3_PKG="python"
        PIP_PKG="python-pip"
        VENV_PKG="python"
        ;;
    apk)
        PYTHON3_PKG="python3"
        PIP_PKG="py3-pip"
        VENV_PKG="python3"
        ;;
esac

# Install Python + pip + venv
install_system_packages "Python 3 toolchain" "$PYTHON3_PKG" "$PIP_PKG" "$VENV_PKG" || {
    echo -e "${RED}[✗] Python 3 is required. Install it manually and re-run setup.${NC}"
    exit 1
}

# Verify Python is now available
if ! command -v python3 &>/dev/null; then
    echo -e "${RED}[✗] Python 3 is still not available after install. Please check your system.${NC}"
    exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
echo -e "${GREEN}[✓] Python $PYTHON_VERSION${NC}"

# Verify pip is available now
if ! command -v pip3 &>/dev/null && ! python3 -m pip --version &>/dev/null; then
    echo -e "${RED}[✗] pip is still not available after install. Please check your system.${NC}"
    exit 1
fi
echo -e "${GREEN}[✓] pip available${NC}"

# Install ffmpeg for video thumbnail generation (optional but recommended)
echo ""
if command -v ffmpeg &>/dev/null; then
    echo -e "${GREEN}[✓] ffmpeg found (video thumbnails enabled)${NC}"
else
    echo -e "${YELLOW}[i] ffmpeg not found — video thumbnails will be unavailable.${NC}"
    if [ -n "$PKG_INSTALL_CMD" ]; then
        _install_ffmpeg=false
        if $SKIP_CONFIRM; then
            _install_ffmpeg=true
        else
            read -rp "Install ffmpeg for video thumbnail support? [Y/n] " inst_ffmpeg
            if [[ ! "$inst_ffmpeg" =~ ^[Nn]$ ]]; then
                _install_ffmpeg=true
            fi
        fi

        if $_install_ffmpeg; then
            # Temporarily skip the internal confirm since user already agreed
            _saved_skip="$SKIP_CONFIRM"
            SKIP_CONFIRM=true
            install_system_packages "ffmpeg" "$FFMPEG_PKG" || true
            SKIP_CONFIRM="$_saved_skip"
        else
            echo -e "${BLUE}[i] Skipped ffmpeg. Video thumbnails will not be generated.${NC}"
        fi
    fi
fi

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
ExecStart=$SCRIPT_DIR/venv/bin/python -m waitress --host=$SERVER_IP --port=$SERVER_PORT --threads=8 app:app
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
