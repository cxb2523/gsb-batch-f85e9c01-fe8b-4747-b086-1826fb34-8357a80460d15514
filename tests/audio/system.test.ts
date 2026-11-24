import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Game } from '../../src/core/Game';
import { AudioSystem } from '../../src/systems/audio';
import { AudioConfig } from '../../src/systems/audio/config';
import { ENGINE_VARIANTS, engineHz } from '../../src/systems/audio/engine';
import type { LoopHandle } from '../../src/systems/audio/api';
import { FakeAudioContext, installFakeAudio, uninstallFakeAudio } from './fakeAudio';

/**
 * End-to-end loop/voice tests against the real `AudioSystem` with a fake Web Audio
 * graph: handle lifecycle, idempotent loops, engine pitch × frequency composition,
 * and voice-pool eviction clearing the owning reference.
 */

/** Only the fields AudioSystem touches at construction/update. */
function makeGame(): Game {
  return {
    events: {
      on: () => () => {},
      emit: () => {},
      once: () => () => {},
    },
    perf: { set: () => {} },
    systems: { has: () => false, get: () => undefined },
    state: { playerPos: { x: 0, y: 0, z: 0 }, interior: null },
  } as unknown as Game;
}

function ctx(): FakeAudioContext {
  const c = FakeAudioContext.instances[0];
  if (!c) throw new Error('no fake AudioContext created');
  return c;
}

const V = AudioConfig.voices;
const E = AudioConfig.engine;

/**
 * Drives the engine twice with the context clock advanced past the gear-shift dip,
 * so the last ramp targets are the steady-state frequencies.
 */
function driveEngine(audio: AudioSystem, handle: LoopHandle, rpm01: number, speedMs: number): void {
  audio.engine(handle, rpm01, 1, speedMs);
  ctx().currentTime += E.shiftSeconds + 0.05;
  audio.engine(handle, rpm01, 1, speedMs);
}

/** Steady-state effective rpm (no shift dip) for the given inputs. */
function steasyRpm(rpm01: number, speedMs: number): number {
  const speeds = E.gearSpeeds;
  const s = Math.max(0, speedMs);
  let gear = 1;
  for (let i = 1; i < speeds.length; i++) if (s >= speeds[i]) gear = i + 1;
  const lo = speeds[gear - 1];
  const hi = gear < speeds.length ? speeds[gear] : lo * 1.6;
  const rolling = s > 1 ? Math.max(0, Math.min(1, (s - lo) / Math.max(0.01, hi - lo))) : rpm01;
  const rpm = rpm01 * (1 - E.gearBlend) + rolling * E.gearBlend;
  return Math.max(0, Math.min(1, rpm));
}

describe('AudioSystem loop lifecycle', () => {
  let audio: AudioSystem;

  beforeEach(() => {
    installFakeAudio();
    audio = new AudioSystem(makeGame());
  });

  afterEach(() => {
    audio.dispose();
    uninstallFakeAudio();
  });

  it('starts a loop, reports it alive, and stop() ends it', () => {
    const handle = audio.loop('vehicle.engine.loop');
    expect(handle.alive).toBe(true);
    expect(audio.activeVoices).toBe(1);
    expect(ctx().created.oscillators.length).toBeGreaterThan(0);

    audio.stop(handle);
    expect(handle.alive).toBe(false);
    // Driving a stopped handle is a no-op and must not throw.
    expect(() => audio.engine(handle, 1, 1, 30)).not.toThrow();
    audio.update(1 / 60);
    // The faded loop is pruned once its fade time elapses.
    ctx().currentTime += V.stopFade * 4;
    audio.update(1 / 60);
    expect(audio.activeVoices).toBe(0);
  });

  it('exposes the engine hook only while the voice is alive', () => {
    const handle = audio.loop('vehicle.engine.loop');
    audio.engine(handle, 0.5, 1, 12);
    audio.stop(handle);
    expect(() => audio.engine(handle, 1, 1, 40)).not.toThrow();
    expect(handle.alive).toBe(false);
  });

  it('fires onEnded exactly once when the owner stops the loop', () => {
    let ended = 0;
    const handle = audio.loop('vehicle.engine.loop');
    handle.onEnded = () => ended++;
    audio.stop(handle);
    audio.stop(handle);
    expect(ended).toBe(1);
  });

  it('sets handle.alive = false and fires onEnded when the pool steals the loop', () => {
    const handles: LoopHandle[] = [];
    for (let i = 0; i < V.maxLoops; i++) handles.push(audio.loop('vehicle.siren.loop'));
    expect(audio.activeVoices).toBe(V.maxLoops);
    const ended: number[] = [];
    handles.forEach((h, i) => (h.onEnded = () => ended.push(i)));

    // One more loop overflows the cap: the pool steals one voice and its handle dies.
    const overflow = audio.loop('vehicle.siren.loop');
    expect(overflow.alive).toBe(true);
    const dead = handles.filter((h) => !h.alive);
    expect(dead).toHaveLength(1);
    expect(ended).toHaveLength(1);
    expect(audio.activeVoices).toBe(V.maxLoops);
  });
});

