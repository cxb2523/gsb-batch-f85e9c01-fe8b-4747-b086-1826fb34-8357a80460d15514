import { BULLET_SPEED } from './tanky-town-bullets';
import { DX, DY, parseLevel, type Tile } from './tanky-town-level';
import { SPEED, type Input, type TankEvent, type World } from './tanky-town-state';

const CODES: Tile[] = ['empty', 'brick', 'cracked', 'steel', 'water', 'bush', 'cake'];
const ROOM_ID = /^[a-z0-9]{4,12}$/;
const ROOM_LETTERS = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * What the host sends about 30 times a second: the whole game, tiles packed one digit each.
 * `phase` and `clearIn` travel too, so the friend can stop on the level-clear pause, follow
 * the host to the next map, or freeze on the end screen without guessing the lifecycle.
 */
export type Snapshot = Pick<
  World,
  | 'levelIndex'
  | 'tanks'
  | 'bullets'
  | 'pickup'
  | 'queue'
  | 'lives'
  | 'score'
  | 'kills'
  | 'phase'
  | 'clearIn'
  | 'players'
> & { tiles: string; events: TankEvent[] };

/** The only messages the two players exchange. */
export type NetMessage = { t: 'snap'; s: Snapshot } | ({ t: 'input' } & Input) | { t: 'again' };

export function snapshot(world: World, events: TankEvent[]): Snapshot {
  return {
    levelIndex: world.levelIndex,
    tiles: world.tiles.map((tile) => CODES.indexOf(tile)).join(''),
    tanks: world.tanks,
    bullets: world.bullets,
    pickup: world.pickup,
    queue: world.queue,
    lives: world.lives,
    score: world.score,
    kills: world.kills,
    phase: world.phase,
    clearIn: world.clearIn,
    players: world.players,
    events,
  };
}

/**
 * Guest side: the host's picture replaces the local one. A new level index swaps the map and
 * starts the level clean, so no bullet, heart or event from the old map can linger. Events are
 * replaced too: the snapshot is the whole truth between two sends, never a delta to pile up.
 */
export function applySnapshot(world: World, snap: Snapshot) {
  const { tiles, events, levelIndex } = snap;
  if (levelIndex !== world.levelIndex) world.level = parseLevel(levelIndex);
  world.levelIndex = levelIndex;
  world.tiles = [...tiles].map((code) => CODES[Number(code)]);
  world.tanks = snap.tanks.map((tank) => ({ ...tank }));
  world.bullets = snap.bullets.map((bullet) => ({ ...bullet }));
  world.pickup = snap.pickup ? { ...snap.pickup } : null;
  world.queue = [...snap.queue];
  world.lives = snap.lives;
  world.score = snap.score;
  world.kills = snap.kills;
  world.phase = snap.phase;
  world.clearIn = snap.clearIn ?? 0;
  world.players = snap.players;
  // Copy the events so playing them here can never touch the host's list.
  world.events = events.map((event) => ({ ...event }));
}

/**
 * Guest side, between snapshots: only the eye moves. Tanks finish their hop and bullets keep
 * flying, but nothing is decided - no phase, no life, no score, no event. During the clear
 * pause or the end screen the world is frozen, exactly like the host's.
 */
export function coast(world: World, dt: number) {
  if (world.phase !== 'play') return;
  for (const tank of world.tanks) tank.off = Math.max(0, tank.off - SPEED[tank.kind] * dt);
  for (const bullet of world.bullets) {
    bullet.x += DX[bullet.dir] * BULLET_SPEED[bullet.owner] * dt;
    bullet.y += DY[bullet.dir] * BULLET_SPEED[bullet.owner] * dt;
  }
}

export const isRoomId = (value: unknown): value is string =>
  typeof value === 'string' && ROOM_ID.test(value);

/** Six letters that are easy to read aloud: no 0/o, 1/l/i. */
export function newRoomId(rng: () => number = Math.random) {
  const pick = () => ROOM_LETTERS[Math.floor(rng() * ROOM_LETTERS.length)];
  return Array.from({ length: 6 }, pick).join('');
}

export const sameInput = (a: Input, b: Input) => a.dir === b.dir && a.fire === b.fire;

/**
 * Folds every snapshot that arrived since the last frame into one: the newest picture wins, but
 * each event is kept once and in order, so a burst of sends can neither drop nor replay events.
 * Events from a map the host already left are dropped, so nothing from the old level leaks in.
 */
export function joinSnapshots(snaps: Snapshot[]): Snapshot {
  if (snaps.length === 1) return snaps[0];
  const latest = snaps[snaps.length - 1];
  const events = snaps
    .filter((snap) => snap.levelIndex === latest.levelIndex)
    .flatMap((snap) => snap.events);
  return { ...latest, events };
}
