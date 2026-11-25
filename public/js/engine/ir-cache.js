// Context-scoped cache of decoded impulse responses (and any other asset buffers
// that need asynchronous decoding). One cache entry per AudioContext, so the same
// IR used by several tracks — or by several graph rebuilds — is decoded exactly
// once, and everything is released when the context is garbage collected.
//
// The same module is used by the browser player (decodeAudioData over HTTP) and
// the server renderer (WAV frames read from disk), only the decode callback differs.

const caches = new WeakMap();

function mapFor(ctx) {
  let m = caches.get(ctx);
  if (!m) caches.set(ctx, (m = new Map()));
  return m;
}

/**
 * Decode (once per context) the asset buffer for `id`.
 * decode(id) must return a Promise<AudioBuffer>; concurrent calls for the same id
 * share one in-flight promise. A failed decode is evicted so it can be retried.
 */
export function loadContextBuffer(ctx, id, decode) {
  if (!id) return Promise.resolve(null);
  const m = mapFor(ctx);
  const hit = m.get(id);
  if (hit) return hit.status === 'ready' ? Promise.resolve(hit.buffer) : hit.promise;
  const entry = { status: 'loading', promise: null, buffer: null };
  // Build the promise before storing it: the resolution callbacks must not close over
  // a map entry that does not exist yet (a self-referential entry never settles).
  const promise = Promise.resolve()
    .then(() => decode(id))
    .then((buffer) => { entry.status = 'ready'; entry.buffer = buffer; entry.promise = null; return buffer; })
    .catch((err) => { m.delete(id); throw err; });
  entry.promise = promise;
  m.set(id, entry);
  return promise;
}

/** Synchronous look-up of a buffer previously decoded with loadContextBuffer().
 * Returns null both for an unknown id and for a decoded "no IR" (empty asset). */
export function contextBuffer(ctx, id) {
  if (!id) return null;
  const entry = caches.get(ctx)?.get(id);
  return entry?.status === 'ready' ? entry.buffer : null;
}

/** Whether this id has finished loading in this context (successfully or as an empty IR). */
export function contextBufferReady(ctx, id) {
  return caches.get(ctx)?.get(id)?.status === 'ready';
}

/** Live Map view of the buffers ready in this context (safe to read on every update()). */
export function contextBufferView(ctx) {
  return {
    get(id) { return contextBuffer(ctx, id); },
    has(id) { return contextBufferReady(ctx, id); },
  };
}

// A convolver must always hold *some* buffer. When no IR is selected we give it a
// one-frame silent IR so its wet branch contributes nothing (the dry path stays at
// unity). Cached per context like every other IR; avoids assigning null, which the
// server's node-web-audio-api convolver rejects (browsers accept null, the silent IR
// is equivalent there too).
const silentIr = new WeakMap();
export function silentIrBuffer(ctx) {
  let b = silentIr.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, 1, ctx.sampleRate);
    b.getChannelData(0)[0] = 0;
    silentIr.set(ctx, b);
  }
  return b;
}

// node-web-audio-api's AudioWorklet loads a module with `import(moduleUrl)` in a
// worker, which on Node requires a file:// URL — a bare Windows path (D:\…) is
// rejected by the ESM loader. Browsers take the URL/relative path unchanged.
export function workletModuleUrl(url) {
  if (typeof process !== 'undefined' && process.versions?.node && typeof url === 'string' && /^[a-zA-Z]:[\\/]/.test(url)) {
    return new URL('file:///' + url.replace(/\\/g, '/')).href;
  }
  return url;
}
