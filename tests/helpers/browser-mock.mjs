// Minimal browser-API surface js/engine.js touches, enough to drive the stretch pipeline in Node
// with self-made Float32 samples. No DOM, no real audio: every node is a stub that records its
// connections, the AudioContext keeps a fake clock, and the stretch "worker" is a scripted mock so
// tests can hold a reply back, fail it, or let it resolve on demand.
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';

// The engine (and loudness.js) each open a MessageChannel kept for the module's whole life. In a
// browser page that is right; across many fresh module imports in one test process the ports would
// keep the event loop alive and the suite would never exit. Node re-refs a MessagePort when an
// `onmessage` handler is assigned, so each port is unref'd now and again on every microtask drain
// the harness performs (see keepPortsUnrefd). Native message delivery is untouched; the ports
// simply never hold the loop open long enough to block process exit.
const unrefdPorts = new Set();
function unrefdPort(port) {
  port.unref?.();
  unrefdPorts.add(port);
  return port;
}
// Re-applies unref after the engine has wired handlers or pushed messages. Tests call this via the
// tick/settle helpers, which already yield to the event loop between assertions.
export const keepPortsUnrefd = () => { for (const p of unrefdPorts) p.unref?.(); };
function TestMessageChannel() {
  const relay = new NodeMessageChannel();
  unrefdPort(relay.port1);
  unrefdPort(relay.port2);
  return relay;
}

export function makeFakeClock() {
  let now = 0;
  const timers = new Map();
  let nextTimer = 1;
  return {
    get currentTime() { return now; },
    advance(sec) { now += sec; },
    setInterval(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms, kind: 'interval' }); return id; },
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, { fn, ms, kind: 'timeout' }); return id; },
    clearInterval(id) { timers.delete(id); },
    clearTimeout(id) { timers.delete(id); },
    // Runs timers whose delay has elapsed under the fake clock. Tests mostly rely on microtask
    // flushing; this covers the engine's setTimeout(trimCaches)/keepLater housekeeping when needed.
    async runTimers(ms = 1) {
      const end = now + ms;
      while (now <= end && timers.size) {
        const due = [...timers.entries()].filter(([, t]) => t.ms <= ms);
        now += 1;
        for (const [id, t] of due) {
          if (!timers.has(id)) continue;
          t.fn();
          if (t.kind === 'timeout') timers.delete(id);
        }
        await Promise.resolve();
      }
    },
  };
}

class FakeParam {
  constructor(value) { this.value = value; this._events = []; }
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
}
class FakeNode {
  constructor(ctx) { this.ctx = ctx; this._connections = []; }
  connect(n) { this._connections.push(n); if (n && n._incoming) n._incoming.push(this); return n; }
  disconnect() { this._connections.length = 0; }
  start() {} stop() {}
  addEventListener() {}
}
class FakeGain extends FakeNode { constructor(ctx) { super(ctx); this.gain = new FakeParam(1); } }
class FakeFilter extends FakeNode {
  constructor(ctx) { super(ctx); this.frequency = new FakeParam(1000); this.detune = new FakeParam(0); this.Q = new FakeParam(1); this.type = ''; }
}
class FakeAnalyser extends FakeNode {
  constructor(ctx) { super(ctx); this.fftSize = 2048; this.smoothingTimeConstant = 0.8; }
  getFloatTimeDomainData(a) { a.fill(0); }
  getByteFrequencyData(a) { a.fill(0); }
}
class FakeSource extends FakeNode {
  constructor(ctx) { super(ctx); this.playbackRate = new FakeParam(1); this.loop = false; this.loopStart = 0; this.loopEnd = 0; this.buffer = null; this.onended = null; }
  start() { this.ctx._sources.add(this); }
  stop() { this.ctx._sources.delete(this); if (this.onended) this.onended(); }
}
class FakeOscillator extends FakeNode {
  constructor(ctx) { super(ctx); this.frequency = new FakeParam(440); this.onended = null; }
  start() {} stop() { if (this.onended) this.onended(); }
  setPeriodicWave() {}
  connect(n) { super.connect(n); return n; }
}
class FakeDelay extends FakeNode { constructor(ctx) { super(ctx); this.delayTime = new FakeParam(0); } }
class FakeCompressor extends FakeNode {
  constructor(ctx) { super(ctx); this.threshold = new FakeParam(0); this.knee = new FakeParam(0); this.ratio = new FakeParam(1); this.attack = new FakeParam(0); this.release = new FakeParam(0); }
}
class FakeConstantSource extends FakeNode { constructor(ctx) { super(ctx); this.offset = new FakeParam(0); } start() {} }
class FakeWorklet extends FakeNode { constructor(ctx) { super(ctx); this._incoming = []; } }
class FakeMediaDest { constructor() { this.stream = { getTracks: () => [] }; } }

