// Convolution reverb: the currently selected IR must be used on both the live graph
// (preview) and the offline render (export). IR buffers are cached per context, so a
// shared IR is decoded once; clearing the IR returns to a dry pass without errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OfflineAudioContext, AudioWorkletNode } from 'node-web-audio-api';
import { fileURLToPath } from 'node:url';
import { buildProjectGraph, setWorkletNode, loadWorklets } from '../public/js/engine/graph.js';
import { buildStudioEffect, STUDIO_EFFECTS } from '../public/js/engine/studiofx.js';
import { loadContextBuffer, contextBuffer, contextBufferView, silentIrBuffer } from '../public/js/engine/ir-cache.js';
import { renderMix, writeWav } from '../server/audio.js';
import { renderSegment } from '../server/render-core.js';
import { OPS } from '../server/ops.js';
import { ValidationError } from '../server/validate.js';

const SR = 48000;
// node-web-audio-api's addModule takes a filesystem path.
const WORKLET_PATH = fileURLToPath(new URL('../public/js/engine/dsp-worklet.js', import.meta.url));
setWorkletNode(AudioWorkletNode);

const dirs = [];
const newDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nyxmix-conv-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const S = (s) => Math.round(s * SR);
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
const peak = (x, a = 0, b = x.length) => { let m = 0; for (let i = a; i < b; i++) m = Math.max(m, Math.abs(x[i])); return m; };
const maxDiff = (a, b, from = 0, to = a.length) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// Two clearly different impulse responses: a short burst vs. a long decaying noise tail.
function makeIr(kind, seconds = 1) {
  const n = S(seconds);
  const buf = new OfflineAudioContext(2, n, SR).createBuffer(2, n, SR);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    if (kind === 'burst') {
      for (let i = 0; i < S(0.02); i++) d[i] = 0.8 * Math.sin(2 * Math.PI * 1000 * i / SR);
    } else {
      let seed = 1234 + ch * 97;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
      for (let i = 0; i < n; i++) d[i] = rnd() * Math.exp(-6 * i / n);
    }
  }
  return buf;
}
const writeBufferWav = (file, buf) => writeWav(file, [buf.getChannelData(0), buf.getChannelData(1)], SR);
const writeToneWav = (file, seconds = 1, freq = 440) => {
  const n = S(seconds);
  const ch = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) { const v = 0.5 * Math.sin(2 * Math.PI * freq * i / SR); ch[0][i] = v; ch[1][i] = v; }
  return writeWav(file, ch, SR);
};

const P = (params) => ({ ...Object.fromEntries(Object.entries(STUDIO_EFFECTS.convolution.params).map(([k, v]) => [k, v.default])), ...(params || {}) });

// Build one convolution effect on an offline context and render a tone through it.
async function renderConv({ ctx, loadIr, params, seconds = 1, preloadIr = true }) {
  const n = S(seconds);
  const fx = buildStudioEffect(ctx, { id: 'fx1', type: 'convolution', params }, P, { from: 0, when: 0, irBuffers: contextBufferView(ctx), loadIr });
  const src = ctx.createBufferSource();
  const sb = ctx.createBuffer(1, n, SR);
  const sd = sb.getChannelData(0);
  for (let i = 0; i < n; i++) sd[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SR);
  src.buffer = sb;
  src.connect(fx.input); fx.output.connect(ctx.destination); src.start(0);
  if (preloadIr && params.ir && loadIr) await loadIr(params.ir);
  const out = await ctx.startRendering();
  return [new Float32Array(out.getChannelData(0)), new Float32Array(out.getChannelData(1))];
}

