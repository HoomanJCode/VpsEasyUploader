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
        // Uppy.Dashboard and Uppy.Tus.
        var Uppy = _U.Uppy, Dashboard = _U.Dashboard, Tus = _U.Tus;
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

        uppy.on('complete', function () {
            if (typeof refreshFiles === 'function') setTimeout(refreshFiles, 800);
            if (typeof refreshDiskInfo === 'function') refreshDiskInfo();
        });

        window.__uppy = uppy;
    });
})();
