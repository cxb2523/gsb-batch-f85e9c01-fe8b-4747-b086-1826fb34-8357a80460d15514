import { useEffect } from 'react';
import { audioManager } from '../lib/audio';
import { inputManager } from '../lib/inputManager';
import { CODE_TO_GAME_KEY } from '../lib/keyMap';

/**
 * Plays the note for a key whenever that key becomes (truly) pressed and
 * releases it when the last source lets go.
 *
 * Mounted once at the root: listening to the shared input manager (instead of
 * raw keyboard events) means touch presses are audible too, and a key held by
 * both touch and keyboard only sounds until both have released it.
 */
export function useGlobalAudio() {
  useEffect(() => {
    const unsubscribe = inputManager.subscribe((code, pressed) => {
      const gameKey = CODE_TO_GAME_KEY[code];
      if (!gameKey) return;

      if (pressed) {
        if (!audioManager.isInitialized()) {
          // Kicks off initialization when needed; playNote also stores the
          // intent so the note is not lost if the context is still warming up.
          void audioManager.start();
        }
        audioManager.playNote(gameKey.note);
      } else {
        audioManager.releaseNote(gameKey.note);
      }
    });

    return () => {
      unsubscribe();
      audioManager.releaseAll();
    };
  }, []);

  // Some browsers only unlock audio from a user gesture; warm the context up on
  // the first tap/click. Key presses do this as well.
  useEffect(() => {
    const warmUp = () => {
      void audioManager.start();
    };
    window.addEventListener('pointerdown', warmUp, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', warmUp);
    };
  }, []);
}