// ── 1. Context-scoped IR cache ─────────────────────────────────────────────
test('IR cache: one decode per context per IR, shared across callers; null and failures handled', async () => {
  const ctx = new OfflineAudioContext(2, SR, SR);
  let decodes = 0;
  const decode = async () => { decodes++; return makeIr('noise', 0.5); };
  const [b1, b2, b3] = await Promise.all([
    loadContextBuffer(ctx, 'ast_a', decode),
    loadContextBuffer(ctx, 'ast_a', decode), // concurrent: shares the in-flight promise
    loadContextBuffer(ctx, 'ast_a', decode),
  ]);
  assert.equal(decodes, 1, 'three requests for one IR decode it once');
  assert.equal(b1, b2); assert.equal(b2, b3);
  assert.equal(contextBuffer(ctx, 'ast_a'), b1, 'synchronous view sees the ready buffer');
  assert.equal(contextBuffer(ctx, 'ast_missing'), null);
  assert.equal(await loadContextBuffer(ctx, '', decode), null, 'empty id is a no-op without decoding');
  assert.equal(decodes, 1);

  // A failed decode is evicted, so the next call can retry instead of caching the error.
  let fails = 0;
  const badDecode = async () => { fails++; throw new Error('corrupt file'); };
  await assert.rejects(loadContextBuffer(ctx, 'ast_bad', badDecode), /corrupt/);
  await assert.rejects(loadContextBuffer(ctx, 'ast_bad', badDecode), /corrupt/);
  assert.equal(fails, 2, 'failure evicted the cache entry and allowed a retry');
  assert.equal(contextBuffer(ctx, 'ast_bad'), null);

  // Separate contexts have separate caches (released with the context).
  const ctx2 = new OfflineAudioContext(2, SR, SR);
  await loadContextBuffer(ctx2, 'ast_a', decode);
  assert.equal(decodes, 2, 'a new context decodes the IR independently');
});

// ── 2. Switching IR on a running graph swaps the convolver buffer ──────────
test('live graph: switching IR swaps the buffer to the new one and matches a fresh render; clearing returns to dry', async () => {
  const irA = makeIr('burst', 0.5), irB = makeIr('noise', 0.5);
  const renders = {};
  // Reference: a graph built fresh with each IR already in the cache.
  for (const [name, ir] of [['A', irA], ['B', irB]]) {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const decodes = { n: 0 };
    const loadIr = (id) => loadContextBuffer(ctx, id, async () => { decodes.n++; return id === 'ast_irA' ? irA : irB; });
    renders[name] = (await renderConv({ ctx, loadIr, params: { ir: name === 'A' ? 'ast_irA' : 'ast_irB', mix: 1 } }))[0];
    assert.equal(decodes.n, 1);
  }
  assert.ok(maxDiff(renders.A, renders.B) > 0.05, 'the two IRs audibly differ');

  // Live graph: built with IR A, then switched to IR B via update() while "playing".
  const ctx = new OfflineAudioContext(2, SR, SR);
  let decodeCalls = 0;
  const loadIr = (id) => loadContextBuffer(ctx, id, async () => { decodeCalls++; return id === 'ast_irA' ? irA : irB; });
  const fx = buildStudioEffect(ctx, { id: 'fx1', type: 'convolution', params: { ir: 'ast_irA', mix: 1 } }, P,
    { from: 0, when: 0, irBuffers: contextBufferView(ctx), loadIr });
  const conv = fx.nodes.find((n) => n.constructor.name === 'ConvolverNode');
  assert.ok(conv, 'convolver node exists');
  // Before the IR is decoded the node holds the silent IR (dry), never an error.
  assert.equal(conv.buffer, silentIrBuffer(ctx));
  await loadIr('ast_irA');
  fx.update({ ir: 'ast_irA', mix: 1 });
  assert.equal(conv.buffer, irA, 'first IR buffer attached');
  assert.equal(decodeCalls, 1);

  // Switch to B: while B decodes the node goes dry (silent IR), the old room is no longer referenced.
  const switched = loadIr('ast_irB');
  fx.update({ ir: 'ast_irB', mix: 1 });
  assert.equal(conv.buffer, silentIrBuffer(ctx), 'mid-decode the node is dry rather than still using the old room');
  await switched;
  fx.update({ ir: 'ast_irB', mix: 1 }); // update again once ready (idempotent; same irId)
  assert.equal(conv.buffer, irB, 'new IR buffer attached; old buffer no longer referenced');
  assert.notEqual(conv.buffer, irA);
  assert.equal(decodeCalls, 2, 'each distinct IR decoded once');

  // A full render through the switched graph equals a graph built directly with IR B.
  const ctxLive = new OfflineAudioContext(2, SR, SR);
  const liveLoad = (id) => loadContextBuffer(ctxLive, id, async () => (id === 'ast_irA' ? irA : irB));
  const liveFx = buildStudioEffect(ctxLive, { id: 'fx1', type: 'convolution', params: { ir: 'ast_irA', mix: 1 } }, P,
    { from: 0, when: 0, irBuffers: contextBufferView(ctxLive), loadIr: liveLoad });
  await liveLoad('ast_irA'); liveFx.update({ ir: 'ast_irA', mix: 1 });
  await liveLoad('ast_irB'); liveFx.update({ ir: 'ast_irB', mix: 1 }); // switch before render
  const n = SR;
  const src = ctxLive.createBufferSource();
  const sb = ctxLive.createBuffer(1, n, SR);
  for (let i = 0; i < n; i++) sb.getChannelData(0)[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SR);
  src.buffer = sb; src.connect(liveFx.input); liveFx.output.connect(ctxLive.destination); src.start(0);
  const switchedOut = new Float32Array((await ctxLive.startRendering()).getChannelData(0));
  assert.ok(maxDiff(switchedOut, renders.B) < 1e-6, `switched graph matches a fresh render with the new IR (diff ${maxDiff(switchedOut, renders.B)})`);

  // Clearing the IR (empty string and missing id alike) returns to dry, no throw.
  fx.update({ ir: '', mix: 1 });
  assert.equal(conv.buffer, silentIrBuffer(ctx), 'cleared IR swaps in the silent IR');
  fx.update({ ir: 'ast_never_loaded', mix: 1 });
  assert.equal(conv.buffer, silentIrBuffer(ctx), 'unknown IR stays dry without throwing');
  fx.update({ ir: '', mix: 1 });
});

