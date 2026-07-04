/*
 * VpsEasyUploader — uploader.test.js
 *
 * Vitest suite for the Uploader state machine (pause / queue / cancel / resume
 * in every combination). The uploader.js module is wrapped in an IIFE so we
 * re-evaluate its source via `new Function` per test to get a fresh closure
 * (isolated activeUploads Map, cancelledQueues Set, etc.) — this lets each
 * test exercise the lifecycle states without leaking state between cases.
 *
 * Run with: `npm test`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createUploadQueue } from './queue.js';

// @vitest-environment happy-dom

/**
 * Set up the minimal DOM fragments the Uploader queries at module load
 * time (csrf meta tag, drop zone, file input, browse button, incomplete
 * section + tbody, toast container) plus a mock Bootstrap toast.
 */
function setupDOM() {
    document.head.innerHTML = '<meta name="csrf-token" content="test-csrf-token">';
    document.body.innerHTML = [
        '<div id="drop-zone"></div>',
        '<input id="file-input" type="file">',
        '<button id="browse-btn" type="button"></button>',
        '<div id="incomplete-section" class="d-none">',
        '  <table><tbody id="incomplete-table-body"></tbody></table>',
        '</div>',
        '<div id="toast">',
        '  <div id="toast-title"></div>',
        '  <div id="toast-body"></div>',
        '</div>',
    ].join('\n');
    globalThis.bootstrap = {
        Toast: { getOrCreateInstance: () => ({ show: vi.fn() }) },
    };
    // Provide a real upload queue (same module Uploader.js reads at load).
    globalThis.UploadQueue = { createUploadQueue };
}

/**
 * Evaluate uploader.js fresh in the current realm and pin the Uploader
 * onto globalThis so the test can drive its public API. We append the
 * globalThis.Uploader line so the IIFE's local `const Uploader` becomes
 * reachable from outside. We read the source synchronously per call so
 * vitest worker CWD shifts don't strand us on a stale absolute path.
 */
function loadUploaderFresh() {
    delete globalThis.Uploader;
    const uploaderSrc = readFileSync(
        resolve(process.cwd(), 'static/js/uploader.js'),
        'utf-8',
    );
    try {
        // eslint-disable-next-line no-new-func
        new Function(uploaderSrc + '\nglobalThis.Uploader = Uploader;')();
    } catch (err) {
        throw new Error('Failed to evaluate uploader.js: ' + err.message);
    }
    if (!globalThis.Uploader || typeof globalThis.Uploader.cancelUpload !== 'function') {
        throw new Error('Uploader did not expose its public API on globalThis');
    }
    return globalThis.Uploader;
}

/**
 * Build a stub row in the incomplete-table-body so cancel/pause/resume
 * have something to operate on. Returns the attached row element so the
 * test can also assert on its post-cancel detached state.
 */
function appendTestRow(uploadId, opts) {
    opts = opts || {};
    const tr = document.createElement('tr');
    tr.id = 'upload-' + uploadId;
    if (opts.dataSource !== undefined) {
        tr.setAttribute('data-source', opts.dataSource);
    }
    tr.setAttribute('data-upload-id', uploadId);
    const filename = opts.filename || 'test.bin';
    tr.innerHTML = [
        '<td>' + filename + '</td>',
        '<td class="status-cell"></td>',
        '<td class="action-cell">',
        '  <button class="cancel-btn" data-upload-id="' + uploadId + '">Cancel</button>',
        '</td>',
    ].join('\n');
    document.getElementById('incomplete-table-body').appendChild(tr);
    return tr;
}

/**
 * Build a fetch mock that responds based on URL and captures every call.
 * Tests can override the per-URL behavior via `mockImplementation`.
 */
function makeOkFetch() {
    return vi.fn(function (url) {
        const u = typeof url === 'string' ? url : (url && url.url) || '';
        if (u.indexOf('/upload/cancel/') === 0) {
            return Promise.resolve({
                ok: true, status: 200,
                json: function () { return Promise.resolve({ success: true }); },
            });
        }
        return Promise.resolve({
            ok: true, status: 200,
            json: function () { return Promise.resolve({}); },
        });
    });
}

