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
import { createState, type Ctx } from '../src/sim/state';
import { ROOMS, ITEMS, roomCost, type RoomType } from '../src/sim/catalog';
import {
  rebuildGrid, validateRoom, applyRoom, sellRoom, validateItem, applyItem, sellItem, itemSpots, itemFootprint,
} from '../src/sim/build';
import { findPath } from '../src/sim/path';

function ctx(money = 1_000_000): Ctx {
  const state = createState();
  state.money = money;
  // geometry tests: research locks are covered in unlock.test.ts
  state.sandbox = true;
  return { state, grid: rebuildGrid(state) };
}

describe('validateRoom', () => {
  it('accepts a minimum consult room in the corridor and prices it', () => {
    const c = ctx();
    const r = validateRoom(c, 'gp', { x: 14, z: 12, w: 3, h: 3 }, { x: 15, z: 14, dir: 'S' });
    expect(r.ok).toBe(true);
    expect(r.cost).toBe(roomCost('gp', 3, 3));
  });

  it('rejects rooms outside the building', () => {
    const r = validateRoom(ctx(), 'gp', { x: 6, z: 12, w: 3, h: 3 }, { x: 7, z: 14, dir: 'S' });
    expect(r).toMatchObject({ ok: false, reason: 'must be inside the hospital' });
  });

  it('rejects rooms below the minimum size in either orientation', () => {
    const c = ctx();
    expect(validateRoom(c, 'scan', { x: 14, z: 12, w: 3, h: 5 }, { x: 15, z: 16, dir: 'S' })).toMatchObject({ ok: false, reason: 'too small' });
    expect(validateRoom(c, 'ballast', { x: 14, z: 12, w: 4, h: 3 }, { x: 15, z: 14, dir: 'S' }).ok).toBe(true);
  });

  it('rejects overlap with another room', () => {
    const c = ctx();
    expect(applyRoom(c, 'gp', { x: 14, z: 12, w: 3, h: 3 }, { x: 15, z: 14, dir: 'S' })).toBeGreaterThan(0);
    expect(validateRoom(c, 'gp', { x: 16, z: 12, w: 3, h: 3 }, { x: 17, z: 14, dir: 'S' })).toMatchObject({ ok: false, reason: 'overlaps another room' });
  });

  it('rejects rooms over corridor items', () => {
    const c = ctx();
    expect(applyItem(c, 'plant', 15, 13, 0)).toBeGreaterThan(0);
    expect(validateRoom(c, 'gp', { x: 14, z: 12, w: 3, h: 3 }, { x: 15, z: 14, dir: 'S' })).toMatchObject({ ok: false, reason: 'space occupied' });
  });

  it('requires the door on the room edge, opening onto a corridor', () => {
    const c = ctx();
    expect(validateRoom(c, 'gp', { x: 14, z: 12, w: 3, h: 3 }, { x: 15, z: 13, dir: 'S' })).toMatchObject({ ok: false, reason: 'door must be on the room edge' });
    expect(validateRoom(c, 'gp', { x: 8, z: 6, w: 3, h: 3 }, { x: 8, z: 7, dir: 'W' })).toMatchObject({ ok: false, reason: 'door must open onto a corridor' });
    applyRoom(c, 'gp', { x: 12, z: 10, w: 3, h: 3 }, { x: 13, z: 12, dir: 'S' });
    expect(validateRoom(c, 'gp', { x: 15, z: 10, w: 3, h: 3 }, { x: 15, z: 11, dir: 'W' })).toMatchObject({ ok: false, reason: 'door must open onto a corridor' });
  });

  it('rejects a room that cuts the corridor off from the entrance (Review Focus 1)', () => {
    const c = ctx();
    expect(applyItem(c, 'reception', 20, 8, 0)).toBeGreaterThan(0);
    expect(applyRoom(c, 'gp', { x: 8, z: 12, w: 12, h: 4 }, { x: 14, z: 15, dir: 'S' })).toBeGreaterThan(0);
    expect(applyRoom(c, 'gp', { x: 20, z: 12, w: 12, h: 4 }, { x: 26, z: 15, dir: 'S' })).toBeGreaterThan(0);
    const r = validateRoom(c, 'gp', { x: 32, z: 12, w: 4, h: 4 }, { x: 33, z: 15, dir: 'S' });
    expect(r).toMatchObject({ ok: false, reason: 'blocks access' });
  });

  it('rejects when money is short (Review Focus 4)', () => {
    const c = ctx(1000);
    expect(validateRoom(c, 'gp', { x: 14, z: 12, w: 3, h: 3 }, { x: 15, z: 14, dir: 'S' })).toMatchObject({ ok: false, reason: 'not enough money' });
    expect(applyRoom(c, 'gp', { x: 14, z: 12, w: 3, h: 3 }, { x: 15, z: 14, dir: 'S' })).toBe(-1);
    expect(c.state.money).toBe(1000);
  });
});

