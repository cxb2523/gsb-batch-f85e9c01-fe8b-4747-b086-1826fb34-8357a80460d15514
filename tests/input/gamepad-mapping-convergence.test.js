/**
 * Logical input state must converge on the three paths that can change what
 * a physical input means or which device owns a slot:
 *
 *   1. mapping edits (setProfileMappingEntry / removeProfileMappingEntry /
 *      resetProfileMapping): pressed codes get 'released', analog actions get
 *      one final 0, and whatever is still physically held is latched until
 *      released, so an old-mapping press can never survive as a new-mapping
 *      held without a pressed;
 *   2. reconnects: another pad taking a slot (no disconnect event) or the same
 *      pad disconnecting and reconnecting — per-slot caches and latches can
 *      never bleed onto the new device, and inputs already held on arrival
 *      stay silent until released and pressed anew;
 *   3. mapping edits and reconnects while gameplay is suppressed: the same
 *      rules apply, and resuming never produces a 'held' without a 'pressed'.
 *
 * Every scenario drives the runtime directly through _processGamepad() with
 * synthetic gamepad objects, mirroring the other gamepad runtime tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GamepadRuntime } from '../../src/input/gamepad-runtime.js';
import { ActionRegistry } from '../../src/core/action-registry.js';
import { BindingStore } from '../../src/core/binding-store.js';

const XBOX_ID = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)';
const DS_ID = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
const PAD_A_ID = 'Pad Alpha (STANDARD GAMEPAD Vendor: 1234 Product: 0001)';
const PAD_B_ID = 'Pad Beta (STANDARD GAMEPAD Vendor: 1234 Product: 0002)';

const round = (v) => Math.round(v * 100) / 100;

function pad(id = XBOX_ID, { index = 0, pressed = [], axes = [0, 0, 0, 0], buttons = 17 } = {}) {
  return {
    id,
    index,
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: buttons }, (_, i) => ({
      pressed: pressed.includes(i),
      value: pressed.includes(i) ? 1 : 0,
    })),
    axes,
  };
}

function setup() {
  const registry = new ActionRegistry();
  const store = new BindingStore(registry);
  registry.register({ id: 'jump', label: 'Jump', slots: 1, gamepadSlots: 2 });
  registry.register({ id: 'b3', label: 'B3', slots: 1, gamepadSlots: 2 });
  registry.register({ id: 'moveX', label: 'Move X', slots: 1, gamepadSlots: 2, analog: true });
  registry.register({ id: 'move2', label: 'Move 2', slots: 1, gamepadSlots: 2, analog: true });
  store.init({});
  for (const action of registry.getAll()) store.initAction(action);
  store.set('jump', 0, 'GP_B0', 'gamepad');
  store.set('b3', 0, 'GP_B3', 'gamepad');
  store.set('moveX', 0, 'GP_A0N', 'gamepad');
  store.set('move2', 0, 'GP_A2N', 'gamepad');
  const runtime = new GamepadRuntime(store, registry, { deadband: 0.12, analogThreshold: 0.5 });
  const events = [];
  runtime.onAnyAction((e) => events.push(`${e.gamepadIndex}:${e.actionId}:${e.type}:${round(e.value)}`));
  /** Event log minus the gamepad-index prefix. */
  const log = () => events.map((line) => line.slice(line.indexOf(':') + 1));
  return { registry, store, runtime, events, log };
}

let gamepads = [];

beforeEach(() => {
  gamepads = [];
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => gamepads,
  });
});

/** Publish `pads` as the browser's current gamepad list (for the public edit API). */
function expose(...pads) {
  gamepads = pads;
}