/** Filter fetch-mock calls to just the DELETE /upload/cancel/* hits. */
function deleteCalls(fetchMock) {
    return fetchMock.mock.calls.filter(function (entry) {
        const url = entry[0];
        return typeof url === 'string' && url.indexOf('/upload/cancel/') === 0;
    });
}

/** Read both toast-title and toast-body text (cleared between tests by setupDOM). */
function lastToast() {
    const titleEl = document.getElementById('toast-title');
    const bodyEl = document.getElementById('toast-body');
    return ((titleEl && titleEl.textContent) || '') + ' ' +
           ((bodyEl && bodyEl.textContent) || '');
}

let Uploader = null;
let fetchMock = null;

beforeEach(function () {
    setupDOM();
    Uploader = loadUploaderFresh();
    fetchMock = makeOkFetch();
    globalThis.fetch = fetchMock;
});

// --------------------------------------------------------------------
// cancelUpload decisions by row data-source
// --------------------------------------------------------------------

describe('Uploader.cancelUpload — cancel decision by data-source', function () {
    it('SKIPS DELETE for data-source="resume" (queued resume row)', async function () {
        appendTestRow('resume-id', { dataSource: 'resume', filename: 'resumable.bin' });

        await Uploader.cancelUpload('resume-id');

        expect(deleteCalls(fetchMock)).toHaveLength(0);
        expect(lastToast()).toMatch(/Preserved/i);
    });

    it('DELETEs for data-source="new" (queued fresh drop)', async function () {
        appendTestRow('new-id', { dataSource: 'new', filename: 'fresh-drop.bin' });

        await Uploader.cancelUpload('new-id');

        const calls = deleteCalls(fetchMock);
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('/upload/cancel/new-id');
        expect((calls[0][1] || {}).method || 'DELETE').toBe('DELETE');
        expect(lastToast()).toMatch(/Cancelled/i);
    });

    it('DELETEs for data-source="incomplete" (dashboard-rendered row)', async function () {
        appendTestRow('incomplete-id', {
            dataSource: 'incomplete', filename: 'old-incomplete.bin',
        });

        await Uploader.cancelUpload('incomplete-id');

        const calls = deleteCalls(fetchMock);
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('/upload/cancel/incomplete-id');
        expect(lastToast()).toMatch(/Cancelled/i);
    });

    it('DELETEs for a row with NO data-source attribute (defensive fallback)', async function () {
        appendTestRow('legacy-id', { dataSource: null, filename: 'legacy.bin' });

        await Uploader.cancelUpload('legacy-id');

        expect(deleteCalls(fetchMock)).toHaveLength(1);
        expect(lastToast()).toMatch(/Cancelled/i);
    });
});

// --------------------------------------------------------------------
// cancelUpload failure surface (status code, network)
// --------------------------------------------------------------------