describe('auto-layout', () => {
  const types = Object.keys(ROOMS) as RoomType[];
  for (const type of types) {
    for (const side of ['S', 'W', 'N'] as const) {
      it(`${type} at minimum size with a ${side} door gets every required item, reachable`, () => {
        const c = ctx();
        const def = ROOMS[type];
        const rect = { x: 14, z: 12, w: def.minW, h: def.minH };
        const door =
          side === 'S' ? { x: 14 + Math.floor(def.minW / 2), z: 12 + def.minH - 1, dir: side }
          : side === 'N' ? { x: 14 + Math.floor(def.minW / 2), z: 12, dir: side }
          : { x: 14, z: 12 + Math.floor(def.minH / 2), dir: side };
        const id = applyRoom(c, type, rect, door);
        expect(id, validateRoom(c, type, rect, door).reason).toBeGreaterThan(0);
        const room = c.state.rooms.find((r) => r.id === id)!;
        const types = room.items.map((iid) => c.state.items.find((i) => i.id === iid)!.type).sort();
        expect(types).toEqual([...def.required].sort());
        for (const iid of room.items) {
          const it = c.state.items.find((i) => i.id === iid)!;
          for (const cell of itemFootprint(it.type, it.x, it.z, it.rot)) expect([cell.x, cell.z]).not.toEqual([door.x, door.z]);
          for (const s of itemSpots(it)) {
            const tx = Math.floor(s.ax), tz = Math.floor(s.az);
            expect(c.grid.room(tx, tz)).toBe(id);
            expect(c.grid.isBlocked(tx, tz)).toBe(false);
            expect(findPath(c.grid, door, { x: tx, z: tz })).not.toBeNull();
          }
        }
      });
    }
  }
});

describe('sellRoom', () => {
  it('refunds half and removes walls, items and tiles', () => {
    const c = ctx(100_000);
    const id = applyRoom(c, 'gp', { x: 14, z: 12, w: 3, h: 3 }, { x: 15, z: 14, dir: 'S' });
    const cost = roomCost('gp', 3, 3);
    expect(c.state.money).toBe(100_000 - cost);
    expect(sellRoom(c, id)).toBe(Math.floor(cost / 2));
    expect(c.state.money).toBe(100_000 - cost + Math.floor(cost / 2));
    expect(c.grid.wall(14, 12, 'N')).toBeUndefined();
    expect(c.grid.room(15, 13)).toBe(-1);
    expect(c.state.items.length).toBe(0);
  });

  it('keeps a wall shared with a neighbouring room', () => {
    const c = ctx();
    const a = applyRoom(c, 'gp', { x: 14, z: 12, w: 3, h: 3 }, { x: 15, z: 14, dir: 'S' });
    applyRoom(c, 'gp', { x: 17, z: 12, w: 3, h: 3 }, { x: 18, z: 14, dir: 'S' });
    sellRoom(c, a);
    expect(c.grid.wall(16, 13, 'E')).toBeDefined();
    expect(c.grid.wall(17, 13, 'W')).toBeDefined();
  });
});

describe('items', () => {
  it('keeps corridor-only items out of rooms and room-only items out of corridors', () => {
    const c = ctx();
    applyRoom(c, 'gp', { x: 14, z: 12, w: 4, h: 4 }, { x: 15, z: 15, dir: 'S' });
    expect(validateItem(c, 'vending', 14, 12, 0)).toMatchObject({ ok: false, reason: 'corridor only' });
    expect(validateItem(c, 'cabinet', 25, 20, 0)).toMatchObject({ ok: false, reason: 'rooms only' });
    expect(validateItem(c, 'plant', 14, 12, 0).ok).toBe(true);
  });

  it('needs its use spot free and inside the same space', () => {
    const c = ctx();
    expect(validateItem(c, 'vending', 8, 10, 1)).toMatchObject({ ok: false, reason: 'needs space in front' });
    expect(validateItem(c, 'vending', 8, 10, 3).ok).toBe(true);
  });

  it('cannot sit on another item or block a room door', () => {
    const c = ctx();
    applyItem(c, 'plant', 25, 20, 0);
    expect(validateItem(c, 'bin', 25, 20, 0)).toMatchObject({ ok: false, reason: 'space occupied' });
    applyRoom(c, 'gp', { x: 14, z: 12, w: 3, h: 3 }, { x: 15, z: 14, dir: 'S' });
    expect(validateItem(c, 'plant', 15, 15, 0)).toMatchObject({ ok: false, reason: 'blocks access' });
  });

  it('rotates footprints: a 3x2 desk facing east is 2 wide and 3 deep', () => {
    const cells = itemFootprint('reception', 20, 10, 3);
    const xs = new Set(cells.map((c) => c.x)), zs = new Set(cells.map((c) => c.z));
    expect([...xs].sort()).toEqual([20, 21]);
    expect([...zs].sort()).toEqual([10, 11, 12]);
  });

  it('sells an item for half its cost and frees the tile', () => {
    const c = ctx(10_000);
    const id = applyItem(c, 'radiator', 25, 20, 0);
    expect(c.state.money).toBe(10_000 - ITEMS.radiator.cost);
    expect(c.grid.isBlocked(25, 20)).toBe(true);
    expect(sellItem(c, id)).toBe(ITEMS.radiator.cost / 2);
    expect(c.grid.isBlocked(25, 20)).toBe(false);
  });
});
