# VpsEasyUploader

**A personal file upload server for a single admin — simple, secure, and production-ready.**

VpsEasyUploader gives you a private web dashboard where you can upload, preview, rename, and delete files. It runs on any VPS and supports **resumable uploads** for huge files (tested with 6 GB+), so dropped connections or browser refreshes won't lose your progress.

---

## Features

- 🔐 **Single admin account** — no public registration, just one password.
- 📤 **Resumable chunked uploads** — huge files survive disconnections, browser refreshes, and cache clears.
- 💾 **Disk space checks** — space is reserved before uploading to prevent mid-transfer failures.
- 🖼️ **Previews & thumbnails** — images preview in a modal; videos get auto-generated thumbnails via ffmpeg.
- 📁 **Full file management** — rename, move, delete, download — all from a responsive dashboard.
- 📱 **Mobile-friendly UI** — Bootstrap 5, works on phones and tablets.
- 🚀 **Easy VPS setup** — two scripts (`setup.sh`, `run.sh`) get you running in minutes.
- 🔄 **Systemd service** — optional auto-start and survive reboots.
- 🧪 **Tested** — pytest and Playwright browser tests included.

---

## Quick Start

```bash
git clone <your-repo-url> VpsEasyUploader
cd VpsEasyUploader
chmod +x setup.sh run.sh
./setup.sh
./run.sh
```

Then open `http://<your-server-ip>:8080` in your browser. On first visit, you'll set your admin password.

---

## Prerequisites

- **Python 3.8+** and **pip**
- **ffmpeg** (optional — for video thumbnails)
  - Ubuntu/Debian: `sudo apt install ffmpeg`
  - CentOS/RHEL: `sudo dnf install ffmpeg`
- **git** (optional — for version control)

---

## Manual Setup

If you prefer to configure manually:

```bash
# 1. Clone and enter the project
git clone <your-repo-url> VpsEasyUploader
cd VpsEasyUploader

# 2. Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate   # Linux/Mac
# venv\Scripts\activate    # Windows

# 3. Install dependencies
pip install -r requirements.txt

# 4. Create .env from the example
cp .env.example .env
# Edit .env with your settings (IP, PORT, etc.)

# 5. Generate a secret key (optional)
python3 -c "import secrets; print(secrets.token_hex(32))"
# Paste the output as SECRET_KEY in .env

# 6. Start the server
python app.py
# OR for production:
python -m waitress --host=0.0.0.0 --port=8080 app:app
```

On the first visit to the server, you'll be prompted to set your admin password. The password hash is stored in `auth.json` (never in `.env`).

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `IP` | `0.0.0.0` | Server IP to bind to |
| `PORT` | `8080` | Server port |
| `SECRET_KEY` | *(auto-generated)* | Flask session secret |
| `LOG_LEVEL` | `WARNING` | Logging verbosity (`DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`) |
| `CHUNK_SIZE_MB` | `5` | Size of each upload chunk in MB |
| `DOMAIN` | *(optional)* | Domain name for HTTPS |
| `SSL_CERT` | *(optional)* | Path to SSL certificate |
| `SSL_KEY` | *(optional)* | Path to SSL private key |

---

## Systemd Service

To have the server start automatically on boot:

```bash
./run.sh --service
```

Or during setup, answer `y` when asked about systemd. Manual commands:

```bash
sudo systemctl start vpseasyuploader
sudo systemctl stop vpseasyuploader
sudo systemctl status vpseasyuploader
sudo journalctl -u vpseasyuploader -f   # View logs
```

---

## Running Tests

```bash
# Install test dependencies
pip install pytest playwright
playwright install chromium

# Run backend tests
pytest tests/ -v

# Run browser test (start the server first)
python app.py &
python tests/test_browser.py
```

---

## Project Structure

```
VpsEasyUploader/
├── app.py                  # Main Flask application
├── requirements.txt        # Python dependencies
├── setup.sh                # Interactive setup script
├── run.sh                  # Start script (with --service for systemd)
├── .env.example            # Environment template
├── .gitignore
├── README.md
├── templates/              # Jinja2 HTML templates
│   ├── login.html
│   ├── register.html
│   └── index.html
├── static/                 # Frontend assets
│   ├── css/style.css
│   └── js/
│       ├── uploader.js     # Resumable upload logic
│       └── dashboard.js    # File browser & UI
├── utils/                  # Backend helpers
│   ├── auth.py             # Password hashing & session
│   ├── file_ops.py         # File listing, thumbnails, move/delete
│   └── chunker.py          # Resumable upload engine
├── tests/                  # Test suite
│   ├── test_auth.py        # Authentication tests
│   ├── test_chunks.py      # Upload + chunk tests
│   └── test_browser.py     # End-to-end browser test
└── uploads/                # (gitignored) Uploaded files
    ├── .chunks/            # Incomplete chunk storage
    └── .thumbnails/        # Generated video thumbnails
```

---

## Resumable Uploads — How It Works

1. **Init**: Client generates a UUID and tells the server `filename` + `total_size`. Server reserves disk space.
2. **Chunks**: Client splits the file into configurable chunks (default 5 MB). Each chunk is sent as multipart form data.
3. **Status**: Before uploading chunks, the client checks which chunks the server already has (for resume).
4. **Complete**: After all chunks are uploaded, server concatenates them into the final file.
5. **Recovery**: If the browser tab is closed or crashes, re-selecting the same file detects the incomplete upload and resumes from where it left off.
6. **Cleanup**: Incomplete uploads older than 7 days are automatically removed.

---

## Security Notes

- Admin password is hashed with `werkzeug.security` (PBKDF2 + SHA256) and stored in `auth.json` with `0600` permissions.
- Session cookies are `HttpOnly` and `SameSite=Lax`.
- All upload/file-management routes require a valid session.
- File paths are validated to prevent directory traversal.
- Always set a strong `SECRET_KEY` in production.

---

## License

MIT — feel free to use, modify, and share.

---

## Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you'd like to change.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