test('stale async IR loads cannot resurrect an older IR after another switch', async () => {
  const irA = makeIr('burst', 0.3), irB = makeIr('noise', 0.3);
  const ctx = new OfflineAudioContext(2, SR, SR);
  let resolveA;
  const loadIr = (id) => loadContextBuffer(ctx, id, () => (id === 'ast_irA'
    ? new Promise((res) => { resolveA = () => res(irA); })
    : Promise.resolve(irB)));
  const fx = buildStudioEffect(ctx, { id: 'fx1', type: 'convolution', params: { ir: 'ast_irA', mix: 1 } }, P,
    { from: 0, when: 0, irBuffers: contextBufferView(ctx), loadIr });
  const conv = fx.nodes.find((n) => n.constructor.name === 'ConvolverNode');
  const pA = loadIr('ast_irA'); fx.update({ ir: 'ast_irA', mix: 1 });
  fx.update({ ir: 'ast_irB', mix: 1 }); // switch before A finished
  await loadIr('ast_irB');
  resolveA(); await pA;
  assert.equal(conv.buffer, irB, 'the late-arriving first IR does not replace the current one');
});

// ── 3. Export path: preloaded IRs, missing vs. failed, decode once ──────────
const baseProject = (effects) => ({
  sampleRate: SR, channels: 2,
  master: { gain: 0, effects: [], automation: {} },
  markers: [],
  tracks: [{ id: 't1', name: 't1', kind: 'audio', gain: 0, pan: 0, mute: false, solo: false, sends: [], automation: {}, effects,
    clips: [{ id: 'c1', assetId: 'ast_tone', start: 0, offset: 0, duration: 1, gain: 0 }] }],
});

