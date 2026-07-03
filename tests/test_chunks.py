"""
Tests for VpsEasyUploader chunked/resumable upload functionality.

Covers:
- Upload initialization
- Chunk upload and status tracking
- Upload completion
- Incomplete upload listing
- Space checking
"""

import os
import re
import tempfile
from pathlib import Path

import pytest

# Set up environment before importing app
os.environ["SECRET_KEY"] = "test-secret-key-for-pytest"
os.environ["LOG_LEVEL"] = "DEBUG"

from app import app as flask_app


def get_csrf_token(client):
    """Get CSRF token by doing a GET to the dashboard (will redirect to login/register if not authed)."""
    resp = client.get("/")
    match = re.search(rb'name="csrf-token"\s+content="([^"]+)"', resp.data)
    if match:
        return match.group(1).decode()
    match = re.search(rb'name="_csrf_token"\s+value="([^"]+)"', resp.data)
    if match:
        return match.group(1).decode()
    return None


def csrf_json(client, url, data, method="post", **kwargs):
    """Helper: add CSRF token to JSON request via X-CSRF-Token header."""
    token = get_csrf_token(client)
    headers = kwargs.pop("headers", {})
    if token:
        headers["X-CSRF-Token"] = token
    if method == "post":
        return client.post(url, json=data, headers=headers, **kwargs)
    elif method == "delete":
        return client.delete(url, json=data, headers=headers, **kwargs)
    return None


def csrf_multipart(client, url, data, **kwargs):
    """Helper: add CSRF token to multipart form request."""
    token = get_csrf_token(client)
    headers = kwargs.pop("headers", {})
    if token:
        headers["X-CSRF-Token"] = token
    # Don't set content_type explicitly — let Flask auto-detect multipart from file tuples
    return client.post(url, data=data, headers=headers, **kwargs)


