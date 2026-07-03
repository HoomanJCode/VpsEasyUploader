"""
File operations utilities for VpsEasyUploader.

Handles listing files, disk usage, thumbnails, delete, rename/move.
"""

import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Project root (two levels up from this file)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
UPLOAD_DIR = PROJECT_ROOT / "uploads"
THUMBNAIL_DIR = UPLOAD_DIR / ".thumbnails"

# File extensions considered as images
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".ico"}

# File extensions considered as videos (for thumbnail generation)
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm", ".avi", ".mov", ".flv", ".wmv", ".m4v", ".mpg", ".mpeg"}

# File type icon mapping (extension -> Bootstrap Icons class)
FILE_ICONS = {
    ".zip": "bi-file-earmark-zip",
    ".rar": "bi-file-earmark-zip",
    ".7z": "bi-file-earmark-zip",
    ".tar": "bi-file-earmark-zip",
    ".gz": "bi-file-earmark-zip",
    ".pdf": "bi-filetype-pdf",
    ".doc": "bi-file-earmark-word",
    ".docx": "bi-file-earmark-word",
    ".xls": "bi-file-earmark-excel",
    ".xlsx": "bi-file-earmark-excel",
    ".ppt": "bi-file-earmark-ppt",
    ".pptx": "bi-file-earmark-ppt",
    ".txt": "bi-file-earmark-text",
    ".md": "bi-file-earmark-text",
    ".py": "bi-file-earmark-code",
    ".js": "bi-file-earmark-code",
    ".html": "bi-file-earmark-code",
    ".css": "bi-file-earmark-code",
    ".json": "bi-file-earmark-code",
    ".xml": "bi-file-earmark-code",
    ".csv": "bi-file-earmark-spreadsheet",
    ".mp3": "bi-file-earmark-music",
    ".wav": "bi-file-earmark-music",
    ".flac": "bi-file-earmark-music",
    ".aac": "bi-file-earmark-music",
}


def get_disk_usage() -> dict:
    """Return disk usage information for the uploads volume."""
    try:
        usage = shutil.disk_usage(UPLOAD_DIR)
        return {
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
        }
    except OSError:
        return {"total": 0, "used": 0, "free": 0}


def check_available_space(required_bytes: int) -> bool:
    """Check if there is enough free space for a file of required_bytes size."""
    disk = get_disk_usage()
    # Leave a 50 MB safety margin for the OS and other processes
    safety_margin = 50 * 1024 * 1024
    return disk["free"] >= (required_bytes + safety_margin)


def list_files() -> list[dict]:
    """
    List all files in the uploads directory (recursively).
    Returns a list of dicts with name, size, modified, is_image, is_video, thumbnail_url, icon.
    Excludes hidden directories (.chunks, .thumbnails) and .gitkeep.
    """
    files = []
    if not UPLOAD_DIR.exists():
        return files

    for entry in UPLOAD_DIR.rglob("*"):
        if entry.is_file():
            # Skip hidden directories
            rel_parts = entry.relative_to(UPLOAD_DIR).parts
            if any(p.startswith(".") for p in rel_parts):
                continue
            if entry.name == ".gitkeep":
                continue

            rel_path = str(entry.relative_to(UPLOAD_DIR)).replace("\\", "/")
            stat = entry.stat()
            ext = entry.suffix.lower()
            is_image = ext in IMAGE_EXTENSIONS
            is_video = ext in VIDEO_EXTENSIONS

            # Determine icon
            icon = FILE_ICONS.get(ext, "bi-file-earmark")

            # Check for thumbnail
            thumbnail_url = None
            thumb_path = THUMBNAIL_DIR / f"{entry.name}.jpg"
            if is_video and thumb_path.exists():
                thumbnail_url = f"/thumbnail/{rel_path}"
            elif is_image:
                thumbnail_url = f"/files/{rel_path}"

            files.append({
                "name": rel_path,
                "size": stat.st_size,
                "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                "is_image": is_image,
                "is_video": is_video,
                "thumbnail_url": thumbnail_url,
                "icon": icon,
            })

    # Sort by name
    files.sort(key=lambda f: f["name"].lower())
    return files


def get_file_path(relative_path: str) -> Path:
    """
    Resolve a relative path to an absolute path inside the uploads directory.
    Raises ValueError if the path tries to escape uploads/.
    """
    # Normalize and resolve the path
    base = UPLOAD_DIR.resolve()
    target = (base / relative_path).resolve()
    # Ensure the resolved path stays within the uploads directory
    if not str(target).startswith(str(base) + os.sep) and target != base:
        raise ValueError("Path escapes the uploads directory")
    return target


def delete_file(relative_path: str) -> bool:
    """Delete a file from uploads/. Returns True on success."""
    try:
        target = get_file_path(relative_path)
        if target.exists() and target.is_file():
            target.unlink()
            # Also remove thumbnail if exists
            thumb = THUMBNAIL_DIR / f"{target.name}.jpg"
            if thumb.exists():
                thumb.unlink()
            return True
        return False
    except (ValueError, OSError):
        return False


def move_file(old_path: str, new_path: str) -> tuple[bool, str]:
    """
    Move/rename a file within uploads/.
    Returns (success, error_message).
    """
    try:
        old_target = get_file_path(old_path)
        new_target = get_file_path(new_path)

        if not old_target.exists():
            return False, "Source file does not exist"

        if new_target.exists():
            return False, "A file already exists at the destination path"

        # Ensure parent directory exists
        new_target.parent.mkdir(parents=True, exist_ok=True)

        shutil.move(str(old_target), str(new_target))

        # Move thumbnail if it exists
        old_thumb = THUMBNAIL_DIR / f"{old_target.name}.jpg"
        if old_thumb.exists():
            new_thumb = THUMBNAIL_DIR / f"{new_target.name}.jpg"
            shutil.move(str(old_thumb), str(new_thumb))

        return True, ""
    except ValueError as e:
        return False, str(e)
    except OSError as e:
        return False, str(e)


def check_ffmpeg_available() -> bool:
    """Check if ffmpeg is installed and available on PATH."""
    try:
        subprocess.run(
            ["ffmpeg", "-version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False


def generate_video_thumbnail(relative_path: str) -> bool:
    """
    Generate a thumbnail for a video file using ffmpeg.
    Captures a frame at 5 seconds, scales to 320x180, saves as JPG.
    Returns True on success, False if ffmpeg is unavailable or fails.
    """
    if not check_ffmpeg_available():
        return False

    try:
        source_path = get_file_path(relative_path)
        if not source_path.exists():
            return False

        THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
        thumb_path = THUMBNAIL_DIR / f"{source_path.name}.jpg"

        # Use ffmpeg to capture a frame at 5 seconds, scale to 320x180
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",  # Overwrite output
                "-ss", "5",  # Seek to 5 seconds
                "-i", str(source_path),  # Input file
                "-vframes", "1",  # One frame
                "-vf", "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2",
                "-q:v", "3",  # Quality (2-5, lower is better)
                str(thumb_path),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
        return result.returncode == 0 and thumb_path.exists()
    except (ValueError, subprocess.TimeoutExpired, OSError):
        return False


def get_thumbnail_path(relative_path: str) -> Optional[Path]:
    """Get the thumbnail path for a file, or None if it doesn't exist."""
    try:
        target = get_file_path(relative_path)
        ext = target.suffix.lower()
        thumb = THUMBNAIL_DIR / f"{target.name}.jpg"
        if ext in VIDEO_EXTENSIONS and thumb.exists():
            return thumb
    except ValueError:
        pass
    return None
