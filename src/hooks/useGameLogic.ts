import { useEffect, useCallback, useRef } from 'react';
import { useSetAtom, useAtomValue, useStore } from 'jotai';
import {
  screenAtom,
  currentLevelAtom,
  playerStateAtom,
  currentStepAtom,
  startTimeAtom,
  finalTimeAtom,
} from '../atoms/gameAtoms';
import { inputManager } from '../lib/inputManager';
import { CODE_TO_GAME_KEY, createEmptyKeyState } from '../lib/keyMap';
import { isSessionResetting, resetGameSession } from '../lib/gameSession';

export function useGameLogic() {
  const store = useStore();
  const setScreen = useSetAtom(screenAtom);
  const currentLevel = useAtomValue(currentLevelAtom);
  const setPlayerState = useSetAtom(playerStateAtom);
  const setCurrentStep = useSetAtom(currentStepAtom);
  const setStartTime = useSetAtom(startTimeAtom);
  const setFinalTime = useSetAtom(finalTimeAtom);

  // Mirror of the values the (non-React) input callbacks need. Updated
  // synchronously wherever they change, so rapid key events cannot observe a
  // stale step / level.
  const stateRef = useRef({
    currentLevel,
    currentStep: 0,
    startTime: 0,
    playerState: createEmptyKeyState(),
  });

  useEffect(() => {
    stateRef.current.currentLevel = currentLevel;
  }, [currentLevel]);

  const applyPlayerState = useCallback((nextState: number[]) => {
    stateRef.current.playerState = nextState;
    setPlayerState(nextState);
  }, [setPlayerState]);

  const resetGameState = useCallback(() => {
    resetGameSession();
    stateRef.current.currentStep = 0;
    stateRef.current.startTime = 0;
    applyPlayerState(createEmptyKeyState());
    setCurrentStep(0);
    setStartTime(0);
  }, [applyPlayerState, setCurrentStep, setStartTime]);

  const checkWinCondition = useCallback((currentState: number[]) => {
    const { currentLevel: level, currentStep: step, startTime: time } = stateRef.current;
    if (!level) return;

    const targetPattern = level.patterns[step];
    if (!targetPattern) return;

    const match = currentState.every((val, index) => val === targetPattern[index]);
    if (!match) return;

    if (step < level.patterns.length - 1) {
      const nextStep = step + 1;
      stateRef.current.currentStep = nextStep;
      setCurrentStep(nextStep);
    } else {
      // Level finished: silence everything and hand over to the result screen.
      const endTime = Date.now();
      stateRef.current.playerState = createEmptyKeyState();
      resetGameSession();
      setPlayerState(createEmptyKeyState());
      setFinalTime(endTime - time);
      setScreen('result');
    }
  }, [setCurrentStep, setFinalTime, setScreen, setPlayerState]);

  // Every input path (keyboard, touch, ...) ends up in the input manager, so
  // there is exactly one place that drives `playerState`.
  const handleKeyTransition = useCallback((code: string, pressed: boolean) => {
    const gameKey = CODE_TO_GAME_KEY[code];
    if (!gameKey) return;

    const state = stateRef.current;
    const resetting = isSessionResetting();
    // Read the live screen/level from the store/ref: always up to date even
    // inside a reset triggered by a screen change, and false while the level
    // data is still loading so those presses are not recorded.
    const gameActive =
      store.get(screenAtom) === 'game' && state.currentLevel !== null;
    const wasPressed = state.playerState[gameKey.index] === 1;

    if (pressed) {
      if (resetting || !gameActive || wasPressed) return;

      if (state.startTime === 0) {
        state.startTime = Date.now();
        setStartTime(state.startTime);
      }

      const nextState = [...state.playerState];
      nextState[gameKey.index] = 1;
      applyPlayerState(nextState);
      checkWinCondition(nextState);
    } else {
      // Always apply releases so a session reset can clear any leftover key
      // state; only run gameplay logic while the game is actually active.
      if (!wasPressed) return;

      const nextState = [...state.playerState];
      nextState[gameKey.index] = 0;
      applyPlayerState(nextState);

      if (!resetting && gameActive) {
        checkWinCondition(nextState);
      }
    }
  }, [applyPlayerState, checkWinCondition, setStartTime, store]);

  useEffect(() => {
    return inputManager.subscribe(handleKeyTransition);
  }, [handleKeyTransition]);

  // A new level (or returning to the same one) always starts from scratch.
  useEffect(() => {
    resetGameState();
  }, [currentLevel, resetGameState]);

  return { resetGameState };
}
