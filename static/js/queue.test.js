/*
 * VpsEasyUploader — queue.test.js
 *
 * Vitest suite for the upload-queue serialization primitive. Lives
 * next to the source so the default `vitest run` picks it up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createUploadQueue } from './queue.js';

describe('createUploadQueue', () => {
    beforeEach(() => {
        // The internal .catch logs to console.error on every thrown
        // task. Silence it during tests so the test runner output
        // stays clean — the behaviour under test is observable
        // through the per-task promise, not through stderr.
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('runs two enqueued tasks strictly in order', async () => {
        const enqueueUpload = createUploadQueue();
        const order = [];

        // Task A yields to the event loop first, then completes —
        // if B sneaks in before A finishes, the assertion below
        // would fail ('B' would land at index 0).
        const taskA = enqueueUpload(async () => {
            await new Promise(resolve => setTimeout(resolve, 20));
            order.push('A');
        });
        const taskB = enqueueUpload(async () => {
            order.push('B');
        });

        await Promise.all([taskA, taskB]);

        expect(order).toEqual(['A', 'B']);
    });

    it('keeps the chain alive when a task throws', async () => {
        const enqueueUpload = createUploadQueue();
        let thirdTaskFinished = false;

        // First task throws. We catch the rejected per-task promise
        // so vitest doesn't fail with UnhandledPromiseRejection.
        const failingTask = enqueueUpload(async () => {
            throw new Error('boom');
        });
        failingTask.catch(() => {}); // swallow on purpose

        // Second task after the throw must still execute. If a
        // thrown task somehow poisoned the chain (e.g. by setting
        // uploadQueue = rejectedPromise), this would never run.
        await enqueueUpload(async () => {
            thirdTaskFinished = true;
        });

        expect(thirdTaskFinished).toBe(true);
    });

    it('returns a per-task promise that resolves with the task’s value', async () => {
        const enqueueUpload = createUploadQueue();
        const result = await enqueueUpload(() => 42);
        expect(result).toBe(42);
    });

    it('returns a per-task promise that rejects when the task throws', async () => {
        const enqueueUpload = createUploadQueue();
        await expect(
            enqueueUpload(() => { throw new Error('rejected!'); })
        ).rejects.toThrow('rejected!');
    });

    it('recovers from two consecutive throwing tasks', async () => {
        // Belt-and-braces: even when every queued task throws,
        // the queue must still hand a future task a turn.
        const enqueueUpload = createUploadQueue();

        enqueueUpload(() => { throw new Error('first'); }).catch(() => {});
        enqueueUpload(() => { throw new Error('second'); }).catch(() => {});

        let afterwardsRan = false;
        await enqueueUpload(() => {
            afterwardsRan = true;
        });

        expect(afterwardsRan).toBe(true);
    });
});
