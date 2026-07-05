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

        // TUS server runs on port 1080 alongside Flask on 8080.
        // On production the browser reaches tusd directly; on local
        // dev it reaches localhost:1080.
        var tusEndpoint = window.location.origin.replace(
            ':' + (window.location.port || '80'), ':1080'
        ) + '/';

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
            resume: true,
            autoRetry: true,
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
