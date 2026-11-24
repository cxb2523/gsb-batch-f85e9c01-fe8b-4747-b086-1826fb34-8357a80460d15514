import { describe, expect, it } from 'vitest';

import { damage, stepBullets } from './tanky-town-bullets';
import { LEVEL_COUNT, parseLevel } from './tanky-town-level';
import {
  applySnapshot,
  coast,
  isRoomId,
  joinSnapshots,
  newRoomId,
  sameInput,
  snapshot,
  type Snapshot,
} from './tanky-town-net';
import {
  addTank,
  playerTank,
  setTile,
  tankPos,
  type Input,
  type TankEvent,
  type World,
} from './tanky-town-state';
import { createWorld, step } from './tanky-town-world';

const fixed = (value: number) => () => value;
const IDLE: Input = { dir: null, fire: false };
/** mulberry32: same seed, same game - keeps the lifecycle tests deterministic. */
function seeded(seed = 7) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const run = (world: World, seconds: number, inputs: Input[]) => {
  for (let t = 0; t < seconds; t += 0.02) step(world, 0.02, inputs);
};
/** Two players, one enemy that never leaves its gate. */
const duo = () => {
  const world = createWorld(fixed(0.5), 0, 2);
  world.queue = ['basic'];
  world.spawnIn = 999;
  return world;
};
/** Two players with nothing left to beat: the next step clears the level. */
const cleared = (rng: () => number = seeded(), level = 0) => {
  const world = createWorld(rng, level, 2);
  world.queue = [];
  world.spawnIn = 999;
  return world;
};
const overTheWire = (snap: Snapshot) => JSON.parse(JSON.stringify(snap)) as Snapshot;
/** The numbers coasting must never touch, plus the drawn positions it may move. */
const frozen = (world: World) => ({
  tanks: world.tanks.map((tank) => tankPos(tank)),
  bullets: world.bullets.map(({ x, y }) => ({ x, y })),
  phase: world.phase,
  clearIn: world.clearIn,
  lives: world.lives,
  score: world.score,
  events: world.events.length,
});

describe('two players', () => {
  it('gives each seat a free home tile on every level', () => {
    for (let i = 0; i < LEVEL_COUNT; i++) {
      const level = parseLevel(i);
      for (const home of level.homes) {
        expect(level.tiles[home.y * level.cols + home.x]).toBe('empty');
      }
      expect(level.homes[1]).toEqual({ x: 7, y: 12 });
    }
  });

  it('starts with two tanks and two extra lives; one player is unchanged', () => {
    const world = duo();
    expect(playerTank(world, 0)).toMatchObject({ x: 3, y: 12, seat: 0 });
    expect(playerTank(world, 1)).toMatchObject({ x: 7, y: 12, seat: 1 });
    expect(world.lives).toBe(5);
    const solo = createWorld(fixed(0.5));
    expect(solo.lives).toBe(3);
    expect(playerTank(solo, 1)).toBeUndefined();
  });

  it('drives each tank from its own input', () => {
    const world = duo();
    run(world, 0.4, [{ dir: 3, fire: false }, IDLE]);
    expect(playerTank(world, 0)!.y).toBeLessThan(12);
    expect(playerTank(world, 1)).toMatchObject({ x: 7, y: 12 });
    run(world, 0.4, [IDLE, { dir: 0, fire: false }]);
    expect(playerTank(world, 1)!.x).toBeGreaterThan(7);
    run(world, 0.2, [IDLE]);
  });

  it('never lets friends hurt each other', () => {
    const world = duo();
    const friend = playerTank(world, 1)!;
    friend.shield = 0;
    world.bullets = [{ x: 6.8, y: 12, dir: 0, owner: 'player', tankId: 1 }];
    run(world, 0.2, [IDLE, IDLE]);
    expect(playerTank(world, 1)).toBeDefined();
    expect(world.lives).toBe(5);
  });

  it('brings back only the player who was hit, at their own home', () => {
    const world = duo();
    const friend = playerTank(world, 1)!;
    friend.shield = 0;
    damage(world, friend);
    expect(world.lives).toBe(4);
    expect(playerTank(world, 0)).toBeDefined();
    run(world, 1.5, [IDLE, IDLE]);
    expect(playerTank(world, 1)).toMatchObject({ x: 7, y: 12 });
    expect(world.tanks.filter((tank) => tank.seat === 0)).toHaveLength(1);
  });

  it('keeps both tanks when the next level loads', () => {
    const world = duo();
    world.queue = [];
    run(world, 3, [IDLE, IDLE]);
    expect(world.levelIndex).toBe(1);
    expect(world.tanks.map((tank) => tank.seat)).toEqual([0, 1]);
  });
});

