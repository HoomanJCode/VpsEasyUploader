/*
 * VpsEasyUploader — Uppy TUS Upload Client
 *
 * Configures Uppy Dashboard + TUS plugin with resume support
 * for both pause/resume and page-refresh scenarios.
 *
 * Uppy handles: drag-drop, file list, progress, speed, pause/resume,
 * retry, chunking — all out of the box via the TUS protocol.
 */
(function () {
    document.addEventListener('DOMContentLoaded', () => {
        var _U = window.Uppy;
        if (!_U) { console.error('Uppy not loaded'); return; }
        var Uppy = _U.Uppy, Dashboard = _U.Dashboard, Tus = _U.Tus;
        if (!Dashboard) { console.warn('Uppy.Dashboard not found'); }
        if (!Tus) { console.warn('Uppy.Tus not found — uploads will fail'); }

        var tusEndpoint = '/tus/';
        var LS_PREFIX = 'vps-resume:';

        // ── Resume helpers ───────────────────────────────────────────

        function resumeKey(file) {
            return LS_PREFIX + file.name + '|' + (file.type || '') + '|' + file.size;
        }

        function saveResumeUrl(file) {
            if (file.tus && file.tus.uploadUrl) {
                try { localStorage.setItem(resumeKey(file), file.tus.uploadUrl); } catch (_) {}
            }
        }

        function loadResumeUrl(file) {
            try { return localStorage.getItem(resumeKey(file)); } catch (_) { return null; }
        }

        function clearResumeUrl(file) {
            try { localStorage.removeItem(resumeKey(file)); } catch (_) {}
        }

        // ── Uppy setup ──────────────────────────────────────────────

        var uppy = new Uppy({ debug: true });

        uppy.use(Dashboard, {
            target: '#uppy-dashboard',
            inline: true,
            showProgressDetails: true,
            proudlyDisplayPoweredByUppy: false,
            height: 360,
            browserBackButtonClose: false,
        });

        uppy.use(Tus, {
            endpoint: tusEndpoint,
            chunkSize: 20 * 1024 * 1024,
            retryDelays: [0, 1000, 3000, 5000],
            withCredentials: true,
            // Stable fingerprint: Uppy's default uses volatile file.id
            // which breaks tus-js-client's URL storage across refreshes.
            // Using file attributes gives a consistent key.
            fingerprint: function (file, _options) {
                return ['vps-easy', file.name, file.type, file.size, file.lastModified].join('-');
            },
            onBeforeRequest: function (req) {
                var meta = document.querySelector('meta[name="csrf-token"]');
                if (meta) req.setHeader('X-CSRF-Token', meta.getAttribute('content'));
            },
        });

        // ── Save upload URL to localStorage on first progress ──────
        uppy.on('upload-progress', function (file) {
            if (file.tus && file.tus.uploadUrl) {
                saveResumeUrl(file);
            }
        });

        // ── Restore upload URL when file is (re-)added ─────────────
        // Covers: initial add, retryUpload (pause→resume), and
        // page-refresh re-select.
        uppy.on('file-added', function (file) {
            var url = loadResumeUrl(file);
            if (url) {
                console.log('[Resume] found upload URL for', file.name);
                // CRITICAL: Object.assign merges into the existing
                // file.tus object — a plain {tus: {uploadUrl}} would
                // REPLACE it, wiping Tus plugin state and forcing a
                // fresh POST instead of HEAD+PATCH.
                uppy.setFileState(file.id, {
                    tus: Object.assign({}, file.tus, { uploadUrl: url }),
                });
            }
        });

        // ── Cleanup ────────────────────────────────────────────────

        uppy.on('complete', function (result) {
            if (result.successful) {
                result.successful.forEach(function (file) { clearResumeUrl(file); });
            }
            // Poll the file list so the dashboard picks up newly uploaded files
            var attempts = 0, maxAttempts = 4;
            function tryRefresh() {
                if (typeof refreshFiles === 'function') refreshFiles();
                if (typeof refreshDiskInfo === 'function') refreshDiskInfo();
                attempts++;
                if (attempts < maxAttempts) setTimeout(tryRefresh, 1500);
            }
            setTimeout(tryRefresh, 800);
        });

        uppy.on('file-removed', function (file) {
            clearResumeUrl(file);
        });

        window.__uppy = uppy;
    });
})();
