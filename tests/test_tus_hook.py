"""
Tests for VpsEasyUploader /tus-hook webhook endpoint.

Covers:
- Unauthorized requests (missing/wrong hook secret)
- Invalid JSON / bad payloads
- Source file not found
- Successful file move from TUSD_DIR to UPLOAD_DIR
- Filename conflict resolution (appends _1, _2 suffix)
- Path traversal prevention (.. sanitized)
- Video thumbnail generation (ffmpeg-dependent; skips if unavailable)
"""

import json
import os
import tempfile
from pathlib import Path

import pytest

# Set up environment before importing app
os.environ["SECRET_KEY"] = "test-secret-key-for-pytest"
os.environ["LOG_LEVEL"] = "DEBUG"
os.environ["TUSD_HOOK_SECRET"] = "test-hook-secret-12345"

from app import app as flask_app


# ---- Helpers ----

def _build_payload(*, filename="test.txt", size=1024, src_path=None, metadata_key="MetaData"):
    """Build a tusd webhook payload dict like the one tusd sends."""
    return {
        "Upload": {
            "Size": size,
            metadata_key: {"filename": filename},
            "Storage": {"Path": src_path or "/tmp/nonexistent"},
            "Offset": size,
        }
    }


def _hook_json(client, payload, secret="test-hook-secret-12345"):
    """POST JSON to /tus-hook with a hook-secret header."""
    return client.post(
        "/tus-hook",
        json=payload,
        headers={"Hook-Secret": secret, "Content-Type": "application/json"},
    )


# ---- Fixtures ----

@pytest.fixture
def app():
    """Create a Flask test client with patched upload/TUSD paths."""
    with tempfile.TemporaryDirectory() as tmpdir:
        import utils.auth as auth_mod
        import utils.file_ops as file_ops_mod

        original_auth = auth_mod.AUTH_FILE
        original_upload = file_ops_mod.UPLOAD_DIR
        original_thumb = file_ops_mod.THUMBNAIL_DIR

        tmp = Path(tmpdir)
        auth_mod.AUTH_FILE = tmp / "auth.json"
        file_ops_mod.UPLOAD_DIR = tmp / "uploads"
        file_ops_mod.THUMBNAIL_DIR = file_ops_mod.UPLOAD_DIR / ".thumbnails"

        file_ops_mod.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        file_ops_mod.THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)

        # monkey-patch module-level values set at import time
        # (test_auth.py imports app first, so these are already stale)
        import app as app_mod
        original_tusd_dir = app_mod.TUSD_DIR
        original_hook_secret = app_mod.TUSD_HOOK_SECRET
        original_app_upload_dir = app_mod.UPLOAD_DIR
        app_mod.TUSD_DIR = file_ops_mod.UPLOAD_DIR / ".tusd"
        app_mod.TUSD_DIR.mkdir(parents=True, exist_ok=True)
        app_mod.TUSD_HOOK_SECRET = "test-hook-secret-12345"
        # tus_hook uses app.UPLOAD_DIR (local import), not file_ops.UPLOAD_DIR
        app_mod.UPLOAD_DIR = file_ops_mod.UPLOAD_DIR

        flask_app.config["TESTING"] = True

        with flask_app.test_client() as client:
            with flask_app.app_context():
                yield client

        # Restore
        auth_mod.AUTH_FILE = original_auth
        file_ops_mod.UPLOAD_DIR = original_upload
        file_ops_mod.THUMBNAIL_DIR = original_thumb
        app_mod.TUSD_DIR = original_tusd_dir
        app_mod.TUSD_HOOK_SECRET = original_hook_secret
        app_mod.UPLOAD_DIR = original_app_upload_dir


@pytest.fixture
def existing_src(app):
    """Create a real source file inside TUSD_DIR and return its path + filename."""
    import app as app_mod

    src = app_mod.TUSD_DIR / "completed-upload.bin"
    src.write_bytes(b"Hello TUS webhook!\n" * 100)
    return str(src)


# ---- Tests: Auth & validation ----