test('export: render uses the selected IR; switching IR changes the output', async () => {
  const dir = newDir();
  await writeToneWav(path.join(dir, 'ast_tone.wav'), 1);
  await writeBufferWav(path.join(dir, 'ast_ir1.wav'), makeIr('burst', 0.8));
  await writeBufferWav(path.join(dir, 'ast_ir2.wav'), makeIr('noise', 0.8));
  const files = (id) => path.join(dir, `${id}.wav`);

  const dry = await renderMix(baseProject([]), files, { start: 0, end: 1, threads: 1 });
  const withA = await renderMix(baseProject([{ id: 'e1', type: 'convolution', enabled: true, params: { ir: 'ast_ir1', mix: 1 } }]), files, { start: 0, end: 1, threads: 1 });
  const withB = await renderMix(baseProject([{ id: 'e1', type: 'convolution', enabled: true, params: { ir: 'ast_ir2', mix: 1 } }]), files, { start: 0, end: 1, threads: 1 });
  assert.ok(maxDiff(withA.channels[0], dry.channels[0]) > 0.02, 'IR A colours the render');
  assert.ok(maxDiff(withB.channels[0], withA.channels[0]) > 0.02, 'IR B differs from IR A on export');
});

test('export: missing IR (no file) renders dry without crashing and stays distinguishable from a decode failure', async () => {
  const dir = newDir();
  await writeToneWav(path.join(dir, 'ast_tone.wav'), 1);
  const files = (id) => path.join(dir, `${id}.wav`);
  const proj = baseProject([{ id: 'e1', type: 'convolution', enabled: true, params: { ir: 'ast_gone', mix: 1 } }]);
  const dry = await renderMix(baseProject([]), files, { start: 0, end: 1, threads: 1 });
  const missing = await renderMix(proj, files, { start: 0, end: 1, threads: 1 }); // no ast_gone.wav on disk
  assert.ok(maxDiff(missing.channels[0], dry.channels[0]) < 1e-6, 'missing IR is bit-identical to the dry render');
  assert.ok(rms(missing.channels[0]) > 0.01, 'the dry signal is clearly audible, not silence');

  // Now a present-but-undecodable IR: must reject with the tagged error, not go silent.
  fs.writeFileSync(path.join(dir, 'ast_broken.wav'), Buffer.from('RIFFxxxxWAVEthis-is-not-a-real-wav-file'));
  const broken = baseProject([{ id: 'e1', type: 'convolution', enabled: true, params: { ir: 'ast_broken', mix: 1 } }]);
  await assert.rejects(renderMix(broken, files, { start: 0, end: 1, threads: 1 }), (err) => {
    assert.equal(err.code, 'ir_decode_failed');
    assert.equal(err.status, 422);
    assert.equal(err.irId, 'ast_broken');
    assert.match(err.message, /ast_broken/);
    return true;
  });
});

test('export: an IR shared by two tracks (and a rebuild) is decoded once per render context', async () => {
  const dir = newDir();
  await writeToneWav(path.join(dir, 'ast_tone.wav'), 1);
  await writeBufferWav(path.join(dir, 'ast_shared.wav'), makeIr('noise', 0.6));
  const files = (id) => path.join(dir, `${id}.wav`);
  const conv = { id: 'e1', type: 'convolution', enabled: true, params: { ir: 'ast_shared', mix: 0.8 } };
  const proj = {
    sampleRate: SR, channels: 2, master: { gain: 0, effects: [], automation: {} }, markers: [],
    tracks: [
      { id: 't1', name: 't1', kind: 'audio', gain: 0, pan: 0, mute: false, solo: false, sends: [], automation: {}, effects: [conv], clips: [{ id: 'c1', assetId: 'ast_tone', start: 0, offset: 0, duration: 1, gain: 0 }] },
      { id: 't2', name: 't2', kind: 'audio', gain: 0, pan: 0, mute: false, solo: false, sends: [], automation: {}, effects: [{ ...conv, id: 'e2' }], clips: [{ id: 'c2', assetId: 'ast_tone', start: 0, offset: 0, duration: 1, gain: 0 }] },
    ],
  };
  // Count IR file reads through a proxy around the files map.
  let reads = 0;
  const countingFiles = new Proxy({ ast_tone: files('ast_tone'), ast_shared: files('ast_shared') }, {
    get(t, k) { if (k === 'ast_shared') reads++; return t[k]; },
  });
  const ch1 = await renderSegment(proj, countingFiles, { from: 0, to: 1, contentEnd: 1 });
  assert.equal(reads, 1, `one IR file read for two tracks, got ${reads}`);
  assert.ok(rms(ch1[0]) > 0.01);
  // A second render on a fresh context decodes again (its own cache), proving caching is per-context.
  const ch2 = await renderSegment(proj, countingFiles, { from: 0, to: 1, contentEnd: 1 });
  assert.equal(reads, 2, 'new render context owns a fresh cache');
  assert.ok(maxDiff(ch1[0], ch2[0]) < 1e-6, 'renders are deterministic');
});

