// Export orchestration helpers.
//
// Exports must be decoupled from the live editing state: everything an export
// needs is copied into an immutable snapshot when the user starts it, and the
// lock guarding the export buttons is released on success, failure and timeout.

// Export dimensions are select values, but they still bound the amount of canvas
// memory a single export can allocate. Reject non-finite or out-of-range values.
const boundedSetting = (value, fallback, minimum, maximum) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
};

export const normalizeExportSettings = (raw = {}) => ({
    size: Math.round(boundedSetting(raw.size, 160, 128, 256)),
    frameCount: Math.round(boundedSetting(raw.frameCount, 32, 24, 48)),
    fps: Math.round(boundedSetting(raw.fps, 16, 12, 24))
});

// Deep-copy the recipe and freeze the settings so later edits to the live
// controls cannot leak into an export that is already running.
export const createExportSnapshot = (recipe, rawSettings) => {
    const snapshot = {
        recipe: structuredClone(recipe),
        settings: normalizeExportSettings(rawSettings)
    };
    return Object.freeze(snapshot);
};

// A tiny single-owner lock. tryAcquire/release are explicit so every terminal
// path can free the buttons, including a Promise rejection or a timeout.
export const createExportLock = () => {
    let locked = false;
    return {
        get locked() {
            return locked;
        },
        tryAcquire() {
            if (locked) return false;
            locked = true;
            return true;
        },
        release() {
            locked = false;
        }
    };
};

export const GIF_TIMEOUT_MESSAGE = 'GIF export timed out.';
export const GIF_CANCELLED_MESSAGE = 'GIF export was cancelled.';

// Drive a gif.js instance to completion with a hard watchdog.
//
// The returned promise settles exactly once. On timeout it rejects and *then*
// calls abort(): the caller's export lock is released by the rejection path, so
// it never depends on the encoder emitting its "abort" event. Late "finished"
// or "abort" events from the encoder are ignored.
export const encodeGif = ({
    frames,
    fps,
    gifFactory,
    prepareFrame = (frame) => frame,
    timeoutMs = 120_000,
    workerScript,
    transparent,
    quality = 10,
    repeat = 0,
    workers = 2
}) => new Promise((resolve, reject) => {
    let gif;
    let watchdog;
    let settled = false;

    const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(watchdog);
        callback(value);
    };

    // Arm before any work so a stalled frame/addFrame also bounds the lock.
    watchdog = window.setTimeout(() => {
        settle(reject, new Error(GIF_TIMEOUT_MESSAGE));
        try {
            gif?.abort();
        } catch (error) {
            console.error(error);
        }
    }, timeoutMs);

    try {
        gif = gifFactory({
            workers,
            quality,
            repeat,
            transparent,
            workerScript
        });
        frames.forEach((frame) => {
            gif.addFrame(prepareFrame(frame), {
                copy: true,
                delay: Math.round(1000 / fps)
            });
        });
        gif.on('finished', (blob) => settle(resolve, blob));
        gif.on('abort', () => settle(reject, new Error(GIF_CANCELLED_MESSAGE)));
        gif.render();
    } catch (error) {
        settle(reject, error);
    }
});