describe('GamepadRuntime — mapping edits converge active logical inputs', () => {
  it('releases a held button on edit and latches the input still held under the new mapping', () => {
    const { runtime, log } = setup();
    const held = pad(XBOX_ID, { pressed: [3] });
    expose(held);

    runtime._processGamepad(held);                       // raw 3 -> GP_B3 held
    expect(log()).toEqual(['b3:pressed:1']);

    // GP_B0 moves onto the still-held raw 3 while the player keeps holding it.
    expect(runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 })).toBe(true);
    expect(log()).toEqual(['b3:pressed:1', 'b3:released:0']);

    runtime._processGamepad(held);                       // still holding: GP_B0 and GP_B3 latched
    expect(log()).toEqual(['b3:pressed:1', 'b3:released:0']);

    runtime._processGamepad(pad(XBOX_ID));               // release: no re-dispatch
    runtime._processGamepad(held);                       // genuine new press
    expect(log()).toEqual([
      'b3:pressed:1',
      'b3:released:0',
      'jump:pressed:1',
      'b3:pressed:1',
    ]);
  });

  it('an old-mapping press cannot survive as a new-mapping held without a pressed', () => {
    const { runtime, log } = setup();
    const holdingRaw0 = pad(XBOX_ID, { pressed: [0] });
    expose(holdingRaw0);

    runtime._processGamepad(holdingRaw0);                // jump pressed under the identity mapping
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });
    expect(log()).toEqual(['jump:pressed:1', 'jump:released:0']);

    // Raw 0 no longer drives anything: the old press has no presence in the new mapping.
    runtime._processGamepad(holdingRaw0);
    runtime._processGamepad(pad(XBOX_ID));
    expect(log()).toEqual(['jump:pressed:1', 'jump:released:0']);

    runtime._processGamepad(pad(XBOX_ID, { pressed: [3] })); // fresh press on the new raw input
    expect(log().filter((line) => line.startsWith('jump:'))).toContain('jump:pressed:1');
  });

  it('sends the analog final 0 exactly once on edit and stays silent while the old stick is held', () => {
    const { runtime, events, log } = setup();
    const held = pad(XBOX_ID, { axes: [-0.9, 0, 0, 0] });
    expose(held);

    runtime._processGamepad(held);
    const analogValues = () => events
      .filter((line) => line.includes(':analog:'))
      .map((line) => Number(line.slice(line.lastIndexOf(':') + 1)));
    expect(analogValues()).toEqual([-0.9]);
    expect(log()).toContain('moveX:pressed:0.9');

    // GP_A0N moves to raw axis 2 while the old stick is still pushed.
    runtime.setProfileMappingEntry(0, 'GP_A0N', { kind: 'axis', index: 2, direction: 'negative' });
    expect(log()).toContain('moveX:released:0');
    expect(analogValues()).toEqual([-0.9, 0]);           // one final 0

    runtime._processGamepad(held);                       // logical axis 0 is now 0: no second 0
    runtime._processGamepad(pad(XBOX_ID));
    expect(analogValues()).toEqual([-0.9, 0]);
    expect(log().filter((line) => line.startsWith('moveX:'))).toEqual([
      'moveX:analog:-0.9',
      'moveX:pressed:0.9',
      'moveX:released:0',
      'moveX:analog:0',
    ]);

    // The edited half works from its new raw axis.
    runtime._processGamepad(pad(XBOX_ID, { axes: [0, 0, -0.8, 0] }));
    expect(log()).toContain('moveX:pressed:0.8');
    expect(analogValues()).toContain(-0.8);
  });

  it('latches a held input that becomes active only because of the edit (no pressed-less events)', () => {
    const { runtime, log } = setup();
    const held = pad(XBOX_ID, { axes: [0, 0, -0.9, 0] });
    expose(held);

    runtime._processGamepad(held);                       // GP_A2N held
    expect(log()).toContain('move2:pressed:0.9');

    // GP_A0N moves onto the stick already pushed.
    runtime.setProfileMappingEntry(0, 'GP_A0N', { kind: 'axis', index: 2, direction: 'negative' });
    const digital = () => log().filter((line) => !line.includes(':analog:'));
    expect(digital()).toContain('move2:released:0');
    expect(digital()).not.toContain('moveX:pressed:0.9');

    runtime._processGamepad(held);                       // still pushed: digital stays silent
    expect(digital()).not.toContain('moveX:pressed:0.9');

    runtime._processGamepad(pad(XBOX_ID));               // release clears the latches
    runtime._processGamepad(held);                       // push again: real edges
    expect(digital()).toContain('moveX:pressed:0.9');
    expect(digital()).toContain('move2:pressed:0.9');
  });

  it('removeProfileMappingEntry converges the same way', () => {
    const { runtime, log } = setup();
    const held = pad(XBOX_ID, { pressed: [0] });
    expose(held);

    runtime._processGamepad(held);
    expect(runtime.removeProfileMappingEntry(0, 'GP_B0')).toBe(true);
    expect(log()).toEqual(['jump:pressed:1', 'jump:released:0']);

    runtime._processGamepad(held);                       // still held: latched, silent
    expect(log()).toEqual(['jump:pressed:1', 'jump:released:0']);
    runtime._processGamepad(pad(XBOX_ID));
    runtime._processGamepad(held);
    expect(log().at(-1)).toBe('jump:pressed:1');
  });

  it('resetProfileMapping converges and the restored mapping needs a fresh press', () => {
    const { runtime, log } = setup();
    expose(pad(XBOX_ID));
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });

    const held = pad(XBOX_ID, { pressed: [3] });
    expose(held);
    runtime._processGamepad(held);                       // edited GP_B0 + identity GP_B3
    expect(log()).toEqual(expect.arrayContaining(['jump:pressed:1', 'b3:pressed:1']));

    expect(runtime.resetProfileMapping(0)).toBe(true);   // back to identity while raw 3 is held
    expect(log()).toEqual(expect.arrayContaining([
      'jump:released:0',
      'b3:released:0',
    ]));

    runtime._processGamepad(held);                       // GP_B3 still held -> latched; GP_B0 inactive
    const afterReset = log().length;
    runtime._processGamepad(held);
    expect(log().length).toBe(afterReset);

    runtime._processGamepad(pad(XBOX_ID));               // release
    runtime._processGamepad(pad(XBOX_ID, { pressed: [0] })); // identity again: raw 0 drives jump
    expect(log().at(-1)).toBe('jump:pressed:1');
  });
});

