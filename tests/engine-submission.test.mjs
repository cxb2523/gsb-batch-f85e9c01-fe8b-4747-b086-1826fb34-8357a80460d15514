// Acceptance tests for the sequenced, cancelable render chain in js/engine.js, driven entirely by
// self-made Float32 samples (the worker mock returns silent Float32Arrays; the fake decoder makes
// short sine/silence loops). Each test imports a fresh engine module so the worker pool, caches and
// submission sequences start clean.
//
// Covers the required scenarios:
//   1. rapid successive picks: only the last one is ever cached or played
//   2. picks made while an FX is held land with the release, new song and effect together
//   3. a late worker reply after a clear cannot resurrect the layer
//   4. re-picking the same song hits the cache (no second stretch)
//   5. a worker error falls back to the layer's original speed and allows a retry, never stuck
//   6. a key-lock change changes the pitch ratio and invalidates the in-flight request/cache key
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installGlobals, FakeWorker, FakeFetch, tick, until, waitForJob } from './helpers/browser-mock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engineUrl = pathToFileURL(join(here, '..', 'js', 'engine.js')).href;

// Three fake songs; every layer can take every type, so the wheel of picks is unrestricted.
const audio = {
  oggs: { all: 'x.ogg', groove: 'x.ogg', lead: 'x.ogg', texture: 'x.ogg' },
  flacs: { all: 'x.flac', groove: 'x.flac', lead: 'x.flac', texture: 'x.flac' },
  frames: { all: 44100, groove: 44100, lead: 44100, texture: 44100 },
};
const MANIFEST = {
  SongA: { code: 'A1', album: 'al', key: 'Cm', bpm: 120, stems: { all: 'a-all.wav', groove: 'a-g.wav', lead: 'a-l.wav', texture: 'a-t.wav' }, ...audio },
  SongB: { code: 'B2', album: 'al', key: 'Gm', bpm: 124, stems: { all: 'b-all.wav', groove: 'b-g.wav', lead: 'b-l.wav', texture: 'b-t.wav' }, ...audio },
  SongC: { code: 'C3', album: 'al', key: 'Dm', bpm: 112, stems: { all: 'c-all.wav', groove: 'c-g.wav', lead: 'c-l.wav', texture: 'c-t.wav' }, ...audio },
};

let engineN = 0;
// Builds an engine whose manifest and stem fetches are served from in-memory fakes, with a fresh
// module instance (and therefore fresh pools, caches and submission sequences) per call.
async function freshEngine({ auto = true } = {}) {
  installGlobals();
  FakeWorker.reset({ auto });
  for (const song of Object.values(MANIFEST)) for (const path of Object.values(song.stems)) {
    FakeFetch.set(path, { frames: 44100, rate: 44100 });
  }
  globalThis.fetch = async (url) => {
    if (String(url).includes('stems.json')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => MANIFEST,
        async arrayBuffer() { return { frames: 44100, rate: 44100 }; } };
    }
    return { ok: true, status: 200, headers: { get: () => null },
      async arrayBuffer() { return FakeFetch.files.get(String(url).split('?')[0]) || { frames: 44100, rate: 44100 }; } };
  };
  const E = await import(`${engineUrl}?v=${engineN++}`);
  await E.loadManifest('stems.json');
  return E;
}

// Holds worker replies so a test decides when each lands.
const held = () => { FakeWorker.auto = false; };
const settle = (n = 4) => tick(n * 2);
// Resolves every worker job currently held, then waits for the chain to react.
async function drain() {
  for (const w of FakeWorker.instances) if (w.job) w.resolve();
  await settle();
}
// Resolves jobs as they appear until the layer leaves its loading state (or the guard trips).
async function resolveUntilNotLoading(E, layerId, rounds = 20) {
  for (let i = 0; i < rounds && E.state.layers[layerId].loading; i++) {
    if (!FakeWorker.instances.some((w) => w.job)) await settle();
    await drain();
  }
}