describe('snapshots', () => {
  it('rebuild the same game on the other side', () => {
    const host = duo();
    addTank(host, 'tough', { x: 0, y: 4 }, 1);
    run(host, 0.6, [
      { dir: 3, fire: true },
      { dir: 2, fire: true },
    ]);
    host.pickup = { x: 1, y: 1, ttl: 5 };
    const guest = createWorld(fixed(0), 0, 2);
    applySnapshot(guest, overTheWire(snapshot(host, [{ type: 'boom', x: 1, y: 2 }])));
    for (const key of ['tiles', 'tanks', 'bullets', 'pickup', 'queue', 'lives', 'score'] as const) {
      expect(guest[key]).toEqual(host[key]);
    }
    expect(guest.events).toEqual([{ type: 'boom', x: 1, y: 2 }]);
    expect(guest.level).toEqual(host.level);
  });

  it('swap the map when the host is on another level', () => {
    const host = createWorld(fixed(0.5), 3, 2);
    const guest = createWorld(fixed(0), 0, 2);
    applySnapshot(guest, overTheWire(snapshot(host, [])));
    expect(guest.level.name).toBe('Stone Fort');
    expect(guest.tiles).toEqual(host.tiles);
  });

  it('stay small enough to send many times a second', () => {
    const world = createWorld(fixed(0.5), 4, 2);
    run(world, 10, [
      { dir: 3, fire: true },
      { dir: 3, fire: true },
    ]);
    expect(JSON.stringify(snapshot(world, [])).length).toBeLessThan(4000);
  });

  it('coast tanks and bullets forward between snapshots without deciding anything', () => {
    const world = duo();
    run(world, 0.1, [{ dir: 3, fire: false }, IDLE]);
    const tank = playerTank(world, 0)!;
    const before = tankPos(tank).y;
    world.bullets = [{ x: 5, y: 5, dir: 0, owner: 'enemy', tankId: 9 }];
    const stats = { phase: world.phase, lives: world.lives, score: world.score };
    coast(world, 0.05);
    expect(tankPos(tank).y).toBeLessThan(before);
    expect(world.bullets[0].x).toBeCloseTo(5.25);
    expect(world.phase).toBe(stats.phase);
    expect(world.lives).toBe(stats.lives);
    expect(world.score).toBe(stats.score);
    expect(world.events).toHaveLength(0);
    coast(world, 5);
    expect(tank.off).toBe(0);
    expect(world.events).toHaveLength(0);
    world.phase = 'over';
    coast(world, 1);
    expect(world.bullets[0].x).toBeCloseTo(30.25);
  });
});

