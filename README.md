# VpsEasyUploader

[![License: MIT](https://img.shields.io/github/license/HoomanJCode/VpsEasyUploader)](https://github.com/HoomanJCode/VpsEasyUploader/blob/master/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/HoomanJCode/VpsEasyUploader)](https://github.com/HoomanJCode/VpsEasyUploader)
[![GitHub issues](https://img.shields.io/github/issues/HoomanJCode/VpsEasyUploader)](https://github.com/HoomanJCode/VpsEasyUploader/issues)

**A personal file upload server for a single admin — simple, secure, and production-ready.**

VpsEasyUploader gives you a private web dashboard where you can upload, preview, rename, and delete files. It runs on any VPS and supports **resumable uploads** for huge files (tested with 6 GB+), so dropped connections or browser refreshes won't lose your progress.

---

## Features

- 🔐 **Single admin account** — no public registration, just one password.
- 📤 **Resumable uploads via TUS protocol** — huge files survive disconnections, browser refreshes, and cache clears. Powered by [Uppy](https://uppy.io) + [tusd](https://github.com/tus/tusd).
- ⚡ **Parallel chunked uploads** — 20 MB chunks streamed concurrently through the TUS protocol, saturating high-bandwidth connections.
- 🖼️ **Previews & thumbnails** — images preview in a modal; videos get auto-generated thumbnails via ffmpeg.
- 📁 **Full file management** — rename, move, delete, download — all from a responsive dashboard.
- 📱 **Mobile-friendly UI** — Bootstrap 5 + Uppy Dashboard, works on phones and tablets.
- 🚀 **Easy VPS setup** — two scripts (`setup.sh`, `run.sh`) get you running in minutes. `./run.sh` auto-downloads and starts tusd alongside Flask.
- 🔄 **Systemd service** — optional auto-start on boot (starts Flask + tusd together).
- 🧪 **Tested** — Python `pytest` suite and a Playwright browser test.

---

## Quick Start

```bash
git clone https://github.com/HoomanJCode/VpsEasyUploader VpsEasyUploader
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
git clone https://github.com/HoomanJCode/VpsEasyUploader VpsEasyUploader
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
 | `TUSD_HOOK_SECRET` | *(auto-generated)* | Shared secret between tusd and Flask webhook |
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
# Python (backend) tests
source venv/bin/activate    # Linux/Mac
pip install pytest playwright
playwright install chromium
pytest tests/ -v

# End-to-end browser test (start the server first)
python app.py &
python tests/test_browser.py
```

---

## Project Structure

```
VpsEasyUploader/
├── app.py                  # Main Flask application + TUS webhook
├── requirements.txt        # Python dependencies
├── setup.sh                # Interactive setup (installs deps, tusd, configures .env)
├── run.sh                  # Start script (auto-downloads tusd, starts Flask + tusd)
├── stop.sh                 # Stop script
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
│       ├── uppy-init.js    # Uppy Dashboard + TUS client configuration
│       └── dashboard.js    # File browser, disk info, modals
├── utils/                  # Backend helpers
│   ├── auth.py             # Password hashing & session
│   ├── csrf.py             # CSRF token generation + decorator
│   └── file_ops.py         # File listing, thumbnails, move/delete
├── tests/                  # Test suite
│   ├── test_auth.py        # Authentication tests
│   └── test_browser.py     # End-to-end browser test (Playwright)
└── uploads/                # (gitignored) Uploaded files
    ├── .tusd/              # tusd in-progress upload storage
    └── .thumbnails/        # Generated video thumbnails
```

---

## Resumable Uploads — How It Works

VpsEasyUploader uses the [TUS protocol](https://tus.io) — the industry standard for resumable file uploads — via two components:

| Layer | Component | Role |
|---|---|---|
| **Client** | [Uppy.js](https://uppy.io) Dashboard | Drag-drop UI, file selection, progress bars, chunking, pause/resume — all handled in the browser |
| **Server** | [tusd](https://github.com/tus/tusd) | Lightweight Go binary that receives and stores upload chunks via the TUS protocol |
| **App** | Flask | Dashboard, authentication, file browsing, and a `/tus-hook` webhook called by tusd when uploads complete |

### Upload flow

1. **User selects files** in the Uppy Dashboard (drag-drop or browse).
2. **Uppy streams chunks** (20 MB each) directly to tusd on port 1080 via the TUS protocol. Chunks are sent in parallel for maximum throughput.
3. **tusd stores chunks** in `uploads/.tusd/` as they arrive. If the connection drops, tusd remembers the upload offset — Uppy resumes from exactly where it left off on the next attempt.
4. **On completion**, tusd fires a POST webhook to Flask's `/tus-hook` endpoint. Flask moves the completed file from `.tusd/` into the main `uploads/` directory and generates a video thumbnail if applicable.
5. **The file appears** in the dashboard file browser immediately.

### Why TUS instead of a custom chunked system

- **Standard protocol** — interoperable with any TUS-compatible client or server.
- **Resume is built-in** — no custom fingerprinting, UUID generation, or chunk tracking code.
- **Concurrent chunking** — tusd handles parallel chunk uploads natively; no need for a custom worker pool.
- **Mature and battle-tested** — tusd is the official reference TUS server, used in production by Transloadit, Vimeo, and others.

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

PRs and issues welcome on [GitHub](https://github.com/HoomanJCode/VpsEasyUploader). For major changes, please [open an issue](https://github.com/HoomanJCode/VpsEasyUploader/issues/new) first to discuss what you'd like to change.

1. Fork the [repository](https://github.com/HoomanJCode/VpsEasyUploader)
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a [Pull Request](https://github.com/HoomanJCode/VpsEasyUploader/pulls)
