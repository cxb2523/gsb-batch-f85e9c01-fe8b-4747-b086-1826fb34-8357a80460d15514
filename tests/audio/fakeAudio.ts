/**
 * Minimal fake Web Audio implementation for unit tests.
 *
 * `AudioGraph.tryCreate` only needs `window` and a global `AudioContext` to exist,
 * so installing this on `globalThis` lets the real `AudioSystem` (graph, voices,
 * recipes, pitch tracking) run headless. Every AudioParam records the values it was
 * asked to ramp to, which is what the engine/pitch assertions read.
 */

export class FakeParam {
  value = 0;
  readonly targets: number[] = [];
  readonly events: { type: 'target' | 'value' | 'linear' | 'exp' | 'curve'; value: number; at?: number }[] = [];

  setTargetAtTime(value: number, at: number): FakeParam {
    this.targets.push(value);
    this.events.push({ type: 'target', value, at });
    this.value = value;
    return this;
  }
  setValueAtTime(value: number, at: number): FakeParam {
    this.events.push({ type: 'value', value, at });
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number, at: number): FakeParam {
    this.events.push({ type: 'linear', value, at });
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number, at: number): FakeParam {
    this.events.push({ type: 'exp', value, at });
    this.value = value;
    return this;
  }
  setValueCurveAtTime(): void {}

  /** Latest ramp target (what the node is heading to). */
  get last(): number {
    return this.targets.length ? this.targets[this.targets.length - 1] : this.value;
  }
}

class FakeNode {
  readonly connected: FakeNode[] = [];
  connect(dest: FakeNode): FakeNode {
    this.connected.push(dest);
    return dest;
  }
  disconnect(): void {
    this.connected.length = 0;
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeOsc extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam();
  readonly detune = new FakeParam();
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeBufferSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new FakeParam();
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeFilter extends FakeNode {
  type = 'lowpass';
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  readonly gain = new FakeParam();
}

class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
}

class FakeDelay extends FakeNode {
  readonly delayTime = new FakeParam();
}

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
}

class FakeConvolver extends FakeNode {
  buffer: unknown = null;
}

class FakePanner extends FakeNode {
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
}

class FakeBuffer {
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {}
  getChannelData(): Float32Array {
    return new Float32Array(this.length);
  }
}

class FakeListener {
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
  readonly forwardX = new FakeParam();
  readonly forwardY = new FakeParam();
  readonly forwardZ = new FakeParam();
  readonly upX = new FakeParam();
  readonly upY = new FakeParam();
  readonly upZ = new FakeParam();
  setPosition(): void {}
  setOrientation(): void {}
}

/** Records everything created so tests can inspect oscillator/filter targets. */
export class FakeAudioContext {
  /** Every context constructed since the last `reset()`, oldest first. */
  static instances: FakeAudioContext[] = [];

  currentTime = 0;
  readonly sampleRate = 48000;
  state: AudioContextState = 'running';
  readonly destination = new FakeNode();
  readonly listener = new FakeListener();
  readonly created = {
    gains: [] as FakeGain[],
    oscillators: [] as FakeOsc[],
    bufferSources: [] as FakeBufferSource[],
    filters: [] as FakeFilter[],
    shapers: [] as FakeShaper[],
    delays: [] as FakeDelay[],
    panners: [] as FakePanner[],
    compressors: [] as FakeCompressor[],
    convolvers: [] as FakeConvolver[],
  };

  constructor(_opts?: unknown) {
    FakeAudioContext.instances.push(this);
  }

  createGain(): FakeGain {
    const g = new FakeGain();
    this.created.gains.push(g);
    return g;
  }
  createOscillator(): FakeOsc {
    const o = new FakeOsc();
    this.created.oscillators.push(o);
    return o;
  }
  createBufferSource(): FakeBufferSource {
    const s = new FakeBufferSource();
    this.created.bufferSources.push(s);
    return s;
  }
  createBiquadFilter(): FakeFilter {
    const f = new FakeFilter();
    this.created.filters.push(f);
    return f;
  }
  createWaveShaper(): FakeShaper {
    const s = new FakeShaper();
    this.created.shapers.push(s);
    return s;
  }
  createDelay(): FakeDelay {
    const d = new FakeDelay();
    this.created.delays.push(d);
    return d;
  }
  createDynamicsCompressor(): FakeCompressor {
    const c = new FakeCompressor();
    this.created.compressors.push(c);
    return c;
  }
  createConvolver(): FakeConvolver {
    const c = new FakeConvolver();
    this.created.convolvers.push(c);
    return c;
  }
  createPanner(): FakePanner {
    const p = new FakePanner();
    this.created.panners.push(p);
    return p;
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
}

/** Installs `window` + `AudioContext` so `AudioGraph.tryCreate` succeeds. */
export function installFakeAudio(): void {
  const g = globalThis as Record<string, unknown>;
  g.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  g.AudioContext = FakeAudioContext;
  FakeAudioContext.instances = [];
}

/** Removes the globals again so other test files see the headless path. */
export function uninstallFakeAudio(): void {
  const g = globalThis as Record<string, unknown>;
  delete g.AudioContext;
  delete g.window;
  FakeAudioContext.instances = [];
}