describe('level lifecycle over the wire', () => {
  it('carries the phase and the clear countdown in every snapshot', () => {
    const host = cleared();
    step(host, 0.02, [IDLE, IDLE]);
    expect(host.phase).toBe('clear');
    const snap = overTheWire(snapshot(host, []));
    expect(snap.phase).toBe('clear');
    expect(snap.clearIn).toBeGreaterThan(0);
    const guest = createWorld(seeded(3), 0, 2);
    applySnapshot(guest, snap);
    expect(guest.phase).toBe('clear');
    expect(guest.clearIn).toBe(snap.clearIn);
  });

  it('stops the friend on the clear pause and freezes the coast there', () => {
    const host = cleared();
    step(host, 0.02, [IDLE, IDLE]);
    expect(host.phase).toBe('clear');
    // Mid-hop tanks and a bullet still in the air must not drift on the guest's screen.
    playerTank(host, 0)!.off = 0.5;
    host.bullets = [{ x: 3.2, y: 6, dir: 2, owner: 'enemy', tankId: 77 }];

    const guest = createWorld(seeded(3), 0, 2);
    applySnapshot(guest, overTheWire(snapshot(host, [])));
    expect(guest.phase).toBe('clear');
    expect(guest.clearIn).toBeGreaterThan(0);

    const before = frozen(guest);
    coast(guest, 1);
    expect(frozen(guest)).toEqual(before);
    expect(guest.phase).toBe('clear');
    expect(guest.clearIn).toBeGreaterThan(0);
  });

  it('follows the host onto the next level with a clean map, no old bullets, drops or events', () => {
    const host = cleared();
    host.bullets = [{ x: 4, y: 4, dir: 1, owner: 'player', tankId: 1 }];
    host.pickup = { x: 1, y: 1, ttl: 9 };
    step(host, 0.02, [IDLE, IDLE]);
    expect(host.phase).toBe('clear');

    const guest = createWorld(seeded(3), 0, 2);
    // The guest is still on the old map, mid-fight, with an event waiting to be played.
    guest.bullets = [{ x: 9, y: 9, dir: 0, owner: 'enemy', tankId: 5 }];
    guest.pickup = { x: 2, y: 2, ttl: 3 };
    guest.events.push({ type: 'boom', x: 1, y: 1 });
    applySnapshot(guest, overTheWire(snapshot(host, [])));
    guest.events.length = 0;

    run(host, 2.6, [IDLE, IDLE]);
    expect(host.levelIndex).toBe(1);
    expect(host.phase).toBe('play');
    const snap = overTheWire(snapshot(host, []));
    applySnapshot(guest, snap);

    expect(guest.levelIndex).toBe(1);
    expect(guest.level).toEqual(parseLevel(1));
    expect(guest.tiles).toEqual(host.tiles);
    expect(guest.bullets).toEqual([]);
    expect(guest.pickup).toBeNull();
    expect(guest.events).toEqual([]);
    expect(guest.phase).toBe('play');
    expect(guest.clearIn).toBe(0);
  });

  it('freezes the friend on the end screen after a loss', () => {
    const host = cleared();
    host.bullets = [{ x: 5, y: 11.6, dir: 1, owner: 'enemy', tankId: 9 }];
    setTile(host, 5, 11, 'empty');
    stepBullets(host, 0.05);
    expect(host.phase).toBe('over');

    const guest = createWorld(seeded(3), 0, 2);
    applySnapshot(guest, overTheWire(snapshot(host, host.events)));
    expect(guest.phase).toBe('over');
    expect(guest.events.map((event) => event.type)).toEqual(expect.arrayContaining(['over']));

    guest.events.length = 0;
    const before = frozen(guest);
    coast(guest, 3);
    expect(frozen(guest)).toEqual(before);
  });

  it('keeps a won game frozen on every snapshot', () => {
    const host = cleared(seeded(), LEVEL_COUNT - 1);
    step(host, 0.02, [IDLE, IDLE]);
    expect(host.phase).toBe('won');
    const guest = createWorld(seeded(3), 0, 2);
    applySnapshot(guest, overTheWire(snapshot(host, [])));
    const before = frozen(guest);
    coast(guest, 2);
    expect(frozen(guest)).toEqual(before);
    expect(guest.phase).toBe('won');
  });

  it('replaces, never piles up, the events between two snapshots', () => {
    const host = cleared();
    const guest = createWorld(seeded(3), 0, 2);
    guest.events.push({ type: 'clang', x: 0, y: 0 });
    const events: TankEvent[] = [{ type: 'boom', x: 3, y: 4 }];
    applySnapshot(guest, overTheWire(snapshot(host, events)));
    expect(guest.events).toEqual(events);
    applySnapshot(guest, overTheWire(snapshot(host, events)));
    expect(guest.events).toEqual(events);
    // The guest plays a copy: playing or clearing it never writes back to the host's list.
    guest.events.length = 0;
    expect(host.events).toEqual([]);
    expect(events).toEqual([{ type: 'boom', x: 3, y: 4 }]);
  });

  it('merges a burst of snapshots: newest world, every event once and in order', () => {
    const world = duo();
    const a = overTheWire(snapshot(world, [{ type: 'shot', x: 1, y: 1 }]));
    const b = overTheWire(snapshot(world, [{ type: 'brick', x: 2, y: 2 }]));
    const c = overTheWire(snapshot(world, [{ type: 'boom', x: 3, y: 3 }]));
    const merged = joinSnapshots([a, b, c]);
    expect(merged).toMatchObject({ levelIndex: c.levelIndex, phase: c.phase, lives: c.lives });
    expect(merged.events.map((event) => event.type)).toEqual(['shot', 'brick', 'boom']);
    expect(joinSnapshots([a])).toBe(a);
  });

  it('drops old-map events when a level switch lands inside one burst', () => {
    const oldMap = duo();
    const newMap = createWorld(seeded(), 1, 2);
    const a = overTheWire(snapshot(oldMap, [{ type: 'boom', x: 1, y: 1 }]));
    const b = overTheWire(snapshot(newMap, [{ type: 'level', x: 3, y: 12 }]));
    const merged = joinSnapshots([a, b]);
    expect(merged.levelIndex).toBe(1);
    expect(merged.events).toEqual([{ type: 'level', x: 3, y: 12 }]);
  });
});

describe('rooms', () => {
  it('makes room names the relay accepts', () => {
    expect(newRoomId(fixed(0))).toBe('aaaaaa');
    expect(isRoomId(newRoomId())).toBe(true);
    expect(isRoomId('AB')).toBe(false);
    expect(isRoomId(null)).toBe(false);
  });

  it('tells when the input changed', () => {
    expect(sameInput(IDLE, { dir: null, fire: false })).toBe(true);
    expect(sameInput(IDLE, { dir: 1, fire: false })).toBe(false);
    expect(sameInput(IDLE, { dir: null, fire: true })).toBe(false);
  });
});