describe('GamepadRuntime — reconnect paths never carry state onto the new device', () => {
  it('another pad taking the slot releases the old inputs and latches the new pad’s held inputs', () => {
    const { runtime, log } = setup();
    const padA = pad(PAD_A_ID, { pressed: [0] });
    expose(padA);
    runtime._processGamepad(padA);
    expect(log()).toEqual(['jump:pressed:1']);

    // No gamepaddisconnected in between: a different object simply appears at index 0.
    const padB = pad(PAD_B_ID, { pressed: [0] });
    expose(padB);
    runtime._processGamepad(padB);
    expect(log()).toEqual(['jump:pressed:1', 'jump:released:0']);
    // Nothing is in the pressed set without a matching press, and nothing fires while held.
    expect(runtime._pressedCodes.get(0)?.size ?? 0).toBe(0);
    runtime._processGamepad(padB);
    expect(log()).toEqual(['jump:pressed:1', 'jump:released:0']);

    runtime._processGamepad(pad(PAD_B_ID));              // release
    runtime._processGamepad(padB);                       // press anew
    expect(log().at(-1)).toBe('jump:pressed:1');
  });

  it('re-resolves the profile when the slot changes owners (no profile-cache bleed)', () => {
    const { runtime } = setup();
    const dualsense = pad(DS_ID);
    expose(dualsense);
    runtime._processGamepad(dualsense);
    expect(runtime.getResolvedProfile(0).family).toBe('dualsense');

    const xbox = pad(XBOX_ID);
    expose(xbox);
    runtime._processGamepad(xbox);
    expect(runtime.getResolvedProfile(0).family).toBe('xbox');

    // The new pad arrives holding a button: it is latched, not pressed.
    const xboxHolding = pad(XBOX_ID, { pressed: [0] });
    const runtime2 = setup().runtime;
    expose(xboxHolding);
    const ds = pad(DS_ID);
    runtime2._processGamepad(ds);
    runtime2._processGamepad(xboxHolding);
    expect(runtime2._latched.get(0)?.has('GP_B0')).toBe(true);
    expect(runtime2._pressedCodes.get(0)?.size ?? 0).toBe(0);
  });

  it('a slot swap settles only that slot and leaves the other pad’s inputs alone', () => {
    const { runtime, events } = setup();
    const pad0 = pad(PAD_A_ID, { index: 0, pressed: [0] });
    const pad1 = pad(PAD_B_ID, { index: 1, pressed: [0] });
    expose(pad0, pad1);
    runtime._processGamepad(pad0);
    runtime._processGamepad(pad1);
    events.length = 0;

    const pad0b = pad('Pad Gamma (STANDARD GAMEPAD Vendor: 1234 Product: 0003)', { index: 0 });
    expose(pad0b, pad1);
    runtime._processGamepad(pad0b);                      // slot 0 changes owners, slot 1 untouched

    const slot0 = events.filter((line) => line.startsWith('0:'));
    const slot1 = events.filter((line) => line.startsWith('1:'));
    expect(slot0).toEqual(['0:jump:released:0']);
    expect(slot1).toEqual([]);
    expect(runtime._pressedCodes.get(1)?.has('GP_B0')).toBe(true);

    runtime._processGamepad(pad1);                       // pad 1 still held: held keeps flowing
    expect(events.filter((line) => line.startsWith('1:')).at(-1)).toBe('1:jump:held:1');
  });

  it('disconnect releases every active input and a reconnect latches inputs already held', () => {
    const { runtime, log, events } = setup();
    const held = pad(XBOX_ID, { pressed: [0], axes: [-0.9, 0, 0, 0] });
    expose(held);
    runtime._processGamepad(held);

    runtime._handleDisconnect({ gamepad: held });
    expect(log()).toContain('jump:released:0');
    expect(log()).toContain('moveX:released:0');
    expect(log()).toContain('moveX:analog:0');
    expect(runtime.isPressed('GP_B0')).toBe(false);
    expect(runtime._curState.has(0)).toBe(false);
    expect(runtime._latched.has(0)).toBe(false);

    // Reconnect with the button and stick still physically held.
    runtime._handleConnect({ gamepad: held });
    runtime._processGamepad(held);
    events.length = 0;                                    // everything after the reconnect
    runtime._processGamepad(held);
    const digital = () => events
      .map((line) => line.slice(line.indexOf(':') + 1))
      .filter((line) => !line.includes(':analog:'));
    expect(digital()).not.toContain('jump:pressed:1');
    expect(digital()).not.toContain('moveX:pressed:0.9');
    expect(runtime._latched.get(0)?.has('GP_B0')).toBe(true);

    runtime._processGamepad(pad(XBOX_ID));               // release everything
    runtime._processGamepad(held);                       // genuine re-press
    expect(digital()).toContain('jump:pressed:1');
    expect(digital()).toContain('moveX:pressed:0.9');
  });

  it('in-memory mapping edits still apply after a reconnect, and held edited inputs stay silent', () => {
    const { runtime, log } = setup();
    expose(pad(XBOX_ID));
    expect(runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 })).toBe(true);

    runtime._handleDisconnect({ gamepad: pad(XBOX_ID) });
    const holdingRaw3 = pad(XBOX_ID, { pressed: [3] });
    expose(holdingRaw3);
    runtime._handleConnect({ gamepad: holdingRaw3 });    // already holding the edited raw button
    expect(runtime.getResolvedProfile(0).source).toBe('memory-edit');

    runtime._processGamepad(holdingRaw3);
    expect(log()).toEqual([]);                           // latched: no pressed-less held

    runtime._processGamepad(pad(XBOX_ID));
    runtime._processGamepad(holdingRaw3);
    expect(log()).toEqual(expect.arrayContaining(['jump:pressed:1', 'b3:pressed:1']));
  });

  it('cancels an in-progress capture when the slot changes owners', () => {
    const { runtime } = setup();
    const padA = pad(PAD_A_ID);
    expose(padA);
    runtime._processGamepad(padA);
    let captured = 'NOT_SET';
    runtime.startCapture((code) => { captured = code; });

    const padB = pad(PAD_B_ID);
    expose(padB);
    runtime._processGamepad(padB);
    expect(captured).toBeNull();
  });
});

