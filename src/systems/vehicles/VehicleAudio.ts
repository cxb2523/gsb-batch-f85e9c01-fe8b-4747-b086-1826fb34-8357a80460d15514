import type { V3 } from '../../core/entities';
import type { Game } from '../../core/Game';
import type { Vehicle } from '../../entities/Vehicle';
import type { LoopHandle } from '../audio/api';
import type { SoundId } from '../audio/sounds';
import { VehicleConfig } from './config';

type LoopKind = 'engine' | 'skid' | 'fire' | 'siren';

const LOOP_IDS: Record<LoopKind, SoundId> = {
  engine: 'vehicle.engine.loop',
  skid: 'vehicle.skid.loop',
  fire: 'vehicle.fire.loop',
  siren: 'vehicle.siren.loop',
};

const RANGE2: Record<LoopKind, number> = {
  engine: VehicleConfig.audioDistance ** 2,
  skid: VehicleConfig.audioDistance ** 2,
  fire: 120 ** 2,
  siren: 400 ** 2,
};

/**
 * Starts/stops the looping sounds each vehicle needs.
 *
 * Ownership rules (the bug this replaces relied on the voice pool to tidy up):
 * - The engine loop belongs to the vehicle entity: it is started when the entity is
 *   created *and running* (`spawn` hands us traffic/police/mission cars with a driver)
 *   or the moment the vehicle acquires a controller, and it is stopped and released
 *   explicitly when the vehicle is destroyed, despawns, or loses its controller.
 * - `startEngine` is idempotent, so two "start" calls for the same vehicle can never
 *   stack a second voice.
 * - Every handle is wired through `onEnded`. If the global voice pool ever steals or
 *   expires a voice, the vehicle's Map entry is dropped synchronously and the next
 *   update recreates a fresh voice instead of driving a dead handle.
 */
export class VehicleAudio {
  private readonly loops: Record<LoopKind, Map<Vehicle, LoopHandle>> = {
    engine: new Map(),
    skid: new Map(),
    fire: new Map(),
    siren: new Map(),
  };
  private readonly offs: (() => void)[] = [];

  constructor(private readonly game: Game) {
    // Destruction is immediate: release the engine voice now rather than waiting for
    // the next distance poll to notice the wreck.
    this.offs.push(
      game.events.on('vehicle:exploded', ({ vehicle }) => this.stopEngine(vehicle as Vehicle)),
      game.events.on('vehicle:despawned', ({ vehicle }) => this.remove(vehicle as Vehicle)),
    );
  }

  update(vehicles: readonly Vehicle[], listener: V3): void {
    const audio = this.game.audio;
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      const dx = v.position.x - listener.x;
      const dz = v.position.z - listener.z;
      const d2 = dx * dx + dz * dz;
      const s = v.state;
      // Engine lifetime follows the entity: alive + not wrecked + still has a controller.
      const running = v.isAlive && !s.wrecked && v.hasController;
      const engine = running && d2 < RANGE2.engine ? this.startEngine(v) : this.stopEngine(v);
      if (engine) {
        audio.engine(engine, s.rpm01, v.controls.throttle, s.speedMs);
        audio.setLoopParams(engine, { position: v.position });
      }
      const sliding = running && s.grounded && Math.abs(s.lateralSpeed) > VehicleConfig.handling.skidLateralSpeed && s.speedMs > 3;
      const skid = this.sync('skid', v, sliding && d2 < RANGE2.skid);
      if (skid) audio.setLoopParams(skid, { position: v.position, volume: Math.min(1, Math.abs(s.lateralSpeed) / 12) });
      const fire = this.sync('fire', v, v.isAlive && s.onFire && d2 < RANGE2.fire);
      if (fire) audio.setLoopParams(fire, { position: v.position });
      const siren = this.sync('siren', v, v.isAlive && s.sirenOn && d2 < RANGE2.siren);
      if (siren) audio.setLoopParams(siren, { position: v.position });
    }
  }

  /**
   * Starts (or returns) the vehicle's engine loop. Idempotent: calling it twice for
   * the same vehicle never creates a second voice.
   */
  startEngine(v: Vehicle): LoopHandle | null {
    return this.sync('engine', v, true);
  }

  /** Stops and releases the vehicle's engine loop (idle inaudible, player out, wreck). */
  stopEngine(v: Vehicle): null {
    this.sync('engine', v, false);
    return null;
  }

  /** Handle currently driving `v`'s engine loop, if any (introspection for tests/debug). */
  engineHandle(v: Vehicle): LoopHandle | null {
    const handle = this.loops.engine.get(v);
    if (!handle) return null;
    if (!handle.alive) {
      this.loops.engine.delete(v);
      return null;
    }
    return handle;
  }

  /** Stop everything attached to a vehicle (despawn / destroy). */
  remove(v: Vehicle): void {
    for (const kind of Object.keys(this.loops) as LoopKind[]) this.sync(kind, v, false);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const kind of Object.keys(this.loops) as LoopKind[]) {
      const map = this.loops[kind];
      for (const [v, handle] of [...map]) this.release(kind, v, handle);
    }
  }

  private sync(kind: LoopKind, v: Vehicle, wanted: boolean): LoopHandle | null {
    const map = this.loops[kind];
    let handle = map.get(v) ?? null;
    // A handle the pool already ended must never be reused: drop it so `wanted`
    // starts a fresh voice.
    if (handle && !handle.alive) {
      map.delete(v);
      handle = null;
    }
    if (wanted) {
      if (!handle) {
        handle = this.game.audio.loop(LOOP_IDS[kind], { position: v.position });
        // Headless (no Web Audio): the handle is inert but still a valid token.
        if (!handle.alive) return null;
        // Pool eviction / natural expiry must clear this vehicle's reference.
        handle.onEnded = () => {
          if (map.get(v) === handle) map.delete(v);
        };
        if (kind === 'siren') this.game.audio.siren(handle, true);
        map.set(v, handle);
      }
    } else if (handle) {
      this.release(kind, v, handle);
      handle = null;
    }
    return handle;
  }

  private release(kind: LoopKind, v: Vehicle, handle: LoopHandle): void {
    const map = this.loops[kind];
    if (map.get(v) === handle) map.delete(v);
    if (kind === 'siren') this.game.audio.siren(handle, false);
    this.game.audio.stop(handle);
  }
}
