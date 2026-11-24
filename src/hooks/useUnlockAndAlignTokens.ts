import { useCallback } from 'react';
import { realignTokensAtCoord } from '../game/tokens/alignment';
import { TOKEN_START_COORDINATES } from '../game/tokens/constants';
import { unlockToken } from '../state/slices/playersSlice';
import type { TTokenColourAndId } from '../types';
import { useDispatch, useStore } from 'react-redux';
import type { AppDispatch, RootState } from '../state/store';

export const useUnlockAndAlignTokens = () => {
  const dispatch = useDispatch<AppDispatch>();
  const store = useStore<RootState>();
  return useCallback(
    ({ colour, id }: TTokenColourAndId) => {
      dispatch(unlockToken({ colour, id }));
      // Read the players only AFTER the unlock so the start tile group size
      // already includes the newly unlocked token. Tokens that were already
      // waiting on the start tile get realigned to the new, larger group.
      const players = store.getState().players.players;
      const tokenStartCoord = TOKEN_START_COORDINATES[colour];
      realignTokensAtCoord(tokenStartCoord, players, dispatch);
    },
    [dispatch, store]
  );
};