describe('GamepadRuntime — edits and reconnects while gameplay is suppressed', () => {
  it('an edit while suppressed never yields a held without a pressed after resume', () => {
    const { runtime, log } = setup();
    const holdingRaw0 = pad(XBOX_ID, { pressed: [0] });
    expose(holdingRaw0);
    runtime._processGamepad(holdingRaw0);
    runtime.setGameplaySuppressed(true);                 // released + latched
    expect(log()).toEqual(['jump:pressed:1', 'jump:released:0']);

    // Edit while the modal is open and the button is still held.
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });
    runtime.setGameplaySuppressed(false);
    runtime._processGamepad(holdingRaw0);                // raw 0 is unmapped now: nothing
    expect(log()).toEqual(['jump:pressed:1', 'jump:released:0']);

    runtime._processGamepad(pad(XBOX_ID, { pressed: [3] })); // fresh press under the new mapping
    expect(log().filter((line) => line.startsWith('jump:'))).toContain('jump:pressed:1');
  });

  it('an input held during suppression that the edit activates is latched through resume', () => {
    const { runtime, log } = setup();
    expose(pad(XBOX_ID));
    runtime.setGameplaySuppressed(true);

    const holdingRaw3 = pad(XBOX_ID, { pressed: [3] });
    expose(holdingRaw3);
    runtime._processGamepad(holdingRaw3);                // baseline only while suppressed
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });

    runtime.setGameplaySuppressed(false);
    runtime._processGamepad(holdingRaw3);                // still held: silent
    expect(log()).toEqual([]);

    runtime._processGamepad(pad(XBOX_ID));
    runtime._processGamepad(holdingRaw3);
    expect(log()).toEqual(expect.arrayContaining(['jump:pressed:1', 'b3:pressed:1']));
  });

  it('a latch created by an edit clears when the input is released while suppressed', () => {
    const { runtime, log } = setup();
    const holdingRaw3 = pad(XBOX_ID, { pressed: [3] });
    expose(holdingRaw3);
    runtime._processGamepad(holdingRaw3);
    runtime.setProfileMappingEntry(0, 'GP_B0', { kind: 'button', index: 3 });
    expect(runtime._latched.get(0)?.has('GP_B0')).toBe(true);

    runtime.setGameplaySuppressed(true);
    runtime._processGamepad(pad(XBOX_ID));               // released while suppressed
    expect(runtime._latched.get(0)?.has('GP_B0') ?? false).toBe(false);
    runtime.setGameplaySuppressed(false);

    runtime._processGamepad(holdingRaw3);                // first press after resume fires
    expect(log()).toContain('jump:pressed:1');
  });

  it('a connect while suppressed latches the held input and resume stays silent', () => {
    const { runtime, log } = setup();
    runtime.setGameplaySuppressed(true);
    const held = pad(XBOX_ID, { pressed: [0] });
    expose(held);
    runtime._handleConnect({ gamepad: held });

    runtime.setGameplaySuppressed(false);
    runtime._processGamepad(held);
    expect(log()).toEqual([]);

    runtime._processGamepad(pad(XBOX_ID));
    runtime._processGamepad(held);
    expect(log()).toEqual(['jump:pressed:1']);
  });

  it('a disconnect while suppressed settles the slot and the reconnect still latches', () => {
    const { runtime, log } = setup();
    const held = pad(XBOX_ID, { pressed: [0] });
    expose(held);
    runtime._processGamepad(held);
    runtime.setGameplaySuppressed(true);                 // already released here
    const eventsAtSuppress = log().length;

    runtime._handleDisconnect({ gamepad: held });
    expect(log().length).toBe(eventsAtSuppress);         // no duplicate releases
    runtime._handleConnect({ gamepad: held });           // still held on reconnect
    runtime.setGameplaySuppressed(false);
    runtime._processGamepad(held);
    expect(log().filter((line) => line.endsWith(':held:1'))).toEqual([]);

    runtime._processGamepad(pad(XBOX_ID));
    runtime._processGamepad(held);
    expect(log().at(-1)).toBe('jump:pressed:1');
  });

  it('an analog edit while suppressed sends no second final 0 after resume', () => {
    const { runtime, events } = setup();
    const held = pad(XBOX_ID, { axes: [-0.9, 0, 0, 0] });
    expose(held);
    runtime._processGamepad(held);
    runtime.setGameplaySuppressed(true);                 // final analog 0 already sent here
    const analogValues = () => events
      .filter((line) => line.includes(':analog:'))
      .map((line) => Number(line.slice(line.lastIndexOf(':') + 1)));
    expect(analogValues()).toEqual([-0.9, 0]);

    runtime.setProfileMappingEntry(0, 'GP_A0N', { kind: 'axis', index: 2, direction: 'negative' });
    runtime.setGameplaySuppressed(false);
    runtime._processGamepad(held);                       // old stick held, logical axis 0 is 0
    runtime._processGamepad(pad(XBOX_ID));
    expect(analogValues()).toEqual([-0.9, 0]);
  });
});
