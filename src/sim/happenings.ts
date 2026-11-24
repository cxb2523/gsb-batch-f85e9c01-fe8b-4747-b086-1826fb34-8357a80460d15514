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
import { ILLNESSES, ITEMS, ROOMS, type IllnessType } from './catalog';
import { DAY, MONTH, adjustRep, earn } from './economy';
import { cleanliness } from './janitor';
import { comfortAt, spawnPatient } from './patients';
import { chance, int, pick, range } from './rng';
import { staffed } from './staff';
import type { Stats } from './state';
import type { World } from './world';
import { scenarioById } from './scenarios';

const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`;

export function startEmergency(w: World, illness: IllnessType, n: number) {
  const s = w.state;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = spawnPatient(w, illness, { at: { x: 30.5 + range(s.rng, -1.5, 1.5), z: 31 + range(s.rng, -0.6, 0.6) }, emergency: true });
    ids.push(p.id);
  }
  const needed = Math.ceil(n * 0.75);
  const reward = n * 1500;
  s.event = { kind: 'emergency', illness, ids, endsAt: s.t + 2 * DAY, needed, reward, cured: 0 };
  const text = `Emergency! The ambulance brought ${n} patients with ${ILLNESSES[illness].name}. Cure ${needed} within two days for ${fmt(reward)}.`;
  w.emit({ type: 'eventStart', kind: 'emergency', text });
  w.emit({ type: 'toast', tone: 'warn', text });
}

export function startInspection(w: World) {
  const s = w.state;
  const p = spawnPatient(w, 'chromaticFlu', { at: { x: 0.5, z: 33.5 }, vip: true });
  s.event = { kind: 'inspection', vipId: p.id, endsAt: s.t + DAY, samples: 0, cleanSum: 0, queueSum: 0, decorSum: 0, brokenSum: 0, sampleT: 0 };
  const text = `A health inspector is touring the hospital today. Keep it clean, calm and in working order.`;
  w.emit({ type: 'eventStart', kind: 'inspection', text });
  w.emit({ type: 'toast', tone: 'info', text });
}

/** 1..5 stars from cleanliness (0..1), decor (0..1), average queue length and broken-machine fraction. */
export function inspectionStars(clean: number, decor: number, avgQueue: number, broken: number): number {
  const score = 0.3 * clean + 0.2 * decor + 0.25 * (1 - Math.min(1, avgQueue / 8)) + 0.25 * (1 - broken);
  return Math.max(1, Math.min(5, 1 + Math.round(score * 4)));
}

function brokenFraction(w: World) {
  const machines = w.state.items.filter((i) => ITEMS[i.type].machine);
  return machines.length ? machines.filter((m) => m.broken).length / machines.length : 0;
}

function avgQueue(w: World) {
  const rooms = w.state.rooms.filter((r) => ROOMS[r.type].service === 'gp' || ROOMS[r.type].service === 'treat' || ROOMS[r.type].service === 'diagnose');
  return rooms.length ? rooms.reduce((a, r) => a + r.queue.length, 0) / rooms.length : 0;
}

function finish(w: World) {
  const [a, b] = scenarioById(w.state.scenario).eventEvery;
  w.state.event = null;
  w.state.nextEventAt = w.state.t + MONTH * range(w.state.rng, a, b);
}

export function updateHappenings(w: World, dt: number) {
  const s = w.state;
  const ev = s.event;
  if (ev?.kind === 'emergency') {
    const open = ev.ids.filter((id) => {
      const p = w.patient(id);
      return p && !p.cured && p.state !== 'leaving' && p.state !== 'gone';
    });
    if (s.t >= ev.endsAt || open.length === 0) {
      const success = ev.cured >= ev.needed;
      if (success) {
        earn(s, ev.reward);
        adjustRep(s, 5);
        s.stats.emergencies++;
      } else adjustRep(s, -4);
      const text = success
        ? `Emergency handled: ${ev.cured} of ${ev.ids.length} cured. ${fmt(ev.reward)} bonus!`
        : `Emergency failed: only ${ev.cured} of ${ev.ids.length} cured. The town noticed.`;
      w.emit({ type: 'eventEnd', kind: 'emergency', success, text });
      w.emit({ type: 'toast', tone: success ? 'good' : 'bad', text });
      finish(w);
    }
    return;
  }
  if (ev?.kind === 'inspection') {
    const vip = w.patient(ev.vipId);
    ev.sampleT -= dt;
    if (ev.sampleT <= 0 && vip) {
      ev.sampleT = 5;
      ev.samples++;
      ev.cleanSum += cleanliness(s);
      ev.queueSum += avgQueue(w);
      ev.decorSum += Math.min(1, comfortAt(w, vip.x, vip.z) / 0.4);
      ev.brokenSum += brokenFraction(w);
    }
    if (s.t >= ev.endsAt || !vip) {
      const n = Math.max(1, ev.samples);
      const stars = inspectionStars(ev.cleanSum / n, ev.decorSum / n, ev.queueSum / n, ev.brokenSum / n);
      adjustRep(s, (stars - 3) * 2);
      s.stats.inspection = Math.max(s.stats.inspection, stars);
      const bonus = stars >= 4 ? 5000 * (stars - 3) : 0;
      if (bonus) earn(s, bonus);
      const text = `Inspection report: ${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}.${bonus ? ` Bonus grant of ${fmt(bonus)}!` : stars <= 2 ? ' The local paper is not kind.' : ''}`;
      w.emit({ type: 'eventEnd', kind: 'inspection', success: stars >= 3, stars, text });
      w.emit({ type: 'toast', tone: stars >= 3 ? 'good' : 'bad', text });
      if (vip && vip.state !== 'leaving') { vip.state = 'leaving'; vip.dest = null; vip.path = []; vip.pathI = 0; }
      finish(w);
    }
    return;
  }
  if (!w.opts.autoSpawn || s.t < s.nextEventAt) return;
  const treatable = (Object.keys(ILLNESSES) as IllnessType[]).filter((k) => s.rooms.some((r) => r.type === ILLNESSES[k].room && staffed(w, r)));
  const hasDesk = s.items.some((i) => i.type === 'reception');
  const sc = scenarioById(s.scenario);
  if (treatable.length && (chance(s.rng, sc.emergencyChance) || !hasDesk)) startEmergency(w, pick(s.rng, treatable), int(s.rng, 5, 8));
  else if (hasDesk) startInspection(w);
  else s.nextEventAt = s.t + MONTH;
}

const AWARDS: { name: string; won: (w: World, y: Stats) => boolean }[] = [
  { name: 'Most Cures', won: (_w, y) => y.cured >= 100 },
  { name: 'Spotless', won: (w) => cleanliness(w.state) >= 0.8 },
  { name: 'In the Black', won: (_w, y) => y.earned > y.spent },
  { name: 'Crowd Favourite', won: (w) => w.state.reputation >= 75 },
];

export function giveAwards(w: World, year: number) {
  const s = w.state;
  const won: string[] = [], lost: string[] = [];
  for (const a of AWARDS) (a.won(w, s.yearStats) ? won : lost).push(a.name);
  const bonus = won.length * 5000;
  if (bonus) earn(s, bonus);
  adjustRep(s, won.length * 3);
  w.emit({ type: 'awards', year, won, lost, bonus });
}
