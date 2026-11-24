import { describe, expect, it, vi } from 'vitest';
import { MusicEngine } from '../../src/core/MusicEngine';
import type {
  GenerationContext,
  InstrumentPlugin,
  MusicalEvent,
  ParamValue,
  ParameterDefinition,
  StyleContext,
  StyleInstance,
  StylePlugin,
} from '../../src/core/types';
import { MockAudioContext } from '../helpers/MockAudioContext';

/**
 * End-to-end tests for the style/seed switch chain.
 *
 * Two deliberately simple, fully deterministic styles emit events on a fixed
 * time grid (no RNG involved) so a test can reason exactly about which events
 * exist on either side of a cutover. Everything is driven through the mock
 * audio clock + scheduler ticks — no wall-clock waits.
 */

interface GridOptions {
  step: number;
  boundaryEvery: number;
  prefix: string;
  instrument: string;
  defaults: Record<string, ParamValue>;
  parameterDefs: ParameterDefinition[];
}

class GridStyle implements StyleInstance {
  private readonly values: Record<string, ParamValue>;

  constructor(
    private readonly opts: GridOptions,
    public readonly seed: string,
    parameters: Record<string, ParamValue>,
  ) {
    this.values = { ...parameters };
  }

  start(_context: StyleContext): void {}
  stop(): void {}

  generateEvents({ from, to }: GenerationContext): MusicalEvent[] {
    const events: MusicalEvent[] = [];
    // Continue from the window start, snapped to the grid. The emitted grid is
    // a pure function of the timeline (no RNG) so tests can assert exact
    // coverage across a cutover.
    let t = Math.max(0, Math.ceil(from / this.opts.step) * this.opts.step);
    while (t < to - 1e-9) {
      events.push({
        id: `${this.opts.prefix}:${Math.round(t * 1000)}`,
        type: 'note',
        startTime: t,
        duration: this.opts.step * 0.8,
        instrument: this.opts.instrument,
        pitch: 60,
        velocity: 0.5,
        metadata: { sourcePlugin: this.opts.prefix },
      });
      t += this.opts.step;
    }
    return events;
  }

  setParameter(name: string, value: ParamValue): void {
    this.values[name] = value;
  }

  nextBoundary(currentPosition: number): number {
    const b = this.opts.boundaryEvery;
    return Math.ceil(currentPosition / b + 1e-9) * b;
  }
}

function gridPlugin(id: string, opts: GridOptions): StylePlugin {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'deterministic grid style for transition tests',
    timeMode: 'beat',
    tags: ['test'],
    color: '#000000',
    parameters: opts.parameterDefs,
    presets: [],
    create: ({ seed, parameters }) => new GridStyle(opts, String(seed), parameters),
  };
}

const STYLE_A_DEFS: ParameterDefinition[] = [
  { id: 'density', name: 'Density', type: 'range', min: 0, max: 1, step: 0.1, default: 1 },
  { id: 'color', name: 'Color', type: 'select', default: 'warm', options: [
    { value: 'warm', label: 'Warm' },
    { value: 'cool', label: 'Cool' },
  ] },
];
const STYLE_B_DEFS: ParameterDefinition[] = [
  { id: 'density', name: 'Density', type: 'range', min: 0, max: 1, step: 0.1, default: 0.25 },
  { id: 'width', name: 'Width', type: 'range', min: 0, max: 100, step: 1, default: 42 },
];

const pluginA = gridPlugin('grid-a', {
  step: 0.25,
  boundaryEvery: 1,
  prefix: 'a',
  instrument: 'pluck',
  defaults: { density: 1, color: 'warm' },
  parameterDefs: STYLE_A_DEFS,
});
const pluginB = gridPlugin('grid-b', {
  step: 0.25,
  boundaryEvery: 1,
  prefix: 'b',
  instrument: 'bell',
  defaults: { density: 0.25, width: 42 },
  parameterDefs: STYLE_B_DEFS,
});

/** Mock whose resume() the test can refuse, like iOS without a valid gesture. */
class FlakyResumeContext extends MockAudioContext {
  allowResume = true;
  async resume(): Promise<void> {
    if (this.allowResume) this.state = 'running';
  }
}

