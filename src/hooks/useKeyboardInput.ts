import { useEffect } from 'react';
import { inputManager, KEYBOARD_SOURCE } from '../lib/inputManager';
import { CODE_TO_GAME_KEY } from '../lib/keyMap';

/**
 * Forwards physical keyboard presses into the shared input manager.
 *
 * This is the only place that listens to `keydown`/`keyup`, so the keyboard and
 * the touch overlay share the same press/release bookkeeping. `keyup` cannot be
 * relied on alone: if the window loses focus while a key is down the release
 * would never arrive, so the held keyboard keys are flushed on blur / hide.
 */
export function useKeyboardInput() {
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!CODE_TO_GAME_KEY[e.code]) return;
      // Let people type into form fields (e.g. the custom scale input).
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      // Auto-repeat is not a new press; without this a key held through a
      // level transition could sound again on the result screen.
      if (e.repeat) return;
      inputManager.press(e.code, KEYBOARD_SOURCE);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (!CODE_TO_GAME_KEY[e.code]) return;
      e.preventDefault();
      inputManager.release(e.code, KEYBOARD_SOURCE);
    };

    const releaseKeyboardKeys = () => {
      inputManager.releaseSource(KEYBOARD_SOURCE);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) releaseKeyboardKeys();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', releaseKeyboardKeys);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', releaseKeyboardKeys);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      releaseKeyboardKeys();
    };
  }, []);
}
