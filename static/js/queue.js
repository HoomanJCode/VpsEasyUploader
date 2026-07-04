/*
 * VpsEasyUploader — Upload Queue
 *
 * Tiny serialization primitive shared by every upload entry point
 * (`handleFiles`, `resumeFromUI`, `resumeUploadFromPause`). Each call
 * to the returned `enqueueUpload(task)` appends `task` to a shared
 * promise chain so two simultaneous uploads run one at a time.
 *
 * The returned per-task promise resolves/rejects with the task
 * itself, so the caller can `await` it (or `.catch` for errors).
 * An inner .catch swallows the task's rejection so a single failing
 * task can't permanently break subsequent batches.
 *
 * Loaded as a vanilla <script> in the browser (attaches
 * `window.UploadQueue`) and as a CommonJS module in Node tests
 * (`require('./queue').createUploadQueue`).
 */
(function (root) {
    function createUploadQueue() {
        let uploadQueue = Promise.resolve();

        /**
         * Append `task` to the queue. The returned promise resolves
         * only when `task` finishes; the internal chain stays alive
         * across rejections so subsequent tasks still run.
         *
         * @param {() => Promise<any>|any} task
         * @returns {Promise<any>}
         */
        return function enqueueUpload(task) {
            const myTask = uploadQueue.then(async () => await task());
            uploadQueue = myTask.catch(err => {
                console.error('Queue chain error:', err);
            });
            return myTask;
        };
    }

    const api = { createUploadQueue };

    // Browser: attach to window so uploader.js can call createUploadQueue()
    if (typeof window !== 'undefined') {
        root.UploadQueue = api;
    }

    // Node (vitest, plain requires): expose as CommonJS module.
    // `module.exports = api` enables named imports via ESM-CJS
    // interop (`import { createUploadQueue } from './queue.js'`).
    // The `.default = api` belt-and-braces lets a default import
    // (`import queue from './queue.js'`) also work.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
        module.exports.default = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
