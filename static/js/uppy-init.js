/*
 * VpsEasyUploader — Uppy TUS Upload Client
 *
 * Configures Uppy Dashboard + TUS plugin.
 * Replaces the entire custom uploader.js + queue.js + chunker.py stack.
 *
 * Uppy handles: drag-drop, file list, progress, speed, pause/resume,
 * retry, chunking — all out of the box via the TUS protocol.
 */
(function () {
    document.addEventListener('DOMContentLoaded', () => {
        var _U = window.Uppy;
        if (!_U) { console.error('Uppy not loaded'); return; }
        // Uppy v3 CDN: constructor at Uppy.Uppy, plugins at
        // Uppy.Dashboard, Uppy.Tus, and Uppy.GoldenRetriever.
        var Uppy = _U.Uppy, Dashboard = _U.Dashboard, Tus = _U.Tus,
            GoldenRetriever = _U.GoldenRetriever;
        if (!Dashboard) { console.warn('Uppy.Dashboard not found'); }
        if (!Tus) { console.warn('Uppy.Tus not found — uploads will fail'); }

        // TUS requests go through Flask's /tus/ proxy to tusd on
        // 127.0.0.1:1080.  No extra firewall port needed — the
        // browser uses the same origin as the dashboard.
        var tusEndpoint = '/tus/';

        var uppy = new Uppy({
            debug: true,
        });

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
            onBeforeRequest: function (req) {
                var meta = document.querySelector('meta[name="csrf-token"]');
                if (meta) req.setHeader('X-CSRF-Token', meta.getAttribute('content'));
            },
        });

        // GoldenRetriever persists upload state in IndexedDB so
        // in-progress uploads survive page refreshes, browser
        // crashes, and accidental tab closures.  When the user
        // returns, partial uploads reappear in the Dashboard
        // and resume from where they left off.
        if (GoldenRetriever) {
            uppy.use(GoldenRetriever, {
                serviceWorker: false,
            });
        } else {
            console.warn('Uppy.GoldenRetriever not available — uploads will not survive page refreshes');
        }

        uppy.on('complete', function () {
            // The TUS webhook moves the file from .tusd/ to uploads/
            // after tusd confirms the upload.  Poll the file list a
            // few times so the dashboard picks it up reliably.
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
