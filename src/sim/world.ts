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
import { Grid } from './grid';
import { ITEMS, ROOMS } from './catalog';
import { applyItem, applyRoom, itemSpots, rebuildGrid, sellItem, sellRoom, validateItem, validateRoom } from './build';
import { calendar, isNight, monthLabel, MONTH } from './economy';
import { range } from './rng';
import { createState, emptyStats, type Item, type Mover, type Patient, type Room, type Staff, type WorldState } from './state';
import type { Command, CommandResult, SimEvent } from './events';
import { fireStaff, genCandidates, hireCandidate, releaseStaffFrom, trainStaff, updateStaff } from './staff';
import { releasePatientsFrom, spawnPatient, updatePatients, updateRooms, type SpawnOpts } from './patients';
import { BALANCE, ILLNESSES, type IllnessType } from './catalog';
import { stop } from './move';
import { boosts, chooseResearch, updateResearch } from './research';
import { giveAwards, updateHappenings } from './happenings';
import { evaluateStars, scenarioById } from './scenarios';

export interface WorldOptions {
  /** spawn patients automatically (default true) */
  autoSpawn?: boolean;
  /** tests: force every treatment roll */
  forceTreatment?: 'success' | 'fail';
}

export class World {
  state: WorldState;
  grid: Grid;
  opts: WorldOptions;
  private events: SimEvent[] = [];
  private starClock = 0;

  constructor(state: WorldState = createState(), opts: WorldOptions = {}) {
    this.state = state;
    this.opts = { autoSpawn: true, ...opts };
    this.grid = rebuildGrid(state);
    // paths stored in a save are still valid for the rebuilt grid; don't let them re-plan
    for (const m of [...state.staff, ...state.patients] as Mover[]) m.pathVer = this.grid.version;
    if (!state.candidates.length) genCandidates(this);
  }

  emit(e: SimEvent) {
    this.events.push(e);
  }
  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  room(id: number): Room | undefined {
    return this.state.rooms.find((r) => r.id === id);
  }
  item(id: number): Item | undefined {
    return this.state.items.find((i) => i.id === id);
  }
  staffById(id: number): Staff | undefined {
    return this.state.staff.find((s) => s.id === id);
  }
  patient(id: number): Patient | undefined {
    return this.state.patients.find((p) => p.id === id);
  }

  /** Rate-limited hint toast. */
  hint(key: string, text: string, tone: 'info' | 'warn' = 'warn', cooldown = 45) {
    const last = this.state.hints[key];
    if (last !== undefined && this.state.t - last < cooldown) return;
    this.state.hints[key] = this.state.t;
    this.emit({ type: 'toast', text, tone });
  }

  spawnPatient(illness?: IllnessType, opts: SpawnOpts = {}): Patient {
    return spawnPatient(this, illness, opts);
  }

  tick(dt: number) {
    const s = this.state;
    s.t += dt;
    for (const m of s.staff as Mover[]) { m.px = m.x; m.pz = m.z; }
    for (const m of s.patients as Mover[]) { m.px = m.x; m.pz = m.z; }
    this.monthCheck();
    this.spawnCheck(dt);
    updateStaff(this, dt);
    updateResearch(this, dt);
    updateRooms(this, dt);
    updatePatients(this, dt);
    updateHappenings(this, dt);
    s.patients = s.patients.filter((p) => p.state !== 'gone');
    this.starClock -= dt;
    if (this.starClock <= 0) {
      this.starClock = 1;
      const stars = evaluateStars(s);
      if (stars > s.stars) {
        s.stars = stars;
        this.emit({ type: 'star', stars, scenario: s.scenario });
      }
    }
  }

  private monthCheck() {
    const s = this.state;
    const cal = calendar(s.t);
    if (cal.monthIndex <= s.lastMonth) return;
    s.lastMonth = cal.monthIndex;
    const salaries = s.staff.reduce((a, st) => a + st.salary, 0);
    s.money -= salaries;
    s.stats.spent += salaries;
    const y = s.yearStats, m = s.monthStats;
    y.cured += m.cured; y.failed += m.failed; y.left += m.left; y.visits += m.visits; y.earned += m.earned; y.spent += m.spent + salaries;
    s.monthStats = emptyStats();
    if (cal.monthIndex % 12 === 0) {
      giveAwards(this, cal.year - 1);
      s.yearStats = emptyStats();
    }
    s.reputation += (50 - s.reputation) * BALANCE.repDrift;
    genCandidates(this);
    this.emit({ type: 'month', salaries, label: monthLabel(cal.monthIndex) });
    for (const [k, def] of Object.entries(ILLNESSES)) {
      if (def.month === cal.monthIndex && k) {
        this.emit({ type: 'toast', tone: 'info', text: `New illness in town: ${def.name}. Cure it in a ${ROOMS[def.room].name}.` });
      }
    }
  }

