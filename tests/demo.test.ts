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
import { createDemoWorld } from '../src/sim/demo';
import { ROOMS, type RoomType } from '../src/sim/catalog';

describe('demo world', () => {
  it('has every room type, staffed, and a crowd of patients after warm-up', () => {
    const w = createDemoWorld();
    const types = new Set(w.state.rooms.map((r) => r.type));
    for (const t of Object.keys(ROOMS) as RoomType[]) expect(types.has(t)).toBe(true);
    expect(w.state.rooms.filter((r) => ROOMS[r.type].staff).every((r) => r.staffId !== -1)).toBe(true);
    expect(w.state.staff.filter((s) => s.state === 'atPost').length).toBeGreaterThanOrEqual(w.state.rooms.filter((r) => ROOMS[r.type].staff).length);
    expect(w.state.patients.length).toBeGreaterThanOrEqual(10);
  });
});
