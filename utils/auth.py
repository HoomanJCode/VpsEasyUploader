"""
Authentication utilities for VpsEasyUploader.

Handles admin password storage, hashing, and session protection.
Password is stored in 'auth.json' at the project root, never in .env.
"""

import json
import os
from functools import wraps
from pathlib import Path

from flask import redirect, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

# Path to the auth metadata file (project root)
AUTH_FILE = Path(__file__).resolve().parent.parent / "auth.json"


def hash_password(password: str) -> str:
    """Hash a password using werkzeug's secure hashing."""
    return generate_password_hash(password)


def verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its hash."""
    return check_password_hash(hashed, password)


def load_password_hash() -> str | None:
    """Load the stored password hash from auth.json, or None if not set."""
    if not AUTH_FILE.exists():
        return None
    try:
        with open(AUTH_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("password_hash")
    except (json.JSONDecodeError, KeyError, OSError):
        return None


def save_password_hash(password_hash: str) -> None:
    """Save the password hash to auth.json."""
    data = {"password_hash": password_hash}
    with open(AUTH_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    # Restrict permissions on auth.json (owner read/write only)
    os.chmod(AUTH_FILE, 0o600)


def is_registered() -> bool:
    """Check whether the admin password has been set yet."""
    return load_password_hash() is not None


def login_required(f):
    """
    Decorator that redirects to /login if the user is not authenticated.
    On first run (no password set), redirects to /register instead.
    """

    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get("logged_in"):
            if is_registered():
                return redirect(url_for("login_page"))
            return redirect(url_for("register_page"))
        return f(*args, **kwargs)

    return decorated_function