  private spawnCheck(dt: number) {
    const s = this.state;
    if (!this.opts.autoSpawn) return;
    const hasDesk = s.items.some((i) => i.type === 'reception');
    if (!hasDesk) {
      if (s.t > 3) this.hint('needDesk', 'Place a Front Desk (Items) so patients can check in.', 'info', 60);
      return;
    }
    s.spawnTimer -= dt;
    if (s.spawnTimer > 0) return;
    const cap = 18 + s.rooms.length * 5;
    if (s.patients.length < cap) spawnPatient(this);
    const repF = 1 - s.reputation / 100;
    const base = BALANCE.spawnMin + BALANCE.spawnRange * repF;
    const night = isNight(s.t) ? BALANCE.nightSlowdown : 1;
    const ease = s.t < MONTH ? 1.5 : 1;
    s.spawnTimer = (base * night * ease * Math.pow(s.priceMult, 1.2) * range(s.rng, 0.6, 1.4)) / (boosts(s).arrivals * scenarioById(s.scenario).spawnMult);
  }

  cmd(c: Command): CommandResult {
    const s = this.state;
    switch (c.type) {
      case 'buildRoom': {
        const v = validateRoom(this, c.room, c.rect, c.door);
        if (!v.ok) return { ok: false, reason: v.reason };
        const id = applyRoom(this, c.room, c.rect, c.door);
        this.afterGridChange();
        this.emit({ type: 'built', kind: 'room', id });
        return { ok: true, id };
      }
      case 'placeItem': {
        const v = validateItem(this, c.item, c.x, c.z, c.rot);
        if (!v.ok) return { ok: false, reason: v.reason };
        const id = applyItem(this, c.item, c.x, c.z, c.rot);
        this.afterGridChange();
        this.emit({ type: 'built', kind: 'item', id });
        return { ok: true, id };
      }
      case 'sellRoom': {
        const room = this.room(c.id);
        if (!room) return { ok: false, reason: 'no such room' };
        releasePatientsFrom(this, { room });
        releaseStaffFrom(this, { room });
        const cx = room.rect.x + room.rect.w / 2, cz = room.rect.z + room.rect.h / 2;
        const refund = sellRoom(this, c.id);
        this.afterGridChange();
        this.emit({ type: 'sold', kind: 'room', id: c.id, refund, x: cx, z: cz });
        return { ok: true, id: c.id };
      }
      case 'sellItem': {
        const item = this.item(c.id);
        if (!item) return { ok: false, reason: 'no such item' };
        if (item.roomId !== -1 && item.cost === 0) return { ok: false, reason: 'required by the room' };
        releasePatientsFrom(this, { item });
        releaseStaffFrom(this, { item });
        const refund = sellItem(this, c.id);
        this.afterGridChange();
        this.emit({ type: 'sold', kind: 'item', id: c.id, refund, x: item.x + 0.5, z: item.z + 0.5 });
        return { ok: true, id: c.id };
      }
      case 'hire':
        return hireCandidate(this, c.candidateId);
      case 'fire':
        return fireStaff(this, c.id);
      case 'train':
        return trainStaff(this, c.id);
      case 'research':
        return chooseResearch(this, c.id);
      case 'setPriceMult':
        s.priceMult = Math.max(0.5, Math.min(2, c.value));
        return { ok: true };
    }
  }

  /** Entities standing inside newly solid tiles get nudged; paths re-plan lazily in step(). */
  private afterGridChange() {
    for (const m of [...this.state.staff, ...this.state.patients] as Mover[]) {
      if (m.spot) continue;
      const tx = Math.floor(m.x), tz = Math.floor(m.z);
      if (this.grid.isBlocked(tx, tz)) {
        const free = nearestFree(this.grid, tx, tz);
        if (free) { m.x = free.x + 0.5; m.z = free.z + 0.5; m.px = m.x; m.pz = m.z; stop(m); }
      }
    }
  }
}

export function nearestFree(g: Grid, x: number, z: number) {
  for (let r = 1; r < 6; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (g.inside(x + dx, z + dz) && !g.isBlocked(x + dx, z + dz)) return { x: x + dx, z: z + dz };
      }
    }
  }
  return null;
}

export { MONTH, ITEMS, itemSpots };