export class FakeAudioContext {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 44100;
    this.state = 'running';
    this.baseLatency = 0.005;
    this.outputLatency = 0;
    this.destination = new FakeNode(this);
    this._sources = new Set();
    this.onstatechange = null;
  }
  get currentTime() { return clock.currentTime; }
  createGain() { return new FakeGain(this); }
  createBiquadFilter() { return new FakeFilter(this); }
  createAnalyser() { return new FakeAnalyser(this); }
  createBufferSource() { return new FakeSource(this); }
  createOscillator() { return new FakeOscillator(this); }
  createDelay(max = 1) { return new FakeDelay(this); }
  createDynamicsCompressor() { return new FakeCompressor(this); }
  createConstantSource() { return new FakeConstantSource(this); }
  createPeriodicWave() { return {}; }
  createMediaStreamDestination() { return new FakeMediaDest(); }
  createBuffer(channels, length, rate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels, length, sampleRate: rate, duration: length / rate,
      getChannelData(c) { return data[c]; },
    };
  }
  // Decodes the "bytes" our fake fetch resolves with: a marker object carrying the loop's sample
  // count, so no codec is involved. Returns a buffer of sine/silence Float32 data. Supports both
  // the promise form and the legacy (success, error) callback form the engine relies on.
  async decodeAudioData(bytes, success, error) {
    const make = () => {
      const frames = bytes?.frames ?? 22050;
      const rate = bytes?.rate || 44100;
      const buf = this.createBuffer(2, frames, rate);
      const tone = bytes?.tone ?? 220;
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < frames; i++) d[i] = bytes?.silent ? 0 : 0.2 * Math.sin((2 * Math.PI * tone * i) / rate);
      }
      return buf;
    };
    if (typeof success === 'function') {
      try { success(make()); } catch (err) { if (typeof error === 'function') error(err); }
      return undefined;
    }
    return make();
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  get audioWorklet() { return { addModule: () => Promise.resolve() }; }
}
export class FakeOfflineContext extends FakeAudioContext {
  async startRendering() { return this.createBuffer(2, this._renderLen || 1024, this.sampleRate); }
}

// Shared fake clock the context reads.
export const clock = makeFakeClock();

// ---------- scripted stretch worker ----------
// The engine constructs `new Worker(url)`; each instance gets one job at a time (mirroring the
// pool). The harness decides when replies fire and whether a job fails, so tests can produce the
// late/stale/error replies the cancelable chain is meant to survive.
export class FakeWorker {
  constructor(url) { this.url = url; this.job = null; this.onmessage = null; this.onerror = null; FakeWorker.instances.push(this); }
  postMessage(msg) {
    this.job = msg;
    // Auto mode answers on the next microtask, mirroring a real worker's asynchronous reply. A
    // resolve()/fail() in held mode can have cleared the job first; guard against that.
    if (FakeWorker.auto) queueMicrotask(() => { if (this.job === msg) this.resolve(); });
  }
  terminate() { this.job = null; const i = FakeWorker.instances.indexOf(this); if (i >= 0) FakeWorker.instances.splice(i, 1); }
  // Test helpers:
  resolve(over = {}) {
    const msg = this.job; if (!msg) throw new Error('no job to resolve');
    this.job = null;
    const channels = [new Float32Array(msg.targetLen), new Float32Array(msg.targetLen)];
    this.onmessage({ data: { id: msg.id, targetLen: msg.targetLen, pitchRatio: msg.pitchRatio, quality: 'fast', formant: false, channels, ...over } });
  }
  fail(error = 'boom') {
    const msg = this.job; if (!msg) throw new Error('no job to fail');
    this.job = null;
    this.onmessage({ data: { id: msg.id, error, targetLen: msg.targetLen, pitchRatio: msg.pitchRatio } });
  }
  // Resolve with an id/echo that imitates a different, older request (the engine must ignore it).
  resolveAs(otherId, over = {}) {
    const msg = this.job; if (!msg) throw new Error('no job');
    this.job = null;
    const channels = [new Float32Array(msg.targetLen), new Float32Array(msg.targetLen)];
    this.onmessage({ data: { id: otherId, targetLen: msg.targetLen + 7, pitchRatio: 2.5, quality: 'fast', formant: false, channels, ...over } });
  }
}
FakeWorker.instances = [];
// auto (the default): every posted job is answered asynchronously with a silent render. false
// (held): tests hold replies and drive resolve()/fail() themselves.
FakeWorker.auto = true;
FakeWorker.reset = ({ auto = true } = {}) => {
  FakeWorker.instances.length = 0; FakeWorker.auto = auto;
};
// Native timers, captured at module load before installGlobals overrides the globals. Test waits
// use these so they still resolve normally while engine timers are unref'd.
const nativeSetTimeout0 = globalThis.setTimeout.bind(globalThis);
FakeWorker.flush = () => new Promise((r) => nativeSetTimeout0(r, 0));
// The pool posts a job only after the original is downloaded and decoded (a few microtask turns),
// so tests wait for a predicate rather than assuming a job exists on the next line.
export const until = async (pred, { timeoutMs = 2000, label = 'condition' } = {}) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => nativeSetTimeout0(r, 2));
  }
};
// Waits until a worker is running a job, then returns that worker.
export const waitForJob = () => until(() => FakeWorker.instances.some((w) => w.job), { label: 'a running worker job' })
  .then(() => FakeWorker.instances.find((w) => w.job));

