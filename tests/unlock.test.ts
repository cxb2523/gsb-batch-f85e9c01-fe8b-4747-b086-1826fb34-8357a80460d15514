/*
 * The contents of this file are subject to the Common Public Attribution License
 * Version 1.0 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * https://github.com/WebWalker3D/Quackwell-General/blob/main/LICENSE. The License is
 * based on the Mozilla Public License Version 1.1 but Sections 14 and 15 have been
 * added to cover use of software over a computer network and provide for limited
 * attribution for the Original Developer. In addition, Exhibit A has been modified
 * to be consistent with Exhibit B.
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License for the
 * specific language governing rights and limitations under the License.
 *
 * The Original Code is Quackwell General.
 * The Initial Developer of the Original Code is Blaine Bouvier. All portions of the
 * code written by Blaine Bouvier are Copyright (c) 2026. All Rights Reserved.
 */
import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { createState } from '../src/sim/state';
import { ROOMS, ITEMS } from '../src/sim/catalog';
import { isItemUnlocked, isRoomUnlocked } from '../src/sim/unlocks';

function world() {
  const s = createState(3);
  s.money = 1_000_000;
  return new World(s, { autoSpawn: false });
}

describe('unlocks', () => {
  it('locks Psychiatry until researched', () => {
    const w = world();
    expect(ROOMS.psych.unlock).toBe('psychiatry');
    expect(isRoomUnlocked(w.state, 'psych')).toBe(false);
    expect(w.cmd({ type: 'buildRoom', room: 'psych', rect: { x: 14, z: 12, w: 4, h: 4 }, door: { x: 15, z: 15, dir: 'S' } })).toMatchObject({ ok: false, reason: 'not researched yet' });
    w.state.research.done.push('psychiatry');
    expect(w.cmd({ type: 'buildRoom', room: 'psych', rect: { x: 14, z: 12, w: 4, h: 4 }, door: { x: 15, z: 15, dir: 'S' } }).ok).toBe(true);
  });

  it('locks research-only items until researched', () => {
    const w = world();
    expect(isItemUnlocked(w.state, 'arcade')).toBe(false);
    expect(w.cmd({ type: 'placeItem', item: 'arcade', x: 25, z: 20, rot: 0 })).toMatchObject({ ok: false, reason: 'not researched yet' });
    w.state.research.done.push('arcade');
    expect(w.cmd({ type: 'placeItem', item: 'arcade', x: 25, z: 20, rot: 0 }).ok).toBe(true);
  });

  it('unlocks everything in sandbox', () => {
    const w = world();
    w.state.sandbox = true;
    expect(isRoomUnlocked(w.state, 'psych')).toBe(true);
    expect(isItemUnlocked(w.state, 'duckStatue')).toBe(true);
  });

  it('staff-free rooms never admit patients', () => {
    expect(ROOMS.staffRoom.staff).toBeNull();
    expect(ROOMS.training.staff).toBeNull();
    expect(ROOMS.staffRoom.service).toBe('none');
    expect(ITEMS.sofa.spots.every((s) => s.kind === 'rest')).toBe(true);
  });
});
