/*
 * VpsEasyUploader — Uploader Module
 *
 * Handles all client-side upload logic:
 *   - File selection and drag-and-drop
 *   - Resumable chunked uploads (init → chunks → complete)
 *   - Pause / resume support
 *   - File-fingerprint verification on resume
 *   - Progress tracked in the unified "Uploads" table
 */

const Uploader = (() => {
    // Server-supplied chunk size (populated from upload init response)
    let chunkSize = 5 * 1024 * 1024; // 5 MB default

    // Active uploads map: uploadId -> { file, meta, progress, status, rowEl, paused }
    const activeUploads = new Map();

    /* ------------------------------------------------------------------ */
    /*  Fingerprint helpers                                               */
    /* ------------------------------------------------------------------ */

    /**
     * Compute a lightweight file fingerprint for resume verification.
     * Uses SHA-256 of the first 1 MB so it's fast even on 6 GB+ files.
     */
    async function computeFileFingerprint(file) {
        const headSize = Math.min(1024 * 1024, file.size);
        const blob = file.slice(0, headSize);
        const buf = await blob.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        const bytes = Array.from(new Uint8Array(hash));
        return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /* ------------------------------------------------------------------ */
    /*  Utility helpers                                                   */
    /* ------------------------------------------------------------------ */

    function getCsrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    function csrfHeaders(extra = {}) {
        return { 'X-CSRF-Token': getCsrfToken(), ...extra };
    }

    function jsonHeaders(extra = {}) {
        return csrfHeaders({ 'Content-Type': 'application/json', ...extra });
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }

    function showToast(title, message, variant = 'primary') {
        const t = document.getElementById('toast');
        document.getElementById('toast-title').textContent = title;
        document.getElementById('toast-body').textContent = message;
        bootstrap.Toast.getOrCreateInstance(t).show();
    }

    /* ------------------------------------------------------------------ */
    /*  Unified uploads table helpers                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Show the "Uploads" section (the old incomplete-section, now used for
     * all uploads regardless of state).
     */
    function showUploadsSection() {
        const sec = document.getElementById('incomplete-section');
        if (sec) sec.classList.remove('d-none');
    }

    /**
     * Create a row inside #incomplete-table-body for this upload.
     * Returns the <tr> element so the caller can update it in place.
     */
    function addUploadRow(uploadId, filename, totalSize) {
        showUploadsSection();
        const tbody = document.getElementById('incomplete-table-body');
        const tr = document.createElement('tr');
        tr.id = `upload-${uploadId}`;
        tr.innerHTML = `
            <td class="text-truncate" style="max-width:250px;">${escapeHtml(filename)}</td>
            <td class="text-nowrap size-cell">${formatBytes(totalSize)}</td>
            <td style="min-width:160px;">
                <div class="progress" style="height:6px;">
                    <div class="progress-bar progress-bar-striped progress-bar-animated"
                         style="width:0%;"></div>
                </div>
                <small class="text-muted status-cell">Initializing…</small>
            </td>
            <td><small class="text-muted time-cell">now</small></td>
            <td class="action-cell">
                <button class="btn btn-sm btn-outline-secondary pause-btn"
                        data-upload-id="${uploadId}" title="Pause">
                    <i class="bi bi-pause-fill"></i>
                </button>
            </td>`;
        tbody.appendChild(tr);
        // Wire up the pause button
        tr.querySelector('.pause-btn').addEventListener('click', () => {
            pauseUpload(uploadId);
        });
        return tr;
    }

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    /**
     * Update the progress cell of a row managed by this module.
     */
    function updateRowProgress(uploadId, done, total, statusText) {
        const tr = document.getElementById(`upload-${uploadId}`);
        if (!tr) return;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const bar = tr.querySelector('.progress-bar');
        if (bar) {
            bar.style.width = pct + '%';
            bar.textContent = pct > 10 ? pct + '%' : '';
        }
        const status = tr.querySelector('.status-cell');
        if (status) status.textContent = statusText || `${done}/${total} chunks (${pct}%)`;
        tr.querySelector('.time-cell').textContent = 'now';
    }

    /**
     * Set the row status to "Paused" and replace the pause button with a
     * Resume button.
     */
    function setRowPaused(uploadId, filename) {
        const tr = document.getElementById(`upload-${uploadId}`);
        if (!tr) return;
        const bar = tr.querySelector('.progress-bar');
        if (bar) {
            bar.classList.remove('progress-bar-animated');
            bar.classList.replace('progress-bar-striped', 'bg-warning');
        }
        tr.querySelector('.status-cell').textContent = '⏸ Paused';
        const action = tr.querySelector('.action-cell');
        action.innerHTML = `<button class="btn btn-sm btn-outline-primary resume-btn"
            data-upload-id="${uploadId}" data-filename="${escapeHtml(filename)}" title="Resume">
            <i class="bi bi-play-fill"></i></button>`;
        // Re-bind so dashboard picks it up (dashboard uses event delegation on tbody)
    }

    function setRowError(uploadId, msg) {
        const tr = document.getElementById(`upload-${uploadId}`);
        if (!tr) return;
        const bar = tr.querySelector('.progress-bar');
        if (bar) {
            bar.classList.remove('progress-bar-animated', 'progress-bar-striped');
            bar.classList.add('bg-danger');
        }
        tr.querySelector('.status-cell').innerHTML =
            `<i class="bi bi-exclamation-triangle text-danger"></i> ${msg}`;
        tr.querySelector('.action-cell').innerHTML = '';
    }

    function removeUploadRow(uploadId) {
        const tr = document.getElementById(`upload-${uploadId}`);
        if (tr) tr.remove();
        // Hide section if no rows remain
        const tbody = document.getElementById('incomplete-table-body');
        if (tbody && tbody.children.length === 0) {
            const sec = document.getElementById('incomplete-section');
            if (sec) sec.classList.add('d-none');
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Pause / resume                                                    */
    /* ------------------------------------------------------------------ */

    function pauseUpload(uploadId) {
        const st = activeUploads.get(uploadId);
        if (!st) return;
        st.paused = true;
        st.pausedByUser = true;
        const filename = st.file ? st.file.name : (st.meta ? st.meta.filename : '');
        setRowPaused(uploadId, filename);
    }

    function resumeUploadFromPause(uploadId) {
        const st = activeUploads.get(uploadId);
        if (!st || !st.pausedByUser) return false;
        st.paused = false;
        st.pausedByUser = false;
        // Resume the chunk loop
        uploadMissingChunks(uploadId).catch(err => {
            console.error(`Resume error [${uploadId}]:`, err);
            setRowError(uploadId, err.message || 'Resume failed');
        });
        return true;
    }

    /* ------------------------------------------------------------------ */
    /*  Core upload flow                                                  */
    /* ------------------------------------------------------------------ */

    async function addFile(file) {
        await startUpload(null, file);
    }

    /**
     * Start or resume an upload.
     *
     * @param {string|null} uploadId  null for new upload; existing id for resume
     * @param {File}        file      file object from browser
     * @param {boolean}     [isResume=false]  set by resume-flow callers
     */
    async function startUpload(uploadId, file, isResume = false) {
        const totalSize = file.size;

        // --- fingerprint ----------------------------------------------------
        const fingerprint = await computeFileFingerprint(file);

        // If resuming, verify fingerprint before talking to the server
        if (isResume && uploadId) {
            const ok = await verifyFingerprint(uploadId, fingerprint, file);
            if (!ok) throw new Error('File does not match the incomplete upload.');
            // error toast is shown inside verifyFingerprint
        }

        // Create unified row
        const row = addUploadRow(uploadId || 'temp', file.name, totalSize);

        // State
        const state = {
            file,
            meta: null,
            progress: 0,
            status: 'init',
            paused: false,
            pausedByUser: false,
        };
        activeUploads.set(uploadId || 'temp', state);

        try {
            // Step 1 — check disk space
            const spaceResp = await fetch(`/check_space?size=${totalSize}`, { headers: csrfHeaders() });
            const spaceData = await spaceResp.json();
            if (!spaceData.available)
                throw new Error('Not enough disk space on the server.');

            // Step 2 — init
            const initResp = await fetch('/upload/init', {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({
                    filename: file.name,
                    total_size: totalSize,
                    upload_id: isResume ? uploadId : undefined,
                    file_fingerprint: fingerprint,
                }),
            });

            if (initResp.status === 409) {
                const e = await initResp.json().catch(() => ({}));
                throw new Error(e.error || `File "${file.name}" already exists on the server.`);
            }
            if (!initResp.ok) {
                const e = await initResp.json().catch(() => ({}));
                throw new Error(e.error || `Init failed (HTTP ${initResp.status})`);
            }

            const initData = await initResp.json();

            // Resolve final upload_id (server may return existing one on conflict)
            const finalId = initData.upload_id;
            if (finalId !== (uploadId || finalId)) {
                // Update state key and row id
                activeUploads.delete(uploadId || 'temp');
                activeUploads.set(finalId, state);
                row.id = `upload-${finalId}`;
                // Re-wire pause button with correct id
                const btn = row.querySelector('.pause-btn');
                if (btn) btn.setAttribute('data-upload-id', finalId);
            }

            // Step 3 — get upload status (which chunks already exist)
            const statusResp = await fetch(`/upload/status/${finalId}`, { headers: csrfHeaders() });
            const statusData = await statusResp.json();
            chunkSize = statusData.chunk_size || chunkSize;

            state.meta = statusData;
            activeUploads.set(finalId, state);

            const received = new Set(statusData.received_chunks || []);
            const totalChunks = statusData.total_chunks;

            // All chunks already here — complete immediately
            if (received.size === totalChunks) {
                await complete(finalId);
                return;
            }

            updateRowProgress(finalId, received.size, totalChunks,
                `${received.size}/${totalChunks} chunks`);
            state.progress = received.size;

            // Step 4 — upload missing chunks (happens async below)
            await uploadMissingChunks(finalId);

        } catch (err) {
            console.error(`Upload error [${uploadId}]:`, err);
            setRowError(row.id.replace('upload-', ''), err.message || 'Upload failed');
            showToast('Upload Failed', err.message, 'danger');
        }
    }

    /**
     * Verify that a re-selected file matches the incomplete upload's fingerprint.
     */
    async function verifyFingerprint(uploadId, fingerprint, file) {
        try {
            const resp = await fetch(`/upload/status/${uploadId}`, { headers: csrfHeaders() });
            if (!resp.ok) {
                showToast('Error', 'Upload not found on server.', 'danger');
                return false;
            }
            const data = await resp.json();

            // Basic sanity: same filename & size
            if (data.filename !== file.name || data.total_size !== file.size) {
                const msg = `File mismatch — expected "${data.filename}" (${formatBytes(data.total_size)}), ` +
                    `got "${file.name}" (${formatBytes(file.size)}). Please select the same file.`;
                showToast('Wrong File', msg, 'danger');
                return false;
            }

            // Fingerprint check (first 1 MB hash)
            const stored = data.file_fingerprint;
            if (stored && stored !== fingerprint) {
                showToast('Wrong File',
                    'This file\'s content doesn\'t match the incomplete upload. Please select the same file.',
                    'danger');
                return false;
            }
            return true;
        } catch (err) {
            showToast('Error', 'Failed to verify upload identity.', 'danger');
            return false;
        }
    }

    /**
     * Upload every missing chunk, respecting the pause flag.
     */
    async function uploadMissingChunks(uploadId) {
        const state = activeUploads.get(uploadId);
        if (!state || !state.meta) return;

        const meta = state.meta;
        const file = state.file;
        const totalChunks = meta.total_chunks;
        const received = new Set(meta.received_chunks || []);
        const totalSize = meta.total_size;
        const cs = meta.chunk_size || chunkSize;

        let done = received.size;
        updateRowProgress(uploadId, done, totalChunks, `Resuming… ${done}/${totalChunks} chunks`);

        for (let i = 0; i < totalChunks; i++) {
            // --- PAUSE CHECK ---
            if (state.paused) {
                // Don't remove from active — stay in the map so resume can find us
                setRowPaused(uploadId, meta.filename);
                return; // exit the loop; resumeUploadFromPause() will re-enter
            }
            // --- SKIP already-uploaded chunks ---
            if (received.has(i)) continue;

            const start = i * cs;
            const end = Math.min(start + cs, totalSize);
            const blob = file.slice(start, end);

            const formData = new FormData();
            formData.append('upload_id', uploadId);
            formData.append('chunk_index', String(i));
            formData.append('chunk_data', blob, `chunk_${i}`);

            const chunkResp = await fetch('/upload/chunk', {
                method: 'POST',
                headers: csrfHeaders(),
                body: formData,
            });
            if (!chunkResp.ok) {
                const e = await chunkResp.json().catch(() => ({}));
                throw new Error(e.error || `Chunk ${i} upload failed`);
            }
            done++;
            state.progress = done;
            updateRowProgress(uploadId, done, totalChunks,
                `Uploading… ${done}/${totalChunks} chunks`);
        }

        // All chunks done
        await complete(uploadId);
    }

    async function complete(uploadId) {
        updateRowProgress(uploadId, 1, 1, 'Finalizing…');
        const resp = await fetch(`/upload/complete/${uploadId}`, {
            method: 'POST',
            headers: csrfHeaders(),
        });
        const data = await resp.json();
        if (!data.success) throw new Error(data.error || 'Completion failed');

        removeUploadRow(uploadId);
        activeUploads.delete(uploadId);
        showToast('Complete', data.message || 'File uploaded successfully.', 'success');

        // Refresh file list and disk info
        if (typeof refreshFiles === 'function') setTimeout(refreshFiles, 500);
        if (typeof refreshDiskInfo === 'function') refreshDiskInfo();
    }

    /* ------------------------------------------------------------------ */
    /*  Public API                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Resume an incomplete upload from the UI.
     * Called by dashboard when the user clicks Resume on an incomplete row.
     * Returns true if the upload was successfully resumed, false on failure.
     */
    async function resumeFromUI(uploadId, file) {
        try {
            await startUpload(uploadId, file, true);
            return true;
        } catch (err) {
            console.error(`Resume failed [${uploadId}]:`, err);
            return false;
        }
    }

    /**
     * Resume a paused upload (already in activeUploads).
     */
    function resumePaused(uploadId) {
        return resumeUploadFromPause(uploadId);
    }

    /* ------------------------------------------------------------------ */
    /*  Drop zone setup                                                   */
    /* ------------------------------------------------------------------ */

    function setupDropZone() {
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');
        const browseBtn = document.getElementById('browse-btn');
        if (!dropZone || !fileInput) return;

        browseBtn.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('click', e => {
            if (e.target !== browseBtn && !browseBtn.contains(e.target)) fileInput.click();
        });
        fileInput.addEventListener('change', () => {
            handleFiles(fileInput.files);
            fileInput.value = '';
        });
        dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', e => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            handleFiles(e.dataTransfer.files);
        });
    }

    async function handleFiles(fileList) {
        if (!fileList || fileList.length === 0) return;
        let total = 0;
        const files = [];
        for (const f of fileList) { total += f.size; files.push(f); }
        try {
            const r = await fetch(`/check_space?size=${total}`, { headers: csrfHeaders() });
            const d = await r.json();
            if (!d.available) {
                showToast('Error', `Need ${formatBytes(total)}, have ${formatBytes(d.free)} free.`, 'danger');
                return;
            }
        } catch (_) { /* server will reject individual uploads */ }
        for (const f of files) await addFile(f);
    }

    return {
        setupDropZone,
        resumeFromUI,
        resumePaused,
        formatBytes,
    };
})();

document.addEventListener('DOMContentLoaded', () => Uploader.setupDropZone());
