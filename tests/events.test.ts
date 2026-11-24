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
import { MONTH, DAY } from '../src/sim/economy';
import { inspectionStars, startEmergency, startInspection } from '../src/sim/happenings';
import type { SimEvent } from '../src/sim/events';

function world() {
  const s = createState(12);
  s.money = 1_000_000;
  const w = new World(s, { autoSpawn: false, forceTreatment: 'success' });
  w.cmd({ type: 'placeItem', item: 'reception', x: 20, z: 20, rot: 0 });
  const ph = w.cmd({ type: 'buildRoom', room: 'pharmacy', rect: { x: 16, z: 8, w: 3, h: 3 }, door: { x: 17, z: 10, dir: 'S' } });
  for (const role of ['assistant', 'nurse'] as const) {
    const c = w.state.candidates.find((x) => x.role === role)!;
    c.skill = 5;
    w.cmd({ type: 'hire', candidateId: c.id });
  }
  return { w, ph: ph.id! };
}
function run(w: World, secs: number, until?: () => boolean, sink?: SimEvent[]) {
  for (let t = 0; t < secs; t += 1 / 30) {
    w.tick(1 / 30);
    sink?.push(...w.drainEvents());
    if (until?.()) return true;
  }
  return false;
}

describe('emergencies', () => {
  it('pays out when enough emergency patients are cured in time', () => {
    const { w } = world();
    const money = w.state.money;
    const ev: SimEvent[] = [];
    startEmergency(w, 'chromaticFlu', 5);
    expect(w.state.event?.kind).toBe('emergency');
    expect(w.state.patients.filter((p) => p.emergency).length).toBe(5);
    expect(run(w, 2 * DAY + 5, () => w.state.event === null, ev)).toBe(true);
    const end = ev.find((e) => e.type === 'eventEnd');
    expect(end).toMatchObject({ type: 'eventEnd', kind: 'emergency', success: true });
    expect(w.state.money).toBeGreaterThan(money + 5 * 1500);
  });

  it('emergency patients go straight to treatment and jump the queue', () => {
    const { w, ph } = world();
    const calm = w.spawnPatient('chromaticFlu');
    calm.diagnosed = true; calm.gpVisits = 1;
    run(w, 200, () => w.room(ph)!.queue.includes(calm.id) || calm.state === 'toRoom' || calm.state === 'inRoom');
    startEmergency(w, 'chromaticFlu', 2);
    run(w, 60, () => w.room(ph)!.queue.some((id) => w.patient(id)?.emergency));
    const q = w.room(ph)!.queue;
    const firstEm = q.findIndex((id) => w.patient(id)?.emergency);
    const calmIdx = q.indexOf(calm.id);
    if (calmIdx !== -1) expect(firstEm).toBeLessThan(calmIdx);
    expect(w.state.patients.filter((p) => p.emergency).every((p) => p.gpVisits === 0)).toBe(true);
  });

  it('resolves as a failure without stalling if the treatment room is sold (Review Focus 4)', () => {
    const { w, ph } = world();
    startEmergency(w, 'chromaticFlu', 6);
    w.cmd({ type: 'sellRoom', id: ph });
    const rep = w.state.reputation;
    const ev: SimEvent[] = [];
    expect(run(w, 2 * DAY + 10, () => w.state.event === null, ev)).toBe(true);
    expect(ev.find((e) => e.type === 'eventEnd')).toMatchObject({ success: false });
    expect(w.state.reputation).toBeLessThan(rep);
  });
});

describe('inspections', () => {
  it('scores cleaner, calmer hospitals higher', () => {
    expect(inspectionStars(1, 0.4, 0, 0)).toBeGreaterThan(inspectionStars(0.2, 0.4, 0, 0));
    expect(inspectionStars(1, 0.4, 0, 0)).toBeGreaterThan(inspectionStars(1, 0.4, 10, 0));
    expect(inspectionStars(1, 0.4, 0, 0)).toBeGreaterThan(inspectionStars(1, 0.4, 0, 1));
    for (const v of [inspectionStars(0, 0, 20, 1), inspectionStars(1, 1, 0, 0)]) { expect(v).toBeGreaterThanOrEqual(1); expect(v).toBeLessThanOrEqual(5); }
  });

  it('a VIP tours for a day and files a report', () => {
    const { w } = world();
    startInspection(w);
    const vip = w.state.patients.find((p) => p.vip)!;
    expect(vip).toBeDefined();
    const ev: SimEvent[] = [];
    expect(run(w, DAY + 30, () => w.state.event === null, ev)).toBe(true);
    const end = ev.find((e) => e.type === 'eventEnd');
    expect(end).toMatchObject({ kind: 'inspection' });
    expect((end as { stars: number }).stars).toBeGreaterThanOrEqual(1);
  });
});

describe('awards', () => {
  it('hands out awards at the end of each year', () => {
    const { w } = world();
    w.state.t = 12 * MONTH - 2;
    w.state.lastMonth = 11;
    w.state.yearStats.cured = 140;
    w.state.yearStats.earned = 500_000;
    w.state.yearStats.spent = 100_000;
    w.state.reputation = 90;
    const money = w.state.money;
    const ev: SimEvent[] = [];
    run(w, 4, undefined, ev);
    const aw = ev.find((e) => e.type === 'awards') as { won: string[] } | undefined;
    expect(aw).toBeDefined();
    expect(aw!.won).toEqual(expect.arrayContaining(['Most Cures', 'In the Black', 'Crowd Favourite', 'Spotless']));
    expect(w.state.money).toBeGreaterThan(money);
    expect(w.state.yearStats.cured).toBe(0);
  });
});
