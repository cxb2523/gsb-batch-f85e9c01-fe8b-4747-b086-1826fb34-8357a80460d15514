import { describe, it, expect, assert, vi } from 'vitest';
import { expandTokenPath, getIntegersBetween, tokenPaths } from '../../src/game/tokens/paths';
import type { TCoordinate, TPlayer, TPlayerColour, TToken, TTokenPath } from '../../src/types';
import { playerSequences } from '../../src/game/players/constants';
import { genLockedTokens } from '../../src/game/tokens/factory';
import {
  applyAlignmentData,
  defaultTokenAlignmentData,
  getTokenAlignmentData,
  realignTokensAtCoord,
  tokenAlignmentData,
} from '../../src/game/tokens/alignment';
import { TOKEN_LOCKED_COORDINATES } from '../../src/game/tokens/constants';
import { DUMMY_PLAYERS } from '../fixtures/players.dummy';
import {
  getAvailableSteps,
  getStepsFromStart,
  getTokenAriaLabel,
  isAnyTokenActiveOfColour,
  isTokenMovable,
  tokensWithCoord,
} from '../../src/game/tokens/logic';
import { DUMMY_TOKEN } from '../fixtures/token.dummy';
import { getHomeCoordForColour } from '../../src/game/coords/logic';

describe('Test tokens/paths', () => {
  describe('getIntegersBetween', () => {
    it('should return inclusive range from a to b when a < b', () => {
      expect(getIntegersBetween(2, 5)).toEqual([2, 3, 4, 5]);
    });

    it('should return inclusive range from a to b when a > b', () => {
      expect(getIntegersBetween(5, 2)).toEqual([5, 4, 3, 2]);
    });

    it('should return array with single element when a equals b', () => {
      expect(getIntegersBetween(3, 3)).toEqual([3]);
    });

    it('should handle inclusive negative ranges correctly', () => {
      expect(getIntegersBetween(-3, 0)).toEqual([-3, -2, -1, 0]);
    });
  });
  describe('expandTokenPath', () => {
    it('should expand a horizontal path into coordinates with the same y value', () => {
      const expected: TCoordinate[] = [
        { x: 5, y: 13 },
        { x: 4, y: 13 },
        { x: 3, y: 13 },
        { x: 2, y: 13 },
        { x: 1, y: 13 },
      ];
      expect(
        expandTokenPath([{ startCoords: { x: 5, y: 13 }, endCoords: { x: 1, y: 13 } }])
      ).toEqual(expected);
      expect(
        expandTokenPath([{ startCoords: { x: 1, y: 13 }, endCoords: { x: 5, y: 13 } }])
      ).toEqual([...expected].reverse());
    });
    it('should expand a vertical path into coordinates with the same x value', () => {
      const expected: TCoordinate[] = [
        { x: 1, y: 9 },
        { x: 1, y: 10 },
        { x: 1, y: 11 },
        { x: 1, y: 12 },
        { x: 1, y: 13 },
      ];
      expect(
        expandTokenPath([{ startCoords: { x: 1, y: 9 }, endCoords: { x: 1, y: 13 } }])
      ).toEqual(expected);
      expect(
        expandTokenPath([{ startCoords: { x: 1, y: 13 }, endCoords: { x: 1, y: 9 } }])
      ).toEqual([...expected].reverse());
    });
    it('should handle multiple token paths and concatenate the results', () => {
      const tokenPaths: TTokenPath[] = [
        {
          startCoords: { x: 6, y: 13 },
          endCoords: { x: 6, y: 9 },
        },
        {
          startCoords: { x: 5, y: 8 },
          endCoords: { x: 1, y: 8 },
        },
      ];
      const expected: TCoordinate[] = [
        { x: 6, y: 13 },
        { x: 6, y: 12 },
        { x: 6, y: 11 },
        { x: 6, y: 10 },
        { x: 6, y: 9 },
        { x: 5, y: 8 },
        { x: 4, y: 8 },
        { x: 3, y: 8 },
        { x: 2, y: 8 },
        { x: 1, y: 8 },
      ];
      expect(expandTokenPath(tokenPaths)).toEqual(expected);
    });
    it('should return an empty array for an empty input', () => {
      expect(expandTokenPath([])).toEqual([]);
    });
  });
});

describe('Test tokens/factory', () => {
  describe('genLockedTokens', () => {
    it.each(playerSequences.four)('should generate locked tokens for %s player', (colour) => {
      const lockedTokens = genLockedTokens(colour);
      expect(lockedTokens).toHaveLength(4);

      lockedTokens.forEach((t, i) => {
        const coordinateList = TOKEN_LOCKED_COORDINATES[colour];
        expect(t.colour).toBe(colour);
        expect(t.id).toBe(i);
        expect(t.hasTokenReachedHome).toBe(false);
        expect(t.isActive).toBe(false);
        expect(t.isLocked).toBe(true);
        expect(t.tokenAlignmentData).toEqual(defaultTokenAlignmentData);
        expect(t.coordinates).toBe(coordinateList[i]);
        expect(t.initialCoords).toBe(coordinateList[i]);
      });
    });
    it('should throw error if player colour is invalid', () => {
      expect(() => genLockedTokens('white' as never)).toThrow();
    });
  });
});