function recordingInstrument(id: string, log: { id: string; event: MusicalEvent; at: number }[]): InstrumentPlugin {
  return {
    id,
    name: id,
    create: () => ({
      trigger(event, at) {
        log.push({ id: event.id, event, at });
      },
      stopAll() {},
      setParameter() {},
    }),
  };
}

function makeEngine(mock: MockAudioContext, log: { id: string; event: MusicalEvent; at: number }[], seed = '100') {
  const engine = new MusicEngine({
    audioContextFactory: () => mock as unknown as AudioContext,
    style: 'grid-a',
    seed,
    lookAhead: 0.16,
    generationHorizon: 45,
  });
  engine.registerInstrument(recordingInstrument('pluck', log));
  engine.registerInstrument(recordingInstrument('bell', log));
  engine.registerStyle(pluginA);
  engine.registerStyle(pluginB);
  return engine;
}

/** Advance the mock audio clock in small steps, ticking like the real interval. */
function drive(engine: MusicEngine, mock: MockAudioContext, seconds: number, step = 0.05): void {
  const steps = Math.round(seconds / step);
  for (let i = 0; i < steps; i++) {
    mock.advance(step);
    (engine as any).scheduler.tick();
  }
}

/** Tick until the engine leaves the transitioning state (or give up). */
function driveUntilLanded(engine: MusicEngine, mock: MockAudioContext, maxSeconds = 6): void {
  let elapsed = 0;
  while ((engine as any).transitioning && elapsed < maxSeconds) {
    mock.advance(0.05);
    (engine as any).scheduler.tick();
    elapsed += 0.05;
  }
  expect((engine as any).transitioning).toBe(false);
}

