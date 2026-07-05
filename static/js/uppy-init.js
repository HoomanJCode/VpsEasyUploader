/*
 * VpsEasyUploader — Uppy TUS Upload Client
 *
 * Configures Uppy Dashboard + TUS plugin with native resume
 * support.  tus-js-client v2 automatically stores upload URLs
 * in localStorage by fingerprint; the only reason that didn't
 * work across page refreshes is that Uppy overrides the
 * fingerprint to use the volatile file.id (which changes every
 * session).  We restore the stable file-based fingerprint so
 * re-selecting the same file after a refresh resumes from
 * where it left off.
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
            // ── Stable fingerprint for resume across page refreshes ──
            // Uppy's default fingerprint uses file.id which changes every
            // session, so tus-js-client never finds the stored upload URL.
            // Using stable file attributes lets tus-js-client's built-in
            // URL storage match the same file after a refresh.
            fingerprint: function (file, _options) {
                return ['vps-easy', file.name, file.type, file.size, file.lastModified].join('-');
            },
            onBeforeRequest: function (req) {
                var meta = document.querySelector('meta[name="csrf-token"]');
                if (meta) req.setHeader('X-CSRF-Token', meta.getAttribute('content'));
            },
        });

        uppy.on('complete', function () {
            // Poll the file list so the dashboard picks up newly uploaded files
            var attempts = 0;
            var maxAttempts = 4;
            function tryRefresh() {
                if (typeof refreshFiles === 'function') refreshFiles();
                if (typeof refreshDiskInfo === 'function') refreshDiskInfo();
                attempts++;
                if (attempts < maxAttempts) setTimeout(tryRefresh, 1500);
            }
            setTimeout(tryRefresh, 800);
        });

        window.__uppy = uppy;
    });
})();