describe('AudioSystem engine pitch × frequency', () => {
  let audio: AudioSystem;

  beforeEach(() => {
    installFakeAudio();
    audio = new AudioSystem(makeGame());
  });

  afterEach(() => {
    audio.dispose();
    uninstallFakeAudio();
  });

  it('multiplies engine rpm frequency by the loop pitch', () => {
    const pitch = 1.5;
    const rpm = 0.6;
    const speed = 12;
    const handle = audio.loop('vehicle.engine.loop', { pitch });
    driveEngine(audio, handle, rpm, speed);

    const base = engineHz(ENGINE_VARIANTS.car.baseHz, steasyRpm(rpm, speed));
    const oscs = ctx().created.oscillators;
    // Fundamental saw (first oscillator) is base × pitch.
    expect(oscs[0].frequency.last).toBeCloseTo(base * pitch, 3);
    // Detuned second saw keeps its ratio on top of the same pitched frequency.
    expect(oscs[1].frequency.last).toBeCloseTo(base * pitch * ENGINE_VARIANTS.car.detuneRatio, 3);
    // Sub oscillator tracks the same pitch-scaled frequency at half.
    expect(oscs[2].frequency.last).toBeCloseTo(base * pitch * ENGINE_VARIANTS.car.subRatio, 3);
  });

  it('re-applies the rpm frequency when pitch changes after an engine update', () => {
    const rpm = 0.8;
    const speed = 20;
    const handle = audio.loop('vehicle.engine.loop');
    driveEngine(audio, handle, rpm, speed);
    const base = engineHz(ENGINE_VARIANTS.car.baseHz, steasyRpm(rpm, speed));
    expect(ctx().created.oscillators[0].frequency.last).toBeCloseTo(base, 3);

    // Pitch changes after the engine update: the frequency must follow, not stay put.
    audio.setLoopParams(handle, { pitch: 2 });
    expect(ctx().created.oscillators[0].frequency.last).toBeCloseTo(base * 2, 3);

    // A later engine update keeps the new pitch (they compose, not overwrite).
    audio.engine(handle, rpm, 1, speed);
    expect(ctx().created.oscillators[0].frequency.last).toBeCloseTo(base * 2, 3);
  });

  it('tracks pitch changes applied before the first engine update', () => {
    const handle = audio.loop('vehicle.engine.loop', { pitch: 0.5 });
    audio.setLoopParams(handle, { pitch: 1.25 });
    driveEngine(audio, handle, 0.4, 8);
    const base = engineHz(ENGINE_VARIANTS.car.baseHz, steasyRpm(0.4, 8));
    expect(ctx().created.oscillators[0].frequency.last).toBeCloseTo(base * 1.25, 3);
  });

  it('applies pitch to the helicopter rotor whine frequency', () => {
    const handle = audio.loop('vehicle.engine.helicopter.loop', { pitch: 1.2 });
    // The rotor drives directly from rpm01 (no car gearbox model).
    driveEngine(audio, handle, 0.5, 20);
    // Heli recipe creates the rotor LFO oscillator first, then the turbine whine.
    const whine = ctx().created.oscillators[1];
    expect(whine.frequency.last).toBeCloseTo((120 + 0.5 * 90) * 1.2, 3);
  });
});
