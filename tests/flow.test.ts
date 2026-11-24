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
import { ILLNESSES, ROOMS, type Role } from '../src/sim/catalog';
import { MONTH } from '../src/sim/economy';
import type { SimEvent } from '../src/sim/events';

function world(opts: ConstructorParameters<typeof World>[1] = {}) {
  const s = createState(7);
  s.money = 1_000_000;
  return new World(s, { autoSpawn: false, ...opts });
}

function hire(w: World, role: Role, skill = 3) {
  const cand = w.state.candidates.find((c) => c.role === role)!;
  cand.skill = skill;
  const r = w.cmd({ type: 'hire', candidateId: cand.id });
  expect(r.ok).toBe(true);
  return w.state.staff.find((s) => s.id === r.id)!;
}

function run(w: World, seconds: number, until?: () => boolean, sink?: SimEvent[]) {
  const dt = 1 / 30;
  for (let t = 0; t < seconds; t += dt) {
    w.tick(dt);
    const ev = w.drainEvents();
    sink?.push(...ev);
    if (until?.()) return true;
  }
  return false;
}

/** reception + consult room + dispensary, fully staffed */
function basic(opts: ConstructorParameters<typeof World>[1] = {}) {
  const w = world(opts);
  expect(w.cmd({ type: 'placeItem', item: 'reception', x: 20, z: 20, rot: 0 }).ok).toBe(true);
  const gp = w.cmd({ type: 'buildRoom', room: 'gp', rect: { x: 12, z: 8, w: 3, h: 3 }, door: { x: 13, z: 10, dir: 'S' } });
  const ph = w.cmd({ type: 'buildRoom', room: 'pharmacy', rect: { x: 16, z: 8, w: 3, h: 3 }, door: { x: 17, z: 10, dir: 'S' } });
  expect(gp.ok && ph.ok).toBe(true);
  return { w, gp: gp.id!, ph: ph.id! };
}

describe('staff', () => {
  it('walks a hired doctor to the unstaffed consult room', () => {
    const { w, gp } = basic();
    const doc = hire(w, 'doctor');
    expect(run(w, 60, () => doc.state === 'atPost')).toBe(true);
    expect(doc.post).toBe(gp);
    expect(w.state.rooms.find((r) => r.id === gp)!.staffId).toBe(doc.id);
  });

  it('refuses to hire without money for the signing bonus (Review Focus 4)', () => {
    const w = world();
    w.state.money = 0;
    const cand = w.state.candidates[0];
    expect(w.cmd({ type: 'hire', candidateId: cand.id })).toMatchObject({ ok: false, reason: 'not enough money' });
  });

  it('refuses to build without money (Review Focus 4)', () => {
    const w = world();
    w.state.money = 10;
    expect(w.cmd({ type: 'buildRoom', room: 'gp', rect: { x: 12, z: 8, w: 3, h: 3 }, door: { x: 13, z: 10, dir: 'S' } })).toMatchObject({ ok: false, reason: 'not enough money' });
  });
});

