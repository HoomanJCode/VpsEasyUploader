/*
 * VpsEasyUploader — Uploader Module
 *
 * Handles all client-side upload logic:
 *   - File selection and drag-and-drop
 *   - Resumable chunked uploads (init → chunks → complete)
 *   - Progress tracking and error recovery
 *   - Resume from incomplete uploads
 */

const Uploader = (() => {
    // Config (will be populated from server)
    let chunkSize = 5 * 1024 * 1024; // 5 MB default

    // Active uploads map: uploadId -> { file, meta, xhr, progress, status }
    const activeUploads = new Map();

    /**
     * Get the CSRF token from the meta tag.
     */
    function getCsrfToken() {
        const meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute('content') : '';
    }

    /**
     * Headers to include on all mutating requests.
     */
    function csrfHeaders(extra = {}) {
        return { 'X-CSRF-Token': getCsrfToken(), ...extra };
    }

    /**
     * Headers for JSON POST requests.
     */
    function jsonHeaders(extra = {}) {
        return csrfHeaders({ 'Content-Type': 'application/json', ...extra });
    }

    /**
     * Format bytes to human-readable string.
     */
    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
    }

    /**
     * Show a toast notification.
     */
    function showToast(title, message, variant = 'primary') {
        const toastEl = document.getElementById('toast');
        document.getElementById('toast-title').textContent = title;
        document.getElementById('toast-body').textContent = message;
        const toast = bootstrap.Toast.getOrCreateInstance(toastEl);
        toast.show();
    }

    /**
     * Generate a UUID v4 for upload identification.
     */
    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Add a file to the upload queue and start the upload process.
     */
    async function addFile(file) {
        const uploadId = generateUUID();
        await startUpload(uploadId, file);
    }

    /**
     * Resume an incomplete upload given its uploadId and the file object.
     */
    async function resumeUpload(uploadId, file) {
        await startUpload(uploadId, file, true);
    }

    /**
     * Core upload orchestration.
     *
     * @param {string} uploadId - UUID for this upload
     * @param {File} file - The file to upload
     * @param {boolean} isResume - Whether this is a resume attempt
     */
    async function startUpload(uploadId, file, isResume = false) {
        const totalSize = file.size;

        // Show the active uploads section
        document.getElementById('active-uploads').classList.remove('d-none');

        // Create UI element for this upload
        const listEl = document.getElementById('upload-list');
        const itemEl = document.createElement('div');
        itemEl.className = 'upload-item';
        itemEl.id = `upload-${uploadId}`;
        itemEl.innerHTML = `
            <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="text-truncate me-2" style="max-width: 60%;">
                    <i class="bi bi-file-earmark me-1"></i>${file.name}
                </span>
                <span class="text-muted small upload-status">Initializing...</span>
            </div>
            <div class="progress">
                <div class="progress-bar progress-bar-striped progress-bar-animated"
                     role="progressbar" style="width: 0%;">0%</div>
            </div>
            <div class="d-flex justify-content-between mt-1">
                <small class="text-muted upload-speed"></small>
                <small class="text-muted upload-size">${formatBytes(totalSize)}</small>
            </div>
        `;
        listEl.appendChild(itemEl);

        // Store upload state
        const state = {
            file,
            meta: null,
            xhr: null,
            progress: 0,
            status: 'init',
        };
        activeUploads.set(uploadId, state);

        try {
            // Step 1: Check disk space
            const spaceCheck = await fetch(`/check_space?size=${totalSize}`, {
                headers: csrfHeaders(),
            });
            const spaceData = await spaceCheck.json();
            if (!spaceData.available) {
                throw new Error('Not enough disk space on the server.');
            }

            // Step 2: Initialize upload
            updateUploadUI(uploadId, 'status', 'Initializing...');
            const initResp = await fetch('/upload/init', {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({
                    filename: file.name,
                    total_size: totalSize,
                    upload_id: isResume ? uploadId : uploadId,
                }),
            });

            // Handle existing completed file (409 Conflict)
            if (initResp.status === 409) {
                const errData = await initResp.json().catch(() => ({}));
                throw new Error(errData.error || `File "${file.name}" already exists on the server.`);
            }

            if (!initResp.ok) {
                const errData = await initResp.json().catch(() => ({}));
                throw new Error(errData.error || `Init failed (HTTP ${initResp.status})`);
            }

            const initData = await initResp.json();

            // Handle conflict (existing incomplete upload for the same file)
            if (initData.conflict && !isResume) {
                const existingId = initData.existing_upload_id || initData.upload_id;
                // Update the existing UI item instead of removing and recreating
                itemEl.id = `upload-${existingId}`;
                activeUploads.delete(uploadId);
                state.meta = initData;
                activeUploads.set(existingId, state);
                updateUploadUI(existingId, 'status', 'Resuming...');
                return resumeUpload(existingId, file);
            }

            // Step 3: Get status of existing chunks (for resume)
            updateUploadUI(uploadId, 'status', 'Checking chunks...');
            const statusResp = await fetch(`/upload/status/${initData.upload_id}`, {
                headers: csrfHeaders(),
            });
            const statusData = await statusResp.json();

            const receivedChunks = new Set(statusData.received_chunks || []);
            const totalChunks = statusData.total_chunks;
            chunkSize = statusData.chunk_size || chunkSize;

            // Update the metadata
            state.meta = statusData;
            activeUploads.set(initData.upload_id, state);

            // Fix: ensure the item ID matches the actual upload_id
            if (initData.upload_id !== uploadId) {
                activeUploads.delete(uploadId);
                activeUploads.set(initData.upload_id, state);
                // Re-create UI item with correct ID
                itemEl.remove();
                const newItem = await ensureUploadItem(initData.upload_id, file, totalSize);
            }

            const finalId = initData.upload_id;
            const finalState = activeUploads.get(finalId);

            // Step 4: Upload missing chunks
            let uploadedSoFar = receivedChunks.size;
            const chunksToUpload = [];
            for (let i = 0; i < totalChunks; i++) {
                if (!receivedChunks.has(i)) {
                    chunksToUpload.push(i);
                }
            }

            if (chunksToUpload.length === 0) {
                // All chunks already present — complete immediately
                await complete(finalId);
                return;
            }

            updateUploadUI(finalId, 'progress', uploadedSoFar, totalChunks);

            // Upload chunk by chunk (sequential to avoid overwhelming the server)
            for (const chunkIndex of chunksToUpload) {
                const start = chunkIndex * chunkSize;
                const end = Math.min(start + chunkSize, totalSize);
                const blob = file.slice(start, end);

                const formData = new FormData();
                formData.append('upload_id', finalId);
                formData.append('chunk_index', chunkIndex.toString());
                formData.append('chunk_data', blob, `chunk_${chunkIndex}`);

                updateUploadUI(finalId, 'status', `Uploading chunk ${chunkIndex + 1}/${totalChunks}...`);

                const chunkResp = await fetch('/upload/chunk', {
                    method: 'POST',
                    headers: csrfHeaders(),
                    body: formData,
                });

                if (!chunkResp.ok) {
                    const errData = await chunkResp.json().catch(() => ({}));
                    throw new Error(errData.error || `Chunk ${chunkIndex} upload failed`);
                }

                uploadedSoFar++;
                updateUploadUI(finalId, 'progress', uploadedSoFar, totalChunks);
            }

            // Step 5: Complete the upload
            await complete(finalId);

        } catch (err) {
            console.error(`Upload error [${uploadId}]:`, err);
            updateUploadUI(uploadId, 'error', err.message);
            showToast('Upload Failed', err.message, 'danger');
        }
    }

    /**
     * Complete an upload by calling the /upload/complete endpoint.
     */
    async function complete(uploadId) {
        updateUploadUI(uploadId, 'status', 'Finalizing...');

        const resp = await fetch(`/upload/complete/${uploadId}`, {
            method: 'POST',
            headers: csrfHeaders(),
        });
        const data = await resp.json();

        if (data.success) {
            updateUploadUI(uploadId, 'completed', 'Complete!');
            showToast('Upload Complete', data.message || 'File uploaded successfully.', 'success');

            // Remove from active after a delay
            setTimeout(() => {
                const itemEl = document.getElementById(`upload-${uploadId}`);
                if (itemEl) itemEl.remove();
                activeUploads.delete(uploadId);
                // Hide section if no more active uploads
                if (activeUploads.size === 0) {
                    document.getElementById('active-uploads').classList.add('d-none');
                }
            }, 3000);

            // Refresh the file list
            if (typeof refreshFiles === 'function') refreshFiles();
            if (typeof refreshIncompleteUploads === 'function') refreshIncompleteUploads();
        } else {
            throw new Error(data.error || 'Completion failed');
        }
    }

    /**
     * Ensure a UI item exists for an upload_id. Re-creates if needed.
     */
    function ensureUploadItem(uploadId, file, totalSize) {
        // Check if item already exists
        if (document.getElementById(`upload-${uploadId}`)) return;

        document.getElementById('active-uploads').classList.remove('d-none');
        const listEl = document.getElementById('upload-list');
        const itemEl = document.createElement('div');
        itemEl.className = 'upload-item';
        itemEl.id = `upload-${uploadId}`;
        itemEl.innerHTML = `
            <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="text-truncate me-2" style="max-width: 60%;">
                    <i class="bi bi-file-earmark me-1"></i>${file.name}
                </span>
                <span class="text-muted small upload-status">Resuming...</span>
            </div>
            <div class="progress">
                <div class="progress-bar progress-bar-striped progress-bar-animated"
                     role="progressbar" style="width: 0%;">0%</div>
            </div>
            <div class="d-flex justify-content-between mt-1">
                <small class="text-muted upload-speed"></small>
                <small class="text-muted upload-size">${formatBytes(totalSize)}</small>
            </div>
        `;
        listEl.appendChild(itemEl);
    }

    /**
     * Update the UI for a given upload.
     */
    function updateUploadUI(uploadId, type, ...args) {
        const itemEl = document.getElementById(`upload-${uploadId}`);
        if (!itemEl) return;

        const progressBar = itemEl.querySelector('.progress-bar');
        const statusEl = itemEl.querySelector('.upload-status');

        switch (type) {
            case 'status':
                if (statusEl) statusEl.textContent = args[0];
                break;
            case 'progress': {
                const done = args[0];
                const total = args[1];
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                if (progressBar) {
                    progressBar.style.width = pct + '%';
                    progressBar.textContent = pct + '%';
                }
                if (statusEl) statusEl.textContent = `${done}/${total} chunks`;
                break;
            }
            case 'completed':
                itemEl.classList.add('completed');
                if (progressBar) {
                    progressBar.classList.remove('progress-bar-animated', 'progress-bar-striped');
                    progressBar.classList.add('bg-success');
                    progressBar.style.width = '100%';
                    progressBar.textContent = '100%';
                }
                if (statusEl) {
                    statusEl.innerHTML = `<i class="bi bi-check-circle text-success me-1"></i>Complete`;
                }
                break;
            case 'error':
                itemEl.classList.add('error');
                if (statusEl) {
                    statusEl.innerHTML = `<i class="bi bi-exclamation-triangle text-danger me-1"></i>${args[0]}`;
                }
                break;
        }
    }

    /**
     * Set up drag-and-drop and file input handlers.
     */
    function setupDropZone() {
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');
        const browseBtn = document.getElementById('browse-btn');

        if (!dropZone || !fileInput) return;

        // Click to browse
        browseBtn.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('click', (e) => {
            if (e.target !== browseBtn && !browseBtn.contains(e.target)) {
                fileInput.click();
            }
        });

        // File input change
        fileInput.addEventListener('change', () => {
            handleFiles(fileInput.files);
            fileInput.value = ''; // Reset so the same file can be re-selected
        });

        // Drag events
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('drag-over');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('drag-over');
            handleFiles(e.dataTransfer.files);
        });
    }

    /**
     * Handle selected files: check space and start uploads.
     */
    async function handleFiles(fileList) {
        if (!fileList || fileList.length === 0) return;

        let totalSize = 0;
        const files = [];
        for (const file of fileList) {
            totalSize += file.size;
            files.push(file);
        }

        // Check total space needed
        try {
            const resp = await fetch(`/check_space?size=${totalSize}`, {
                headers: csrfHeaders(),
            });
            const data = await resp.json();
            if (!data.available) {
                showToast('Error',
                    `Not enough space. Need ${formatBytes(totalSize)}, have ${formatBytes(data.free)} free.`,
                    'danger');
                return;
            }
        } catch (err) {
            console.error('Space check failed:', err);
            // Continue anyway — server will reject if space is insufficient
        }

        // Start uploads sequentially (server handles one at a time better)
        for (const file of files) {
            await addFile(file);
        }
    }

    /**
     * Resume an incomplete upload from the UI (called by dashboard module).
     */
    async function resumeFromUI(uploadId, fileInputElement) {
        if (!fileInputElement || !fileInputElement.files || fileInputElement.files.length === 0) {
            showToast('Error', 'Please select the same file to resume.', 'danger');
            return;
        }
        const file = fileInputElement.files[0];
        await resumeUpload(uploadId, file);
    }

    // Expose public API
    return {
        setupDropZone,
        resumeUpload,
        resumeFromUI,
        formatBytes,
    };
})();

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    Uploader.setupDropZone();
});
