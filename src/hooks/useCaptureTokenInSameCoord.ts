import { useDispatch, useStore } from 'react-redux';
import {
  deactivateAllTokens,
  lockToken,
  setIsAnyTokenMoving,
  setTokenAlignmentData,
} from '../state/slices/playersSlice';
import { type TSequenceCalculationResult } from '../types';
import { type TToken } from '../types';
import { useCallback } from 'react';
import { transitionStates } from '../game/tokens/constants';
import { defaultTokenAlignmentData, realignTokensAtCoord } from '../game/tokens/alignment';
import { getGloballyUniqueTokenId } from '../game/tokens/logic';
import { useCoordsToPosition } from './useCoordsToPosition';
import { tokenMotionRegistry } from '../game/movement/tokenMotionRegistry';
import { sleep } from '../utils/sleep';
import type { RootState } from '../state/store';

export function useCaptureTokenInSameCoord() {
  const dispatch = useDispatch();
  const store = useStore<RootState>();
  const getPosition = useCoordsToPosition();

  return useCallback(
    async (
      captureData: TSequenceCalculationResult['captureData'],
      capturingToken: TToken
    ): Promise<void> => {
      dispatch(deactivateAllTokens(capturingToken.colour));
      dispatch(setIsAnyTokenMoving(true));
      dispatch(
        setTokenAlignmentData({
          colour: capturingToken.colour,
          id: capturingToken.id,
          newAlignmentData: defaultTokenAlignmentData,
        })
      );

      const { durationMs, timingFn } = transitionStates.backward;
      const animationPromises: Promise<void>[] = [];
      for (let i = 0; i < captureData.length; i++) {
        const { token, moveSequence } = captureData[i];
        const { colour, id } = token;
        const entry = tokenMotionRegistry.get(getGloballyUniqueTokenId(colour, id));
        if (!entry) continue;
        entry.setExternallyAnimating(true);
        // Tokens knocked back to base must restore their default alignment.
        dispatch(
          setTokenAlignmentData({ colour, id, newAlignmentData: defaultTokenAlignmentData })
        );
        const animateToken = async () => {
          for (const coord of moveSequence) {
            const { x, y } = getPosition(coord, defaultTokenAlignmentData);
            await entry.animateTo(x, y, { duration: durationMs / 1000, ease: timingFn });
          }
          entry.setExternallyAnimating(false);
          dispatch(lockToken({ colour, id }));
        };
        animationPromises.push(animateToken());
        if (i < captureData.length - 1) await sleep(250);
      }
      if (animationPromises.length !== 0) await Promise.all(animationPromises);

      // Every captured token was standing on the capturing token's destination
      // tile. Now that lockToken has moved them back to base, realign the
      // tokens still on that tile from the post-capture players state so the
      // survivors (e.g. a single remaining token) drop their stale offsets.
      const contestedCoord = captureData[0]?.token.coordinates;
      if (contestedCoord) {
        realignTokensAtCoord(contestedCoord, store.getState().players.players, dispatch);
      }

      dispatch(setIsAnyTokenMoving(false));
    },
    [dispatch, getPosition, store]
  );
}
