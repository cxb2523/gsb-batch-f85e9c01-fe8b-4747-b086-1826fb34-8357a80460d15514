/** Shared fake WebAudio plumbing for the audio tests. Not a test file itself, so the runner
 * (`tsx --test tests/*.test.ts`) never picks it up. */

export function fakeParam() {
  const param = {
    value: 0, calls: 0,
    setValueAtTime() { param.calls++; return param; }, linearRampToValueAtTime() { param.calls++; return param; },
    exponentialRampToValueAtTime() { param.calls++; return param; }, setTargetAtTime() { param.calls++; return param; },
    cancelScheduledValues() { return param; },
  };
  return param;
}

/** A permissive stand-in for the WebAudio graph: enough to run every code path in node.
 * `close()` flips the context to `closed`, like the real thing, so lifecycle tests can prove a
 * rebuilt context is really a new one. */
export function fakeContext(options: { sampleRate?: number } = {}) {
  const created: { kind: string; node: Record<string, unknown> }[] = [];
  const rate = options.sampleRate ?? 8000;
  let disconnects = 0;
  const makeNode = (kind: string) => {
    const store: Record<string, unknown> = { kind };
    const node: Record<string, unknown> = new Proxy(store, {
      get(target, property: string) {
        if (property === 'connect') return (destination: unknown) => destination;
        if (property === 'disconnect') return () => { disconnects++; };
        if (property === 'start' || property === 'stop') return () => {};
        if (property === 'then') return undefined;
        if (!(property in target)) target[property] = fakeParam();
        return target[property];
      },
      set(target, property: string, value) { target[property] = value; return true; },
    });
    created.push({ kind, node });
    return node;
  };
  const ctx: Record<string, unknown> = {
    state: 'running', currentTime: 0, sampleRate: rate, destination: makeNode('destination'),
    createGain: () => makeNode('gain'), createOscillator: () => makeNode('osc'), createBiquadFilter: () => makeNode('biquad'),
    createDynamicsCompressor: () => makeNode('compressor'), createDelay: () => makeNode('delay'), createConvolver: () => makeNode('convolver'),
    createBufferSource: () => makeNode('source'), createStereoPanner: () => makeNode('panner'),
    createBuffer: (channels: number, length: number, bufferRate: number) => ({
      duration: length / bufferRate, sampleRate: bufferRate, length, numberOfChannels: channels,
      getChannelData: () => new Float32Array(length),
    }),
    resume: () => Promise.resolve(), suspend: () => Promise.resolve(),
    close: () => { ctx.state = 'closed'; return Promise.resolve(); },
  };
  return {
    ctx: ctx as unknown as AudioContext,
    raw: ctx,
    count: (kind: string) => created.filter(entry => entry.kind === kind).length,
    endAll: () => { for (const { node } of created) if (typeof node.onended === 'function') (node.onended as () => void)(); },
    disconnects: () => disconnects,
  };
}