// ---------- globals the engine reads at import or call time ----------
// Native timers (also captured as nativeSetTimeout0 near the FakeWorker for test waits).
const nativeSetTimeout = nativeSetTimeout0;
const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
// The engine keeps long-lived intervals (the clock watcher, the source-health check) and chains of
// deferred timeouts (cache trims, keep-mix, landings). In a page these are wanted; in a test they
// would hold the event loop open after every assertion has run. Schedule normally, but unref each
// handle so test work still fires on time while nothing blocks process exit.
function unrefdTimer(handle) { handle?.unref?.(); return handle; }

export function installGlobals() {
  const g = globalThis;
  g.window = g;
  g.Worker = FakeWorker;
  g.AudioContext = FakeAudioContext;
  g.OfflineAudioContext = FakeOfflineContext;
  g.MessageChannel = TestMessageChannel;
  if (!g.__TIMERS_UNREFD) {
    g.__TIMERS_UNREFD = true;
    g.setTimeout = (fn, ms, ...args) => unrefdTimer(nativeSetTimeout(fn, ms, ...args));
    g.setInterval = (fn, ms, ...args) => unrefdTimer(nativeSetInterval(fn, ms, ...args));
    g.clearTimeout = nativeClearTimeout;
    g.clearInterval = nativeClearInterval;
  }
  // Node 18+ already exposes a read-only global navigator; define each property explicitly so
  // read-only getters don't throw, while keeping a plain object where none exists.
  const nav = g.navigator || {};
  const navProps = {
    maxTouchPoints: 0, hardwareConcurrency: 8, deviceMemory: 8, vendor: '', userAgent: 'node-test',
    userAgentData: { mobile: false },
  };
  for (const [k, v] of Object.entries(navProps)) {
    try { nav[k] = v; } catch { Object.defineProperty(nav, k, { value: v, configurable: true, writable: true }); }
  }
  if (!g.navigator) {
    Object.defineProperty(g, 'navigator', { value: nav, configurable: true, writable: true });
  }
  g.matchMedia = g.matchMedia || (() => ({ matches: false, addEventListener() {}, addListener() {} }));
  g.Audio = class { canPlayType() { return 'maybe'; } };
  g.MediaRecorder = undefined;
  g.indexedDB = undefined; // keepMix/keptRender simply skip storage
  g.AudioWorkletNode = FakeWorklet;
  g.performance = g.performance || { now: () => Number(process.hrtime.bigint() / 1000n) / 1e6 };
  g.addEventListener = () => {};
  g.document = g.document || { addEventListener() {}, fonts: { ready: Promise.resolve() }, featurePolicy: { allowsFeature: () => true } };
  g.location = g.location || { hash: '', pathname: '/', search: '' };
  g.history = g.history || { replaceState() {} };
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  // fetch: our "files" are markers, not real bytes; the fake decoder reads their frame count.
  g.fetch = async (url) => ({
    ok: true, status: 200, headers: { get: () => null },
    async arrayBuffer() { return FakeFetch.files.get(cleanUrl(url)) || { frames: 22050, rate: 44100 }; },
  });
  return g;
}
const cleanUrl = (u) => String(u).split('?')[0];

// A registry of fake "stem files": url -> { frames, rate, tone, silent }.
export const FakeFetch = {
  files: new Map(),
  set(url, marker) { this.files.set(cleanUrl(url), marker); },
};

export const flushMicrotasks = () => new Promise((r) => queueMicrotask(() => { keepPortsUnrefd(); queueMicrotask(r); }));
// Uses the native timer explicitly: the global override unrefs engine timers, but a test's own wait
// must still resolve through the normal event loop.
export const tick = (ms = 0) => new Promise((r) => nativeSetTimeout0(() => { keepPortsUnrefd(); r(); }, ms));
