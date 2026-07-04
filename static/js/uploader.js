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
            sc.textContent = '⏳ Queued…';
            sc.classList.add('fst-italic');
        }
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
            sc.textContent = 'Initializing…';
            sc.classList.remove('fst-italic');
        }
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
        // start a new one. If it's mid-chunk, it will see paused=false
        // and continue naturally — no need to start a second loop.
        if (!st._looping) {
            uploadMissingChunks(uploadId).catch(err => {
                console.error(`Resume error [${uploadId}]:`, err);
                setRowError(uploadId, err.message || 'Resume failed');
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
            // setRowTransitioning and the synchronous body of startUpload
            if (cancelledQueues.has(row.id.replace('upload-', ''))) return;
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
     * Upload every missing chunk, respecting the pause flag.
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
            // Pick the label once at the start so it stays stable for the
            // whole chunk loop; new uploads say "Uploading…", resumes keep
            // saying "Resuming…" all the way until Finalizing.
            const initialLabel = done > 0 ? 'Resuming…' : 'Uploading…';
            updateRowProgress(uploadId, done, totalChunks, null, initialLabel);

            for (let i = 0; i < totalChunks; i++) {
                // --- CANCEL CHECK ---
                if (state.cancelled) {
                    removeUploadRow(uploadId);
                    activeUploads.delete(uploadId);
                    return;
                }
                // --- PAUSE CHECK (top of loop — between chunks) ---
                if (state.paused) {
                    setRowPaused(uploadId, meta.filename);
                    return;
                }
                // --- SKIP already-uploaded chunks (rendered as chunk-done on init) ---
                if (received.has(i)) continue;

                // Mark the segment as in-flight before fetching
                setChunkState(uploadId, i, 'uploading');

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
                    setChunkState(uploadId, i, 'error');
                    const e = await chunkResp.json().catch(() => ({}));
                    throw new Error(e.error || `Chunk ${i} upload failed`);
                }
                done++;
                state.progress = done;
                // Keep meta in sync so pause+resume starts from the correct count
                if (!meta.received_chunks) meta.received_chunks = [];
                meta.received_chunks.push(i);
                received.add(i);
                setChunkState(uploadId, i, 'done');
                updateRowProgress(uploadId, done, totalChunks, null, initialLabel);
                // If user paused during this chunk, restore paused UI and bail
                if (state.paused) {
                    setRowPaused(uploadId, meta.filename);
                    return;
                }
            }

            // All chunks done
            await complete(uploadId);
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
        } else if (typeof uploadId === 'string' && uploadId.startsWith('queued-')) {
            // Queued file hasn't started yet — mark it so the queue loop skips it
            cancelledQueues.add(uploadId);
        }
        removeUploadRow(uploadId);
        try {
            await fetch(`/upload/cancel/${uploadId}`, {
                method: 'DELETE',
                headers: csrfHeaders(),
            });
        } catch (_) { /* best effort */ }
        showToast('Cancelled', 'Upload has been cancelled and cleaned up.');
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

    // Promise that serialises all uploads — each batch chains onto the
    // previous via .then(), so separate drop/browse events run one at a time.
    let uploadQueue = Promise.resolve();

    async function handleFiles(fileList) {
        if (!fileList || fileList.length === 0) return;
        const files = Array.from(fileList);

        // Create rows IMMEDIATELY (synchronously) so the user sees files
        // waiting in the queue even while a previous batch is uploading.
        const entries = files.map(f => {
            const qid = 'queued-' + (++_queueId);
            const row = addUploadRow(qid, f.name, f.size);
            return { file: f, row, qid };
        });
        // All start as "Queued…" — the loop below transitions them to active
        for (const entry of entries) {
            setRowQueued(entry.qid);
        }

        // Chain onto the queue so separate drop/browse events are sequential.
        // The .catch keeps the chain alive even if an unexpected error escapes
        // startUpload's internal try/catch — otherwise a rejection becomes the
        // new uploadQueue and every subsequent batch would be silently skipped.
        uploadQueue = uploadQueue.then(async () => {
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
            // active when it's its turn.
            for (const entry of entries) {
                if (cancelledQueues.has(entry.qid)) {
                    cancelledQueues.delete(entry.qid);
                    continue;
                }
                setRowTransitioning(entry.qid);
                await startUpload(entry.qid, entry.file, false, entry.row);
            }
        }).catch(err => {
            console.error('Queue chain error:', err);
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
