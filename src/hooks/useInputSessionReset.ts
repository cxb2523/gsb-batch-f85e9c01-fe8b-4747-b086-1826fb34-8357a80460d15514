import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { screenAtom } from '../atoms/gameAtoms';
import { resetGameSession } from '../lib/gameSession';

/**
 * Any screen transition (game -> result, result -> game, game -> menu, ...)
 * starts from a clean input/audio state, so no key press or note can leak into
 * the next screen or the next level.
 */
export function useInputSessionReset() {
  const screen = useAtomValue(screenAtom);

  useEffect(() => {
    resetGameSession();
  }, [screen]);
}