describe('style/seed transition chain', () => {
  it('lands at the boundary and re-initialises the new style parameters from its definitions', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.3);

    // Dirty the outgoing style's parameters first.
    engine.setParameter('density', 0.1);
    expect(engine.getParameters().density).toBe(0.1);

    engine.useStyle('grid-b');
    expect((engine as any).transitioning).toBe(true);
    const requestPos = engine.getState().position;
    const boundary: number = (engine as any).transitionBoundary;
    // The cutover is guaranteed beyond the dispatch horizon (look-ahead), so
    // no boundary event can have been handed to an instrument twice, and it
    // always leaves at least the minimum fade room.
    expect(boundary).toBeGreaterThanOrEqual(requestPos + 0.6 - 1e-9);
    expect(boundary).toBeGreaterThanOrEqual(requestPos + 0.16 + 0.05 - 1e-9);

    driveUntilLanded(engine, mock);

    expect(engine.getState().styleId).toBe('grid-b');
    expect(engine.getState().status).toBe('playing');
    // Fresh defaults from B's own definitions — not A's values, not stale B.
    expect(engine.getParameters().density).toBe(0.25);
    expect(engine.getParameters().width).toBe(42);
    expect(engine.getParameters()).not.toHaveProperty('color');

    drive(engine, mock, 0.6);
    expect(log.some((l) => l.event.metadata?.sourcePlugin === 'b')).toBe(true);
    await engine.dispose();
  });

  it('re-selecting a previously used style still resets its parameters to defaults', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.2);

    engine.useStyle('grid-b');
    driveUntilLanded(engine, mock);
    engine.setParameter('width', 7); // user tweak on B
    expect(engine.getParameters().width).toBe(7);

    engine.useStyle('grid-a');
    driveUntilLanded(engine, mock);
    expect(engine.getParameters().density).toBe(1);

    engine.useStyle('grid-b');
    driveUntilLanded(engine, mock);
    // The earlier tweak must not survive a fresh landing of B.
    expect(engine.getParameters().width).toBe(42);
    expect(engine.getParameters().density).toBe(0.25);
    await engine.dispose();
  });

  it('never dispatches the same event twice across the cutover', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.3);

    engine.useStyle('grid-b');
    const boundary: number = (engine as any).transitionBoundary;
    driveUntilLanded(engine, mock);
    drive(engine, mock, 1.0);

    const ids = log.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates at all

    // Every B event sits at/after the boundary; every A event strictly before.
    for (const l of log) {
      if (l.event.metadata?.sourcePlugin === 'b') {
        expect(l.event.startTime).toBeGreaterThanOrEqual(boundary - 1e-9);
      } else {
        expect(l.event.startTime).toBeLessThan(boundary);
      }
    }
    await engine.dispose();
  });

  it('does not lose any note at or after the boundary (continuous coverage)', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.3);

    engine.useStyle('grid-b');
    const boundary: number = (engine as any).transitionBoundary;
    driveUntilLanded(engine, mock);
    drive(engine, mock, 1.0);

    const incoming = log
      .filter((l) => l.event.metadata?.sourcePlugin === 'b')
      .map((l) => l.event.startTime)
      .sort((x, y) => x - y);

    // Incoming generation starts exactly at the boundary — nothing skipped.
    expect(incoming[0]).toBeCloseTo(boundary, 6);
    // And continues on the full 0.25s grid without holes.
    for (let i = 1; i < incoming.length; i++) {
      expect(incoming[i] - incoming[i - 1]).toBeCloseTo(0.25, 6);
    }
    // Outgoing ring-out events before the boundary were also preserved.
    expect(log.some((l) => l.event.metadata?.sourcePlugin === 'a' && l.event.startTime < boundary)).toBe(true);
    await engine.dispose();
  });

  it('merges rapid style + seed requests mid-transition and applies both in one landing', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.3);

    const styleEvents: string[] = [];
    const seedEvents: string[] = [];
    engine.eventBus.on('style', ({ styleId }) => styleEvents.push(styleId));
    engine.eventBus.on('seed', ({ seed, pending }) => {
      if (!pending) seedEvents.push(seed);
    });

    engine.useStyle('grid-b'); // transition begins
    engine.setSeed('200');
    engine.useStyle('grid-a'); // latest style request
    engine.setSeed('300'); // latest seed request
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'grid-a', seed: '300' });

    driveUntilLanded(engine, mock);
    drive(engine, mock, 0.5);

    expect(engine.getState().styleId).toBe('grid-a');
    expect(engine.getState().seed).toBe('300');
    // Exactly one landing => one of each event.
    expect(styleEvents.filter((id) => id === 'grid-a')).toHaveLength(1);
    expect(seedEvents).toContain('300');
    expect(seedEvents).not.toContain('200');
    expect((engine as any).pendingTarget).toBeNull();
    await engine.dispose();
  });

  it('a seed-only request mid-transition lands without touching the current style', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.3);

    engine.useStyle('grid-b');
    engine.setSeed('555');
    driveUntilLanded(engine, mock);

    expect(engine.getState().styleId).toBe('grid-b');
    expect(engine.getState().seed).toBe('555');
    await engine.dispose();
  });

  it('pause interrupting a transition preserves the target; resume lands it and is playing', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.3);

    const ends: string[] = [];
    engine.eventBus.on('transition', ({ phase }) => ends.push(phase));

    engine.useStyle('grid-b');
    engine.pause();
    expect(engine.getState().status).toBe('paused');
    expect((engine as any).transitioning).toBe(false);
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'grid-b' });
    // begin/end stay balanced even though the cutover was interrupted.
    expect(ends.filter((p) => p === 'begin')).toHaveLength(1);
    expect(ends.filter((p) => p === 'end')).toHaveLength(1);

    await engine.resume();
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('grid-b');
    expect(engine.getParameters().density).toBe(0.25); // re-initialised on resume
    drive(engine, mock, 0.6);
    expect(log.some((l) => l.event.metadata?.sourcePlugin === 'b')).toBe(true);
    await engine.dispose();
  });

  it('a further request while paused merges with the interrupted transition target', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.3);

    engine.useStyle('grid-b');
    engine.pause();
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'grid-b' });

    engine.setSeed('999'); // while paused — must not erase the queued style
    expect(engine.getState().styleId).toBe('grid-b');
    expect(engine.getState().seed).toBe('999');
    expect((engine as any).pendingTarget).toBeNull();

    await engine.resume();
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('grid-b');
    expect(engine.getState().seed).toBe('999');
    drive(engine, mock, 0.6);
    expect(log.some((l) => l.event.metadata?.sourcePlugin === 'b')).toBe(true);
    await engine.dispose();
  });

  it('stop interrupting a transition: restart lands the target and plays from t=0', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.3);

    engine.useStyle('grid-b');
    engine.stop();
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'grid-b' });
    await new Promise((r) => setTimeout(r, 230)); // wind-down timer
    expect(engine.getState().status).toBe('idle');

    await engine.start();
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('grid-b');
    expect(engine.getState().seed).toBe('100');
    drive(engine, mock, 0.8);
    expect(log.some((l) => l.event.metadata?.sourcePlugin === 'b')).toBe(true);
    await engine.dispose();
  });

  it('waits for the audio clock: it does not land before the boundary is reached', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.3);
    const before = log.length;

    engine.useStyle('grid-b');
    const boundary: number = (engine as any).transitionBoundary;
    // Stay strictly before the boundary (it is ~1s away); the cutover must
    // wait for the audio clock rather than fire early.
    drive(engine, mock, 0.4);
    expect((engine as any).transitioning).toBe(true);
    expect(engine.getState().styleId).toBe('grid-a');
    expect(engine.getState().position).toBeLessThan(boundary);
    // Outgoing music keeps ringing out in the meantime.
    expect(log.length).toBeGreaterThan(before);
    expect(log.every((l) => l.event.metadata?.sourcePlugin === 'a')).toBe(true);

    driveUntilLanded(engine, mock);
    expect(engine.getState().styleId).toBe('grid-b');
    await engine.dispose();
  });

  it('produces identical event sequences for the same seed + style + version, transition included', async () => {
    const mock1 = new MockAudioContext();
    const log1: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine1 = makeEngine(mock1, log1, '777');
    await engine1.start();
    drive(engine1, mock1, 0.3);
    engine1.useStyle('grid-b');
    driveUntilLanded(engine1, mock1);
    drive(engine1, mock1, 1.2);
    await engine1.dispose();

    const mock2 = new MockAudioContext();
    const log2: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine2 = makeEngine(mock2, log2, '777');
    await engine2.start();
    drive(engine2, mock2, 0.3);
    engine2.useStyle('grid-b');
    driveUntilLanded(engine2, mock2);
    drive(engine2, mock2, 1.2);
    await engine2.dispose();

    expect(log2.map((l) => l.id)).toEqual(log1.map((l) => l.id));
    expect(log2.map((l) => l.event.startTime)).toEqual(log1.map((l) => l.event.startTime));
  });

  it('a visibility-driven fallback to paused keeps the transition target and survives resume', async () => {
    const mock = new FlakyResumeContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.3);

    engine.useStyle('grid-b');
    expect((engine as any).transitioning).toBe(true);

    // The tab comes back but the browser refuses to resume the context.
    mock.allowResume = false;
    mock.state = 'suspended';
    await engine.handleVisibility(true);
    expect(engine.getState().status).toBe('paused');
    expect((engine as any).transitioning).toBe(false);
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'grid-b' });

    // A request made while paused merges with the preserved target.
    engine.setSeed('313');
    expect(engine.getState().seed).toBe('313');

    mock.allowResume = true;
    await engine.resume();
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('grid-b');
    expect(engine.getState().seed).toBe('313');
    drive(engine, mock, 0.6);
    expect(log.some((l) => l.event.metadata?.sourcePlugin === 'b')).toBe(true);
    await engine.dispose();
  });

  it('a style switch performed while paused re-initialises parameters immediately', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    drive(engine, mock, 0.4);
    engine.pause();

    engine.useStyle('grid-b');
    expect(engine.getState().status).toBe('paused');
    expect(engine.getState().styleId).toBe('grid-b');
    expect(engine.getParameters().density).toBe(0.25);
    expect(engine.getParameters().width).toBe(42);

    await engine.resume();
    expect(engine.getState().status).toBe('playing');
    drive(engine, mock, 0.6);
    expect(log.some((l) => l.event.metadata?.sourcePlugin === 'b')).toBe(true);
    await engine.dispose();
  });

  it('never calls Math.random on the generation/transition path', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start(); // noise buffer may use Math.random; arm the spy afterwards
    const spy = vi.spyOn(Math, 'random');
    drive(engine, mock, 0.3);
    engine.useStyle('grid-b');
    driveUntilLanded(engine, mock);
    engine.setSeed('4242');
    driveUntilLanded(engine, mock);
    drive(engine, mock, 0.8);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await engine.dispose();
  });
});