@pytest.fixture
def app():
    """Create a Flask test client with a fresh temporary directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        import utils.auth as auth_mod
        import utils.file_ops as file_ops_mod
        import utils.chunker as chunker_mod

        original_auth = auth_mod.AUTH_FILE
        original_upload = file_ops_mod.UPLOAD_DIR
        original_thumb = file_ops_mod.THUMBNAIL_DIR
        original_chunk = chunker_mod.CHUNK_DIR

        tmp = Path(tmpdir)
        auth_mod.AUTH_FILE = tmp / "auth.json"
        file_ops_mod.UPLOAD_DIR = tmp / "uploads"
        file_ops_mod.THUMBNAIL_DIR = file_ops_mod.UPLOAD_DIR / ".thumbnails"
        chunker_mod.CHUNK_DIR = file_ops_mod.UPLOAD_DIR / ".chunks"

        file_ops_mod.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        file_ops_mod.THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
        chunker_mod.CHUNK_DIR.mkdir(parents=True, exist_ok=True)

        flask_app.config["TESTING"] = True
        flask_app.config["CHUNK_SIZE_MB"] = 1  # Small chunks for testing

        with flask_app.test_client() as client:
            with flask_app.app_context():
                # Login first (via form with CSRF)
                get_resp = client.get("/register")
                match = re.search(rb'name="_csrf_token"\s+value="([^"]+)"', get_resp.data)
                csrf_tok = match.group(1).decode() if match else ""
                client.post("/register", data={
                    "password": "testpass123",
                    "confirm": "testpass123",
                    "_csrf_token": csrf_tok,
                })
                yield client

        auth_mod.AUTH_FILE = original_auth
        file_ops_mod.UPLOAD_DIR = original_upload
        file_ops_mod.THUMBNAIL_DIR = original_thumb
        chunker_mod.CHUNK_DIR = original_chunk


class TestUploadInit:
    """Tests for the upload initialization endpoint."""

    def test_init_small_file(self, app):
        """Initialize an upload for a small file."""
        resp = csrf_json(app, "/upload/init", {
            "filename": "test.txt",
            "total_size": 1024,  # 1 KB
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert "upload_id" in data
        assert data["total_size"] == 1024
        assert data["filename"] == "test.txt"
        assert data["total_chunks"] == 1  # 1 KB < 1 MB chunk

    def test_init_requires_filename(self, app):
        """Init should fail without filename."""
        resp = csrf_json(app, "/upload/init", {
            "total_size": 1024,
        })
        assert resp.status_code == 400

    def test_init_requires_positive_size(self, app):
        """Init should fail with zero or negative size."""
        resp = csrf_json(app, "/upload/init", {
            "filename": "test.txt",
            "total_size": 0,
        })
        assert resp.status_code == 400

    def test_init_large_file(self, app):
        """Init for a file that requires multiple chunks."""
        chunk_size = 1 * 1024 * 1024  # 1 MB
        total_size = 5 * 1024 * 1024 + 100  # ~5 MB + 100 bytes → 6 chunks

        resp = csrf_json(app, "/upload/init", {
            "filename": "large.bin",
            "total_size": total_size,
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["total_chunks"] == 6


class TestChunkUpload:
    """Tests for chunk upload and status tracking."""

    @pytest.fixture
    def initiated_upload(self, app):
        """Initiate an upload and return the upload_id."""
        resp = csrf_json(app, "/upload/init", {
            "filename": "test.dat",
            "total_size": 1048576,  # 1 MB
        })
        return resp.get_json()["upload_id"]

    def test_upload_chunk(self, app, initiated_upload):
        """Upload a single chunk."""
        upload_id = initiated_upload
        chunk_data = b"A" * 1048576  # 1 MB of 'A's

        from io import BytesIO
        data = {
            "upload_id": upload_id,
            "chunk_index": "0",
            "chunk_data": (BytesIO(chunk_data), "chunk_0"),
        }
        resp = csrf_multipart(app, "/upload/chunk", data=data)
        assert resp.status_code == 200
        assert resp.get_json()["success"] is True

    def test_upload_status(self, app, initiated_upload):
        """Check upload status shows progress."""
        upload_id = initiated_upload
        resp = app.get(f"/upload/status/{upload_id}")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["total_chunks"] == 1
        assert data["received_chunks"] == []

    def test_upload_status_nonexistent(self, app):
        """Status for non-existent upload should 404."""
        resp = app.get("/upload/status/nonexistent-id")
        assert resp.status_code == 404

    def test_full_upload_flow(self, app, initiated_upload):
        """Complete flow: init → chunk → status → complete → verify file."""
        from io import BytesIO

        upload_id = initiated_upload
        # Exactly 1 MB (1,048,576 bytes) to match the chunk size
        chunk_data = b"X" * 1048576

        # Upload chunk
        data = {
            "upload_id": upload_id,
            "chunk_index": "0",
            "chunk_data": (BytesIO(chunk_data), "chunk_0"),
        }
        resp = csrf_multipart(app, "/upload/chunk", data=data)
        assert resp.status_code == 200

        # Check status
        resp = app.get(f"/upload/status/{upload_id}")
        status = resp.get_json()
        assert 0 in status["received_chunks"]

        # Complete
        resp = csrf_json(app, f"/upload/complete/{upload_id}", {})
        assert resp.status_code == 200
        assert resp.get_json()["success"] is True

        # Verify file exists via file listing
        resp = app.get("/files")
        files_data = resp.get_json()
        filenames = [f["name"] for f in files_data["files"]]
        assert "test.dat" in filenames

    def test_incomplete_uploads_listing(self, app, initiated_upload):
        """Incomplete uploads should list after init but before complete."""
        resp = app.get("/uploads/incomplete")
        assert resp.status_code == 200
        data = resp.get_json()
        uploads = data["uploads"]
        assert len(uploads) == 1
        assert uploads[0]["filename"] == "test.dat"


class TestSpaceCheck:
    """Tests for disk space checking."""

    def test_check_space_available(self, app):
        """Should report space available for a small file."""
        resp = app.get("/check_space?size=1024")
        assert resp.status_code == 200
        data = resp.get_json()
        assert "available" in data
        assert "free" in data

    def test_check_space_invalid_size(self, app):
        """Should return 400 for invalid size."""
        resp = app.get("/check_space?size=notanumber")
        assert resp.status_code == 400