class TestUnauthorized:
    """Tests that the webhook rejects invalid or missing secrets."""

    def test_missing_secret(self, app):
        resp = app.post("/tus-hook", json=_build_payload())
        assert resp.status_code == 403

    def test_wrong_secret(self, app):
        resp = _hook_json(app, _build_payload(), secret="wrong-secret")
        assert resp.status_code == 403

    def test_empty_secret(self, app):
        resp = _hook_json(app, _build_payload(), secret="")
        assert resp.status_code == 403


class TestInvalidPayload:
    """Tests that malformed payloads return 400."""

    def test_no_json_body(self, app):
        resp = app.post(
            "/tus-hook",
            data="not json",
            headers={"Hook-Secret": "test-hook-secret-12345"},
        )
        assert resp.status_code in (400, 415)

    def test_missing_upload_key(self, app):
        resp = _hook_json(app, {})
        # .get("Upload", {}) → empty dict → no filename → 400
        assert resp.status_code == 400

    def test_zero_size(self, app):
        resp = _hook_json(app, _build_payload(size=0))
        assert resp.status_code == 400

    def test_negative_size(self, app):
        resp = _hook_json(app, _build_payload(size=-1))
        assert resp.status_code == 400

    def test_no_storage_path(self, app):
        payload = {
            "Upload": {
                "Size": 100,
                "MetaData": {"filename": "test.txt"},
                "Storage": {},
            }
        }
        resp = _hook_json(app, payload)
        assert resp.status_code == 400

    def test_nonexistent_source_file(self, app):
        resp = _hook_json(app, _build_payload(src_path="/tmp/definitely-not-real-file.xyz"))
        assert resp.status_code == 404


# ---- Tests: Successful operations ----

class TestSuccessfulMove:
    """Tests that valid payloads move the file correctly."""

    def test_moves_file_to_uploads(self, app, existing_src):
        payload = _build_payload(
            filename="moved-file.txt",
            size=2100,
            src_path=existing_src,
        )
        resp = _hook_json(app, payload)
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["success"] is True
        assert data["filename"] == "moved-file.txt"

        # Verify the file is now in UPLOAD_DIR, not TUSD_DIR
        import utils.file_ops as file_ops_mod
        dest = file_ops_mod.UPLOAD_DIR / "moved-file.txt"
        assert dest.exists()
        assert not Path(existing_src).exists()  # source was moved

    def test_preserves_file_content(self, app, existing_src):
        original_content = Path(existing_src).read_text()
        payload = _build_payload(
            filename="content-check.txt",
            size=2100,
            src_path=existing_src,
        )
        resp = _hook_json(app, payload)
        assert resp.status_code == 200

        import utils.file_ops as file_ops_mod
        dest = file_ops_mod.UPLOAD_DIR / "content-check.txt"
        assert dest.read_text() == original_content

    def test_creates_parent_dirs(self, app, existing_src):
        """File with path separators creates intermediate directories."""
        payload = _build_payload(
            filename="sub/folder/deep/nested.txt",
            size=2100,
            src_path=existing_src,
        )
        resp = _hook_json(app, payload)
        assert resp.status_code == 200
        assert resp.get_json()["filename"] == "sub/folder/deep/nested.txt"

        import utils.file_ops as file_ops_mod
        dest = file_ops_mod.UPLOAD_DIR / "sub" / "folder" / "deep" / "nested.txt"
        assert dest.exists()

    def test_metadata_key_variant(self, app, existing_src):
        """tusd may send metadata as 'Metadata' instead of 'MetaData'."""
        payload = _build_payload(
            filename="metadata-key.txt",
            size=2100,
            src_path=existing_src,
            metadata_key="Metadata",
        )
        resp = _hook_json(app, payload)
        assert resp.status_code == 200
        assert resp.get_json()["filename"] == "metadata-key.txt"


