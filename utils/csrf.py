"""
CSRF (Cross-Site Request Forgery) protection for VpsEasyUploader.

Generates a per-session CSRF token and validates it on all mutating requests
(POST, PUT, DELETE, PATCH). Tokens come from:
  - Hidden form field:  _csrf_token
  - HTTP header:        X-CSRF-Token
  - JSON body key:      _csrf_token

The token is generated once per session and persisted across requests.
"""

import secrets
from functools import wraps

from flask import abort, request, session


def _generate_token() -> str:
    """Generate a cryptographically secure random token."""
    return secrets.token_hex(32)


def get_csrf_token() -> str:
    """
    Get or create the CSRF token for the current session.
    Call this from templates to embed the token in forms.
    """
    if "_csrf_token" not in session:
        session["_csrf_token"] = _generate_token()
    return session["_csrf_token"]


def csrf_required(f):
    """
    Decorator that validates the CSRF token on mutating HTTP methods.

    Skips validation for GET, HEAD, OPTIONS, and TRACE (idempotent/safe).
    Validates POST, PUT, PATCH, DELETE requests.

    The token is checked in this order:
      1. Form field:   request.form.get("_csrf_token")
      2. Header:       request.headers.get("X-CSRF-Token")
      3. JSON body:    request.get_json(silent=True).get("_csrf_token") if JSON
    """

    @wraps(f)
    def decorated_function(*args, **kwargs):
        # Only validate mutating methods
        if request.method not in ("POST", "PUT", "PATCH", "DELETE"):
            return f(*args, **kwargs)

        expected = get_csrf_token()

        # Try form field first
        token = request.form.get("_csrf_token")

        # Try header
        if not token:
            token = request.headers.get("X-CSRF-Token")

        # Try JSON body
        if not token:
            data = request.get_json(silent=True)
            if data and isinstance(data, dict):
                token = data.get("_csrf_token")

        if not token or not secrets.compare_digest(token, expected):
            abort(403, description="CSRF token missing or invalid")

        return f(*args, **kwargs)

    return decorated_function
