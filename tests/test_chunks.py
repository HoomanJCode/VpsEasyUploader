"""
Tests for VpsEasyUploader chunked/resumable upload functionality.

Covers:
- Upload initialization
- Chunk upload and status tracking
- Upload completion
- Incomplete upload listing
- Space checking
- Resume with preserved chunks
- Cancel and cleanup
"""

import os
import re
import tempfile
import time
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


class TestResumeAndTracking:
    """Tests for resume, chunk tracking, cancel, and cleanup."""

    # Total size: 3 MB + 500 bytes → 4 chunks (1 MB each, last is 500 bytes)
    TOTAL_SIZE = 3 * 1024 * 1024 + 500
    TOTAL_CHUNKS = 4

    @pytest.fixture
    def multi_chunk_upload(self, app):
        """Initiate a multi-chunk upload (4 chunks)."""
        resp = csrf_json(app, "/upload/init", {
            "filename": "multi.bin",
            "total_size": self.TOTAL_SIZE,
        })
        data = resp.get_json()
        assert resp.status_code == 200
        return data["upload_id"]

    # ------------------------------------------------------------------
    # Resume preserves received_chunks
    # ------------------------------------------------------------------

    def test_resume_preserves_received_chunks(self, app, multi_chunk_upload):
        """Re-initializing with upload_id keeps previously uploaded chunks."""
        from io import BytesIO
        upload_id = multi_chunk_upload

        # Upload chunk 0 and chunk 2 (out of order)
        for idx in [0, 2]:
            chunk = b"A" * 1048576  # 1 MB
            resp = csrf_multipart(app, "/upload/chunk", data={
                "upload_id": upload_id,
                "chunk_index": str(idx),
                "chunk_data": (BytesIO(chunk), f"chunk_{idx}"),
            })
            assert resp.status_code == 200

        # Re-init with the same upload_id
        resp = csrf_json(app, "/upload/init", {
            "filename": "multi.bin",
            "total_size": self.TOTAL_SIZE,
            "upload_id": upload_id,
        })
        assert resp.status_code == 200

        # Verify chunks 0 and 2 are still present
        resp = app.get(f"/upload/status/{upload_id}")
        status = resp.get_json()
        assert status["total_chunks"] == self.TOTAL_CHUNKS
        assert 0 in status["received_chunks"]
        assert 2 in status["received_chunks"]
        assert len(status["received_chunks"]) == 2

    # ------------------------------------------------------------------
    # Multiple chunks status tracking
    # ------------------------------------------------------------------

    def test_upload_all_chunks_tracks_complete_set(self, app, multi_chunk_upload):
        """Uploading all 4 chunks should show all in status."""
        from io import BytesIO
        upload_id = multi_chunk_upload
        chunk_size = 1048576  # 1 MB

        for i in range(self.TOTAL_CHUNKS):
            if i == self.TOTAL_CHUNKS - 1:
                chunk = b"B" * 500  # last chunk is 500 bytes
            else:
                chunk = b"B" * chunk_size
            resp = csrf_multipart(app, "/upload/chunk", data={
                "upload_id": upload_id,
                "chunk_index": str(i),
                "chunk_data": (BytesIO(chunk), f"chunk_{i}"),
            })
            assert resp.status_code == 200, f"Chunk {i} failed"

        # Verify all 4 chunks recorded
        resp = app.get(f"/upload/status/{upload_id}")
        status = resp.get_json()
        assert status["received_chunks"] == [0, 1, 2, 3]
        assert len(status["received_chunks"]) == self.TOTAL_CHUNKS

    # ------------------------------------------------------------------
    # Chunk re-upload is idempotent
    # ------------------------------------------------------------------

    def test_chunk_reupload_is_idempotent(self, app, multi_chunk_upload):
        """Uploading the same chunk twice should succeed both times."""
        from io import BytesIO
        upload_id = multi_chunk_upload
        chunk = b"C" * 1048576

        # First upload
        resp = csrf_multipart(app, "/upload/chunk", data={
            "upload_id": upload_id,
            "chunk_index": "0",
            "chunk_data": (BytesIO(chunk), "chunk_0"),
        })
        assert resp.status_code == 200

        # Second upload — same chunk
        resp = csrf_multipart(app, "/upload/chunk", data={
            "upload_id": upload_id,
            "chunk_index": "0",
            "chunk_data": (BytesIO(chunk), "chunk_0"),
        })
        assert resp.status_code == 200

        # Status should show chunk 0 only once
        resp = app.get(f"/upload/status/{upload_id}")
        status = resp.get_json()
        assert status["received_chunks"] == [0]
        assert len(status["received_chunks"]) == 1

    # ------------------------------------------------------------------
    # Cancel removes upload from listing
    # ------------------------------------------------------------------

    def test_cancel_removes_upload(self, app, multi_chunk_upload):
        """Cancelling an upload removes it from the incomplete list."""
        from io import BytesIO
        upload_id = multi_chunk_upload

        # Upload one chunk so there's something to clean up
        chunk = b"D" * 1048576
        csrf_multipart(app, "/upload/chunk", data={
            "upload_id": upload_id,
            "chunk_index": "0",
            "chunk_data": (BytesIO(chunk), "chunk_0"),
        })

        # It should be in the incomplete list
        resp = app.get("/uploads/incomplete")
        assert any(u["upload_id"] == upload_id for u in resp.get_json()["uploads"])

        # Cancel it
        resp = csrf_json(app, f"/upload/cancel/{upload_id}", {}, method="delete")
        assert resp.status_code == 200
        assert resp.get_json()["success"] is True

        # No longer in the list
        resp = app.get("/uploads/incomplete")
        assert not any(u["upload_id"] == upload_id for u in resp.get_json()["uploads"])

        # Status should 404
        resp = app.get(f"/upload/status/{upload_id}")
        assert resp.status_code == 404

    # ------------------------------------------------------------------
    # Progress percentage math
    # ------------------------------------------------------------------

    def test_progress_percent_is_accurate(self, app, multi_chunk_upload):
        """progress_percent should correctly reflect uploaded/total."""
        from io import BytesIO
        upload_id = multi_chunk_upload

        # Upload 2 of 4 chunks
        for i in range(2):
            chunk = b"E" * 1048576
            csrf_multipart(app, "/upload/chunk", data={
                "upload_id": upload_id,
                "chunk_index": str(i),
                "chunk_data": (BytesIO(chunk), f"chunk_{i}"),
            })

        # Check listing progress
        resp = app.get("/uploads/incomplete")
        uploads = resp.get_json()["uploads"]
        u = next(u for u in uploads if u["upload_id"] == upload_id)
        assert u["received_chunks_count"] == 2
        assert u["total_chunks"] == self.TOTAL_CHUNKS
        assert u["progress_percent"] == 50.0  # 2/4 = 50%

        # Upload one more → 75%
        chunk = b"E" * 1048576
        csrf_multipart(app, "/upload/chunk", data={
            "upload_id": upload_id,
            "chunk_index": "2",
            "chunk_data": (BytesIO(chunk), "chunk_2"),
        })
        resp = app.get("/uploads/incomplete")
        uploads = resp.get_json()["uploads"]
        u = next(u for u in uploads if u["upload_id"] == upload_id)
        assert u["received_chunks_count"] == 3
        assert u["progress_percent"] == 75.0  # 3/4 = 75%

    # ------------------------------------------------------------------
    # File fingerprint on resume
    # ------------------------------------------------------------------

    def test_fingerprint_preserved_on_resume_when_not_reprovided(self, app, multi_chunk_upload):
        """Resume without new fingerprint keeps the old one."""
        upload_id = multi_chunk_upload

        # Set initial fingerprint
        csrf_json(app, "/upload/init", {
            "filename": "multi.bin",
            "total_size": self.TOTAL_SIZE,
            "upload_id": upload_id,
            "file_fingerprint": "original-fingerprint",
        })

        # Resume WITHOUT providing a new fingerprint — should preserve the original
        csrf_json(app, "/upload/init", {
            "filename": "multi.bin",
            "total_size": self.TOTAL_SIZE,
            "upload_id": upload_id,
        })

        # Verify original fingerprint was preserved
        resp = app.get(f"/upload/status/{upload_id}")
        assert resp.get_json()["file_fingerprint"] == "original-fingerprint"

    def test_fingerprint_overwritten_when_reprovided_on_resume(self, app, multi_chunk_upload):
        """Resume with a new fingerprint overwrites the old one."""
        upload_id = multi_chunk_upload

        # Set initial fingerprint
        csrf_json(app, "/upload/init", {
            "filename": "multi.bin",
            "total_size": self.TOTAL_SIZE,
            "upload_id": upload_id,
            "file_fingerprint": "old-fingerprint",
        })

        # Resume with new fingerprint
        csrf_json(app, "/upload/init", {
            "filename": "multi.bin",
            "total_size": self.TOTAL_SIZE,
            "upload_id": upload_id,
            "file_fingerprint": "new-fingerprint",
        })

        # Verify new fingerprint took effect
        resp = app.get(f"/upload/status/{upload_id}")
        assert resp.get_json()["file_fingerprint"] == "new-fingerprint"

    def test_fingerprint_absent_returns_none(self, app, multi_chunk_upload):
        """Upload without a fingerprint returns None for that field."""
        upload_id = multi_chunk_upload

        resp = app.get(f"/upload/status/{upload_id}")
        assert resp.get_json()["file_fingerprint"] is None

    # ------------------------------------------------------------------
    # Cleanup expired uploads
    # ------------------------------------------------------------------

    def test_cleanup_expired_removes_old_uploads(self, app, multi_chunk_upload):
        """Expired uploads are removed by cleanup_expired_uploads."""
        import utils.chunker as chunker_mod

        upload_id = multi_chunk_upload

        # Artificially age the upload by setting last_activity far in the past
        meta = chunker_mod.load_meta(upload_id)
        assert meta is not None
        meta["last_activity"] = time.time() - (8 * 24 * 60 * 60)  # 8 days ago
        chunker_mod.save_meta(upload_id, meta)

        # Run cleanup
        cleaned = chunker_mod.cleanup_expired_uploads()
        assert cleaned == 1

        # Upload should be gone
        resp = app.get(f"/upload/status/{upload_id}")
        assert resp.status_code == 404

        # Incomplete list should be empty
        resp = app.get("/uploads/incomplete")
        assert resp.get_json()["uploads"] == []

    def test_cleanup_keeps_recent_uploads(self, app, multi_chunk_upload):
        """Recent uploads are not removed by cleanup_expired_uploads."""
        import utils.chunker as chunker_mod

        multi_chunk_upload  # just created, so it's recent

        cleaned = chunker_mod.cleanup_expired_uploads()
        assert cleaned == 0  # nothing should be removed

        # Upload should still exist
        resp = app.get("/uploads/incomplete")
        assert len(resp.get_json()["uploads"]) == 1
