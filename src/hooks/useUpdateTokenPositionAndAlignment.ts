import { useCallback } from 'react';
import { useStore, useDispatch } from 'react-redux';
import { areCoordsEqual } from '../game/coords/logic';
import { realignTokensAtCoord } from '../game/tokens/alignment';
import { tokenPaths } from '../game/tokens/paths';
import { updateTokenCoordinatesAndDirection } from '../state/slices/playersSlice';
import type { RootState, AppDispatch } from '../state/store';
import type { TPlayerColour, TCoordinate, TTokenDirection } from '../types';

type TUpdateTokenPositionAndAlignmentParams = {
  colour: TPlayerColour;
  id: number;
  newCoords: TCoordinate;
  direction: TTokenDirection;
};

export const useUpdateTokenPositionAndAlignment = () => {
  const store = useStore<RootState>();
  const dispatch = useDispatch<AppDispatch>();
  return useCallback(
    ({ colour, id, newCoords, direction }: TUpdateTokenPositionAndAlignmentParams) => {
      dispatch(updateTokenCoordinatesAndDirection({ colour, id, newCoords, direction }));
      // Read the players only AFTER the coordinate update landed in the store so
      // every alignment recomputation is based on the post-movement state.
      const players = store.getState().players.players;
      const tokenPath = tokenPaths[colour];
      const currentCoordIndex = tokenPath.findIndex((c) => areCoordsEqual(c, newCoords));

      // Realign the tile the moving token just entered. Empty tiles are skipped
      // inside realignTokensAtCoord, so this never throws on an empty group.
      realignTokensAtCoord(newCoords, players, dispatch);

      // Realign the tile the moving token just left (its previous path tile).
      // When the coordinate is not on this token's path there is no previous
      // tile to realign.
      if (currentCoordIndex > 0) {
        const previousCoord = tokenPath[currentCoordIndex - 1];
        realignTokensAtCoord(previousCoord, players, dispatch);
      }
    },
    [dispatch, store]
  );
};
