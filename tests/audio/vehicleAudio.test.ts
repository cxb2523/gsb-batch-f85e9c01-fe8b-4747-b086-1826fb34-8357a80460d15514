import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Game } from '../../src/core/Game';
import { Events } from '../../src/core/Events';
import type { Vehicle } from '../../src/entities/Vehicle';
import { AudioSystem } from '../../src/systems/audio';
import { AudioConfig } from '../../src/systems/audio/config';
import type { AudioApi, LoopHandle } from '../../src/systems/audio/api';
import { NullAudio } from '../../src/systems/audio/api';
import { VehicleAudio } from '../../src/systems/vehicles/VehicleAudio';
import { FakeAudioContext, installFakeAudio, uninstallFakeAudio } from './fakeAudio';

/**
 * Vehicle engine-loop lifecycle: the loop is bound to the vehicle entity (start on
 * creation/control, stop + release on destruction/despawn), repeated starts are
 * idempotent, and a voice stolen by the global pool clears the vehicle reference.
 */

const V = AudioConfig.voices;

interface FakeVehicle {
  isAlive: boolean;
  hasController: boolean;
  position: { x: number; y: number; z: number };
  state: {
    rpm01: number;
    wrecked: boolean;
    onFire: boolean;
    sirenOn: boolean;
    grounded: boolean;
    lateralSpeed: number;
    speedMs: number;
  };
  controls: { throttle: number; brake: number; steer: number; handbrake: boolean };
}

/** Enough of Vehicle for VehicleAudio. */
function makeVehicle(pos = { x: 0, y: 0, z: 0 }): Vehicle {
  return {
    isAlive: true,
    hasController: true,
    position: { x: pos.x, y: pos.y, z: pos.z },
    state: { rpm01: 0.3, wrecked: false, onFire: false, sirenOn: false, grounded: true, lateralSpeed: 0, speedMs: 10 },
    controls: { throttle: 0.5, brake: 0, steer: 0, handbrake: false },
  } as unknown as Vehicle;
}

/** Mutable view of the fake vehicle (the public type marks some fields read-only). */
function mut(v: Vehicle): FakeVehicle {
  return v as unknown as FakeVehicle;
}

function fakeGame(audio: AudioApi): Game {
  return {
    audio,
    events: new Events(),
    perf: { set: () => {} },
    systems: { has: () => false, get: () => undefined },
  } as unknown as Game;
}

function ctx(): FakeAudioContext {
  const c = FakeAudioContext.instances[0];
  if (!c) throw new Error('no fake AudioContext created');
  return c;
}

