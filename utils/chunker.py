"""
Chunked / resumable upload utilities for VpsEasyUploader.

Handles upload initialization, chunk storage, status tracking,
upload completion (merging), incomplete upload listing, and cleanup.
"""

import json
import os
import time
import uuid
from pathlib import Path

from utils.file_ops import UPLOAD_DIR, get_file_path, check_available_space

# Directory for chunk metadata and temporary files
CHUNK_DIR = UPLOAD_DIR / ".chunks"

# Maximum age of incomplete uploads before cleanup (7 days in seconds)
INCOMPLETE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60


def _get_upload_dir(upload_id: str) -> Path:
    """Get the directory for a specific upload's chunks and metadata."""
    return CHUNK_DIR / upload_id


def _get_meta_path(upload_id: str) -> Path:
    """Get the path to the metadata JSON file for an upload."""
    return _get_upload_dir(upload_id) / "meta.json"


def _get_reserved_path(upload_id: str) -> Path:
    """Get the path to the reserved space file for an upload."""
    return _get_upload_dir(upload_id) / "reserved.tmp"


def _get_chunk_path(upload_id: str, chunk_index: int) -> Path:
    """Get the path for a specific chunk file."""
    return _get_upload_dir(upload_id) / f"chunk_{chunk_index:04d}"


def load_meta(upload_id: str) -> dict | None:
    """Load upload metadata, or None if not found."""
    meta_path = _get_meta_path(upload_id)
    if not meta_path.exists():
        return None
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def save_meta(upload_id: str, meta: dict) -> None:
    """Save upload metadata to disk."""
    upload_dir = _get_upload_dir(upload_id)
    upload_dir.mkdir(parents=True, exist_ok=True)
    with open(_get_meta_path(upload_id), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)


def init_upload(filename: str, total_size: int, upload_id: str | None = None) -> dict:
    """
    Initialize a new resumable upload (or return an existing one if same file/size).

    Steps:
    1. Check for existing incomplete upload with same filename + size (recovery).
    2. Check disk space and reserve space.
    3. Create metadata file.

    Returns a dict with upload details.
    """
    # Sanitize filename: strip leading/trailing slashes and dots
    sanitized = filename.strip().lstrip("/\\").rstrip("/\\")
    # Remove path traversal attempts
    sanitized = sanitized.replace("\\", "/")
    parts = [p for p in sanitized.split("/") if p and p not in (".", "..")]
    filename = "/".join(parts) if parts else sanitized
    if not filename:
        raise ValueError("Invalid filename")

    from flask import current_app

    # Check for existing incomplete upload with same filename and size
    if upload_id is None:
        existing = _find_existing_upload(filename, total_size)
        if existing:
            return {
                "upload_id": existing["upload_id"],
                "chunk_size": existing["chunk_size"],
                "total_chunks": existing["total_chunks"],
                "total_size": existing["total_size"],
                "filename": existing["filename"],
                "conflict": False,
                "resumed": True,
                "existing_upload_id": existing["upload_id"],
            }

    # Generate a new upload_id if not provided
    if upload_id is None:
        upload_id = str(uuid.uuid4())

    # Calculate chunk size from config
    chunk_size_mb = int(current_app.config.get("CHUNK_SIZE_MB", 5))
    chunk_size = chunk_size_mb * 1024 * 1024

    # Calculate total chunks
    total_chunks = (total_size + chunk_size - 1) // chunk_size  # ceiling division

    # Check available disk space
    if not check_available_space(total_size):
        raise ValueError("Not enough disk space available for this upload")

    # Create upload directory
    upload_dir = _get_upload_dir(upload_id)
    upload_dir.mkdir(parents=True, exist_ok=True)

    # Reserve space by creating an empty file of the declared size
    reserved_path = _get_reserved_path(upload_id)
    try:
        with open(reserved_path, "wb") as f:
            # Use truncate to allocate the file size without writing data
            os.truncate(f.fileno(), total_size)
    except OSError as e:
        raise ValueError(f"Failed to reserve disk space: {e}")

    # Save metadata
    meta = {
        "upload_id": upload_id,
        "filename": filename,
        "total_size": total_size,
        "chunk_size": chunk_size,
        "total_chunks": total_chunks,
        "received_chunks": [],
        "created_at": time.time(),
        "last_activity": time.time(),
    }
    save_meta(upload_id, meta)

    return {
        "upload_id": upload_id,
        "chunk_size": chunk_size,
        "total_chunks": total_chunks,
        "total_size": total_size,
        "filename": filename,
        "conflict": False,
    }


def _find_existing_upload(filename: str, total_size: int) -> dict | None:
    """
    Find an existing incomplete upload with the same filename and total_size.
    Used for recovery when a client loses their upload_id.
    """
    if not CHUNK_DIR.exists():
        return None

    for upload_dir in CHUNK_DIR.iterdir():
        if not upload_dir.is_dir():
            continue
        meta = load_meta(upload_dir.name)
        if meta and meta.get("filename") == filename and meta.get("total_size") == total_size:
            # Check that all chunk files are intact
            return meta

    return None


