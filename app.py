"""
VpsEasyUploader — Personal file upload server for a single admin.

A Flask application with TUS-powered resumable uploads,
web-based file management, and easy setup for VPS deployment.

Run with: python app.py   (development)
Or via run.sh which starts Waitress + tusd for production.
"""

import logging
import os
import secrets
import sys
from pathlib import Path

from dotenv import load_dotenv
from flask import (
    Flask,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
)

# Load environment variables from .env file
load_dotenv()

# ---- Flask App Setup ----
app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "dev-secret-change-me")

# Session configuration
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["PERMANENT_SESSION_LIFETIME"] = 86400  # 24 hours

# Custom config from .env
app.config["LOG_LEVEL"] = os.getenv("LOG_LEVEL", "WARNING")

# ---- Logging Setup ----
log_level = getattr(logging, app.config["LOG_LEVEL"].upper(), logging.WARNING)
logging.basicConfig(
    level=log_level,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("VpsEasyUploader")

# Import utilities after app setup (they depend on app context for config)
from utils.auth import is_registered, load_password_hash, hash_password, verify_password, save_password_hash, login_required
from utils.csrf import csrf_required, get_csrf_token
from utils.file_ops import (
    list_files,
    delete_file,
    move_file,
    get_disk_usage,
    generate_video_thumbnail,
    get_thumbnail_path,
    get_file_path,
    UPLOAD_DIR,
    THUMBNAIL_DIR,
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
)

# Directory where tusd stores in-progress uploads (tusd writes completed
# files here; the /tus-hook webhook moves them to UPLOAD_DIR).
TUSD_DIR = UPLOAD_DIR / ".tusd"

# Shared secret so only tusd can call the completion webhook
TUSD_HOOK_SECRET = os.getenv("TUSD_HOOK_SECRET", secrets.token_hex(32))

# Ensure required directories exist
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
TUSD_DIR.mkdir(parents=True, exist_ok=True)

# Store hook secret in .env so it's stable across restarts
if not os.getenv("TUSD_HOOK_SECRET"):
    with open(".env", "a") as _f:
        _f.write(f"\nTUSD_HOOK_SECRET={TUSD_HOOK_SECRET}\n")
    logger.info("Generated and saved TUSD_HOOK_SECRET to .env")

# ---- TUS Proxy: forwards TUS protocol requests to tusd (127.0.0.1:1080) ----
# The browser uses a same-origin /tus/ endpoint so no extra firewall
# port is needed on the VPS.  Large PATCH bodies (up to chunkSize) are
# buffered in memory — acceptable for a single-user uploader.
@app.route("/tus", defaults={"path": ""}, methods=["POST", "PATCH", "HEAD", "OPTIONS", "DELETE", "GET"])
@app.route("/tus/", defaults={"path": ""}, methods=["POST", "PATCH", "HEAD", "OPTIONS", "DELETE", "GET"])
@app.route("/tus/<path:path>", methods=["POST", "PATCH", "HEAD", "OPTIONS", "DELETE", "GET"])
def tus_proxy(path):
    """Proxy TUS protocol requests to tusd running on 127.0.0.1:1080."""
    import urllib.request
    import urllib.error

    tusd_url = f"http://127.0.0.1:1080/files/{path}"

    # Forward headers, skipping hop-by-hop and Host
    skip_headers = {"host", "connection", "transfer-encoding", "content-length"}
    forward_headers = {}
    for key, value in request.headers:
        if key.lower() not in skip_headers:
            forward_headers[key] = value

    # Read the request body (PATCH bodies are bounded by chunkSize, ~20 MB)
    body = request.get_data() if request.method in ("POST", "PATCH", "DELETE") else None

    req = urllib.request.Request(
        tusd_url,
        data=body,
        headers=forward_headers,
        method=request.method,
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            # Build response headers, skipping hop-by-hop
            response_headers = {}
            for key, value in resp.getheaders():
                if key.lower() not in skip_headers:
                    response_headers[key] = value
            return resp.read(), resp.status, response_headers
    except urllib.error.HTTPError as e:
        return e.read(), e.code, dict(e.headers.items())
    except Exception as e:
        logger.warning("TUS proxy error: %s", e)
        return jsonify({"error": "TUS backend unavailable — is tusd running?"}), 502


# ---- TUS Webhook: called by tusd when an upload completes ----
@app.route("/tus-hook", methods=["POST"])
def tus_hook():
    """
    Webhook called by tusd when an upload completes.
    Moves the completed file from TUSD_DIR to UPLOAD_DIR,
    generates thumbnails, and logs the completion.
    """
    import shutil

    # Verify the hook secret so only tusd can call this
    auth = request.headers.get("Hook-Secret", "")
    if not secrets.compare_digest(auth, TUSD_HOOK_SECRET):
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400

    upload = data.get("Upload", {})
    original_filename = (
        upload.get("MetaData", {}).get("filename") or
        upload.get("Metadata", {}).get("filename") or
        Path(upload.get("Storage", {}).get("Path", "")).name
    )

    size = upload.get("Size", 0)
    logger.info("TUS hook: upload complete — %s (%s bytes)", original_filename, size)

    if not original_filename or not isinstance(size, int) or size <= 0:
        return jsonify({"error": "Bad hook payload"}), 400

    # Determine source path from tusd's storage
    src_path_str = upload.get("Storage", {}).get("Path", "")
    if not src_path_str:
        return jsonify({"error": "No storage path in hook payload"}), 400

    src = Path(src_path_str)
    if not src.exists():
        logger.warning("TUS hook: source file not found — %s", src)
        return jsonify({"error": "Source file not found"}), 404

    # Determine target path (sanitize filename)
    sanitized = original_filename.strip().lstrip("/\\").rstrip("/\\")
    sanitized = sanitized.replace("\\", "/")
    parts = [p for p in sanitized.split("/") if p and p not in (".", "..")]
    dest_filename = "/".join(parts) if parts else sanitized

    try:
        dest = get_file_path(dest_filename)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    dest.parent.mkdir(parents=True, exist_ok=True)

    # If file already exists, append a suffix
    if dest.exists():
        stem = dest.stem
        suffix = dest.suffix
        counter = 1
        while dest.exists():
            dest = dest.parent / f"{stem}_{counter}{suffix}"
            counter += 1
        # Update dest_filename to reflect the actual resolved name
        dest_filename = str(dest.relative_to(UPLOAD_DIR))

    try:
        shutil.move(str(src), str(dest))
        logger.info("TUS hook: moved %s → %s", src.name, dest)
    except OSError as e:
        logger.exception("TUS hook: failed to move file")
        return jsonify({"error": str(e)}), 500

    # Generate video thumbnail if applicable
    ext = dest.suffix.lower()
    if ext in VIDEO_EXTENSIONS:
        generate_video_thumbnail(dest_filename)

    return jsonify({"success": True, "filename": dest_filename, "size": size})


# ---- Cache-busting version for static assets ----
_STATIC_DIR = Path(__file__).parent / "static"
_ASSET_VERSION = 0
if _STATIC_DIR.exists():
    for _p in _STATIC_DIR.rglob("*"):
        if _p.is_file():
            _ASSET_VERSION = max(_ASSET_VERSION, int(_p.stat().st_mtime))
logger.info("Asset version: %s", _ASSET_VERSION)


# ---- Routes: Authentication ----
@app.route("/register", methods=["GET", "POST"])
def register_page():
    """Registration page — only accessible when no admin password is set."""
    if is_registered():
        return redirect(url_for("index"))

    error = None
    if request.method == "POST":
        # Validate CSRF token
        expected = get_csrf_token()
        token = request.form.get("_csrf_token", "")
        if not token or not secrets.compare_digest(token, expected):
            return render_template("register.html", error="Invalid or missing CSRF token. Please refresh and try again.", csrf_token=get_csrf_token())

        password = request.form.get("password", "")
        confirm = request.form.get("confirm", "")

        if not password:
            error = "Password is required."
        elif len(password) < 8:
            error = "Password must be at least 8 characters."
        elif password != confirm:
            error = "Passwords do not match."
        else:
            password_hash = hash_password(password)
            save_password_hash(password_hash)
            session["logged_in"] = True
            session.permanent = True
            logger.info("Admin password set and logged in")
            return redirect(url_for("index"))

    return render_template("register.html", error=error, csrf_token=get_csrf_token(), asset_version=_ASSET_VERSION)


@app.route("/login", methods=["GET", "POST"])
def login_page():
    """Login page."""
    if not is_registered():
        return redirect(url_for("register_page"))

    if session.get("logged_in"):
        return redirect(url_for("index"))

    error = None
    if request.method == "POST":
        # Validate CSRF token
        expected = get_csrf_token()
        token = request.form.get("_csrf_token", "")
        if not token or not secrets.compare_digest(token, expected):
            return render_template("login.html", error="Invalid or missing CSRF token. Please refresh and try again.", csrf_token=get_csrf_token())

        password = request.form.get("password", "")
        stored_hash = load_password_hash()

        if stored_hash and verify_password(password, stored_hash):
            session["logged_in"] = True
            session.permanent = True
            logger.info("Admin logged in")
            return redirect(url_for("index"))
        else:
            error = "Invalid password."

    return render_template("login.html", error=error, csrf_token=get_csrf_token(), asset_version=_ASSET_VERSION)


@app.route("/logout")
def logout():
    """Log out the current session."""
    session.clear()
    return redirect(url_for("login_page"))


# ---- Routes: File Management ----
@app.route("/")
@login_required
def index():
    """Main dashboard page."""
    disk = get_disk_usage()
    return render_template(
        "index.html",
        disk=disk,
        csrf_token=get_csrf_token(),
        asset_version=_ASSET_VERSION,
    )


@app.route("/files")
@login_required
def files_api():
    """JSON endpoint: list all files with metadata."""
    try:
        files = list_files()
        return jsonify({"files": files})
    except Exception as e:
        logger.exception("Error listing files")
        return jsonify({"error": str(e)}), 500


@app.route("/files/<path:filename>")
@login_required
def serve_file(filename):
    """Serve an uploaded file directly."""
    from utils.file_ops import get_file_path

    try:
        target = get_file_path(filename)
        directory = str(target.parent)
        file_name = target.name
        return send_from_directory(directory, file_name)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/delete/<path:filename>", methods=["DELETE"])
@login_required
@csrf_required
def delete_file_route(filename):
    """Delete a file."""
    success = delete_file(filename)
    if success:
        logger.info("Deleted file: %s", filename)
        return jsonify({"success": True})
    return jsonify({"success": False, "error": "File not found or could not be deleted"}), 404


@app.route("/move", methods=["POST"])
@login_required
@csrf_required
def move_file_route():
    """Move/rename a file."""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"success": False, "error": "Invalid JSON"}), 400

    old_path = data.get("old_path", "")
    new_path = data.get("new_path", "")

    if not old_path or not new_path:
        return jsonify({"success": False, "error": "Both old_path and new_path are required"}), 400

    success, error = move_file(old_path, new_path)
    if success:
        logger.info("Moved file: %s -> %s", old_path, new_path)
        return jsonify({"success": True})
    return jsonify({"success": False, "error": error}), 400


# ---- Routes: Utilities ----
@app.route("/thumbnail/<path:filename>")
@login_required
def thumbnail(filename):
    """Serve a pre-generated video thumbnail, or 404."""
    thumb = get_thumbnail_path(filename)
    if thumb and thumb.exists():
        return send_from_directory(str(thumb.parent), thumb.name)
    return "Not found", 404


@app.route("/disk_usage")
@login_required
def disk_usage_api():
    """Get current disk usage info."""
    disk = get_disk_usage()
    return jsonify(disk)


# ---- Error Handlers ----
@app.errorhandler(404)
def not_found(_e):
    return jsonify({"error": "Not found"}), 404


@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": "File too large or insufficient disk space"}), 413


@app.errorhandler(500)
def server_error(_e):
    return jsonify({"error": "Internal server error"}), 500


# ---- Entry Point ----
if __name__ == "__main__":
    ip = os.getenv("IP", "0.0.0.0")
    port = int(os.getenv("PORT", "8080"))
    logger.info("Starting VpsEasyUploader on %s:%s", ip, port)
    app.run(host=ip, port=port, debug=(app.config["LOG_LEVEL"] == "DEBUG"))