test('1. rapid successive picks: only the last submission is cached and played', async () => {
  const E = await freshEngine();
  E.warmUp();
  held();
  // Fire three picks on the same layer before any worker reply lands.
  const p1 = E.selectStem('groove', 'SongA');
  const p2 = E.selectStem('groove', 'SongB');
  const p3 = E.selectStem('groove', 'SongC');
  const sub = E.submission('groove');
  assert.equal(sub.song, 'SongC', 'the newest submission is SongC');
  assert.ok(sub.seq >= 3, 'each pick bumped the sequence');
  // The newest pick's job is the only one that survives: wait for it to be running and confirm no
  // queued/stale sibling job can reach the worker ahead of it.
  await waitForJob();
  assert.equal(E.poolState().queued, 0, 'stale queued jobs were dropped, not parked behind the newest');
  await resolveUntilNotLoading(E, 'groove');
  await Promise.allSettled([p1, p2, p3]);
  const s = E.state.layers.groove;
  assert.equal(s.song, 'SongC', 'the layer heard the last pick');
  assert.ok(s.buffer, 'a buffer was assigned to the layer');
  assert.equal(s.bufferKey, sub.key);
  // Only the final render key may be cached; stale keys were released, never written.
  const keys = E.renderCache().keys();
  assert.ok(keys.includes(sub.key), 'the current render key is cached');
  assert.ok(keys.every((k) => k.startsWith('SongC|')), `no stale song's render was cached: ${keys}`);
});

test('2. a pick queued during an FX hold drops in on release with the effect', async () => {
  const E = await freshEngine();
  E.ensureCtx();
  // Put a groove in (auto mode lets its render resolve) and start the transport.
  const first = E.selectStem('groove', 'SongA');
  await resolveUntilNotLoading(E, 'groove');
  await first;
  await E.play();
  await settle();
  assert.equal(E.state.playing, true);
  // Hold the low-pass FX, then pick a new song: it must queue rather than drop in immediately.
  E.fxStart('lowpass');
  held();
  const queuedPick = E.selectStem('groove', 'SongB');
  await until(() => E.queued('groove'), { label: 'the pick to queue for the FX release' });
  const sub = E.submission('groove');
  assert.equal(sub.song, 'SongB');
  // Let the queued render finish while the effect is still held.
  await resolveUntilNotLoading(E, 'groove');
  await queuedPick;
  assert.equal(E.queued('groove'), true, 'still queued until the release');
  // Release: the same submission chain commits it, together with the effect.
  E.fxStop();
  await settle();
  assert.equal(E.queued('groove'), false);
  const s = E.state.layers.groove;
  assert.equal(s.song, 'SongB', 'the new song is the one committed on release');
  assert.equal(s.bufferKey, sub.key, 'the committed buffer matches the queued submission');
  assert.equal(E.submission('groove').seq, sub.seq, 'the release did not open a newer submission');
});

test('3. a late worker reply after clearing the layer cannot resurrect it', async () => {
  const E = await freshEngine();
  E.warmUp();
  held();
  const pick = E.selectStem('lead', 'SongA');
  await waitForJob();
  assert.equal(E.state.layers.lead.song, 'SongA');
  const keyBefore = E.submission('lead').key;
  const seqBefore = E.submission('lead').seq;
  // Clear while the render is in flight. The clear is itself a submission (seq advances, request
  // becomes null): the bound job is stale, so the pool retires its worker and no later reply can be
  // matched to the layer.
  E.clearLayer('lead');
  await settle();
  assert.equal(E.state.layers.lead.song, null, 'the layer is cleared');
  assert.equal(E.submission('lead'), null, 'clearing drops the recorded request');
  assert.equal(E.renderCache().has(keyBefore), false, 'the cleared key was released from the cache');
  assert.ok(E.poolState().staleRunning === 0, 'no job bound to the dead submission keeps running');
  // Even if a worker somehow answered now (an id that matches nothing live, or the dead seq), the
  // engine must neither cache it nor bring the layer back.
  for (const w of FakeWorker.instances) if (w.job) w.resolveAs(99999);
  await settle();
  await Promise.allSettled([pick]);
  assert.equal(E.state.layers.lead.song, null, 'the stale reply did not resurrect the layer');
  assert.equal(E.state.layers.lead.buffer, null);
  assert.equal(E.renderCache().has(keyBefore), false, 'nothing was cached for the dead layer');
  assert.ok(E.submission('lead') === null || E.submission('lead').seq > seqBefore);
});