describe('Test tokens/alignment', () => {
  describe('getTokenAlignmentData', () => {
    it('returns alignment data array matching the number of tokens requested', () => {
      expect(getTokenAlignmentData(3)).toEqual(tokenAlignmentData[3]);
      expect(getTokenAlignmentData(7)).toEqual(tokenAlignmentData[7]);
      expect(getTokenAlignmentData(16)).toEqual(tokenAlignmentData[16]);
    });
    it('throws error for invalid token count', () => {
      expect(() => getTokenAlignmentData(17)).toThrow();
      expect(() => getTokenAlignmentData(0)).toThrow();
      expect(() => getTokenAlignmentData(-1)).toThrow();
    });
  });
  describe('applyAlignmentData', () => {
    it('should throw an error if not all tokens have the same coordinate', () => {
      const tokens: TToken[] = [
        { ...DUMMY_TOKEN, colour: 'blue', id: 0, coordinates: { x: 6, y: 11 } },
        { ...DUMMY_TOKEN, colour: 'blue', id: 1, coordinates: { x: 8, y: 13 } },
        { ...DUMMY_TOKEN, colour: 'green', id: 0, coordinates: { x: 11, y: 8 } },
      ];
      expect(() => applyAlignmentData(tokens, vi.fn())).toThrow();
    });
    it('should be a no-op (without throwing) for an empty group', () => {
      const dispatch = vi.fn();
      expect(() => applyAlignmentData([], dispatch)).not.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
    });
  });

  describe('realignTokensAtCoord', () => {
    const buildStackedPlayers = (coord: TCoordinate, specs: [TPlayerColour, number][]) => {
      const players = structuredClone(DUMMY_PLAYERS);
      specs.forEach(([colour, id]) => {
        const token = players.find((p) => p.colour === colour)!.tokens[id];
        token.isLocked = false;
        token.coordinates = coord;
        token.tokenAlignmentData = { xOffset: 0.9, yOffset: -0.9, scaleFactor: 0.1 };
      });
      return players;
    };

    it('recomputes alignment for every token currently on the tile', () => {
      const coord = { x: 6, y: 11 };
      const players = buildStackedPlayers(coord, [
        ['blue', 0],
        ['blue', 1],
        ['green', 2],
      ]);
      const dispatch = vi.fn();

      realignTokensAtCoord(coord, players, dispatch);

      expect(dispatch).toHaveBeenCalledTimes(3);
      const alignmentForThree = getTokenAlignmentData(3);
      const expectedSpecs: [TPlayerColour, number][] = [
        ['blue', 0],
        ['blue', 1],
        ['green', 2],
      ];
      expectedSpecs.forEach(([colour, id], index) => {
        expect(dispatch).toHaveBeenCalledWith({
          type: 'players/setTokenAlignmentData',
          payload: {
            colour,
            id,
            newAlignmentData: alignmentForThree[index],
          },
        });
      });
    });

    it('restores the default alignment for a single remaining token after another token leaves', () => {
      const coord = { x: 6, y: 11 };
      // Simulates the post-move state: only one token remains on the tile and
      // it still carries the stale alignment of the former two-token group.
      const players = buildStackedPlayers(coord, [['red', 0]]);
      const dispatch = vi.fn();

      realignTokensAtCoord(coord, players, dispatch);

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith({
        type: 'players/setTokenAlignmentData',
        payload: {
          colour: 'red',
          id: 0,
          newAlignmentData: defaultTokenAlignmentData,
        },
      });
    });

    it('uses the provided (post-movement) players snapshot rather than any earlier group size', () => {
      const coord = { x: 8, y: 9 };
      // Two tokens in the snapshot even though the caller used to hold a
      // three-token group before the movement happened.
      const players = buildStackedPlayers(coord, [
        ['blue', 0],
        ['yellow', 1],
      ]);
      const dispatch = vi.fn();

      realignTokensAtCoord(coord, players, dispatch);

      const alignmentForTwo = getTokenAlignmentData(2);
      expect(dispatch).toHaveBeenNthCalledWith(1, {
        type: 'players/setTokenAlignmentData',
        payload: { colour: 'blue', id: 0, newAlignmentData: alignmentForTwo[0] },
      });
      expect(dispatch).toHaveBeenNthCalledWith(2, {
        type: 'players/setTokenAlignmentData',
        payload: { colour: 'yellow', id: 1, newAlignmentData: alignmentForTwo[1] },
      });
    });

    it('does nothing and never throws when the tile is empty', () => {
      const players = structuredClone(DUMMY_PLAYERS);
      const dispatch = vi.fn();

      expect(() => realignTokensAtCoord({ x: 7, y: 10 }, players, dispatch)).not.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('never invokes alignment computation with an inconsistent (mixed-coordinate) group', () => {
      const coord = { x: 6, y: 11 };
      const players = buildStackedPlayers(coord, [['blue', 0]]);
      // Tamper with the group so tokensWithCoord and the coord argument disagree.
      players.find((p) => p.colour === 'blue')!.tokens[0].coordinates = { x: 0, y: 0 };
      const dispatch = vi.fn();

      expect(() => realignTokensAtCoord(coord, players, dispatch)).not.toThrow();
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});

describe('Test tokens/logic', () => {
  describe('isAnyTokenActiveOfColour', () => {
    it('returns true if any player has an active token of the specified colour', () => {
      const players = structuredClone(DUMMY_PLAYERS);
      const player = players.find((p) => p.colour === 'blue');
      player!.tokens[0].isActive = true;
      expect(isAnyTokenActiveOfColour('blue', players)).toBe(true);
    });
    it('returns false if no player has an active token of the specified colour', () => {
      const players = DUMMY_PLAYERS;
      expect(isAnyTokenActiveOfColour('blue', players)).toBe(false);
    });
    it('returns false if the specified player is missing or has no tokens', () => {
      expect(isAnyTokenActiveOfColour('white' as never, DUMMY_PLAYERS)).toBe(false);
      (structuredClone(DUMMY_PLAYERS).find((p) => p.colour === 'blue')!
        .tokens as unknown as undefined) = undefined;
      expect(isAnyTokenActiveOfColour('blue', DUMMY_PLAYERS)).toBe(false);
    });
  });

  describe('tokensWithCoord', () => {
    it('returns all tokens from all players with the specified coordinate', () => {
      const players = structuredClone(DUMMY_PLAYERS);
      const bluePlayerTokens = (players.find((p) => p.colour === 'blue') as TPlayer).tokens;
      const greenPlayerTokens = (players.find((p) => p.colour === 'green') as TPlayer).tokens;
      const commonCoord = { x: 6, y: 11 };

      bluePlayerTokens[0].coordinates = commonCoord;
      bluePlayerTokens[1].coordinates = commonCoord;
      greenPlayerTokens[2].coordinates = commonCoord;

      const expected = [bluePlayerTokens[0], bluePlayerTokens[1], greenPlayerTokens[2]];

      assert.sameDeepMembers(tokensWithCoord(commonCoord, players), expected);
    });
    it('returns an empty array if no tokens match the specified coordinate', () => {
      expect(tokensWithCoord({ x: 7, y: 10 }, DUMMY_PLAYERS)).toEqual([]);
    });
    it('returns an empty array if players array is empty', () => {
      expect(tokensWithCoord({ x: 7, y: 10 }, [])).toEqual([]);
    });
  });
  describe('getAvailableSteps', () => {
    it('returns the correct number of available steps for a token at a given coordinate and colour', () => {
      const token: TToken = { ...DUMMY_TOKEN, colour: 'blue', coordinates: { x: 7, y: 13 } };
      expect(getAvailableSteps(token)).toBe(5);
    });
    it('returns zero if the token is at a position with no available moves', () => {
      const token: TToken = {
        ...DUMMY_TOKEN,
        colour: 'blue',
        coordinates: getHomeCoordForColour('blue'),
      };
      expect(getAvailableSteps(token)).toBe(0);
    });
  });
  describe('getStepsFromStart', () => {
    it('returns the correct number of steps taken from start for a token at a given coordinate and colour', () => {
      const token: TToken = { ...DUMMY_TOKEN, colour: 'blue', coordinates: { x: 6, y: 9 } };
      expect(getStepsFromStart(token)).toBe(4);
    });
    it('returns zero if the token is at home', () => {
      const token: TToken = {
        ...DUMMY_TOKEN,
        colour: 'blue',
        coordinates: tokenPaths.blue[0],
      };
      expect(getStepsFromStart(token)).toBe(0);
    });
  });
  describe('getTokenAriaLabel', () => {
    it('returns the "locked in base" label when the token is locked and has not reached home', () => {
      expect(getTokenAriaLabel('blue', 0, true, false, 0)).toBe('blue token 1, locked in base');
    });

    it('returns the "at home" label when the token is locked and has reached home', () => {
      expect(getTokenAriaLabel('green', 2, true, true, 56)).toBe('green token 3, at home');
    });

    it('returns the steps-from-start label when the token is unlocked', () => {
      expect(getTokenAriaLabel('red', 1, false, false, 12)).toBe(
        'red token 2, 12 steps from start'
      );
    });
  });
  describe('isTokenMovable', () => {
    it.each([
      [true, false, false, { x: 6, y: 9 }],
      [false, true, false, { x: 6, y: 9 }],
      [false, false, true, { x: 6, y: 9 }],
      [false, false, false, { x: 7, y: 9 }],
    ])(
      'return %s if isLocked is %s and hasTokenReachedHome is %s and token is at coordinate %o',
      (expected, isLocked, hasTokenReachedHome, coordinates) => {
        const token: TToken = {
          ...DUMMY_TOKEN,
          colour: 'blue',
          coordinates,
          isLocked,
          hasTokenReachedHome,
        };
        expect(isTokenMovable(token, 5)).toBe(expected);
      }
    );
  });
});
