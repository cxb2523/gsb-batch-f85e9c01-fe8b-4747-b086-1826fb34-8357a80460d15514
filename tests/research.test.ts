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
import { RESEARCH, availableResearch, boosts } from '../src/sim/research';
import { isRoomUnlocked } from '../src/sim/unlocks';
import type { SimEvent } from '../src/sim/events';

function lab(staffed = true) {
  const s = createState(6);
  s.money = 1_000_000;
  const w = new World(s, { autoSpawn: false });
  expect(w.cmd({ type: 'buildRoom', room: 'research', rect: { x: 14, z: 10, w: 4, h: 3 }, door: { x: 15, z: 12, dir: 'S' } }).ok).toBe(true);
  if (staffed) {
    const c = w.state.candidates.find((x) => x.role === 'doctor')!;
    c.skill = 3;
    w.cmd({ type: 'hire', candidateId: c.id });
  }
  return w;
}
function run(w: World, secs: number, until?: () => boolean, sink?: SimEvent[]) {
  for (let t = 0; t < secs; t += 1 / 30) {
    w.tick(1 / 30);
    sink?.push(...w.drainEvents());
    if (until?.()) return true;
  }
  return false;
}

describe('research', () => {
  it('a staffed lab completes the selected project', () => {
    const w = lab();
    expect(w.cmd({ type: 'research', id: 'fizzDeluxe' }).ok).toBe(true);
    const ev: SimEvent[] = [];
    expect(run(w, 200, () => w.state.research.done.includes('fizzDeluxe'), ev)).toBe(true);
    expect(ev.some((e) => e.type === 'researched' && e.id === 'fizzDeluxe')).toBe(true);
    expect(w.state.research.current).toBeNull();
  });

  it('an empty lab makes no progress', () => {
    const w = lab(false);
    w.cmd({ type: 'research', id: 'fizzDeluxe' });
    run(w, 120);
    expect(w.state.research.points).toBe(0);
  });

  it('researching Psychiatry unlocks the room', () => {
    const w = lab();
    w.cmd({ type: 'research', id: 'psychiatry' });
    expect(isRoomUnlocked(w.state, 'psych')).toBe(false);
    expect(run(w, 400, () => isRoomUnlocked(w.state, 'psych'))).toBe(true);
  });

  it('respects prerequisites', () => {
    const w = lab();
    expect(availableResearch(w.state).some((r) => r.id === 'miracleCures')).toBe(false);
    expect(w.cmd({ type: 'research', id: 'miracleCures' })).toMatchObject({ ok: false, reason: 'not available yet' });
    w.state.research.done.push('steadyCures');
    expect(availableResearch(w.state).some((r) => r.id === 'miracleCures')).toBe(true);
  });

  it('researchers earn experience and promotions like everyone else', () => {
    const w = lab();
    const doc = w.state.staff[0];
    doc.skill = 2;
    doc.xp = 29;
    w.cmd({ type: 'research', id: 'duckStatue' });
    expect(run(w, 200, () => doc.skill === 3)).toBe(true);
    expect(doc.xp).toBeLessThan(30);
  });

  it('boosts reflect finished projects', () => {
    const s = createState(1);
    expect(boosts(s)).toEqual({ diagnosis: 0, cure: 0, wear: 1, patience: 1, arrivals: 1, vending: 5 });
    s.research.done = RESEARCH.map((r) => r.id);
    expect(boosts(s)).toEqual({ diagnosis: 10, cure: 0.1, wear: 0.5, patience: 0.8, arrivals: 1.2, vending: 12 });
  });
});
