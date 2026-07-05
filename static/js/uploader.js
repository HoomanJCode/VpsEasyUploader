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
    // Counter for queued row IDs
    let _queueId = 0;
    // Track cancelled queued files so the loop skips them
    const cancelledQueues = new Set();

    /* ------------------------------------------------------------------ */
    /*  Fingerprint helpers                                               */
    /* ------------------------------------------------------------------ */

    /**
     * Compute a lightweight file fingerprint for resume verification.
     * Uses SHA-256 of the first 1 MB when available (secure context),
     * falls back to filename+size+lastModified on plain HTTP.
     */
    async function computeFileFingerprint(file) {
        // Try SubtleCrypto first (HTTPS / localhost only)
        if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
            const headSize = Math.min(1024 * 1024, file.size);
            const blob = file.slice(0, headSize);
            const buf = await blob.arrayBuffer();
            try {
                const hash = await crypto.subtle.digest('SHA-256', buf);
                const bytes = Array.from(new Uint8Array(hash));
                return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
            } catch (_) { /* fall through to fallback */ }
        }
        // Plain-HTTP fallback: name, size, lastModified (null-byte separated
        // so the separator can't appear in a filename on any platform)
        return 'fallback:' + file.name + '\x00' + file.size + '\x00' + (file.lastModified || 0);
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

    function formatSpeed(bytesPerSec) {
        if (!bytesPerSec || bytesPerSec <= 0 || !isFinite(bytesPerSec)) return '\u2014';
        if (bytesPerSec < 1024) return formatBytes(Math.round(bytesPerSec)) + '/s';
        const i = Math.floor(Math.log(bytesPerSec) / Math.log(1024));
        const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        return (bytesPerSec / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }

    function showToast(title, message, variant = 'primary') {
        const t = document.getElementById('toast');
        document.getElementById('toast-title').textContent = title;
        document.getElementById('toast-body').textContent = message;
        bootstrap.Toast.getOrCreateInstance(t).show();
    }

    /**
     * Format elapsed seconds to a human-readable relative time.
     */
    function formatRelativeTime(startedAt) {
        const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        if (secs < 5) return 'Just now';
        if (secs < 60) return `${secs}s ago`;
        if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
        return `${Math.floor(secs / 3600)} hr ago`;
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
            <td style="min-width:220px;">
                <div class="chunks-bar"><!-- segments added after init/status --></div>
                <small class="text-muted status-cell">Initializing…</small>
            </td>
            <td class="text-nowrap text-end speed-cell">\u2014</td>
            <td><small class="text-muted time-cell">now</small></td>
            <td class="action-cell">
                <button class="btn btn-sm btn-outline-secondary pause-btn"
                        data-upload-id="${uploadId}" title="Pause">
                    <i class="bi bi-pause-fill"></i>
                </button>
                <button class="btn btn-sm btn-outline-danger cancel-btn"
                        data-upload-id="${uploadId}" title="Cancel">
                    <i class="bi bi-x-lg"></i>
                </button>
            </td>`;
        tbody.appendChild(tr);
        // Wire up the pause button
        tr.querySelector('.pause-btn').addEventListener('click', () => {
            pauseUpload(uploadId);
        });
        // Wire up the cancel button (direct binding for active uploads)
        tr.querySelector('.cancel-btn').addEventListener('click', () => {
            cancelUpload(uploadId);
        });
        return tr;
    }

    /**
     * Above this chunk count, render a single continuous bar instead of
     * one segment per chunk — otherwise very large files render as a wall
     * of imperceptible 1px slices with gaps consuming all the width.
     */
    const MAX_CHUNK_SEGMENTS = 50;

    /**
     * Format the chunk-count overlay text used on the chunks-bar.
     */
    function formatChunkText(done, total, label) {
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return label
            ? `${label} ${done}/${total} (${pct}%)`
            : `${done}/${total} (${pct}%)`;
    }

    /**
     * Render the segmented chunks-bar once `totalChunks` and the set of
     * already-received chunk indices are known. Caches each segment on the
     * state object so later per-chunk updates don't query the DOM.
     * @param {string}   uploadId
     * @param {number}   totalChunks
     * @param {number[]} receivedIndices  chunk indices already on the server
     */
    function renderChunksBar(uploadId, totalChunks, receivedIndices) {
        const tr = document.getElementById(`upload-${uploadId}`);
        if (!tr) return;
        const bar = tr.querySelector('.chunks-bar');
        if (!bar) return;
        bar.innerHTML = '';

        const state = activeUploads.get(uploadId);
        if (!state) return;
        state.segments = null;
        state.segmentText = null;
        state.continuousMode = false;
        state.continuousSeg = null;

        const done = (receivedIndices && receivedIndices.length) || 0;

        // Fallback: too many chunks → single continuous bar
        if (totalChunks > MAX_CHUNK_SEGMENTS) {
            const pct = totalChunks > 0 ? Math.round((done / totalChunks) * 100) : 0;
            const seg = document.createElement('div');
            seg.className = 'chunk-segment chunk-done';
            seg.style.flex = `0 0 ${pct}%`;
            bar.appendChild(seg);
            const text = document.createElement('div');
            text.className = 'chunks-bar-text';
            text.textContent = formatChunkText(done, totalChunks, '');
            bar.appendChild(text);
            state.segmentText = text;
            state.continuousMode = true;
            state.continuousSeg = seg;
            return;
        }

        // Discrete segments — one per chunk
        const doneSet = new Set(receivedIndices || []);
        state.segments = [];
        for (let i = 0; i < totalChunks; i++) {
            const seg = document.createElement('div');
            seg.className = 'chunk-segment';
            if (doneSet.has(i)) seg.classList.add('chunk-done');
            bar.appendChild(seg);
            state.segments.push(seg);
        }
        const text = document.createElement('div');
        text.className = 'chunks-bar-text';
        text.textContent = formatChunkText(done, totalChunks, '');
        bar.appendChild(text);
        state.segmentText = text;
    }

    /**
     * Update one chunk segment's state using the cached reference —
     * O(1) and no DOM query per chunk.
     */
    function setChunkState(uploadId, chunkIndex, stateName) {
        const state = activeUploads.get(uploadId);
        if (!state || !state.segments) return;
        const seg = state.segments[chunkIndex];
        if (!seg) return;
        seg.classList.remove('chunk-done', 'chunk-uploading', 'chunk-paused', 'chunk-error');
        if (stateName) seg.classList.add(`chunk-${stateName}`);
    }

    /**
     * Update the overlay text on the chunks-bar; in continuous fallback
     * mode, also resize the single visible segment to match the percentage.
     */
    function updateChunksBarText(uploadId, done, total, label) {
        const state = activeUploads.get(uploadId);
        if (!state || !state.segmentText) return;
        state.segmentText.textContent = formatChunkText(done, total, label);
        if (state.continuousMode && state.continuousSeg) {
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            state.continuousSeg.style.flex = `0 0 ${pct}%`;
        }
    }

    /**
     * Update the row's speed cell.
     * @param {string} uploadId
     * @param {number|null} bytesPerSec  calculated speed, or null to clear
     */
    function updateRowSpeed(uploadId, bytesPerSec) {
        const tr = document.getElementById(`upload-${uploadId}`);
        if (!tr) return;
        const speedEl = tr.querySelector('.speed-cell');
        if (speedEl) speedEl.textContent = formatSpeed(bytesPerSec);
    }

    /**
     * Calculate the current upload speed in bytes per second.
     * Uses only chunks uploaded SINCE the session started (excludes
     * pre-existing chunks on resume to avoid an inflated spike).
     * Prefers _chunkStartAt (set when data first flows) over startedAt
     * (set before init overhead) for accurate throughput.
     * @param {Object} state  the active upload state object
     * @param {number} chunkSize  bytes per chunk
     * @returns {number|null}
     */
    function calcSpeed(state, chunkSize) {
        if (!state || !state.meta) return null;
        const t0 = state._chunkStartAt || state.startedAt;
        if (!t0) return null;
        const elapsed = (Date.now() - t0) / 1000;
        if (elapsed < 0.5) return null; // Not enough data yet
        const freshChunks = Math.max(0, (state.progress || 0) - (state._resumeOffset || 0));
        const bytesUploaded = freshChunks * (chunkSize || state.meta.chunk_size || 0);
        return Math.round(bytesUploaded / elapsed);
    }

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    /**
     * Update the progress cell of a row managed by this module.
     * For active uploads, the chunks-bar handles its own segment states;
     * this only updates the overlay text and the status cell.
     * @param {string} uploadId
     * @param {number} done       chunks completed
     * @param {number} total      total chunks
     * @param {string} [statusText]  custom override (e.g. 'Finalizing…')
     * @param {string} [label]       prefix for default format → "label X/Y chunks (Z%)"
     */
    function updateRowProgress(uploadId, done, total, statusText, label) {
        const tr = document.getElementById(`upload-${uploadId}`);
        if (!tr) return;
        // Update chunks-bar overlay (no-op until renderChunksBar has been called)
        updateChunksBarText(uploadId, done, total, label);
        const status = tr.querySelector('.status-cell');
        if (status) {
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            if (statusText != null) {
                status.textContent = statusText;
            } else if (label) {
                status.textContent = `${label} ${done}/${total} chunks (${pct}%)`;
            } else {
                status.textContent = `${done}/${total} chunks (${pct}%)`;
            }
        }
        const state = activeUploads.get(uploadId);
        if (state) {
            const tc = tr.querySelector('.time-cell');
            if (tc) tc.textContent = formatRelativeTime(state.startedAt);
        }
    }

    /**
     * Set the row status to "Paused" and replace the pause button with a
     * Resume button.
     */
    function setRowPaused(uploadId, filename) {
        const tr = document.getElementById(`upload-${uploadId}`);
        if (!tr) return;
        const bar = tr.querySelector('.chunks-bar');
        if (bar) bar.classList.add('paused-active');
        const sc = tr.querySelector('.status-cell');
        if (sc) sc.textContent = '⏸ Paused';
        updateRowSpeed(uploadId, null);
        const action = tr.querySelector('.action-cell');
        if (action) {
            action.innerHTML = `<button class="btn btn-sm btn-outline-primary resume-btn"
                data-upload-id="${uploadId}" data-filename="${escapeHtml(filename)}" title="Resume">
                <i class="bi bi-play-fill"></i></button>
                <button class="btn btn-sm btn-outline-danger cancel-btn"
                data-upload-id="${uploadId}" title="Cancel">
                <i class="bi bi-x-lg"></i></button>`;
        }
    }

    function setRowError(uploadId, msg) {
        const tr = document.getElementById(`upload-${uploadId}`);
        if (!tr) return;
        const bar = tr.querySelector('.chunks-bar');
        if (bar) bar.classList.add('all-error');
        const sc = tr.querySelector('.status-cell');
        if (sc) sc.innerHTML =
            `<i class="bi bi-exclamation-triangle text-danger"></i> ${msg}`;
        updateRowSpeed(uploadId, null);
        const ac = tr.querySelector('.action-cell');
        if (ac) ac.innerHTML = '';
    }

    /**
     * Set the row to "Queued" — dimmed row, cancel button only.
     * The visual dim makes it unmistakable that the upload is waiting.
     * The chunks-bar is empty (no segments yet — we don't know totalChunks).
     */
    function setRowQueued(uploadId) {
        const tr = document.getElementById(`upload-${uploadId}`);
        if (!tr) return;
        tr.style.opacity = '0.55';
        tr.setAttribute('data-queued', 'true');
        const sc = tr.querySelector('.status-cell');
        if (sc) {
            sc.textContent = '\u23F3 Queued\u2026';
            sc.classList.add('fst-italic');
        }
        updateRowSpeed(uploadId, null);
        const action = tr.querySelector('.action-cell');
        if (action) {
            action.innerHTML = `<button class="btn btn-sm btn-outline-danger cancel-btn"
                data-upload-id="${uploadId}" title="Remove from queue">
                <i class="bi bi-x-lg"></i></button>`;
        }
    }

    /**
     * Transition a queued row to "Initializing…" — restores full opacity,
     * pause+cancel buttons, and clears the queued styling. The chunks-bar
     * stays empty until renderChunksBar runs after the status fetch.
     */
    function setRowTransitioning(uploadId) {
        const tr = document.getElementById(`upload-${uploadId}`);
        if (!tr) return;
        tr.style.opacity = '';
        tr.removeAttribute('data-queued');
        const sc = tr.querySelector('.status-cell');
        if (sc) {
            sc.textContent = 'Initializing\u2026';
            sc.classList.remove('fst-italic');
        }
        updateRowSpeed(uploadId, null);
        const tc = tr.querySelector('.time-cell');
        if (tc) tc.textContent = 'now';
        const action = tr.querySelector('.action-cell');
        if (action) {
            action.innerHTML = `<button class="btn btn-sm btn-outline-secondary pause-btn"
                data-upload-id="${uploadId}" title="Pause">
                <i class="bi bi-pause-fill"></i></button>
            <button class="btn btn-sm btn-outline-danger cancel-btn"
                data-upload-id="${uploadId}" title="Cancel">
                <i class="bi bi-x-lg"></i></button>`;
            tr.querySelector('.pause-btn').addEventListener('click', () => pauseUpload(uploadId));
            tr.querySelector('.cancel-btn').addEventListener('click', () => cancelUpload(uploadId));
        }
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
        // Restore the row to active-upload state
        const tr = document.getElementById(`upload-${uploadId}`);
        if (tr) {
            const bar = tr.querySelector('.chunks-bar');
            if (bar) bar.classList.remove('paused-active');
            const sc = tr.querySelector('.status-cell');
            if (sc) {
                sc.textContent = '⏳ Resuming after current upload\u2026';
                sc.classList.add('fst-italic');
            }
            const action = tr.querySelector('.action-cell');
            if (action) {
                action.innerHTML = `<button class="btn btn-sm btn-outline-secondary pause-btn"
                    data-upload-id="${uploadId}" title="Pause">
                    <i class="bi bi-pause-fill"></i></button>
                    <button class="btn btn-sm btn-outline-danger cancel-btn"
                    data-upload-id="${uploadId}" title="Cancel">
                    <i class="bi bi-x-lg"></i></button>`;
                tr.querySelector('.pause-btn').addEventListener('click', () => pauseUpload(uploadId));
                tr.querySelector('.cancel-btn').addEventListener('click', () => cancelUpload(uploadId));
            }
        }
        // If the chunk loop already exited (paused between chunks),
        // start a new one — but route it through the upload queue so
        // it never runs in parallel with another in-flight upload.
        // If the loop is still mid-chunk, it will see paused=false
        // and continue naturally — no need to start a second loop.
        if (!st._looping) {
            enqueueUpload(async () => {
                try {
                    await uploadMissingChunks(uploadId);
                } catch (err) {
                    console.error(`Resume error [${uploadId}]:`, err);
                    setRowError(uploadId, err.message || 'Resume failed');
                }
            });
        }
        return true;
    }

    /* ------------------------------------------------------------------ */
    /*  Core upload flow                                                  */
    /* ------------------------------------------------------------------ */

    /**
     * Start or resume an upload.
     *
     * @param {string|null} uploadId  null for new upload; existing id for resume
     * @param {File}        file      file object from browser
     * @param {boolean}     [isResume=false]  set by resume-flow callers
     */
    async function startUpload(uploadId, file, isResume = false, existingRow = null) {
        const totalSize = file.size;

        // --- fingerprint ----------------------------------------------------
        const fingerprint = await computeFileFingerprint(file);

        // If resuming, verify fingerprint before talking to the server
        if (isResume && uploadId) {
            const ok = await verifyFingerprint(uploadId, fingerprint, file);
            if (!ok) throw new Error('File does not match the incomplete upload.');
            // error toast is shown inside verifyFingerprint
        }

        // Create or reuse a row for this upload
        let row;
        if (existingRow) {
            // Reuse the pre-created queued row (already transitioned via setRowTransitioning)
            row = existingRow;
            // Guard against the narrow race where user cancelled between
            // setRowTransitioning and the synchronous body of startUpload.
            // Check both doomed paths: the Set (post-init qid rename) and
            // the data-cancelled attribute that cancelUpload stamps on
            // the row (which survives DOM removal and ID mutates).
            if (row.getAttribute('data-cancelled') === 'true' ||
                cancelledQueues.has(row.id.replace('upload-', ''))) return;
        } else if (isResume && uploadId) {
            // Reuse the existing server-rendered row — don't create a duplicate
            row = document.getElementById(`upload-${uploadId}`);
            if (row) {
                // The row may carry legacy HTML (Bootstrap progress) from
                // dashboard.js's page-load render. Replace the progress cell
                // with the chunks-bar structure so it can be rendered after
                // the status fetch.
                const progressCell = row.querySelector('td:nth-child(3)');
                if (progressCell && !progressCell.querySelector('.chunks-bar')) {
                    progressCell.innerHTML = `
                        <div class="chunks-bar"></div>
                        <small class="text-muted status-cell">Initializing…</small>
                    `;
                }
                const sc = row.querySelector('.status-cell');
                if (sc) sc.textContent = 'Initializing…';
                const tc = row.querySelector('.time-cell');
                if (tc) tc.textContent = 'now';
                const ac = row.querySelector('.action-cell');
                if (ac) {
                    ac.innerHTML = `<button class="btn btn-sm btn-outline-secondary pause-btn"
                        data-upload-id="${uploadId}" title="Pause">
                        <i class="bi bi-pause-fill"></i></button>
                        <button class="btn btn-sm btn-outline-danger cancel-btn"
                        data-upload-id="${uploadId}" title="Cancel">
                        <i class="bi bi-x-lg"></i></button>`;
                    row.querySelector('.pause-btn').addEventListener('click', () => pauseUpload(uploadId));
                    row.querySelector('.cancel-btn').addEventListener('click', () => cancelUpload(uploadId));
                }
            } else {
                row = addUploadRow(uploadId, file.name, totalSize);
            }
        } else {
            row = addUploadRow(uploadId || 'temp', file.name, totalSize);
        }

        // State
        const state = {
            file,
            meta: null,
            progress: 0,
            status: 'init',
            paused: false,
            pausedByUser: false,
            cancelled: false,
            startedAt: Date.now(),
            // Marks this upload as a resumption of a server-tracked
            // incomplete upload. cancelUpload skips the server DELETE
            // when this is true so partial chunks survive even if the
            // user cancels while we're already mid-init.
            fromResume: !!isResume,
        };
        const rowId = row.id.replace('upload-', '');
        activeUploads.set(rowId, state);

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
            if (finalId !== rowId) {
                // Update state key and row id
                activeUploads.delete(rowId);
                activeUploads.set(finalId, state);
                row.id = `upload-${finalId}`;

                // Update data-upload-id on both buttons for event delegation
                // and re-bind direct listeners (the old closures captured 'temp')
                const rewireBtn = (selector, handler) => {
                    const btn = row.querySelector(selector);
                    if (!btn) return;
                    btn.setAttribute('data-upload-id', finalId);
                    // Also update data-filename if the button has it (e.g. resume-btn)
                    if (btn.hasAttribute('data-filename')) {
                        btn.setAttribute('data-filename', file.name);
                    }
                    const clone = btn.cloneNode(true);
                    btn.replaceWith(clone);
                    if (handler) clone.addEventListener('click', handler);
                };
                rewireBtn('.pause-btn', () => pauseUpload(finalId));
                rewireBtn('.cancel-btn', () => cancelUpload(finalId));
                // If user paused during init, .pause-btn was already replaced
                // by a .resume-btn carrying 'temp'. Fix its data-upload-id too.
                rewireBtn('.resume-btn', null);
            }

            // Step 3 — get upload status (which chunks already exist)
            const statusResp = await fetch(`/upload/status/${finalId}`, { headers: csrfHeaders() });
            const statusData = await statusResp.json();
            chunkSize = statusData.chunk_size || chunkSize;

            state.meta = statusData;
            activeUploads.set(finalId, state);

            const received = new Set(statusData.received_chunks || []);
            const totalChunks = statusData.total_chunks;

            // Track how many chunks were already on the server before this
            // session started; used by calcSpeed to avoid counting them
            // against the session elapsed time (inflated speed spike on resume).
            state._resumeOffset = state._resumeOffset || received.size;

            // Build the segmented chunks-bar now that we know the total and
            // which chunks already exist on the server (resume case).
            renderChunksBar(finalId, totalChunks, [...received]);
            activeUploads.set(finalId, state);

            // All chunks already here — complete immediately
            if (received.size === totalChunks) {
                await complete(finalId);
                return;
            }

            updateRowProgress(finalId, received.size, totalChunks);
            state.progress = received.size;

            // Step 4 — upload missing chunks (happens async below)
            await uploadMissingChunks(finalId);

        } catch (err) {
            console.error(`Upload error [${uploadId}]:`, err);
            showToast('Upload Failed', err.message, 'danger');
            const currentRowId = row.id.replace('upload-', '');
            if (activeUploads.has(currentRowId)) {
                activeUploads.delete(currentRowId);
            }
            setRowError(currentRowId, err.message || 'Upload failed');
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

            // Fingerprint check: skip if current fingerprint is fallback
            // (the filename+size check above already provides basic verification)
            const stored = data.file_fingerprint;
            if (fingerprint && !fingerprint.startsWith('fallback:') &&
                stored && stored !== fingerprint) {
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
     * Number of chunks to upload concurrently.
     * Tuned for Waitress with 8 threads — keeps 4+ threads free for
     * dashboard API calls and other browser tabs.
     */
    const CHUNK_CONCURRENCY = 4;

    /**
     * Upload every missing chunk using a parallel worker-pool.
     * Workers share a cursor across the chunk list; JS's single-threaded
     * event loop makes the increment naturally atomic.
     */
    async function uploadMissingChunks(uploadId) {
        const state = activeUploads.get(uploadId);
        if (!state || !state.meta) return;
        // Guard against double loops (e.g. resume clicked while old loop
        // is mid-chunk — resumeUploadFromPause checks this flag).
        if (state._looping) return;
        state._looping = true;

        try {
            const meta = state.meta;
            const file = state.file;
            const totalChunks = meta.total_chunks;
            const received = new Set(meta.received_chunks || []);
            const totalSize = meta.total_size;
            const cs = meta.chunk_size || chunkSize;

            let done = received.size;
            const initialLabel = done > 0 ? 'Resuming…' : 'Uploading…';
            updateRowProgress(uploadId, done, totalChunks, null, initialLabel);

            // Timestamp when chunks actually start flowing — used by
            // calcSpeed instead of startedAt (which includes init overhead).
            state._chunkStartAt = Date.now();

            let cursor = 0;
            let hasError = false;

            const worker = async () => {
                while (true) {
                    if (state.cancelled || state.paused || hasError) return;

                    const i = cursor++;
                    if (i >= totalChunks) return;

                    if (received.has(i)) continue;

                    setChunkState(uploadId, i, 'uploading');

                    const start = i * cs;
                    const end = Math.min(start + cs, totalSize);
                    const blob = file.slice(start, end);

                    const formData = new FormData();
                    formData.append('upload_id', uploadId);
                    formData.append('chunk_index', String(i));
                    formData.append('chunk_data', blob, `chunk_${i}`);

                    try {
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
                        if (!meta.received_chunks) meta.received_chunks = [];
                        meta.received_chunks.push(i);
                        received.add(i);
                        setChunkState(uploadId, i, 'done');
                        updateRowProgress(uploadId, done, totalChunks, null, initialLabel);
                        updateRowSpeed(uploadId, calcSpeed(state, cs));
                    } catch (err) {
                        hasError = true;
                        setChunkState(uploadId, i, 'error');
                        throw err;
                    }
                }
            };

            const workers = Array(CHUNK_CONCURRENCY).fill(null).map(() => worker());
            await Promise.all(workers);

            // Post-loop: handle exit reason
            if (state.cancelled) {
                removeUploadRow(uploadId);
                activeUploads.delete(uploadId);
                return;
            }
            if (state.paused) {
                setRowPaused(uploadId, meta.filename);
                return;
            }
            if (!hasError && done >= totalChunks) {
                await complete(uploadId);
            }
        } finally {
            state._looping = false;
        }
    }

    async function complete(uploadId) {
        updateRowProgress(uploadId, 1, 1, 'Finalizing…');
        try {
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
        } catch (err) {
            setRowError(uploadId, err.message || 'Completion failed');
            showToast('Upload Failed', err.message, 'danger');
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Public API                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Resume an incomplete upload from the UI.
     * Called by dashboard when the user picks a file to resume a
     * server-tracked incomplete upload. The actual startUpload is
     * routed through the upload queue so we never run in parallel with
     * any in-flight upload.
     *
     * Returns a promise that resolves with `true` if the upload
     * eventually completed, `false` on failure or pre-start cancel.
     */
    function resumeFromUI(uploadId, file) {
        // Dim the existing dashboard row so the user has immediate
        // feedback that the resume was accepted but is blocked on the
        // current upload. Cancelling the row at this stage is a
        // pre-start cancel handled via cancelUpload + cancelledQueues.
        setRowQueued(uploadId);
        // `setRowQueued` writes a Cancel button titled "Remove from
        // queue" which is the right wording for a drag-drop queue row,
        // but for a queued resume (file picked, not yet started) the
        // more accurate label is "Cancel queued resume".
        const preRow = document.getElementById(`upload-${uploadId}`);
        if (preRow) {
            // Tag the row so cancelUpload can recognise this as a
            // resume path and preserve server chunks on cancel.
            preRow.setAttribute('data-source', 'resume');
            const cancelBtn = preRow.querySelector('.cancel-btn');
            if (cancelBtn) cancelBtn.setAttribute('title', 'Cancel queued resume (partial progress will be preserved)');
        }
        return enqueueUpload(async () => {
            // Was the user (or a script) cancelled before we got our turn?
            // Honor it — don't start a fresh upload that nobody asked for.
            if (cancelledQueues.has(uploadId)) {
                cancelledQueues.delete(uploadId);
                return false;
            }
            try {
                await startUpload(uploadId, file, true);
                return true;
            } catch (err) {
                console.error(`Resume failed [${uploadId}]:`, err);
                return false;
            }
        });
    }

    /**
     * Resume a paused upload (already in activeUploads).
     */
    function resumePaused(uploadId) {
        return resumeUploadFromPause(uploadId);
    }

    /**
     * Cancel an active or paused upload — stops the chunk loop,
     * removes the row, and tells the server to clean up.
     */
    async function cancelUpload(uploadId) {
        const st = activeUploads.get(uploadId);
        if (st) {
            st.cancelled = true;
            st.paused = false; // unpause so loop wakes up and sees cancelled
            activeUploads.delete(uploadId);
        } else {
            // Either it's a queued file drop (qid starts with 'queued-')
            // or a queued resume waiting its turn in uploadQueue. Mark in
            // cancelledQueues AND tag the row directly so the queued task
            // body can detect this cancel even after handleFiles mutates
            // entry.qid from queued-N to the server UUID mid-loop.
            cancelledQueues.add(uploadId);
        }

        // Decide whether to DELETE the server-side record, and BOTH:
        //   1. Read data-source BEFORE removing the row from the DOM (the
        //      prior order hazard: removeUploadRow detached <tr>, then the
        //      lookup returned null, so isResume was forced to false and
        //      legitimate resumes got wiped server-side).
        //   2. Tag the row with data-cancelled so that even if init later
        //      mutates entry.qid on a still-pending entry, handleFiles'
        //      queued task body will skip it.
        //
        //   - data-source="resume" -> SKIP DELETE (preserve chunks)
        //   - any other value      -> DELETE (full cancel/cleanup)
        const tr = document.getElementById(`upload-${uploadId}`);
        const isResume = !!tr && tr.getAttribute('data-source') === 'resume';
        if (tr) tr.setAttribute('data-cancelled', 'true');
        removeUploadRow(uploadId);

        if (isResume) {
            showToast('Preserved',
                'Resume stopped — partial upload kept on the server. ' +
                'You can resume it from the incomplete uploads list later.',
            );
        } else {
            // Fire the server DELETE and explicitly check the response.
            // The prior version swallowed both network errors AND non-2xx
            // HTTP responses, so a 403 (CSRF session stale), 500 (chunker
            // permission error caught by shutil.rmtree(ignore_errors=True))
            // or a 404 (record already gone) all looked identical to the
            // user as "Cancelled" — even though the row would come back on
            // the next refresh because the chunks were never removed.
            try {
                const resp = await fetch(`/upload/cancel/${uploadId}`, {
                    method: 'DELETE',
                    headers: csrfHeaders(),
                });
                if (resp.ok) {
                    // Don't auto-refresh /uploads/incomplete here:
                    // refreshIncompleteUploads does tbody.innerHTML = '' and
                    // re-renders from server only, which would clobber any
                    // in-flight queued-drop rows that handleFiles set up
                    // between page load and now (opacity 0.55, "⏳ Queued…"
                    // status, cancel-only button). The cancelled row is
                    // already removed by removeUploadRow above and the
                    // server record is genuinely gone — the page-level
                    // refresh on next navigation will be correct.
                    showToast('Cancelled', 'Upload has been cancelled and cleaned up.');
                } else {
                    console.error(`Cancel failed for ${uploadId}: HTTP ${resp.status}`);
                    showToast('Cancel Failed',
                        `The server returned HTTP ${resp.status}. The upload row was removed ` +
                        `from your view, but its chunks may still exist on the server. ` +
                        `Try refreshing — the record will reappear if it's still there.`,
                        'danger',
                    );
                }
            } catch (err) {
                console.error('Cancel network error:', err);
                showToast('Cancel Failed',
                    'Network error talking to the server. The upload row was removed from ' +
                    'your view, but it may still exist on disk. Check your connection and refresh.',
                    'danger',
                );
            }
        }
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

    // Promise that serialises all uploads — routed through the shared
    // UploadQueue module (static/js/queue.js) so the helper can be
    // exercised directly from vitest tests without simulating the
    // whole Uploader IIFE. The returned function preserves the
    // "one upload at a time" guarantee across handleFiles,
    // resumeFromUI, and resumeUploadFromPause.
    //
    // If queue.js failed to load (network error, parse error) we
    // fall back to a passthrough queue so we don't crash the page
    // entirely — uploads will be allowed to run in parallel in that
    // degraded state, but at least the app stays usable.
    const enqueueUpload = window.UploadQueue
        ? window.UploadQueue.createUploadQueue()
        : (task => Promise.resolve().then(task));

    async function handleFiles(fileList) {
        if (!fileList || fileList.length === 0) return;
        const files = Array.from(fileList);

        // Create rows IMMEDIATELY (synchronously) so the user sees files
        // waiting in the queue even while a previous batch is uploading.
        const entries = files.map(f => {
            const qid = 'queued-' + (++_queueId);
            const row = addUploadRow(qid, f.name, f.size);
            // Tag the row so cancelUpload knows this came from a fresh
            // drag-drop (vs a resume of existing server work) — the row
            // is later promoted to data-source="resume" if /upload/init
            // answers with conflict (file already exists server-side).
            row.setAttribute('data-source', 'new');
            return { file: f, row, qid };
        });
        // All start as "Queued…" — the loop below transitions them to active
        for (const entry of entries) {
            setRowQueued(entry.qid);
        }

        // Eagerly register every queued file server-side so the record
        // survives page reloads (server's /uploads/incomplete lists them
        // again on refresh). Without this, queued new drops evaporate
        // client-side on reload and the user loses their queue.
        //
        // Fingerprints run in parallel (CPU-bound SHA-256 across files).
        // The actual /upload/init calls run sequentially so the server's
        // record creation order matches the queue order on reload.
        let fingerprints = [];
        try {
            fingerprints = await Promise.all(entries.map(e => computeFileFingerprint(e.file)));
        } catch (err) {
            console.error('Parallel fingerprinting failed; falling back.', err);
            fingerprints = await Promise.all(entries.map(e => computeFileFingerprint(e.file).catch(() => null)));
        }
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const fingerprint = fingerprints[i];
            if (!fingerprint) {
                showToast('Error',
                    `Could not fingerprint "${entry.file.name}". The file will be ` +
                    `queued locally and uploaded when reachable.`,
                    'danger',
                );
                continue;
            }
            try {
                const initResp = await fetch('/upload/init', {
                    method: 'POST',
                    headers: jsonHeaders(),
                    body: JSON.stringify({
                        filename: entry.file.name,
                        total_size: entry.file.size,
                        file_fingerprint: fingerprint,
                    }),
                });
                if (!initResp.ok) {
                    const e = await initResp.json().catch(() => ({}));
                    throw new Error(e.error || `Init failed (HTTP ${initResp.status})`);
                }
                const init = await initResp.json();
                const serverId = init.upload_id;
                if (!serverId) {
                    // Server returned 200 but no upload_id — treat the same
                    // as a transport failure so we don't promote the row to
                    // 'upload-undefined' and accidentally DELETE it later.
                    throw new Error(`Init response missing upload_id for "${entry.file.name}"`);
                }
                // Promote the row's id and its cancel button to use the
                // server UUID so /upload/cancel, /upload/bump and any
                // future server call reference the real record.
                entry.row.id = `upload-${serverId}`;
                const cancelBtn = entry.row.querySelector('.cancel-btn');
                if (cancelBtn) cancelBtn.setAttribute('data-upload-id', serverId);
                entry.serverId = serverId;
                entry.qid = serverId;
                // Conflict = an incomplete upload with same filename+size
                // already exists server-side; this row is effectively a
                // resume path, so cancel should preserve chunks.
                if (init.conflict) entry.row.setAttribute('data-source', 'resume');
            } catch (err) {
                console.error(`Eager init failed for ${entry.file.name}:`, err);
                showToast('Error',
                    `Could not register "${entry.file.name}" on the server. ` +
                    `The file will be queued locally and uploaded when reachable.`,
                    'danger',
                );
                // Leave the row with its queued-N id; on reload the file
                // won't be in /uploads/incomplete (best-effort fallback).
            }
        }

        // Chain onto the upload queue so this batch serialises against
        // any in-flight or queued upload from a previous drop, browse,
        // or resume. enqueueUpload returns a per-task promise; we ignore
        // it here because addUploadRow already created the visible rows
        // and the queued task will pick them up when its turn arrives.
        enqueueUpload(async () => {
            let total = 0;
            for (const f of files) total += f.size;

            // Check disk space for the batch
            try {
                const r = await fetch(`/check_space?size=${total}`, { headers: csrfHeaders() });
                const d = await r.json();
                if (!d.available) {
                    showToast('Error', `Need ${formatBytes(total)}, have ${formatBytes(d.free)} free.`, 'danger');
                    // Clean up the pre-created rows
                    for (const entry of entries) {
                        removeUploadRow(entry.qid);
                        cancelledQueues.delete(entry.qid);
                    }
                    return;
                }
            } catch (_) { /* server will reject individual uploads */ }

            // Process sequentially — each file transitions from queued to
            // active when it's its turn. The row's data-source flag
            // drives the isResume parameter so startUpload's state
            // (fromResume) stays in sync with the row's intent.
            //
            // Cancellation check covers two paths:
            //   - cancelledQueues Set — catches cancels that ran AFTER init
            //     promoted entry.qid from queued-N to the server UUID.
            //   - data-cancelled attribute — catches pre-init cancels where
            //     cancelUpload fired BEFORE init mutated entry.qid, so
            //     cancelledQueues contains 'queued-N' but entry.qid is now
            //     '<server uuid>'. The attribute is tagged directly on the
            //     row, which survives both DOM removal and qid rename.
            for (const entry of entries) {
                if (cancelledQueues.has(entry.qid) ||
                    entry.row.getAttribute('data-cancelled') === 'true') {
                    cancelledQueues.delete(entry.qid);
                    continue;
                }
                setRowTransitioning(entry.qid);
                const isResume = entry.row.getAttribute('data-source') === 'resume';
                await startUpload(entry.qid, entry.file, isResume, entry.row);
            }
        });
    }

    return {
        setupDropZone,
        resumeFromUI,
        resumePaused,
        cancelUpload,
        formatBytes,
    };
})();

document.addEventListener('DOMContentLoaded', () => Uploader.setupDropZone());