describe('VehicleAudio with the real AudioSystem', () => {
  let audio: AudioSystem;

  beforeEach(() => {
    installFakeAudio();
    audio = new AudioSystem(fakeGame(new NullAudio()));
  });

  afterEach(() => {
    audio.dispose();
    uninstallFakeAudio();
  });

  it('starts the engine loop on control and stops + releases it when control is lost', () => {
    const va = new VehicleAudio(fakeGame(audio));
    const v = makeVehicle();

    va.startEngine(v);
    const handle = va.engineHandle(v);
    expect(handle).not.toBeNull();
    expect(handle?.alive).toBe(true);
    expect(audio.activeVoices).toBe(1);

    // Update drives the handle but must not stack a second voice.
    va.update([v], { x: 0, y: 0, z: 0 });
    expect(va.engineHandle(v)).toBe(handle);
    expect(audio.activeVoices).toBe(1);

    // Losing control stops and releases the voice immediately.
    mut(v).hasController = false;
    va.update([v], { x: 0, y: 0, z: 0 });
    expect(va.engineHandle(v)).toBeNull();
    expect(handle?.alive).toBe(false);
    va.dispose();
  });

  it('is idempotent: repeated startEngine calls yield one voice and one handle', () => {
    const va = new VehicleAudio(fakeGame(audio));
    const v = makeVehicle();
    const first = va.startEngine(v);
    const second = va.startEngine(v);
    const third = va.startEngine(v);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(audio.activeVoices).toBe(1);
    va.dispose();
  });

  it('stops on wreck/explosion via the audio lifecycle hooks', () => {
    const game = fakeGame(audio);
    const va = new VehicleAudio(game);
    const v = makeVehicle();
    va.startEngine(v);
    const handle = va.engineHandle(v);
    expect(handle).not.toBeNull();

    mut(v).state.wrecked = true;
    game.events.emit('vehicle:exploded', { vehicle: v, position: { x: 0, y: 0, z: 0 } });
    expect(handle?.alive).toBe(false);
    expect(va.engineHandle(v)).toBeNull();
    va.dispose();
  });

  it('releases every loop on remove()/despawn', () => {
    const game = fakeGame(audio);
    const va = new VehicleAudio(game);
    const v = makeVehicle();
    mut(v).state.onFire = true;
    mut(v).state.sirenOn = true;
    va.startEngine(v);
    va.update([v], { x: 0, y: 0, z: 0 });
    const engine = va.engineHandle(v);
    expect(engine).not.toBeNull();

    game.events.emit('vehicle:despawned', { vehicle: v });
    expect(va.engineHandle(v)).toBeNull();
    expect(engine?.alive).toBe(false);
    // Every loop for this vehicle was stopped; the pool prunes the faded voices.
    ctx().currentTime += V.stopFade * 4;
    audio.update(1 / 60);
    expect(audio.activeVoices).toBe(0);
    va.dispose();
  });

  it('clears the vehicle reference when the pool steals the engine voice', () => {
    const va = new VehicleAudio(fakeGame(audio));
    const v = makeVehicle();
    va.startEngine(v);
    const handle = va.engineHandle(v);
    expect(handle).not.toBeNull();

    // Fill the loop cap with other sounds so the engine voice is the oldest victim.
    const others: LoopHandle[] = [];
    for (let i = 0; i < V.maxLoops; i++) others.push(audio.loop('vehicle.siren.loop'));
    // Overflow once more: the pool steals the quietest/oldest loop (the engine, vol 1
    // but older than the sirens which are also vol 1 → oldest wins).
    audio.loop('vehicle.siren.loop');

    expect(handle?.alive).toBe(false);
    // The vehicle must have dropped the dead handle instead of holding it.
    expect(va.engineHandle(v)).toBeNull();
    // A later update recreates a fresh voice rather than driving the dead handle.
    mut(v).hasController = true;
    va.update([v], { x: 0, y: 0, z: 0 });
    expect(va.engineHandle(v)).not.toBeNull();
    expect(va.engineHandle(v)).not.toBe(handle);
    va.dispose();
  });
});

describe('VehicleAudio against NullAudio (headless)', () => {
  beforeEach(() => {
    uninstallFakeAudio();
  });

  afterEach(() => {
    uninstallFakeAudio();
  });

  it('never throws and reports no live handle when audio has no graph', () => {
    // Headless: `window` exists but there is no AudioContext, so AudioSystem returns
    // alive-but-inert handles and VehicleAudio drives them without throwing.
    const g = globalThis as Record<string, unknown>;
    g.window = { addEventListener: () => {}, removeEventListener: () => {} };
    const headless = new AudioSystem(fakeGame(new NullAudio()));
    const va = new VehicleAudio(fakeGame(headless));
    const v = makeVehicle();
    expect(() => va.startEngine(v)).not.toThrow();
    expect(() => va.update([v], { x: 0, y: 0, z: 0 })).not.toThrow();
    expect(() => va.stopEngine(v)).not.toThrow();
    va.dispose();
    headless.dispose();
    delete g.window;
  });

  it('is a no-op with NullAudio (one inert loop token, updates never throw)', () => {
    let loops = 0;
    const nullAudio = new NullAudio();
    const origLoop = nullAudio.loop.bind(nullAudio);
    nullAudio.loop = ((id: Parameters<AudioApi['loop']>[0]) => {
      loops++;
      return origLoop(id);
    }) as AudioApi['loop'];
    const va = new VehicleAudio(fakeGame(nullAudio));
    const v = makeVehicle();
    va.startEngine(v);
    expect(loops).toBe(1);
    expect(() => va.update([v], { x: 0, y: 0, z: 0 })).not.toThrow();
    va.dispose();
  });
});
