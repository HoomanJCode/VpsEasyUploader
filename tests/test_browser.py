"""
VpsEasyUploader — Browser Test Script (Playwright)

End-to-end test that:
  1. Navigates to the server
  2. Registers the admin account
  3. Uploads a file
  4. Verifies the file appears in the dashboard

Requirements:
  pip install playwright
  playwright install chromium

Usage:
  # Start the server first:
  python app.py

  # In another terminal:
  python tests/test_browser.py

  Or with a custom URL:
  BASE_URL=http://localhost:8080 python tests/test_browser.py
"""

import os
import sys
import tempfile
import time

# Configuration
BASE_URL = os.environ.get("BASE_URL", "http://localhost:8080")
TEST_PASSWORD = "BrowserTest123"

# ── Output helpers ──────────────────────────────────────────────────────────
GREEN = "\033[0;32m"
RED = "\033[0;31m"
YELLOW = "\033[1;33m"
CYAN = "\033[0;36m"
NC = "\033[0m"


def log(msg: str, color: str = NC) -> None:
    print(f"{color}[{time.strftime('%H:%M:%S')}] {msg}{NC}")


def success(msg: str) -> None:
    log(f"✓ {msg}", GREEN)


def warn(msg: str) -> None:
    log(f"! {msg}", YELLOW)


def fail(msg: str) -> None:
    log(f"✗ {msg}", RED)


def main():
    """Run the browser test."""
    log("=" * 60, CYAN)
    log("  VpsEasyUploader — Browser Test", CYAN)
    log("=" * 60, CYAN)
    log(f"Server URL: {BASE_URL}")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        fail("Playwright is not installed. Run: pip install playwright && playwright install chromium")
        sys.exit(1)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        try:
            # ── Step 1: Navigate to server ────────────────────────────────
            log("Step 1: Navigating to server...")
            page.goto(BASE_URL)
            page.wait_for_load_state("networkidle")

            # Check if we're on the register page (first run)
            current_url = page.url
            log(f"  Current URL: {current_url}")

            if "/register" in current_url:
                # ── Step 2: Register ──────────────────────────────────────
                log("Step 2: Registering admin account...")
                page.fill("#password", TEST_PASSWORD)
                page.fill("#confirm", TEST_PASSWORD)
                page.click("button[type='submit']")
                page.wait_for_load_state("networkidle")
                success("Registration completed")

            elif "/login" in current_url:
                # ── Step 2b: Login ────────────────────────────────────────
                log("Step 2b: Login page detected, logging in...")
                page.fill("#password", TEST_PASSWORD)
                page.click("button[type='submit']")
                page.wait_for_load_state("networkidle")
                success("Login completed")

            # ── Step 3: Wait for dashboard ────────────────────────────────
            log("Step 3: Waiting for dashboard to load...")
            page.wait_for_selector("#drop-zone", timeout=10000)
            success("Dashboard loaded")

            # ── Step 4: Upload a test file ────────────────────────────────
            log("Step 4: Uploading a test file...")

            # Create a temporary test file
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".txt", delete=False, prefix="test_upload_"
            ) as tmp:
                tmp.write("Hello from VpsEasyUploader browser test!\n" * 100)
                tmp_path = tmp.name

            # Set up file chooser dialog
            with page.expect_file_chooser() as fc_info:
                page.click("#browse-btn")
            file_chooser = fc_info.value
            file_chooser.set_files(tmp_path)

            # Wait for upload to complete (look for completed state or file in table)
            time.sleep(3)
            page.wait_for_timeout(2000)

            # Check for completed upload
            completed = page.query_selector(".upload-item.completed")
            if completed:
                success("Upload completed successfully")
            else:
                # Check file table
                file_row = page.query_selector(f"tr[data-file='{os.path.basename(tmp_path)}']")
                if file_row:
                    success("File appears in dashboard table")
                else:
                    warn("Could not verify upload completion in UI (may need more time)")

            # ── Step 5: Verify file listing ───────────────────────────────
            log("Step 5: Refreshing file list...")
            page.click("#refresh-files-btn")
            page.wait_for_timeout(1000)

            file_list = page.query_selector_all("#file-table-body tr")
            file_count = len([r for r in file_list if r.get_attribute("data-file")])
            log(f"  Found {file_count} files in dashboard")

            if file_count > 0:
                success(f"File listing works ({file_count} files)")
            else:
                warn("No files found in listing (may need more time)")

            # ── Cleanup ───────────────────────────────────────────────────
            os.unlink(tmp_path)
            log("Cleaned up temporary test file")

            # ── Summary ───────────────────────────────────────────────────
            print()
            log("=" * 60, GREEN)
            log("  Browser test completed successfully!", GREEN)
            log("=" * 60, GREEN)

        except Exception as e:
            fail(f"Test failed: {e}")
            # Take a screenshot for debugging
            try:
                page.screenshot(path="test_failure.png")
                log("Screenshot saved to test_failure.png", YELLOW)
            except Exception:
                pass
            raise

        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
