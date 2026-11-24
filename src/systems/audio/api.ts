import type { V3 } from '../../core/entities';
import type { Quaternion } from 'three';
import { isSoundId, type SoundId } from './sounds';

export type AudioBus = 'master' | 'sfx' | 'engine' | 'ambient' | 'ui' | 'music';

export interface PlayOptions {
  position?: V3;
  /** 0..1, default 1. */
  volume?: number;
  /** Playback rate multiplier, default 1. */
  pitch?: number;
  bus?: AudioBus;
}

export interface LoopParams {
  pitch?: number;
  volume?: number;
  position?: V3;
}

export interface LoopHandle {
  readonly id: number;
  readonly sound: SoundId;
  alive: boolean;
  /**
   * Optional owner hook, invoked exactly once when the loop's voice ends for any
   * reason: an explicit `stop()`, the voice pool stealing it, natural expiry, or
   * `dispose()`. Holders (vehicles, helicopters, ambient beds) set this to drop
   * their reference synchronously instead of keeping a handle that can no longer
   * be driven. Must be safe to call from inside `stop()`.
   */
  onEnded?: () => void;
}

/**
 * The audio contract (docs/TEAM-PLAN.md §3.6). `game.audio` always returns an
 * implementation of this: the real system when loaded, `NullAudio` otherwise.
 */
export interface AudioApi {
  play(id: SoundId, opts?: PlayOptions): void;
  loop(id: SoundId, opts?: PlayOptions): LoopHandle;
  stop(handle: LoopHandle): void;
  setLoopParams(handle: LoopHandle, params: LoopParams): void;
  /** Drive an engine loop: rpm01 in 0..1, throttle01 in 0..1, speed in m/s. */
  engine(handle: LoopHandle, rpm01: number, throttle01: number, speedMs: number): void;
  siren(handle: LoopHandle, on: boolean): void;
  setListener(position: V3, quaternion: Quaternion, velocity: V3): void;
  setBusVolume(bus: AudioBus, volume: number): void;
  getBusVolume(bus: AudioBus): number;
  /** Toggle the in-car radio station. */
  radio(on: boolean): void;
  /** Resume the AudioContext after a user gesture (autoplay policy). */
  resume(): void;
}

/**
 * Silent implementation. Used when the audio system is not loaded and as the
 * behaviour of the Phase 1 stub. Unknown ids warn once each.
 */
export class NullAudio implements AudioApi {
  private nextHandle = 1;
  private readonly warned = new Set<string>();
  private readonly volumes: Record<AudioBus, number> = { master: 1, sfx: 1, engine: 1, ambient: 1, ui: 1, music: 1 };

  protected validate(id: string): void {
    if (isSoundId(id) || this.warned.has(id)) return;
    this.warned.add(id);
    console.warn(`[audio] unknown sound id '${id}' (add it to src/systems/audio/sounds.ts)`);
  }

  play(id: SoundId): void {
    this.validate(id);
  }

  loop(id: SoundId): LoopHandle {
    this.validate(id);
    return { id: this.nextHandle++, sound: id, alive: true };
  }

  stop(handle: LoopHandle): void {
    if (!handle.alive) return;
    handle.alive = false;
    const ended = handle.onEnded;
    handle.onEnded = undefined;
    ended?.();
  }

  setLoopParams(): void {}

  engine(): void {}

  siren(): void {}

  setListener(): void {}

  setBusVolume(bus: AudioBus, volume: number): void {
    this.volumes[bus] = Math.max(0, Math.min(1, volume));
  }

  getBusVolume(bus: AudioBus): number {
    return this.volumes[bus];
  }

  radio(): void {}

  resume(): void {}
}