test('export: empty ir parameter is the dry pass (clearing the IR)', async () => {
  const dir = newDir();
  await writeToneWav(path.join(dir, 'ast_tone.wav'), 1);
  const files = (id) => path.join(dir, `${id}.wav`);
  const cleared = baseProject([{ id: 'e1', type: 'convolution', enabled: true, params: { ir: '', mix: 1 } }]);
  const dry = await renderMix(baseProject([]), files, { start: 0, end: 1, threads: 1 });
  const out = await renderMix(cleared, files, { start: 0, end: 1, threads: 1 });
  assert.ok(maxDiff(out.channels[0], dry.channels[0]) < 1e-6);
});

// ── 4. Semantics preserved: dry bypass, mix/predelay/gain, 5.1 bus ─────────
test('dry bypass and mix/predelay/gain semantics are unchanged', async () => {
  const ir = makeIr('noise', 0.5);
  const run = async (params) => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const loadIr = (id) => loadContextBuffer(ctx, id, async () => ir);
    return (await renderConv({ ctx, loadIr, params }))[0];
  };
  const dry = await run({ ir: 'ast_x', mix: 0 });
  const expected = new Float32Array(SR);
  for (let i = 0; i < SR; i++) expected[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / SR);
  assert.ok(maxDiff(dry, expected) < 1e-6, 'mix 0 is the untouched dry signal');
  const wet = await run({ ir: 'ast_x', mix: 1 });
  assert.ok(maxDiff(wet, expected) > 0.01, 'mix 1 adds the reverb tail');
  const half = await run({ ir: 'ast_x', mix: 0.5 });
  assert.ok(maxDiff(half, wet) > 1e-4 && maxDiff(half, dry) > 1e-4, 'mix 0.5 sits between dry and wet');
  // gain scales only the wet branch: isolate the reverb component (full render minus
  // the identical dry path) at 0 dB and −12 dB; the level must drop by ~12 dB.
  const quiet = await run({ ir: 'ast_x', mix: 1, gain: -12 });
  const wetComp = wet.map((v, i) => v - dry[i]);
  const quietComp = quiet.map((v, i) => v - dry[i]);
  const gainDb = 20 * Math.log10(rms(quietComp) / rms(wetComp));
  assert.ok(Math.abs(gainDb + 12) < 0.5, `wet branch follows gain: measured ${gainDb.toFixed(1)} dB, expected −12 dB`);
  // predelay delays only the reverb: the wet component's onset moves with predelay.
  const onset = (x) => { for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 1e-5) return i / SR; return null; };
  const pd0 = await run({ ir: 'ast_x', mix: 1, predelay: 0 });
  const pd50 = await run({ ir: 'ast_x', mix: 1, predelay: 50 });
  const wet0 = pd0.map((v, i) => v - dry[i]), wet50 = pd50.map((v, i) => v - dry[i]);
  assert.ok(onset(wet50) - onset(wet0) > 0.04, `predelay pushes the reverb onset back (${onset(wet0)} → ${onset(wet50)})`);
  // No IR selected: dry, no error.
  const none = await run({ ir: '' });
  assert.ok(maxDiff(none, expected) < 1e-6, 'empty IR is the dry signal');
});

