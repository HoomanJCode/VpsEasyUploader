/*
 * VpsEasyUploader — Uppy TUS Upload Client
 *
 * Configures Uppy Dashboard + TUS plugin with fingerprint-based
 * resume: when the user re-selects the same file after a page
 * refresh, the upload resumes from where it left off on the
 * server instead of starting from 0 %.
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
        var RESUME_KEY = 'vpsEasyResume';

        // ── Fingerprint-based resume helpers ────────────────────────────
        // tus-js-client v2 auto-stores upload URLs in localStorage by
        // fingerprint, but Uppy's Tus plugin without resume:true never
        // looks them up.  We do that lookup ourselves.

        function fingerprint(file) {
            // Match tus-js-client's default fingerprint:
            // [name, type, size, lastModified].join('-')
            var lm = file.data ? (file.data.lastModified || 0) : 0;
            return [file.name, file.type || '', file.size, lm].join('-');
        }

        function saveResumeEntry(file, uploadUrl) {
            var entries = loadResumeEntries();
            var fp = fingerprint(file);
            entries[fp] = { name: file.name, url: uploadUrl, size: file.size, type: file.type || '', fp: fp };
            try { localStorage.setItem(RESUME_KEY, JSON.stringify(entries)); } catch (_) {}
        }

        function removeResumeEntriesByUrl(uploadUrl) {
            var entries = loadResumeEntries();
            var changed = false;
            for (var key in entries) {
                if (entries[key].url === uploadUrl) { delete entries[key]; changed = true; }
            }
            if (changed) try { localStorage.setItem(RESUME_KEY, JSON.stringify(entries)); } catch (_) {}
        }

        function loadResumeEntries() {
            try { return JSON.parse(localStorage.getItem(RESUME_KEY)) || {}; } catch (_) { return {}; }
        }

        // ── Uppy setup ──────────────────────────────────────────────────

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
            onBeforeRequest: function (req) {
                var meta = document.querySelector('meta[name="csrf-token"]');
                if (meta) req.setHeader('X-CSRF-Token', meta.getAttribute('content'));
            },
        });

        // ── Resume: inject uploadUrl when re-selecting the same file ───
        uppy.on('file-added', function (file) {
            var entries = loadResumeEntries();
            var fp = fingerprint(file);
            var entry = entries[fp];
            if (entry && entry.url) {
                console.log('[Resume] found saved upload URL for', file.name, entry.url);
                uppy.setFileState(file.id, {
                    tus: { uploadUrl: entry.url },
                });
            }
        });

        // Save the upload URL as soon as the POST completes and the
        // first progress event fires (before chunking starts).  This
        // way the URL is persisted even if the user refreshes mid-upload.
        var savedResume = {};
        uppy.on('upload-progress', function (file) {
            if (!savedResume[file.id] && file.tus && file.tus.uploadUrl) {
                savedResume[file.id] = true;
                saveResumeEntry(file, file.tus.uploadUrl);
            }
        });

        // Clean up on successful completion (remove by URL so stale
        // fingerprints from the complete event can't cause mismatches).
        uppy.on('complete', function (result) {
            if (result.successful) {
                result.successful.forEach(function (file) {
                    var url = file.tus && file.tus.uploadUrl;
                    if (url) removeResumeEntriesByUrl(url);
                });
            }
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

        // Keep the URL on error so the user can retry
        uppy.on('upload-error', function (file) {
            if (file.tus && file.tus.uploadUrl) {
                saveResumeEntry(file, file.tus.uploadUrl);
            }
        });

        // Clean up when user removes/cancels a file mid-upload
        uppy.on('file-removed', function (file) {
            if (file.tus && file.tus.uploadUrl) {
                removeResumeEntriesByUrl(file.tus.uploadUrl);
            }
        });

        window.__uppy = uppy;
    });
})();
