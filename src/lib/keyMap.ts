/**
 * Shared definitions for the nine game keys.
 *
 * Both the physical keyboard, the on-screen touch zones and the game logic use
 * this single source of truth so the mapping can never drift apart.
 */

export interface GameKey {
  /** `KeyboardEvent.code` of the physical key. */
  code: string;
  /** Index inside `playerState` / the level patterns. */
  index: number;
  /** Key used to look the note up in the current scale map. */
  note: string;
  /** Label rendered in the UI. */
  label: string;
}

export const GAME_KEYS: readonly GameKey[] = [
  { code: 'KeyA', index: 0, note: 'a', label: 'A' },
  { code: 'KeyS', index: 1, note: 's', label: 'S' },
  { code: 'KeyD', index: 2, note: 'd', label: 'D' },
  { code: 'KeyF', index: 3, note: 'f', label: 'F' },
  { code: 'Space', index: 4, note: ' ', label: 'SPACE' },
  { code: 'KeyJ', index: 5, note: 'j', label: 'J' },
  { code: 'KeyK', index: 6, note: 'k', label: 'K' },
  { code: 'KeyL', index: 7, note: 'l', label: 'L' },
  { code: 'Semicolon', index: 8, note: ';', label: ';' },
];

export const CODE_TO_GAME_KEY: Readonly<Record<string, GameKey>> =
  Object.fromEntries(GAME_KEYS.map((gameKey) => [gameKey.code, gameKey]));

export const GAME_KEY_COUNT = GAME_KEYS.length;

/** Creates a fresh all-released player state array. */
export function createEmptyKeyState(): number[] {
  return Array.from({ length: GAME_KEY_COUNT }, () => 0);
}
