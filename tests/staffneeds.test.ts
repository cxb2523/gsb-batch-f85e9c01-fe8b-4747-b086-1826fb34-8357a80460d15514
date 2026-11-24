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
import type { Role } from '../src/sim/catalog';
import type { SimEvent } from '../src/sim/events';

function world() {
  const s = createState(9);
  s.money = 1_000_000;
  return new World(s, { autoSpawn: false, forceTreatment: 'success' });
}
function hire(w: World, role: Role, skill = 3) {
  const c = w.state.candidates.find((x) => x.role === role)!;
  c.skill = skill;
  const r = w.cmd({ type: 'hire', candidateId: c.id });
  return w.state.staff.find((s) => s.id === r.id)!;
}
function run(w: World, secs: number, until?: () => boolean, sink?: SimEvent[]) {
  for (let t = 0; t < secs; t += 1 / 30) {
    w.tick(1 / 30);
    sink?.push(...w.drainEvents());
    if (until?.()) return true;
  }
  return false;
}
const GP = { type: 'buildRoom' as const, room: 'gp' as const, rect: { x: 12, z: 8, w: 3, h: 3 }, door: { x: 13, z: 10, dir: 'S' as const } };
const STAFFROOM = { type: 'buildRoom' as const, room: 'staffRoom' as const, rect: { x: 24, z: 8, w: 3, h: 3 }, door: { x: 25, z: 10, dir: 'S' as const } };
const TRAINING = { type: 'buildRoom' as const, room: 'training' as const, rect: { x: 28, z: 8, w: 3, h: 4 }, door: { x: 29, z: 11, dir: 'S' as const } };

describe('energy and breaks', () => {
  it('a tired doctor takes a break in the Staff Room and comes back', () => {
    const w = world();
    expect(w.cmd(GP).ok && w.cmd(STAFFROOM).ok).toBe(true);
    const doc = hire(w, 'doctor');
    expect(run(w, 60, () => doc.state === 'atPost')).toBe(true);
    doc.energy = 15;
    expect(run(w, 60, () => doc.state === 'onBreak')).toBe(true);
    expect(run(w, 120, () => doc.state === 'atPost')).toBe(true);
    expect(doc.energy).toBeGreaterThanOrEqual(95);
  });

  it('works slower when exhausted and there is no Staff Room', () => {
    const w = world();
    w.cmd({ type: 'placeItem', item: 'reception', x: 20, z: 20, rot: 0 });
    w.cmd(GP);
    hire(w, 'assistant');
    const doc = hire(w, 'doctor', 3);
    const p = w.spawnPatient('chromaticFlu');
    expect(run(w, 200, () => p.state === 'inRoom')).toBe(true);
    doc.energy = 2;
    const before = p.timer;
    run(w, 3);
    expect(before - p.timer).toBeGreaterThan(1.8);
    expect(before - p.timer).toBeLessThan(2.2);
  });

  it('quits when mood hits zero', () => {
    const w = world();
    w.cmd(GP);
    const doc = hire(w, 'doctor');
    run(w, 60, () => doc.state === 'atPost');
    doc.energy = 0;
    doc.mood = 0.2;
    const ev: SimEvent[] = [];
    expect(run(w, 10, () => doc.state === 'leaving', ev)).toBe(true);
    expect(ev.some((e) => e.type === 'quit' && e.id === doc.id)).toBe(true);
  });

  it('selling the Staff Room mid-break releases the staff member (Review Focus 2)', () => {
    const w = world();
    w.cmd(GP);
    const sr = w.cmd(STAFFROOM);
    const doc = hire(w, 'doctor');
    run(w, 60, () => doc.state === 'atPost');
    doc.energy = 10;
    expect(run(w, 60, () => doc.state === 'onBreak')).toBe(true);
    expect(w.cmd({ type: 'sellRoom', id: sr.id! }).ok).toBe(true);
    expect(doc.state).toBe('idle');
    expect(doc.spot).toBeNull();
    expect(run(w, 60, () => doc.state === 'atPost')).toBe(true);
  });

  it('firing someone on a break frees their post for a new hire', () => {
    const w = world();
    const gp = w.cmd(GP);
    w.cmd(STAFFROOM);
    const doc = hire(w, 'doctor');
    run(w, 60, () => doc.state === 'atPost');
    doc.energy = 10;
    run(w, 60, () => doc.state === 'onBreak');
    w.cmd({ type: 'fire', id: doc.id });
    const doc2 = hire(w, 'doctor');
    expect(run(w, 90, () => doc2.state === 'atPost')).toBe(true);
    expect(w.room(gp.id!)!.staffId).toBe(doc2.id);
  });
});

describe('experience and training', () => {
  it('promotes after 30 completed services', () => {
    const w = world();
    w.cmd({ type: 'placeItem', item: 'reception', x: 20, z: 20, rot: 0 });
    w.cmd(GP);
    hire(w, 'assistant');
    const doc = hire(w, 'doctor', 2);
    doc.xp = 29;
    const salary = doc.salary;
    const p = w.spawnPatient('chromaticFlu');
    const ev: SimEvent[] = [];
    expect(run(w, 300, () => p.gpVisits > 0, ev)).toBe(true);
    expect(doc.skill).toBe(3);
    expect(doc.salary).toBeGreaterThan(salary);
    expect(ev.some((e) => e.type === 'promoted')).toBe(true);
  });

  it('training costs money and adds a skill star', () => {
    const w = world();
    w.cmd(GP);
    expect(w.cmd(TRAINING).ok).toBe(true);
    const doc = hire(w, 'doctor', 2);
    run(w, 60, () => doc.state === 'atPost');
    const money = w.state.money;
    expect(w.cmd({ type: 'train', id: doc.id }).ok).toBe(true);
    expect(w.state.money).toBe(money - 3000);
    expect(run(w, 400, () => doc.skill === 3)).toBe(true);
    expect(run(w, 60, () => doc.state === 'atPost')).toBe(true);
  });

  it('refuses training without a Training Room or at five stars', () => {
    const w = world();
    w.cmd(GP);
    const doc = hire(w, 'doctor', 2);
    expect(w.cmd({ type: 'train', id: doc.id })).toMatchObject({ ok: false, reason: 'build a Training Room first' });
    w.cmd(TRAINING);
    doc.skill = 5;
    expect(w.cmd({ type: 'train', id: doc.id })).toMatchObject({ ok: false, reason: 'already a five-star expert' });
  });
});