def save_chunk(upload_id: str, chunk_index: int, chunk_data: bytes) -> bool:
    """
    Save a single chunk of an upload to disk.
    Validates chunk size against expected size (except last chunk which may be smaller).
    Returns True on success, False on failure.
    """
    meta = load_meta(upload_id)
    if meta is None:
        return False

    if chunk_index < 0 or chunk_index >= meta["total_chunks"]:
        return False

    # Validate chunk size: all chunks except the last must be exactly chunk_size
    expected_size = meta["chunk_size"]
    is_last = chunk_index == meta["total_chunks"] - 1
    if is_last:
        expected_size = meta["total_size"] - (chunk_index * meta["chunk_size"])

    actual_size = len(chunk_data)
    if actual_size != expected_size:
        return False

    chunk_path = _get_chunk_path(upload_id, chunk_index)
    try:
        with open(chunk_path, "wb") as f:
            f.write(chunk_data)
    except OSError:
        return False

    # Update metadata
    if chunk_index not in meta["received_chunks"]:
        meta["received_chunks"].append(chunk_index)
        meta["received_chunks"].sort()
    meta["last_activity"] = time.time()
    save_meta(upload_id, meta)

    return True


def get_upload_status(upload_id: str) -> dict | None:
    """
    Get the status of an upload.
    Returns dict with received_chunks and total_chunks, or None if not found.
    """
    meta = load_meta(upload_id)
    if meta is None:
        return None
    return {
        "upload_id": meta["upload_id"],
        "filename": meta["filename"],
        "total_size": meta["total_size"],
        "total_chunks": meta["total_chunks"],
        "received_chunks": meta["received_chunks"],
        "chunk_size": meta["chunk_size"],
    }


def complete_upload(upload_id: str) -> tuple[bool, str]:
    """
    Finalize an upload by concatenating all chunks into the final file.
    Returns (success, message).

    Steps:
    1. Verify all chunks are present.
    2. Concatenate chunks in order into the target file.
    3. Clean up chunk directory and reserved space.
    4. Delete metadata.
    """
    meta = load_meta(upload_id)
    if meta is None:
        return False, "Upload not found"

    if len(meta["received_chunks"]) != meta["total_chunks"]:
        missing = set(range(meta["total_chunks"])) - set(meta["received_chunks"])
        return False, f"Missing chunks: {sorted(missing)}"

    # Verify all chunk files exist and have correct sizes
    for i in range(meta["total_chunks"]):
        chunk_path = _get_chunk_path(upload_id, i)
        if not chunk_path.exists():
            return False, f"Chunk {i} file not found"

        expected_size = meta["chunk_size"]
        if i == meta["total_chunks"] - 1:
            # Last chunk may be smaller
            expected_size = meta["total_size"] - (i * meta["chunk_size"])

        actual_size = chunk_path.stat().st_size
        if actual_size != expected_size:
            return False, f"Chunk {i} size mismatch: expected {expected_size}, got {actual_size}"

    # Determine target path
    filename = meta["filename"]
    try:
        target_path = get_file_path(filename)
    except ValueError as e:
        return False, str(e)

    # Ensure target directory exists
    target_path.parent.mkdir(parents=True, exist_ok=True)

    # Concatenate chunks
    try:
        with open(target_path, "wb") as outfile:
            for i in range(meta["total_chunks"]):
                chunk_path = _get_chunk_path(upload_id, i)
                with open(chunk_path, "rb") as infile:
                    # Read and write in 1 MB blocks to handle large chunks
                    while True:
                        data = infile.read(1024 * 1024)
                        if not data:
                            break
                        outfile.write(data)
    except OSError as e:
        return False, f"Failed to write final file: {e}"

    # Cleanup: remove chunk directory and reserved space
    cleanup_upload(upload_id)

    return True, f"Upload complete: {filename}"


def cleanup_upload(upload_id: str) -> None:
    """Remove all traces of an upload (chunks, metadata, reserved space)."""
    import shutil

    upload_dir = _get_upload_dir(upload_id)
    if upload_dir.exists():
        shutil.rmtree(str(upload_dir), ignore_errors=True)


def list_incomplete_uploads() -> list[dict]:
    """
    List all incomplete uploads with their metadata.
    Returns a list of dicts with upload_id, filename, total_size, progress, etc.
    """
    incomplete = []
    if not CHUNK_DIR.exists():
        return incomplete

    for upload_dir in CHUNK_DIR.iterdir():
        if not upload_dir.is_dir():
            continue
        meta = load_meta(upload_dir.name)
        if meta is None:
            # Orphaned directory without metadata; clean it up
            import shutil
            shutil.rmtree(str(upload_dir), ignore_errors=True)
            continue

        total = meta["total_chunks"]
        received = len(meta["received_chunks"])
        incomplete.append({
            "upload_id": meta["upload_id"],
            "filename": meta["filename"],
            "total_size": meta["total_size"],
            "total_chunks": total,
            "received_chunks_count": received,
            "progress_percent": round((received / total) * 100, 1) if total > 0 else 0,
            "created_at": meta.get("created_at", 0),
            "last_activity": meta.get("last_activity", 0),
        })

    # Sort by last activity, newest first
    incomplete.sort(key=lambda u: u["last_activity"], reverse=True)
    return incomplete


def cleanup_expired_uploads() -> int:
    """
    Remove incomplete uploads that are older than INCOMPLETE_MAX_AGE_SECONDS.
    Returns the number of cleaned uploads.
    """
    now = time.time()
    cleaned = 0
    if not CHUNK_DIR.exists():
        return cleaned

    for upload_dir in list(CHUNK_DIR.iterdir()):
        if not upload_dir.is_dir():
            continue
        meta = load_meta(upload_dir.name)
        if meta is None:
            # Orphaned directory
            import shutil
            shutil.rmtree(str(upload_dir), ignore_errors=True)
            cleaned += 1
            continue

        last_activity = meta.get("last_activity", meta.get("created_at", 0))
        if now - last_activity > INCOMPLETE_MAX_AGE_SECONDS:
            cleanup_upload(upload_dir.name)
            cleaned += 1

    return cleaned