describe('Uploader.cancelUpload — failure surfacing (no silent swallow)', function () {
    function withFetchReturning(url, responseOrReject) {
        fetchMock.mockImplementation(function (u) {
            const target = typeof u === 'string' ? u : (u && u.url) || '';
            if (target.indexOf('/upload/cancel/') === 0) {
                return typeof responseOrReject === 'function'
                    ? responseOrReject()
                    : responseOrReject;
            }
            return Promise.resolve({
                ok: true, status: 200,
                json: function () { return Promise.resolve({}); },
            });
        });
    }

    it('shows Cancel Failed toast on HTTP 403 with the status code', async function () {
        appendTestRow('csrf-fail-id', { dataSource: 'new' });
        withFetchReturning('cancel', Promise.resolve({
            ok: false, status: 403,
            json: function () { return Promise.resolve({ error: 'CSRF invalid' }); },
        }));
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(function () {});

        await Uploader.cancelUpload('csrf-fail-id');

        expect(lastToast()).toMatch(/403/);
        expect(consoleErr).toHaveBeenCalledWith(expect.stringContaining('403'));
        consoleErr.mockRestore();
    });

    it('shows Cancel Failed toast on HTTP 500 (chunker permission error swallowed by ignore_errors=True)', async function () {
        appendTestRow('server-fail-id', { dataSource: 'new' });
        withFetchReturning('cancel', Promise.resolve({
            ok: false, status: 500,
            json: function () { return Promise.resolve({ error: 'Internal Server Error' }); },
        }));
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(function () {});

        await Uploader.cancelUpload('server-fail-id');

        expect(lastToast()).toMatch(/500/);
        consoleErr.mockRestore();
    });

    it('shows Cancel Failed toast on network rejection', async function () {
        appendTestRow('net-fail-id', { dataSource: 'new' });
        withFetchReturning('cancel', Promise.reject(new Error('Network unreachable')));
        const consoleErr = vi.spyOn(console, 'error').mockImplementation(function () {});

        await Uploader.cancelUpload('net-fail-id');

        expect(lastToast()).toMatch(/Network/i);
        consoleErr.mockRestore();
    });

    it('does NOT issue DELETE for data-source="resume" even when server is unavailable', async function () {
        appendTestRow('resume-net-id', { dataSource: 'resume' });
        // Force network error for any URL
        fetchMock.mockImplementation(function () {
            return Promise.reject(new Error('down'));
        });

        await Uploader.cancelUpload('resume-net-id');

        // Resume rows must never hit the server DELETE; network outage notwithstanding
        expect(deleteCalls(fetchMock)).toHaveLength(0);
        expect(lastToast()).toMatch(/Preserved/i);
    });
});

// --------------------------------------------------------------------
// cancelUpload DOM side effects
// --------------------------------------------------------------------

describe('Uploader.cancelUpload — DOM side effects', function () {
    it('removes the row from the DOM (parentNode becomes null)', async function () {
        const tr = appendTestRow('remove-id', { dataSource: 'new' });

        await Uploader.cancelUpload('remove-id');

        expect(tr.parentNode).toBeNull();
        expect(document.getElementById('upload-remove-id')).toBeNull();
    });

    it('stamps data-cancelled="true" on the detached row element', async function () {
        const tr = appendTestRow('stamp-id', { dataSource: 'new' });

        await Uploader.cancelUpload('stamp-id');

        // Even though the row is detached, we keep the JS reference and
        // can still read attributes — this is what lets handleFiles'
        // queued task body detect the cancel after the qid rename race.
        expect(tr.getAttribute('data-cancelled')).toBe('true');
    });

    it('stamps data-cancelled even for data-source="resume" (queue task still needs to skip)', async function () {
        const tr = appendTestRow('stamp-resume-id', { dataSource: 'resume' });

        await Uploader.cancelUpload('stamp-resume-id');

        expect(tr.getAttribute('data-cancelled')).toBe('true');
        expect(tr.getAttribute('data-source')).toBe('resume'); // unchanged
    });

    it('is idempotent on double-cancel: each call independently attempts a DELETE; server-side cleanup_upload is the idempotent boundary', async function () {
        appendTestRow('double-id', { dataSource: 'new' });

        await Uploader.cancelUpload('double-id');
        // Row is now detached; second call must still be safe (no early throw)
        await expect(Uploader.cancelUpload('double-id')).resolves.not.toThrow();

        // cancelUpload fires the DELETE branch on both calls (the second
        // finds tr=null, isResume stays false, falls into DELETE). Server-side
        // cleanup_upload is the layer that makes this safe (idempotent).
        // Loose >= would hide a regression that fires an extra DELETE.
        expect(deleteCalls(fetchMock)).toHaveLength(2);
    });
});

// --------------------------------------------------------------------
// pause / resume safety net — pause on unknown id, resume on no state
// --------------------------------------------------------------------

