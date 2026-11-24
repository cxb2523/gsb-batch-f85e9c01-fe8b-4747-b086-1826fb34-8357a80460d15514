import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { screenAtom } from '../atoms/gameAtoms';
import { inputManager, KEYBOARD_SOURCE } from '../lib/inputManager';

/**
 * The level select screen is also playable with the keyboard (each key sounds a
 * note). Presses flow through the shared input manager via `useKeyboardInput`;
 * this hook only makes sure nothing stays held when the menu is left or the
 * window loses focus.
 */
export function useMenuKeyboard() {
  const currentScreen = useAtomValue(screenAtom);

  useEffect(() => {
    if (currentScreen !== 'levelSelect') {
      return;
    }

    const releaseMenuKeys = () => {
      inputManager.releaseSource(KEYBOARD_SOURCE);
    };

    window.addEventListener('blur', releaseMenuKeys);
    return () => {
      window.removeEventListener('blur', releaseMenuKeys);
      releaseMenuKeys();
    };
  }, [currentScreen]);
}
