/*
 * VpsEasyUploader — Uppy TUS Upload Client
 *
 * Resume support: saves TUS upload URLs to localStorage on upload-progress,
 * then injects them into uppy.state.tus (the internal urlStorage that the Tus
 * plugin actually checks) when the same file is re-added.
 *
 * Why uppy.state.tus and not file.tus.uploadUrl?
 *   The @uppy/tus plugin overrides tus-js-client's urlStorage with an
 *   in-memory wrapper keyed on uppy.state.tus[fingerprint].  Setting
 *   file.tus.uploadUrl via setFileState has no effect because the plugin
 *   checks state.tus, not the file object.
 */
(function () {
    document.addEventListener('DOMContentLoaded', () => {
        var _U = window.Uppy;
        if (!_U) { console.error('Uppy not loaded'); return; }
        var Uppy = _U.Uppy, Dashboard = _U.Dashboard, Tus = _U.Tus;
        if (!Dashboard) { console.warn('Uppy.Dashboard not found'); }
        if (!Tus) { console.warn('Uppy.Tus not found — uploads will fail'); }

        var uppy = new Uppy({ debug: true });

        // ── Fingerprint helper ──────────────────────────────────────────
        // Handles both native File objects (Tus plugin passes these) and
        // Uppy file objects (event handlers use these).  lastModified lives
        // directly on native Files but on file.data.lastModified for Uppy.
        function fingerprint(file) {
            var lm = file.lastModified || (file.data && file.data.lastModified) || 0;
            return ['vps-easy', file.name, file.type, file.size, lm].join('-');
        }

        // ── Resume: save / restore TUS upload URLs ──────────────────────
        // localStorage key → TUS upload URL (absolute path like /tus/<id>)
        var PREFIX = 'vps-resume:';

        // Build the same resume key regardless of whether `file` is a
        // Uppy file object or a native File.
        function resumeKey(file) {
            var lm = file.lastModified || (file.data && file.data.lastModified) || 0;
            return PREFIX + file.name + '|' + (file.type || '') + '|' + file.size + '|' + lm;
        }

        function saveResumeUrl(file) {
            if (!file.tus || !file.tus.uploadUrl) return;
            var key = resumeKey(file);
            var url = file.tus.uploadUrl;
            if (localStorage.getItem(key) !== url) {
                try { localStorage.setItem(key, url); } catch (_) {}
                console.log('[Resume:SAVE]', key, url);
            }
        }

        function clearResumeUrl(file) {
            try { localStorage.removeItem(resumeKey(file)); } catch (_) {}
        }

        function restoreResumeState(file) {
            var key = resumeKey(file);
            var url = localStorage.getItem(key);
            if (!url) return false;

            // Inject into uppy.state.tus — the in-memory urlStorage that
            // the Tus plugin actually checks when deciding whether to POST
            // or HEAD+PATCH.
            var fp = fingerprint(file);
            var state = uppy.getState().tus || {};

            if (!state[fp]) {
                var record = JSON.stringify({
                    size: file.size,
                    metadata: { filename: file.name, filetype: file.type },
                    creationTime: new Date().toString(),
                    uploadUrl: url
                });
                var patch = {};
                patch[fp] = record;
                uppy.setState({
                    tus: Object.assign({}, state, patch)
                });
                console.log('[Resume:RESTORE] fp=' + fp + ' url=' + url);
                return true;
            }
            return false;
        }

        // ── Uppy plugins ────────────────────────────────────────────────

        uppy.use(Dashboard, {
            target: '#uppy-dashboard',
            inline: true,
            height: 420,
            showProgressDetails: true,
            proudlyDisplayPoweredByUppy: false,
            browserBackButtonClose: false,
            note: 'Drop files here or click to browse. Uploads resume automatically if interrupted.',
            showSelectedFiles: true,
            disableStatusBar: false,
        });

        uppy.use(Tus, {
            endpoint: '/tus/',
            chunkSize: 20 * 1024 * 1024,
            retryDelays: [0, 1000, 3000, 5000],
            withCredentials: true,
            fingerprint: fingerprint,
            onBeforeRequest: function (req) {
                var meta = document.querySelector('meta[name="csrf-token"]');
                if (meta) req.setHeader('X-CSRF-Token', meta.getAttribute('content'));
            },
        });

        // ── State-class helpers for live file-item indicators ───────────

        var STATE_CLASSES = ['is-uploading', 'is-complete', 'is-paused', 'is-error'];
        // Per-file speed tracking
        var speedTrack = {};

        function findFileItem(file) {
            return document.querySelector('.uppy-DashboardItem[data-id="' + file.id + '"]');
        }

        function setFileStateClass(file, className) {
            var el = findFileItem(file);
            if (!el) return;
            STATE_CLASSES.forEach(function (c) { el.classList.remove(c); });
            if (className) el.classList.add(className);
        }

        function formatSpeed(bytesPerSec) {
            if (bytesPerSec >= 1e6) return (bytesPerSec / 1e6).toFixed(1) + ' MB/s';
            if (bytesPerSec >= 1e3) return (bytesPerSec / 1e3).toFixed(0) + ' KB/s';
            return bytesPerSec + ' B/s';
        }

        function updateSpeedBadge(file) {
            var el = findFileItem(file);
            if (!el) return;
            var statusEl = el.querySelector('.uppy-DashboardItem-status');
            if (!statusEl) return;

            var badge = el.querySelector('.uppy-speed-badge');
            var now = Date.now();
            var bytes = file.progress.bytesUploaded || 0;
            var track = speedTrack[file.id];

            if (track && track.lastBytes < bytes && track.lastTime < now) {
                var elapsed = (now - track.lastTime) / 1000;
                if (elapsed > 0.1) {
                    var speed = (bytes - track.lastBytes) / elapsed;
                    if (!badge) {
                        badge = document.createElement('span');
                        badge.className = 'uppy-speed-badge';
                        badge.innerHTML = '<i class="bi bi-lightning-charge-fill"></i>';
                        statusEl.appendChild(badge);
                    }
                    badge.lastChild.textContent = ' ' + formatSpeed(speed);
                }
            } else if (!track) {
                // First data point — show placeholder
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'uppy-speed-badge';
                    badge.innerHTML = '<i class="bi bi-lightning-charge-fill"></i> calculating...';
                    statusEl.appendChild(badge);
                }
            }

            speedTrack[file.id] = { lastBytes: bytes, lastTime: now };
        }

        function removeSpeedBadge(file) {
            var el = findFileItem(file);
            if (!el) return;
            var badge = el.querySelector('.uppy-speed-badge');
            if (badge) badge.remove();
            delete speedTrack[file.id];
        }

        // ── Resume event handlers ───────────────────────────────────────

        // Save URL on first chunk so pause/resume & page-refresh both work.
        // Saved once per file (guard: only when URL is new).
        uppy.on('upload-progress', function (file) {
            saveResumeUrl(file);
            setFileStateClass(file, 'is-uploading');
            updateSpeedBadge(file);
        });

        // Restore saved URL into uppy.state.tus when a file is added.
        // Covers: initial add, retryUpload (pause→resume), and page-refresh
        // re-add (same fingerprint matches saved URL).
        uppy.on('file-added', function (file) {
            restoreResumeState(file);
            // Mark as paused until upload actually starts
            setFileStateClass(file, 'is-paused');
        });

        // Upload begins — switch from paused/queued to uploading
        uppy.on('upload', function () {
            var files = uppy.getFiles();
            files.forEach(function (f) {
                if (f.progress && f.progress.uploadStarted && !f.progress.uploadComplete) {
                    setFileStateClass(f, 'is-uploading');
                }
            });
        });

        // Single file succeeded
        uppy.on('upload-success', function (file) {
            setFileStateClass(file, 'is-complete');
            removeSpeedBadge(file);
        });

        // Clean up localStorage and mark complete when all uploads finish
        uppy.on('complete', function (result) {
            if (result.successful) {
                result.successful.forEach(function (file) {
                    clearResumeUrl(file);
                    setFileStateClass(file, 'is-complete');
                });
            }
            // Poll the file list so the dashboard picks up newly uploaded files
            var attempts = 0, maxAttempts = 4;
            function tryRefresh() {
                if (typeof refreshFiles === 'function') refreshFiles();
                if (typeof refreshDiskInfo === 'function') refreshDiskInfo();
                if (++attempts < maxAttempts) setTimeout(tryRefresh, 1500);
            }
            setTimeout(tryRefresh, 800);
        });

        // Upload error
        uppy.on('upload-error', function (file) {
            setFileStateClass(file, 'is-error');
            removeSpeedBadge(file);
        });

        // Clean up when user removes a file (cancel, clear, etc.)
        uppy.on('file-removed', function (file) {
            clearResumeUrl(file);
            removeSpeedBadge(file);
        });

        // All uploads cancelled — mark remaining files as paused
        uppy.on('cancel-all', function () {
            var files = uppy.getFiles();
            files.forEach(function (f) {
                if ((!f.progress || !f.progress.uploadComplete) && !f.error) {
                    setFileStateClass(f, 'is-paused');
                }
            });
        });

        window.__uppy = uppy;
    });
})();
