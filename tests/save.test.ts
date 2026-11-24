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
import { World } from '../src/sim/world';
import { SAVE_VERSION, deserialize, serialize } from '../src/sim/save';

const run = (w: World, n: number) => { for (let i = 0; i < n; i++) { w.tick(1 / 30); w.drainEvents(); } };
/** pathVer is a cache key tied to the live grid instance, not game state */
const snap = (w: World) => JSON.stringify(w.state, (k, v) => (k === 'pathVer' ? undefined : v));

describe('save / load', () => {
  it('round-trips a busy hospital and keeps simulating identically', () => {
    const a = createDemoWorld(5, 10);
    run(a, 200);
    const json = serialize(a);
    const res = deserialize(json);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const b = new World(res.state);
    run(a, 300);
    run(b, 300);
    expect(snap(b)).toBe(snap(a));
  });

  it('stamps the current version', () => {
    const w = createDemoWorld(5, 1);
    expect(JSON.parse(serialize(w)).version).toBe(SAVE_VERSION);
  });

  it('rejects corrupt JSON and unknown versions without throwing (Review Focus 1)', () => {
    expect(deserialize('{not json')).toMatchObject({ ok: false });
    expect(deserialize(JSON.stringify({ version: SAVE_VERSION + 7, state: {} }))).toMatchObject({ ok: false, reason: 'made by a newer version' });
    expect(deserialize(JSON.stringify({ version: SAVE_VERSION, state: { money: 5 } }))).toMatchObject({ ok: false, reason: 'damaged save' });
    expect(deserialize('null')).toMatchObject({ ok: false });
  });

  it('migrates a milestone-1 state (no version) by filling new fields', () => {
    const w = createDemoWorld(5, 1);
    const legacy = JSON.parse(JSON.stringify(w.state));
    for (const k of ['version', 'litter', 'research', 'event', 'nextEventAt', 'yearStats', 'scenario', 'sandbox', 'goals']) delete legacy[k];
    for (const st of legacy.staff) { delete st.energy; delete st.mood; delete st.xp; }
    for (const it of legacy.items) { delete it.wear; delete it.broken; }
    const res = deserialize(JSON.stringify({ state: legacy }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state.litter).toEqual([]);
    expect(res.state.staff[0].energy).toBe(100);
    expect(res.state.items[0].wear).toBe(0);
    expect(() => { const b = new World(res.state); run(b, 60); }).not.toThrow();
  });
});