describe('patient flow', () => {
  it('cures a Chromatic Flu patient through reception, consult room and dispensary', () => {
    const { w } = basic({ forceTreatment: 'success' });
    hire(w, 'assistant'); hire(w, 'doctor'); hire(w, 'nurse');
    const p = w.spawnPatient('chromaticFlu');
    const events: SimEvent[] = [];
    expect(run(w, 600, () => p.state === 'gone', events)).toBe(true);
    expect(p.cured).toBe(true);
    const fees = ROOMS.gp.fee * p.gpVisits + ILLNESSES.chromaticFlu.fee;
    expect(w.state.stats.earned).toBe(fees);
    expect(events.some((e) => e.type === 'cured' && e.id === p.id)).toBe(true);
  });

  it('sends an unsure patient back to the GP until diagnosed (no scan lab)', () => {
    const { w } = basic({ forceTreatment: 'success' });
    hire(w, 'assistant'); hire(w, 'doctor', 1); hire(w, 'nurse');
    const p = w.spawnPatient('chromaticFlu');
    expect(run(w, 900, () => p.state === 'gone')).toBe(true);
    expect(p.gpVisits).toBe(2);
    expect(p.certainty).toBeGreaterThanOrEqual(0.8);
    expect(p.cured).toBe(true);
  });

  it('proceeds to treatment after the maximum GP visits even when still unsure', () => {
    const { w } = basic({ forceTreatment: 'success' });
    hire(w, 'assistant'); hire(w, 'doctor', 1); hire(w, 'nurse');
    const p = w.spawnPatient('chromaticFlu');
    p.certainty = -1.2;
    expect(run(w, 1200, () => p.state === 'gone')).toBe(true);
    expect(p.gpVisits).toBe(3);
    expect(p.certainty).toBeLessThan(0.8);
    expect(p.cured).toBe(true);
  });

  it('uses the scan lab to raise certainty instead of extra GP visits', () => {
    const { w } = basic({ forceTreatment: 'success' });
    expect(w.cmd({ type: 'buildRoom', room: 'scan', rect: { x: 24, z: 8, w: 4, h: 4 }, door: { x: 25, z: 11, dir: 'S' } }).ok).toBe(true);
    hire(w, 'assistant'); hire(w, 'doctor', 1); hire(w, 'doctor', 3); hire(w, 'nurse');
    const p = w.spawnPatient('chromaticFlu');
    expect(run(w, 900, () => p.state === 'gone')).toBe(true);
    expect(p.gpVisits).toBe(1);
    expect(p.cured).toBe(true);
  });

  it('a patient whose treatment room does not exist leaves; the GP keeps working (Review Focus 3)', () => {
    const { w } = basic({ forceTreatment: 'success' });
    hire(w, 'assistant'); hire(w, 'doctor', 5); hire(w, 'nurse');
    const stuck = w.spawnPatient('glowbelly');
    const events: SimEvent[] = [];
    run(w, 120, () => stuck.diagnosed, events);
    expect(stuck.diagnosed).toBe(true);
    const next = w.spawnPatient('chromaticFlu');
    run(w, 1200, () => stuck.state === 'gone', events);
    expect(stuck.state).toBe('gone');
    expect(stuck.cured).toBe(false);
    expect(next.gpVisits).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'toast' && e.text.includes(ROOMS.ward.name))).toBe(true);
  });

  it('selling a room mid-treatment releases the patient and the nurse (Review Focus 2)', () => {
    const { w, ph } = basic({ forceTreatment: 'success' });
    hire(w, 'assistant'); hire(w, 'doctor', 5);
    const nurse = hire(w, 'nurse');
    const p = w.spawnPatient('chromaticFlu');
    expect(run(w, 600, () => p.state === 'inRoom' && p.target === ph)).toBe(true);
    expect(w.cmd({ type: 'sellRoom', id: ph }).ok).toBe(true);
    expect(p.state).not.toBe('inRoom');
    expect(p.spot).toBeNull();
    expect(nurse.state).toBe('idle');
    expect(nurse.post).toBe(-1);
    expect(nurse.spot).toBeNull();
    expect(() => run(w, 30)).not.toThrow();
  });

  it('a thirsty waiting patient buys from the vending machine', () => {
    const w = world();
    w.cmd({ type: 'placeItem', item: 'reception', x: 20, z: 20, rot: 0 });
    w.cmd({ type: 'placeItem', item: 'vending', x: 26, z: 20, rot: 0 });
    w.cmd({ type: 'buildRoom', room: 'gp', rect: { x: 12, z: 8, w: 3, h: 3 }, door: { x: 13, z: 10, dir: 'S' } });
    hire(w, 'assistant');
    const p = w.spawnPatient('jellylegs');
    expect(run(w, 200, () => p.state === 'waiting')).toBe(true);
    p.thirst = 95;
    const before = w.state.money;
    expect(run(w, 120, () => p.thirst < 10)).toBe(true);
    expect(w.state.money).toBeGreaterThan(before);
  });

  it('an out-of-patience patient leaves and reputation drops', () => {
    const w = world();
    w.cmd({ type: 'placeItem', item: 'reception', x: 20, z: 20, rot: 0 });
    hire(w, 'assistant');
    const p = w.spawnPatient('jellylegs');
    expect(run(w, 200, () => p.state === 'waiting')).toBe(true);
    const rep = w.state.reputation;
    p.patience = 0.5;
    expect(run(w, 10, () => p.state === 'leaving')).toBe(true);
    expect(w.state.reputation).toBeLessThan(rep);
  });
});

describe('economy', () => {
  it('pays salaries at month end even into the red', () => {
    const w = world();
    const doc = hire(w, 'doctor', 2);
    w.state.money = 100;
    const events: SimEvent[] = [];
    run(w, MONTH + 1, undefined, events);
    expect(w.state.money).toBe(100 - doc.salary);
    expect(events.some((e) => e.type === 'month')).toBe(true);
  });

  it('starts spawning patients only once a front desk exists', () => {
    const s = createState(3);
    const w = new World(s);
    run(w, 120);
    expect(w.state.patients.length).toBe(0);
    w.cmd({ type: 'placeItem', item: 'reception', x: 20, z: 20, rot: 0 });
    run(w, 120);
    expect(w.state.patients.length).toBeGreaterThan(0);
  });
});
