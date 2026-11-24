import { describe, expect, it } from 'vitest';
import { configureStore, type EnhancedStore } from '@reduxjs/toolkit';
import playersReducer, {
  lockToken,
  markTokenAsReachedHome,
  setTokenAlignmentData,
  unlockToken,
  updateTokenCoordinatesAndDirection,
} from '../../src/state/slices/playersSlice';
import boardReducer, { initialState as boardInitialState } from '../../src/state/slices/boardSlice';
import diceReducer, { initialState as diceInitialState } from '../../src/state/slices/diceSlice';
import sessionReducer, {
  initialState as sessionInitialState,
} from '../../src/state/slices/sessionSlice';
import {
  defaultTokenAlignmentData,
  getTokenAlignmentData,
  realignTokensAtCoord,
} from '../../src/game/tokens/alignment';
import { TOKEN_START_COORDINATES } from '../../src/game/tokens/constants';
import { tokenPaths } from '../../src/game/tokens/paths';
import { tokensWithCoord } from '../../src/game/tokens/logic';
import { getToken } from '../../src/state/slices/playersSlice';
import type { RootState } from '../../src/state/store';
import type { TPlayerColour } from '../../src/types';
import { DUMMY_PLAYERS } from '../fixtures/players.dummy';

type TPlayerState = RootState['players'];

const playersPreloadedState: TPlayerState = {
  players: structuredClone(DUMMY_PLAYERS),
  currentPlayerColour: 'blue',
  playerSequence: ['blue', 'red', 'green', 'yellow'],
  isAnyTokenMoving: false,
  isGameEnded: false,
  playerFinishOrder: [],
};

function buildStore(): EnhancedStore<RootState> {
  return configureStore({
    reducer: {
      players: playersReducer,
      board: boardReducer,
      dice: diceReducer,
      session: sessionReducer,
    },
    preloadedState: {
      players: playersPreloadedState,
      board: boardInitialState,
      dice: diceInitialState,
      session: sessionInitialState,
    },
  });
}

const placeToken = (
  store: EnhancedStore<RootState>,
  colour: TPlayerColour,
  id: number,
  coord: { x: number; y: number }
) => {
  if (getToken(store.getState().players, colour, id).isLocked) {
    store.dispatch(unlockToken({ colour, id }));
  }
  store.dispatch(
    updateTokenCoordinatesAndDirection({ colour, id, newCoords: coord, direction: 'forward' })
  );
};

describe('alignment chain through a real redux store', () => {
  it('restores default alignment for the one token remaining after an opponent is captured back to base', () => {
    const store = buildStore();
    const contestedCoord = { x: 6, y: 11 };
    placeToken(store, 'blue', 0, contestedCoord);
    placeToken(store, 'red', 0, contestedCoord);
    // Both currently share the two-token stacked alignment.
    realignTokensAtCoord(contestedCoord, store.getState().players.players, store.dispatch);
    expect(getToken(store.getState().players, 'red', 0).tokenAlignmentData).toEqual(
      getTokenAlignmentData(2)[1]
    );

    // Capture: red gets its default alignment restored, is knocked back to its
    // base coordinate, and the contested tile is realigned from the
    // POST-capture store state (see useCaptureTokenInSameCoord).
    store.dispatch(
      setTokenAlignmentData({ colour: 'red', id: 0, newAlignmentData: defaultTokenAlignmentData })
    );
    store.dispatch(lockToken({ colour: 'red', id: 0 }));
    realignTokensAtCoord(contestedCoord, store.getState().players.players, store.dispatch);

    const redAfterCapture = getToken(store.getState().players, 'red', 0);
    expect(redAfterCapture.isLocked).toBe(true);
    expect(redAfterCapture.tokenAlignmentData).toEqual(defaultTokenAlignmentData);
    expect(tokensWithCoord(contestedCoord, store.getState().players.players)).toHaveLength(1);
    // The blue token was the second member of the former two-token group; after
    // the capture it is the sole remaining token and gets the single-token
    // (default) alignment computed from the post-capture store state.
    expect(getToken(store.getState().players, 'blue', 0).tokenAlignmentData).toEqual(
      defaultTokenAlignmentData
    );
  });

  it('realigns the tile a token leaves when it reaches home', () => {
    const store = buildStore();
    const lastIndex = tokenPaths.blue.length - 1;
    const formerCoord = tokenPaths.blue[lastIndex - 2];
    placeToken(store, 'blue', 0, formerCoord);
    placeToken(store, 'blue', 1, formerCoord);
    realignTokensAtCoord(formerCoord, store.getState().players.players, store.dispatch);
    expect(getToken(store.getState().players, 'blue', 1).tokenAlignmentData).toEqual(
      getTokenAlignmentData(2)[1]
    );

    // The mover advances home and is marked as reached.
    placeToken(store, 'blue', 0, tokenPaths.blue[lastIndex]);
    store.dispatch(markTokenAsReachedHome({ colour: 'blue', id: 0 }));
    realignTokensAtCoord(formerCoord, store.getState().players.players, store.dispatch);

    expect(tokensWithCoord(formerCoord, store.getState().players.players)).toEqual([
      getToken(store.getState().players, 'blue', 1),
    ]);
    expect(getToken(store.getState().players, 'blue', 1).tokenAlignmentData).toEqual(
      defaultTokenAlignmentData
    );
  });

  it('updates the start tile alignment when a locked token is unlocked onto it', () => {
    const store = buildStore();
    const startCoord = TOKEN_START_COORDINATES.blue;
    placeToken(store, 'blue', 0, startCoord);
    expect(getToken(store.getState().players, 'blue', 0).tokenAlignmentData).toEqual(
      defaultTokenAlignmentData
    );

    store.dispatch(unlockToken({ colour: 'blue', id: 1 }));
    realignTokensAtCoord(startCoord, store.getState().players.players, store.dispatch);

    const startGroup = tokensWithCoord(startCoord, store.getState().players.players);
    expect(startGroup).toHaveLength(2);
    expect(getToken(store.getState().players, 'blue', 0).tokenAlignmentData).toEqual(
      getTokenAlignmentData(2)[0]
    );
    expect(getToken(store.getState().players, 'blue', 1).tokenAlignmentData).toEqual(
      getTokenAlignmentData(2)[1]
    );
  });

  it('never throws when asked to realign an empty tile or a group whose coordinates disagree', () => {
    const store = buildStore();

    expect(() =>
      realignTokensAtCoord({ x: 7, y: 10 }, store.getState().players.players, store.dispatch)
    ).not.toThrow();

    // A tile whose stored group no longer matches the requested coordinate.
    placeToken(store, 'blue', 0, { x: 6, y: 13 });
    expect(() =>
      realignTokensAtCoord({ x: 0, y: 0 }, store.getState().players.players, store.dispatch)
    ).not.toThrow();
  });
});