test('4. re-picking the same song hits the cache and never stretches twice', async () => {
  const E = await freshEngine();
  E.warmUp();
  const firstPick = E.selectStem('texture', 'SongA');
  await resolveUntilNotLoading(E, 'texture');
  await firstPick;
  const first = E.submission('texture');
  assert.ok(E.renderCache().buffered(first.key), 'the first pick produced a cached buffer');
  // Pick away, then back to the same song: the second SongA render must reuse the cache entry.
  const away = E.selectStem('texture', 'SongB');
  await resolveUntilNotLoading(E, 'texture');
  await away;
  held();
  const before = E.poolState().running;
  const back = E.selectStem('texture', 'SongA', { force: true });
  // Give the download/render path every chance to spawn a job; a cached key must take none.
  await settle(6);
  assert.equal(E.poolState().running, before, 'returning to a cached render starts no worker job');
  await back;
  const again = E.submission('texture');
  assert.equal(again.key, first.key, 'the same parameters give the same render key');
  assert.ok(E.renderCache().buffered(first.key), 'the original render is still in the cache');
});

test('5. a worker error falls back to original speed and a later pick retries', async () => {
  const E = await freshEngine();
  E.warmUp();
  held();
  const pick = E.selectStem('groove', 'SongA');
  const job = await waitForJob();
  assert.equal(E.state.layers.groove.loading, true, 'the layer waits on its render');
  job.fail('synthetic stretch failure');
  await until(() => !E.state.layers.groove.loading, { label: 'the fallback to settle' });
  await pick;
  const s = E.state.layers.groove;
  assert.equal(s.song, 'SongA', 'the pick is not dropped on a worker failure');
  assert.equal(s.loading, false, 'it is not stuck in the loading state');
  assert.ok(s.buffer && s.buffer.nativeFallback === true, 'it plays the original at native speed');
  assert.equal(s.bufferKey, null, 'the failed render was not cached');
  assert.ok(s.error, 'the layer records why it fell back');
  // A fresh pick (new submission) stretches again and succeeds.
  const retry = E.selectStem('groove', 'SongB');
  await resolveUntilNotLoading(E, 'groove');
  await retry;
  const after = E.state.layers.groove;
  assert.equal(after.song, 'SongB');
  assert.ok(after.buffer && !after.buffer.nativeFallback, 'the retry produced a real stretched buffer');
  assert.equal(after.error, null, 'a successful render clears the fallback error');
});

test('6. a key-lock change changes the pitch ratio and invalidates the in-flight render', async () => {
  const E = await freshEngine();
  E.ensureCtx();
  const first = E.selectStem('groove', 'SongA');
  await resolveUntilNotLoading(E, 'groove');
  await first;
  const before = E.submission('groove');
  // Lock to a different master key: the required semitones (and so the pitch ratio) move.
  E.setMasterKey('G');
  const after = E.submission('groove');
  assert.notEqual(after.pitchRatio, before.pitchRatio, 'the pitch ratio follows the key lock');
  assert.notEqual(after.key, before.key, 'the render key changes with the key');
  assert.ok(after.seq > before.seq, 'the key change is a new sequenced submission');
  // The old render is no longer any submission's target. It may be parked for the moment because
  // the layer is still sounding its buffer, but it is released the instant the new render lands —
  // one layer keeps exactly one stretched buffer, it does not accumulate across key changes.
  const cache = E.renderCache();
  assert.ok(!cache.keys().some((k) => k === before.key && k === after.key), 'the keys are distinct cache entries');
  // Any worker job still running must be bound to the new sequence, never the expired one.
  await settle();
  for (const w of FakeWorker.instances) {
    if (w.job && w.job.layerId === 'groove') assert.equal(w.job.seq, after.seq, 'no stale job survives the key change');
  }
  // Let the new render complete and confirm the layer ends on the new key's buffer, at which point
  // the parked old buffer is explicitly discarded rather than left for the memory budget to evict.
  await resolveUntilNotLoading(E, 'groove');
  await settle();
  assert.equal(E.state.layers.groove.bufferKey, after.key);
  assert.equal(cache.has(before.key), false, 'the replaced buffer is released once the new one lands');
  assert.ok(cache.keys().every((k) => k !== before.key), 'the cache holds no render for the expired key');
});
