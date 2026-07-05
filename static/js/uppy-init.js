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
        function fingerprint(file) {
            return ['vps-easy', file.name, file.type, file.size, file.lastModified].join('-');
        }

        // ── Resume: save / restore TUS upload URLs ──────────────────────
        // localStorage key → TUS upload URL (absolute path like /tus/<id>)
        var PREFIX = 'vps-resume:';

        function resumeKey(file) {
            return PREFIX + fingerprint(file);
        }

        function saveResumeUrl(file) {
            if (!file.tus || !file.tus.uploadUrl) return;
            var key = resumeKey(file);
            var url = file.tus.uploadUrl;
            if (localStorage.getItem(key) !== url) {
                localStorage.setItem(key, url);
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
                uppy.setState({
                    tus: Object.assign({}, state, (function () {
                        var patch = {}; patch[fp] = record; return patch;
                    })())
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
            showProgressDetails: true,
            proudlyDisplayPoweredByUppy: false,
            height: 360,
            browserBackButtonClose: false,
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

        // ── Resume event handlers ───────────────────────────────────────

        // Save URL on first chunk so pause/resume & page-refresh both work.
        // Saved once per file (guard: only when URL is new).
        uppy.on('upload-progress', function (file) {
            saveResumeUrl(file);
        });

        // Restore saved URL into uppy.state.tus when a file is added.
        // Covers: initial add, retryUpload (pause→resume), and page-refresh
        // re-add (same fingerprint matches saved URL).
        uppy.on('file-added', function (file) {
            restoreResumeState(file);
        });

        // Clean up localStorage when upload completes so stale URLs
        // don't conflict with future uploads of the same file.
        uppy.on('complete', function (result) {
            if (result.successful) {
                result.successful.forEach(function (file) {
                    clearResumeUrl(file);
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

        // Clean up when user removes a file (cancel, clear, etc.)
        uppy.on('file-removed', function (file) {
            clearResumeUrl(file);
        });

        window.__uppy = uppy;
    });
})();
