import { inputManager } from './inputManager';
import { audioManager } from './audio';

/**
 * True while `resetGameSession` is tearing the session down. Gameplay handlers
 * use it to ignore the synthetic release notifications emitted by the reset
 * instead of treating them as player input.
 */
let resetting = false;

export function isSessionResetting(): boolean {
  return resetting;
}

/**
 * Brings the whole input/audio session back to a clean state.
 *
 * Must be called whenever the player leaves the game, reaches the result
 * screen, restarts or switches levels: clearing the held-key bookkeeping and
 * stopping every sounding note guarantees the next level starts silent and
 * without stuck keys.
 */
export function resetGameSession(): void {
  if (resetting) {
    // Nested reset (e.g. level completion while a screen reset is running):
    // the outer call already covers everything.
    return;
  }

  resetting = true;
  try {
    inputManager.reset();
    audioManager.releaseAll();
  } finally {
    resetting = false;
  }
}