test('5.1 bus: convolution keeps all six channels with the centre intact', async () => {
  const n = S(0.25);
  const ctx = new OfflineAudioContext(6, n, SR);
  await loadWorklets(ctx, WORKLET_PATH);
  const ir = makeIr('noise', 0.25);
  const loadIr = (id) => loadContextBuffer(ctx, id, async () => ir);
  const fx = buildStudioEffect(ctx, { id: 'fx1', type: 'convolution', params: { ir: 'ast_ir', mix: 0.5 } }, P,
    { from: 0, when: 0, channels: 6, irBuffers: contextBufferView(ctx), loadIr });
  await loadIr('ast_ir'); fx.update({ ir: 'ast_ir', mix: 0.5 });
  const buf = ctx.createBuffer(6, n, SR);
  for (let ch = 0; ch < 6; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = 0.4 * Math.sin(2 * Math.PI * (220 + ch * 30) * i / SR); }
  const src = ctx.createBufferSource(); src.buffer = buf;
  src.connect(fx.input); fx.output.connect(ctx.destination); src.start(0);
  const out = await ctx.startRendering();
  assert.equal(out.numberOfChannels, 6);
  const C = new Float32Array(out.getChannelData(2));
  for (const v of C) assert.ok(Number.isFinite(v));
  assert.ok(rms(C, S(0.1)) > 0.01, 'centre channel survives the convolution on a 5.1 bus');
});

test('buildProjectGraph: convolution wired through the full graph with an IR and without one', async () => {
  const n = S(0.5);
  const ir = makeIr('noise', 0.4);
  const project = (irId) => ({
    sampleRate: SR, channels: 2, master: { gain: 0, effects: [], automation: {} },
    tracks: [{ id: 't', kind: 'audio', gain: 0, pan: 0, sends: [], automation: {},
      effects: [{ id: 'e', type: 'convolution', enabled: true, params: { ir: irId, mix: 1 } }],
      clips: [{ id: 'c', assetId: 'ast_src', start: 0, duration: 0.5, offset: 0, gain: 0 }] }],
  });
  const src = new OfflineAudioContext(1, n, SR).createBuffer(1, n, SR);
  for (let i = 0; i < n; i++) src.getChannelData(0)[i] = 0.5 * Math.sin(2 * Math.PI * 330 * i / SR);
  const draw = async (irId) => {
    const ctx = new OfflineAudioContext(2, n, SR);
    await loadWorklets(ctx, WORKLET_PATH);
    const loadIr = (id) => loadContextBuffer(ctx, id, async () => ir);
    buildProjectGraph(ctx, project(irId), new Map([['ast_src', src]]), { from: 0, when: 0, irBuffers: contextBufferView(ctx), loadIr });
    if (irId) await loadIr(irId);
    return new Float32Array((await ctx.startRendering()).getChannelData(0));
  };
  const wet = await draw('ast_ir'), dry = await draw('');
  assert.ok(peak(wet) > 0.01 && Number.isFinite(peak(wet)));
  assert.ok(peak(dry) > 0.01, 'no-IR graph still passes the dry signal');
});

// ── 5. Ops validation: clearing the IR is an accepted edit, bad ids are not ─
test('effect.add/update: empty ir clears (no error), malformed ids are rejected', () => {
  const project = { sampleRate: SR, channels: 2, master: { gain: 0, effects: [], automation: {} }, markers: [], assets: [], tracks: [] };
  const add = (args) => OPS['effect.add'].apply(project, args);
  const fx = add({ type: 'convolution', params: { ir: 'ast_ab12', mix: 0.5 } });
  const id = fx.effectId;
  assert.equal(project.master.effects[0].params.ir, 'ast_ab12');
  // Clearing via an empty string is a valid edit and leaves the IR unset (dry).
  OPS['effect.update'].apply(project, { effectId: id, params: { ir: '' } });
  assert.equal(project.master.effects[0].params.ir, '');
  // A non-asset value is still rejected.
  assert.throws(() => add({ type: 'convolution', params: { ir: '../etc/passwd' } }), ValidationError);
  assert.throws(() => OPS['effect.update'].apply(project, { effectId: id, params: { ir: 'nope' } }), ValidationError);
});
