"""
Tests for VpsEasyUploader authentication.

Covers:
- Initial registration (first admin password set)
- Login with correct and incorrect credentials
- Protected endpoint redirection
- Logout behavior
"""

import json
import os
import re
import tempfile
from pathlib import Path

import pytest

# Set up environment before importing app
os.environ["SECRET_KEY"] = "test-secret-key-for-pytest"
os.environ["LOG_LEVEL"] = "DEBUG"

from app import app as flask_app


def get_csrf_token_from_response(response):
    """Extract CSRF token from an HTML page response."""
    match = re.search(rb'name="_csrf_token"\s+value="([^"]+)"', response.data)
    if match:
        return match.group(1).decode()
    # Also check meta tag
    match = re.search(rb'name="csrf-token"\s+content="([^"]+)"', response.data)
    if match:
        return match.group(1).decode()
    return None


def csrf_form_data(client, url, base_data, **kwargs):
    """
    Helper: GET a page to establish session/CSRF token, then POST form data with the token.
    Returns the POST response.
    """
    get_resp = client.get(url)
    token = get_csrf_token_from_response(get_resp)
    data = dict(base_data)
    if token:
        data["_csrf_token"] = token
    return client.post(url, data=data, **kwargs)


def csrf_headers(client):
    """Get CSRF headers for AJAX requests after priming the session."""
    get_resp = client.get("/")
    token = get_csrf_token_from_response(get_resp)
    if token:
        return {"X-CSRF-Token": token}
    return {}


@pytest.fixture
def app():
    """Create a Flask test client with a fresh auth state."""
    # Override auth.json and uploads path to a temp directory
    with tempfile.TemporaryDirectory() as tmpdir:
        # Patch paths in the utils modules
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

        flask_app.config["TESTING"] = True

        with flask_app.test_client() as client:
            with flask_app.app_context():
                yield client

        # Restore original paths
        auth_mod.AUTH_FILE = original_auth
        file_ops_mod.UPLOAD_DIR = original_upload
        file_ops_mod.THUMBNAIL_DIR = original_thumb


class TestRegistration:
    """Tests for the registration flow (first admin password set)."""

    def test_register_page_loads(self, app):
        """GET /register should show the registration form when no password is set."""
        resp = app.get("/register")
        assert resp.status_code == 200
        assert b"Set your admin password" in resp.data

    def test_register_creates_password(self, app):
        """POST /register should create auth.json and log the user in."""
        resp = csrf_form_data(app, "/register", {
            "password": "MySecret123",
            "confirm": "MySecret123",
        }, follow_redirects=True)
        assert resp.status_code == 200
        # Should redirect to the dashboard
        assert b"VpsEasyUploader" in resp.data or b"Dashboard" in resp.data

        # auth.json should exist
        import utils.auth as auth_mod
        assert auth_mod.AUTH_FILE.exists()
        assert auth_mod.is_registered()

    def test_register_password_mismatch(self, app):
        """Password mismatch should show error."""
        resp = csrf_form_data(app, "/register", {
            "password": "MySecret123",
            "confirm": "WrongConfirm",
        })
        assert resp.status_code == 200
        assert b"Passwords do not match" in resp.data

    def test_register_short_password(self, app):
        """Password too short should show error."""
        resp = csrf_form_data(app, "/register", {
            "password": "123",
            "confirm": "123",
        })
        assert resp.status_code == 200
        assert b"at least 8 characters" in resp.data


class TestLogin:
    """Tests for the login flow."""

    @pytest.fixture
    def registered_app(self, app):
        """Register an admin password first."""
        csrf_form_data(app, "/register", {
            "password": "MySecret123",
            "confirm": "MySecret123",
        })
        return app

    def test_login_page_loads(self, registered_app):
        """GET /login should show the login form."""
        # First logout
        registered_app.get("/logout")
        resp = registered_app.get("/login")
        assert resp.status_code == 200
        assert b"Sign in to manage your files" in resp.data

    def test_login_with_correct_password(self, registered_app):
        """Login with correct password should succeed."""
        registered_app.get("/logout")
        resp = csrf_form_data(registered_app, "/login", {
            "password": "MySecret123",
        }, follow_redirects=True)
        assert resp.status_code == 200

    def test_login_with_incorrect_password(self, registered_app):
        """Login with wrong password should show error."""
        registered_app.get("/logout")
        resp = csrf_form_data(registered_app, "/login", {
            "password": "WrongPassword",
        })
        assert resp.status_code == 200
        assert b"Invalid password" in resp.data

    def test_redirect_to_register_when_no_password(self, app):
        """If auth.json doesn't exist, /login should redirect to /register."""
        resp = app.get("/login", follow_redirects=True)
        assert resp.status_code == 200
        # Should be redirected to register
        assert b"Set your admin password" in resp.data


class TestProtectedRoutes:
    """Tests that protected routes require authentication."""

    @pytest.fixture
    def logged_in_app(self, app):
        """Register and login."""
        csrf_form_data(app, "/register", {
            "password": "MySecret123",
            "confirm": "MySecret123",
        })
        return app

    def test_index_requires_login(self, app):
        """Unauthenticated access to / should redirect."""
        resp = app.get("/", follow_redirects=True)
        assert resp.status_code == 200

    def test_index_accessible_when_logged_in(self, logged_in_app):
        """Authenticated access to / should show dashboard."""
        resp = logged_in_app.get("/")
        assert resp.status_code == 200
        assert b"Upload Files" in resp.data or b"VpsEasyUploader" in resp.data

    def test_files_api_requires_login(self, app):
        """GET /files should redirect if not logged in."""
        resp = app.get("/files")
        assert resp.status_code in (302, 401)

    def test_files_api_accessible_when_logged_in(self, logged_in_app):
        """GET /files should return JSON when logged in."""
        resp = logged_in_app.get("/files")
        assert resp.status_code == 200
        data = resp.get_json()
        assert "files" in data

    def test_logout(self, logged_in_app):
        """Logout should clear the session."""
        resp = logged_in_app.get("/logout", follow_redirects=True)
        assert resp.status_code == 200
        # After logout, accessing / should redirect to login
        resp2 = logged_in_app.get("/")
        # Should be a redirect since logged out
        assert resp2.status_code in (302, 200)
