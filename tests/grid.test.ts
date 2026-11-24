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
import { Grid, createLot } from '../src/sim/grid';

describe('Grid walls and stepping', () => {
  it('blocks an orthogonal step across a wall edge', () => {
    const g = new Grid(10, 10);
    g.setWall(3, 3, 'E', { kind: 'room', door: false, window: false });
    expect(g.canStep(3, 3, 1, 0)).toBe(false);
    expect(g.canStep(4, 3, -1, 0)).toBe(false);
    expect(g.canStep(3, 3, 0, 1)).toBe(true);
  });

  it('allows an orthogonal step through a door edge', () => {
    const g = new Grid(10, 10);
    g.setWall(3, 3, 'N', { kind: 'room', door: true, window: false });
    expect(g.canStep(3, 3, 0, -1)).toBe(true);
    expect(g.canStep(3, 2, 0, 1)).toBe(true);
  });

  it('shares one edge between neighbours (E of x == W of x+1)', () => {
    const g = new Grid(10, 10);
    g.setWall(5, 5, 'S', { kind: 'room', door: false, window: false });
    expect(g.wall(5, 6, 'N')).toBeDefined();
    expect(g.edgeKey(5, 5, 'S')).toBe(g.edgeKey(5, 6, 'N'));
  });

  it('blocks a diagonal step when either orthogonal leg crosses a wall or door', () => {
    const g = new Grid(10, 10);
    g.setWall(3, 3, 'E', { kind: 'room', door: false, window: false });
    expect(g.canStep(3, 3, 1, 1)).toBe(false);
    expect(g.canStep(3, 4, 1, -1)).toBe(false);
    const g2 = new Grid(10, 10);
    g2.setWall(3, 3, 'N', { kind: 'room', door: true, window: false });
    expect(g2.canStep(3, 3, 1, -1)).toBe(false);
    expect(g2.canStep(2, 2, 1, 1)).toBe(false);
  });

  it('blocks steps into item-blocked tiles and out of bounds', () => {
    const g = new Grid(10, 10);
    g.setBlocked(4, 4, true);
    expect(g.canStep(3, 4, 1, 0)).toBe(false);
    expect(g.canStep(3, 3, 1, 1)).toBe(false);
    expect(g.canStep(0, 0, -1, 0)).toBe(false);
    expect(g.canStep(9, 9, 0, 1)).toBe(false);
  });
});

describe('createLot', () => {
  it('builds a 48x40 lot with a 28x22 building and outer walls', () => {
    const g = createLot();
    expect([g.w, g.h]).toEqual([48, 40]);
    expect(g.building).toMatchObject({ x: 8, z: 6, w: 28, h: 22 });
    expect(g.inBuilding(8, 6)).toBe(true);
    expect(g.inBuilding(35, 27)).toBe(true);
    expect(g.inBuilding(36, 27)).toBe(false);
    expect(g.wall(8, 10, 'W')?.kind).toBe('outer');
    expect(g.wall(20, 6, 'N')?.kind).toBe('outer');
  });

  it('has a two-tile entrance door on the south wall at x 21-22', () => {
    const g = createLot();
    expect(g.wall(21, 27, 'S')?.door).toBe(true);
    expect(g.wall(22, 27, 'S')?.door).toBe(true);
    expect(g.wall(20, 27, 'S')?.door).toBe(false);
    expect(g.building.entrance).toEqual({ x: 21, z: 27 });
  });

  it('puts windows on some outer segments but never beside the entrance', () => {
    const g = createLot();
    const windows = [...g.walls.values()].filter((w) => w.window);
    expect(windows.length).toBeGreaterThan(10);
    for (const x of [19, 20, 21, 22, 23, 24]) expect(g.wall(x, 27, 'S')?.window).toBe(false);
  });
});
