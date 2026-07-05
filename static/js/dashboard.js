/*
 * VpsEasyUploader — Dashboard Module
 *
 * Handles the file browser table, disk info, modals,
 * incomplete upload listing, and all UI interactions.
 */

document.addEventListener('DOMContentLoaded', () => {
    // Bootstrap modal instances
    let previewModal, deleteModal, renameModal;

    // Track current file for delete/rename operations
    let currentFilePath = '';
    let deleteFileInputRef = null; // For incomplete upload resume

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
     * Initialize Bootstrap components.
     */
    function initBootstrap() {
        previewModal = new bootstrap.Modal(document.getElementById('preview-modal'));
        deleteModal = new bootstrap.Modal(document.getElementById('delete-modal'));
        renameModal = new bootstrap.Modal(document.getElementById('rename-modal'));
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
     * Format an ISO date string to a relative or absolute format.
     */
    function formatDate(isoString) {
        const date = new Date(isoString);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'Just now';
        if (diffMins < 60) return `${diffMins} min ago`;
        if (diffHours < 24) return `${diffHours} hr ago`;
        if (diffDays < 7) return `${diffDays} days ago`;

        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
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
     * Update the disk info display in the navbar.
     */
    async function updateDiskInfo() {
        try {
            const resp = await fetch('/disk_usage', {
                headers: csrfHeaders(),
            });
            const data = await resp.json();
            const used = formatBytes(data.used);
            const total = formatBytes(data.total);
            const free = formatBytes(data.free);
            document.getElementById('disk-info').innerHTML =
                `<i class="bi bi-hdd me-1"></i> ${free} free / ${total}`;
        } catch (err) {
            console.error('Failed to fetch disk info:', err);
        }
    }

    /**
     * Fetch and render the file list.
     */
    async function refreshFiles() {
        const tbody = document.getElementById('file-table-body');
        const emptyState = document.getElementById('empty-state');

        try {
            const resp = await fetch('/files', {
                headers: csrfHeaders(),
            });
            const data = await resp.json();
            const files = data.files || [];

            if (files.length === 0) {
                tbody.innerHTML = '';
                emptyState.classList.remove('d-none');
                return;
            }

            emptyState.classList.add('d-none');

            tbody.innerHTML = files.map(file => {
                const size = formatBytes(file.size);
                const date = formatDate(file.modified);
                const icon = file.thumbnail_url
                    ? `<img src="${file.thumbnail_url}" alt="" class="file-thumbnail" loading="lazy">`
                    : `<i class="bi ${file.icon} file-icon"></i>`;

                const previewAttr = (file.is_image || file.is_video) ? ' data-previewable="true"' : '';

                return `
                    <tr data-file="${escapeHtml(file.name)}"${previewAttr}>
                        <td class="text-center">${icon}</td>
                        <td class="text-truncate" style="max-width: 300px;">
                            <span class="fw-medium">${escapeHtml(file.name)}</span>
                        </td>
                        <td><span class="text-nowrap">${size}</span></td>
                        <td><span class="text-nowrap text-muted">${date}</span></td>
                        <td>
                            <div class="d-flex gap-1">
                                ${file.is_image ? `
                                <button class="btn btn-sm btn-outline-info action-btn preview-btn"
                                        data-file="${escapeHtml(file.name)}" title="Preview">
                                    <i class="bi bi-eye"></i>
                                </button>` : (file.is_video ? `
                                <button class="btn btn-sm btn-outline-info action-btn preview-btn"
                                        data-file="${escapeHtml(file.name)}" title="Preview">
                                    <i class="bi bi-play-circle"></i>
                                </button>` : `
                                <a href="/files/${encodeURIComponent(file.name)}"
                                   class="btn btn-sm btn-outline-secondary action-btn"
                                   title="Download" download>
                                    <i class="bi bi-download"></i>
                                </a>`)}
                                <button class="btn btn-sm btn-outline-warning action-btn rename-btn"
                                        data-file="${escapeHtml(file.name)}" title="Rename / Move">
                                    <i class="bi bi-pencil"></i>
                                </button>
                                <button class="btn btn-sm btn-outline-danger action-btn delete-btn"
                                        data-file="${escapeHtml(file.name)}" title="Delete">
                                    <i class="bi bi-trash"></i>
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');

            // Bind click handlers
            bindFileActions();

        } catch (err) {
            console.error('Failed to fetch files:', err);
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="text-center text-danger py-4">
                        <i class="bi bi-exclamation-triangle me-2"></i>
                        Failed to load files. Check server logs.
                    </td>
                </tr>
            `;
        }
    }

    /**
     * HTML-escape a string for safe insertion.
     */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Bind click handlers for preview, rename, and delete buttons.
     */
    function bindFileActions() {
        // Preview buttons
        document.querySelectorAll('.preview-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const filename = btn.getAttribute('data-file');
                openPreview(filename);
            });
        });

        // Click on image row to preview
        document.querySelectorAll('tr[data-previewable="true"]').forEach(row => {
            row.addEventListener('click', () => {
                const filename = row.getAttribute('data-file');
                openPreview(filename);
            });
        });

        // Rename buttons
        document.querySelectorAll('.rename-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const filename = btn.getAttribute('data-file');
                openRenameModal(filename);
            });
        });

        // Delete buttons
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const filename = btn.getAttribute('data-file');
                openDeleteModal(filename);
            });
        });
    }

    /**
     * Open the preview modal for an image or video file.
     */
    function openPreview(filename) {
        const ext = filename.split('.').pop().toLowerCase();
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
        const videoExts = ['mp4', 'webm', 'mkv', 'avi', 'mov'];

        const titleEl = document.getElementById('preview-title');
        const imgEl = document.getElementById('preview-image');
        const videoEl = document.getElementById('preview-video');

        imgEl.classList.add('d-none');
        videoEl.classList.add('d-none');

        if (imageExts.includes(ext)) {
            titleEl.textContent = filename;
            imgEl.src = `/files/${encodeURIComponent(filename)}`;
            imgEl.classList.remove('d-none');
        } else if (videoExts.includes(ext)) {
            titleEl.textContent = filename;
            videoEl.querySelector('source').src = `/files/${encodeURIComponent(filename)}`;
            videoEl.classList.remove('d-none');
            videoEl.load();
        }

        previewModal.show();
    }

    /**
     * Open the rename/move modal.
     */
    function openRenameModal(filename) {
        currentFilePath = filename;
        document.getElementById('rename-old-path').value = filename;
        document.getElementById('rename-new-path').value = filename;
        renameModal.show();
    }

    /**
     * Open the delete confirmation modal.
     */
    function openDeleteModal(filename) {
        currentFilePath = filename;
        document.getElementById('delete-filename').textContent = filename;
        deleteModal.show();
    }

    /**
     * Execute file deletion.
     */
    async function deleteFile() {
        if (!currentFilePath) return;

        try {
            const resp = await fetch(`/delete/${encodeURIComponent(currentFilePath)}`, {
                method: 'DELETE',
                headers: csrfHeaders(),
            });
            const data = await resp.json();

            if (data.success) {
                showToast('Deleted', `"${currentFilePath}" has been deleted.`);
                refreshFiles();
                updateDiskInfo();
            } else {
                showToast('Error', data.error || 'Failed to delete file.', 'danger');
            }
        } catch (err) {
            console.error('Delete error:', err);
            showToast('Error', 'Network error while deleting.', 'danger');
        }

        deleteModal.hide();
        currentFilePath = '';
    }

    /**
     * Execute rename/move operation.
     */
    async function renameFile() {
        const oldPath = document.getElementById('rename-old-path').value;
        const newPath = document.getElementById('rename-new-path').value.trim();

        if (!newPath || oldPath === newPath) {
            renameModal.hide();
            return;
        }

        try {
            const resp = await fetch('/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
                body: JSON.stringify({ old_path: oldPath, new_path: newPath }),
            });
            const data = await resp.json();

            if (data.success) {
                showToast('Moved', `"${oldPath}" → "${newPath}"`);
                refreshFiles();
            } else {
                showToast('Error', data.error || 'Failed to move file.', 'danger');
            }
        } catch (err) {
            console.error('Move error:', err);
            showToast('Error', 'Network error during move.', 'danger');
        }

        renameModal.hide();
        currentFilePath = '';
    }

    /**
     * Bind main action buttons.
     */
    function bindMainActions() {
        // Refresh files button
        document.getElementById('refresh-files-btn').addEventListener('click', refreshFiles);

        // Delete confirmation
        document.getElementById('delete-confirm-btn').addEventListener('click', deleteFile);

        // Rename confirmation
        document.getElementById('rename-confirm-btn').addEventListener('click', renameFile);
    }

    /**
     * Initialize the dashboard.
     */
    function init() {
        initBootstrap();
        bindMainActions();
        updateDiskInfo();
        refreshFiles();

        // Periodic refresh of disk info (every 30s)
        setInterval(updateDiskInfo, 30000);
    }

    // Expose for uppy-init.js callback (uppy's complete() refreshes
    // files + disk info on success so the page stays in sync).
    window.refreshFiles = refreshFiles;
    window.refreshDiskInfo = updateDiskInfo;

    // Start the dashboard
    init();
});
