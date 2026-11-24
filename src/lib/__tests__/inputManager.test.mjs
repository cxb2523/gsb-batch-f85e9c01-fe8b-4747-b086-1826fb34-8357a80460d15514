/**
 * Standalone checks for the input bookkeeping invariants.
 *
 * Uses Node's built-in test runner and its native TypeScript type-stripping, so
 * no extra dependencies are needed:
 *   node --test src/lib/__tests__/inputManager.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InputManager,
  KEYBOARD_SOURCE,
  touchSource,
} from '../inputManager.ts';

const A = 'KeyA';
const S = 'KeyS';

test('a single source press/release emits exactly one transition', () => {
  const manager = new InputManager();
  const events = [];
  manager.subscribe((code, pressed) => events.push([code, pressed]));

  assert.equal(manager.press(A, 'k1'), true);
  assert.equal(manager.press(A, 'k1'), false, 'repeat press is ignored');
  assert.equal(manager.release(A, 'k1'), true);
  assert.equal(manager.release(A, 'k1'), false, 'release without press is ignored');

  assert.deepEqual(events, [[A, true], [A, false]]);
});

test('two sources on the same key only release when the last lets go', () => {
  const manager = new InputManager();
  const events = [];
  manager.subscribe((code, pressed) => events.push([code, pressed]));

  manager.press(A, KEYBOARD_SOURCE);
  manager.press(A, touchSource(1));
  manager.release(A, touchSource(1));

  assert.equal(manager.isPressed(A), true, 'keyboard still holds it');
  assert.equal(manager.release(A, KEYBOARD_SOURCE), true);
  assert.equal(manager.isPressed(A), false);

  assert.deepEqual(events, [[A, true], [A, false]]);
});

test('two fingers on different keys release independently', () => {
  const manager = new InputManager();
  manager.press(A, touchSource(1));
  manager.press(S, touchSource(2));

  manager.release(A, touchSource(1));
  assert.equal(manager.isPressed(A), false);
  assert.equal(manager.isPressed(S), true);

  manager.release(S, touchSource(2));
  assert.deepEqual(manager.getActiveCodes(), []);
});

test('sliding a finger from one key to another releases first', () => {
  const manager = new InputManager();
  const source = touchSource(7);
  const events = [];
  manager.subscribe((code, pressed) => events.push([code, pressed]));

  manager.press(A, source);
  manager.release(A, source);
  manager.press(S, source);

  assert.deepEqual(events, [[A, true], [A, false], [S, true]]);
  assert.equal(manager.isPressed(A), false);
  assert.equal(manager.isPressed(S), true);
});

test('releaseSourcePrefix releases only matching sources', () => {
  const manager = new InputManager();
  manager.press(A, KEYBOARD_SOURCE);
  manager.press(S, touchSource(3));
  manager.press(S, touchSource(4));

  manager.releaseSourcePrefix('touch:');
  assert.equal(manager.isPressed(A), true, 'keyboard untouched');
  assert.equal(manager.isPressed(S), false);
});

test('reset releases everything and fires one release per key', () => {
  const manager = new InputManager();
  manager.press(A, KEYBOARD_SOURCE);
  manager.press(A, touchSource(1));
  manager.press(S, touchSource(2));

  const releases = [];
  manager.subscribe((code, pressed) => {
    if (!pressed) releases.push(code);
  });

  manager.reset();
  assert.deepEqual(releases.sort(), [A, S]);
  assert.deepEqual(manager.getActiveCodes(), []);

  // The same source can press again after a reset.
  manager.press(A, KEYBOARD_SOURCE);
  assert.equal(manager.isPressed(A), true);
});

test('unknown keys are ignored', () => {
  const manager = new InputManager();
  assert.equal(manager.press('KeyQ', KEYBOARD_SOURCE), false);
  assert.deepEqual(manager.getActiveCodes(), []);
});