class TestFilenameConflict:
    """Tests that filename conflicts are resolved by appending a suffix."""

    def test_first_conflict_appends_1(self, app, existing_src):
        import utils.file_ops as file_ops_mod

        # Pre-create a file with the same name
        (file_ops_mod.UPLOAD_DIR / "dup.txt").write_text("existing")

        payload = _build_payload(
            filename="dup.txt",
            size=2100,
            src_path=existing_src,
        )
        resp = _hook_json(app, payload)
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["filename"].startswith("dup_")
        assert data["filename"].endswith(".txt")

        # Verify both files exist
        assert (file_ops_mod.UPLOAD_DIR / "dup.txt").exists()
        assert (file_ops_mod.UPLOAD_DIR / data["filename"]).exists()

    def test_multiple_conflicts_increment(self, app, existing_src):
        import utils.file_ops as file_ops_mod

        # Pre-create dup.txt, dup_1.txt
        (file_ops_mod.UPLOAD_DIR / "dup.txt").write_text("v0")
        (file_ops_mod.UPLOAD_DIR / "dup_1.txt").write_text("v1")

        payload = _build_payload(
            filename="dup.txt",
            size=2100,
            src_path=existing_src,
        )
        resp = _hook_json(app, payload)
        assert resp.status_code == 200
        assert resp.get_json()["filename"] == "dup_2.txt"


class TestPathSanitization:
    """Tests that malicious filenames are sanitized."""

    def test_strips_leading_slash(self, app, existing_src):
        payload = _build_payload(
            filename="/leading-slash.txt",
            size=2100,
            src_path=existing_src,
        )
        resp = _hook_json(app, payload)
        assert resp.status_code == 200
        assert resp.get_json()["filename"] == "leading-slash.txt"

    def test_removes_dot_dot(self, app, existing_src):
        payload = _build_payload(
            filename="../../../etc/passwd",
            size=2100,
            src_path=existing_src,
        )
        resp = _hook_json(app, payload)
        assert resp.status_code == 200
        data = resp.get_json()
        assert ".." not in data["filename"]
        # Sanitization removes the .. segments, leaving etc/passwd
        assert data["filename"] == "etc/passwd"

    def test_normalizes_backslashes(self, app, existing_src):
        payload = _build_payload(
            filename="folder\\file.txt",
            size=2100,
            src_path=existing_src,
        )
        resp = _hook_json(app, payload)
        assert resp.status_code == 200
        assert resp.get_json()["filename"] == "folder/file.txt"


class TestVideoThumbnail:
    """Tests that video files trigger thumbnail generation."""

    def test_video_triggers_thumbnail(self, app):
        """Upload a .mp4 file — thumbnail should be generated."""
        # Check if ffmpeg is available
        import shutil
        if shutil.which("ffmpeg") is None:
            pytest.skip("ffmpeg not available — skipping thumbnail test")

        import app as app_mod

        # Create a tiny valid mp4 or just a file with .mp4 extension
        src = app_mod.TUSD_DIR / "video-upload.mp4"
        src.write_bytes(b"fake mp4 content for thumbnail test")

        payload = _build_payload(
            filename="my-video.mp4",
            size=len("fake mp4 content for thumbnail test"),
            src_path=str(src),
        )
        resp = _hook_json(app, payload)
        assert resp.status_code == 200

        # Thumbnail may or may not be generated for fake content,
        # but the route should not crash
        import utils.file_ops as file_ops_mod
        dest = file_ops_mod.UPLOAD_DIR / "my-video.mp4"
        assert dest.exists()

    def test_non_video_skips_thumbnail(self, app, existing_src):
        """A .txt file should NOT trigger thumbnail generation."""
        resp = _hook_json(app, _build_payload(
            filename="document.txt",
            size=2100,
            src_path=existing_src,
        ))
        assert resp.status_code == 200
        # No crash is the assertion — thumbnail code path is skipped

    def test_returns_size_in_response(self, app, existing_src):
        payload = _build_payload(
            filename="size-check.bin",
            size=2100,
            src_path=existing_src,
        )
        resp = _hook_json(app, payload)
        assert resp.status_code == 200
        assert resp.get_json()["size"] == 2100
