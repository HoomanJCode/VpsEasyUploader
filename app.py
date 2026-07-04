"""
VpsEasyUploader — Personal file upload server for a single admin.

A production-ready Flask application with resumable uploads,
web-based file management, and easy setup for VPS deployment.

Run with: python app.py   (development)
Or via run.sh which uses Waitress for production.
"""

import logging
import os
import secrets
import sys
import threading
import time
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
app.config["CHUNK_SIZE_MB"] = int(os.getenv("CHUNK_SIZE_MB", "5"))
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
    check_available_space,
    generate_video_thumbnail,
    get_thumbnail_path,
    UPLOAD_DIR,
    THUMBNAIL_DIR,
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
)
from utils.chunker import (
    init_upload,
    save_chunk,
    get_upload_status,
    complete_upload,
    list_incomplete_uploads,
    cleanup_expired_uploads,
    cleanup_upload as chunker_cleanup,
)

# Ensure required directories exist
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)


# ---- Periodic Cleanup Thread ----
def cleanup_loop():
    """Periodically clean up expired incomplete uploads (runs every hour)."""
    while True:
        time.sleep(3600)  # Run every hour
        try:
            cleaned = cleanup_expired_uploads()
            if cleaned > 0:
                logger.info("Cleaned up %d expired upload(s)", cleaned)
        except Exception:
            logger.exception("Error during upload cleanup")


cleanup_thread = threading.Thread(target=cleanup_loop, daemon=True)
cleanup_thread.start()


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

    return render_template("register.html", error=error, csrf_token=get_csrf_token())


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

    return render_template("login.html", error=error, csrf_token=get_csrf_token())


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
    incomplete = list_incomplete_uploads()
    # Format timestamps for template display
    from datetime import datetime
    for u in incomplete:
        ts = u.get("last_activity", 0)
        dt = datetime.fromtimestamp(ts)
        now = datetime.now()
        diff = now - dt
        if diff.total_seconds() < 60:
            u["last_activity_fmt"] = "Just now"
        elif diff.total_seconds() < 3600:
            u["last_activity_fmt"] = f"{int(diff.total_seconds() // 60)} min ago"
        elif diff.total_seconds() < 86400:
            u["last_activity_fmt"] = f"{int(diff.total_seconds() // 3600)} hr ago"
        elif diff.days < 7:
            u["last_activity_fmt"] = f"{diff.days} days ago"
        else:
            u["last_activity_fmt"] = dt.strftime("%b %d, %Y")
    return render_template(
        "index.html",
        disk=disk,
        incomplete_uploads=incomplete,
        csrf_token=get_csrf_token(),
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


# ---- Routes: Resumable Upload ----
@app.route("/upload/init", methods=["POST"])
@login_required
@csrf_required
def upload_init():
    """Initialize a resumable upload."""
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400

    filename = data.get("filename", "").strip()
    total_size = data.get("total_size", 0)
    upload_id = data.get("upload_id")
    file_fingerprint = data.get("file_fingerprint")

    if not filename:
        return jsonify({"error": "filename is required"}), 400
    if not isinstance(total_size, int) or total_size <= 0:
        return jsonify({"error": "total_size must be a positive integer"}), 400

    # Check for existing completed file (overwrite detection)
    from utils.file_ops import get_file_path as _resolver
    try:
        existing = _resolver(filename)
        if existing.exists():
            return jsonify({
                "error": f"A file named '{filename}' already exists.",
                "code": "FILE_EXISTS",
            }), 409
    except ValueError:
        pass

    try:
        result = init_upload(filename, total_size, upload_id, file_fingerprint)
        # Check for conflict (existing incomplete upload with same filename/size)
        if result.get("resumed"):
            return jsonify({
                "upload_id": result["upload_id"],
                "chunk_size": result["chunk_size"],
                "total_chunks": result["total_chunks"],
                "total_size": result["total_size"],
                "filename": result["filename"],
                "conflict": True,
                "existing_upload_id": result["existing_upload_id"],
            })
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 413
    except Exception as e:
        logger.exception("Error initializing upload")
        return jsonify({"error": str(e)}), 500


@app.route("/upload/status/<upload_id>")
@login_required
def upload_status(upload_id):
    """Get the status of a resumable upload."""
    status = get_upload_status(upload_id)
    if status is None:
        return jsonify({"error": "Upload not found"}), 404
    return jsonify(status)


@app.route("/upload/chunk", methods=["POST"])
@login_required
@csrf_required
def upload_chunk():
    """Receive a single chunk of an upload."""
    upload_id = request.form.get("upload_id", "")
    chunk_index_str = request.form.get("chunk_index", "")
    chunk_file = request.files.get("chunk_data")

    if not upload_id:
        return jsonify({"error": "upload_id is required"}), 400
    if not chunk_index_str:
        return jsonify({"error": "chunk_index is required"}), 400
    if not chunk_file:
        return jsonify({"error": "chunk_data file is required"}), 400

    try:
        chunk_index = int(chunk_index_str)
    except ValueError:
        return jsonify({"error": "chunk_index must be an integer"}), 400

    chunk_data = chunk_file.read()
    success = save_chunk(upload_id, chunk_index, chunk_data)

    if success:
        logger.debug("Chunk %d saved for upload %s", chunk_index, upload_id)
        return jsonify({"success": True, "chunk_index": chunk_index})
    return jsonify({"error": "Failed to save chunk"}), 400


@app.route("/upload/complete/<upload_id>", methods=["POST"])
@login_required
@csrf_required
def upload_complete(upload_id):
    """Finalize an upload by merging all chunks."""
    # Get the filename BEFORE completing (metadata is deleted on success)
    from utils.chunker import load_meta as chunker_load_meta
    meta = chunker_load_meta(upload_id)
    filename = meta.get("filename", "") if meta else None

    success, message = complete_upload(upload_id)
    if success:
        logger.info("Upload completed: %s (file=%s)", upload_id, filename)

        # Generate video thumbnail if applicable
        if filename:
            ext = Path(filename).suffix.lower()
            if ext in VIDEO_EXTENSIONS:
                generate_video_thumbnail(filename)

        return jsonify({"success": True, "message": message})

    return jsonify({"success": False, "error": message}), 400


@app.route("/upload/cancel/<upload_id>", methods=["DELETE"])
@login_required
@csrf_required
def upload_cancel(upload_id):
    """Cancel an incomplete upload and remove all its chunks/metadata."""
    chunker_cleanup(upload_id)
    logger.info("Upload cancelled: %s", upload_id)
    return jsonify({"success": True})


@app.route("/uploads/incomplete")
@login_required
def incomplete_uploads():
    """List all incomplete uploads."""
    incomplete = list_incomplete_uploads()
    return jsonify({"uploads": incomplete})


# ---- Routes: Utilities ----
@app.route("/check_space")
@login_required
def check_space():
    """Check if enough space is available for a given size."""
    size_str = request.args.get("size", "0")
    try:
        size = int(size_str)
    except ValueError:
        return jsonify({"available": False, "error": "size must be an integer"}), 400

    available = check_available_space(size)
    disk = get_disk_usage()
    return jsonify({
        "available": available,
        "free": disk["free"],
        "total": disk["total"],
    })


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