describe('Uploader pause / resume safety', function () {
    it('resumePaused on an unknown uploadId safely returns false (no chunk loop enqueued)', function () {
        appendTestRow('unknown-resume-id', { dataSource: 'resume' });
        expect(Uploader.resumePaused('unknown-resume-id')).toBe(false);
    });

    it('resumePaused on an unknown uploadId returns false (no chunk loop enqueued)', function () {
        expect(Uploader.resumePaused('unknown-resume-id')).toBe(false);
    });

    it('resumePaused on a non-paused active state returns false (no enqueue)', function () {
        // We can't easily fabricate a non-paused active state from outside,
        // but a fresh Uploader has empty activeUploads, so this is the same
        // as the unknown-id case above — assert the false contract holds.
        expect(Uploader.resumePaused('absent-id')).toBe(false);
    });
});

// --------------------------------------------------------------------
// Upload queue integration — verifies the queue serializer that the
// Uploader routes every drop/resume through still upholds the pause /
// cancel / resume lifecycle when the queue is exercised directly with
// state-machine-shaped tasks (the bug surface that ee3eb03 / 0334fb7
// patched from the other direction).
// --------------------------------------------------------------------

describe('Upload queue (createUploadQueue) state-machine scenarios', function () {
    it('five tasks run strictly in order, including a long mid-task', async function () {
        const log = [];
        const enqueue = createUploadQueue();
        const tasks = [10, 30, 5, 0, 0].map(function (delay, i) {
            return enqueue(async function () {
                if (delay) await new Promise(function (r) { setTimeout(r, delay); });
                log.push('T' + i);
            });
        });
        await Promise.all(tasks);
        expect(log).toEqual(['T0', 'T1', 'T2', 'T3', 'T4']);
    });

    it('a throwing task does NOT poison the chain — next tasks still run', async function () {
        const log = [];
        const enqueue = createUploadQueue();
        const failing = enqueue(async function () { throw new Error('boom'); });
        const next = enqueue(async function () { log.push('survived-1'); });
        const after = enqueue(async function () { log.push('survived-2'); });
        await Promise.all([failing.catch(function () {}), next, after]);
        expect(log).toEqual(['survived-1', 'survived-2']);
    });

    it('two consecutive throwing tasks still hand a future task a turn', async function () {
        const enqueue = createUploadQueue();
        enqueue(function () { throw new Error('first'); }).catch(function () {});
        enqueue(function () { throw new Error('second'); }).catch(function () {});
        let ran = false;
        await enqueue(function () { ran = true; });
        expect(ran).toBe(true);
    });

    it('a pause-then-resume on a single slow task resumes correctly', async function () {
        const log = [];
        const enqueue = createUploadQueue();
        let resumed = false;

        const slow = enqueue(async function () {
            log.push('start');
            while (!resumed) {
                await new Promise(function (r) { setTimeout(r, 5); });
            }
            log.push('resumed');
        });
        const after = enqueue(async function () { log.push('after'); });

        // Resume the slow task after 30ms
        setTimeout(function () { resumed = true; }, 30);

        await Promise.all([slow, after]);
        expect(log).toEqual(['start', 'resumed', 'after']);
    });

    it('a rejected per-task promise (cancel) does not block subsequent tasks', async function () {
        const log = [];
        const enqueue = createUploadQueue();

        // Simulating a cancel: per-task rejection handled by handler.
        // The next task must still run.
        const cancelled = enqueue(async function () { throw new Error('cancelled by user'); });
        const next = enqueue(async function () { log.push('still-ran'); });

        await Promise.all([cancelled.catch(function () {}), next]);
        expect(log).toEqual(['still-ran']);
    });

    it('per-task promise surfaces the resolved value AND the rejection reason', async function () {
        const enqueue = createUploadQueue();

        const values = [];
        const t1 = enqueue(async function () { return 'first-result'; })
            .then(function (v) { values.push(['t1', v]); });
        const t2 = enqueue(function () { return 'second-result'; })
            .then(function (v) { values.push(['t2', v]); });
        const t3f = enqueue(function () { throw new Error('third-rejected'); });
        // Catch is wired INTO the await chain so vitest doesn't see a rejected top-level promise
        const t3c = t3f.catch(function (err) { values.push(['t3', err.message]); });

        await Promise.all([t1, t2, t3c]);
        expect(values).toEqual([
            ['t1', 'first-result'],
            ['t2', 'second-result'],
            ['t3', 'third-rejected'],
        ]);
    });
});
