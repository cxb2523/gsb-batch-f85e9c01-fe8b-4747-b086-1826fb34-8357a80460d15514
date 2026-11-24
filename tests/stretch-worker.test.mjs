// Sandbox test for js/stretch-worker.js: drives the worker's message handler directly with
// self-made short Float32 samples (silence and a sine), no audio files or DOM. It checks the
// contract the main thread relies on for its cancelable render chain:
//   - every reply carries the same id as the request
//   - the actual quality/formant come back, with exactly targetLen samples
//   - targetLen and pitchRatio are echoed for staleness matching on the main thread
//   - a bad job reports { id, error } plus the same echo instead of throwing
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'js', 'stretch-worker.js'), 'utf8');

// Loads the worker script into a sandbox with a captured onmessage, returning { post, replies }.
function loadWorker() {
  const replies = [];
  const sandbox = {
    console,
    self: {
      postMessage(msg, _transfers) { replies.push(msg); },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'stretch-worker.js' });
  assert.equal(typeof sandbox.self.onmessage, 'function', 'the worker registers self.onmessage');
  return {
    replies,
    post(job) { sandbox.self.onmessage({ data: job }); },
  };
}

const SR = 22050; // small rate keeps the synthetic job quick
function sine(n, freq = 220) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.2 * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}
const silence = (n) => new Float32Array(n);
const stereo = (mono) => [mono, mono.slice()];

test('worker echoes id, targetLen and pitchRatio and returns exactly targetLen samples', () => {
  const w = loadWorker();
  const inLen = SR; // one second
  const targetLen = Math.round(inLen * 1.1); // a 10% slower loop
  const pitchRatio = 1;
  w.post({ id: 42, channels: stereo(sine(inLen)), sampleRate: SR, srcRate: SR, targetLen, pitchRatio, type: 'groove', inLen });
  assert.equal(w.replies.length, 1);
  const r = w.replies[0];
  assert.equal(r.id, 42, 'id matches the request');
  assert.equal(r.targetLen, targetLen, 'targetLen echoed');
  assert.equal(r.pitchRatio, pitchRatio, 'pitchRatio echoed');
  assert.equal(r.error, undefined, 'a good job has no error');
  assert.ok(r.quality === 'fast' || r.quality === 'hq', 'reports the actual quality');
  assert.equal(typeof r.formant, 'boolean', 'reports whether formants were kept');
  assert.equal(r.channels.length, 2);
  for (const c of r.channels) assert.equal(c.length, targetLen, 'each channel has the requested length');
});

test('worker renders a pitched sine shorter and keeps the echo on the hq path', () => {
  const w = loadWorker();
  const inLen = SR;
  const pitchRatio = Math.pow(2, 2 / 12); // two semitones up
  const targetLen = Math.round(inLen / pitchRatio);
  w.post({ id: 7, channels: stereo(sine(inLen, 330)), sampleRate: SR, srcRate: SR, targetLen, pitchRatio, type: 'lead', inLen, quality: 'hq', formant: true });
  const r = w.replies[0];
  assert.equal(r.id, 7);
  assert.equal(r.targetLen, targetLen);
  assert.ok(Math.abs(r.pitchRatio - pitchRatio) < 1e-12);
  assert.equal(r.channels[0].length, targetLen);
  assert.equal(typeof r.quality, 'string');
  assert.equal(typeof r.formant, 'boolean'); // formant may be false where the fast path sufficed
});

test('silent input of a different rate is converted and still echoes the request', () => {
  const w = loadWorker();
  const srcRate = SR, outRate = 24000;
  const inLen = Math.round(SR * 0.5);
  const targetLen = Math.round(inLen * (outRate / srcRate));
  w.post({ id: 99, channels: stereo(silence(inLen)), sampleRate: outRate, srcRate, targetLen, pitchRatio: 1, type: 'all', inLen });
  const r = w.replies[0];
  assert.equal(r.id, 99);
  assert.equal(r.targetLen, targetLen);
  assert.equal(r.pitchRatio, 1);
  assert.equal(r.channels[0].length, targetLen);
});

test('a failing job answers with id, error and the same echo, and does not throw', () => {
  const w = loadWorker();
  const inLen = SR, targetLen = 2000, pitchRatio = 1;
  // A channels array whose buffers are plain objects (not typed arrays) breaks run() deep in the
  // DSP; the worker must catch it and answer rather than escape the message handler.
  const broken = [{ notTyped: true }, { notTyped: true }];
  assert.doesNotThrow(() => w.post({ id: 123, channels: broken, sampleRate: SR, srcRate: SR, targetLen, pitchRatio, type: 'groove', inLen }));
  const r = w.replies[0];
  assert.equal(r.id, 123);
  assert.equal(typeof r.error, 'string', 'the failure is reported as an error string');
  assert.equal(r.targetLen, targetLen, 'the echo rides along on errors too');
  assert.equal(r.pitchRatio, pitchRatio);
});
