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
import {
  BALANCE, DIAGNOSIS_THRESHOLD, ILLNESSES, ITEMS, MAX_GP_VISITS, RECEPTION_DURATION, ROLES, ROOMS,
  type IllnessType, type RoomType,
} from './catalog';
import { itemSpots } from './build';
import { DIR_VEC, type Dir } from './grid';
import { adjustRep, calendar, earn } from './economy';
import { goTo, hop, moving, spotOf, step, stop } from './move';
import { randomName } from './names';
import { chance, int, rand, range } from './rng';
import type { Item, Patient, Room } from './state';
import { gainXp, releaseSpot, staffed } from './staff';
import { isRoomUnlocked } from './unlocks';
import { binNear, dropLitter, litterNear, roomBroken, wearMachines } from './janitor';
import { boosts } from './research';
import { scenarioById } from './scenarios';
import type { Pt } from './path';
import type { World } from './world';

export interface SpawnOpts { at?: Pt; emergency?: boolean; vip?: boolean }

const OPP: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };
const LEFT: Record<Dir, Dir> = { N: 'W', W: 'S', S: 'E', E: 'N' };
const RIGHT: Record<Dir, Dir> = { N: 'E', E: 'S', S: 'W', W: 'N' };

const THIRST_RATE = 0.3;
const PATIENCE_STAND = BALANCE.patienceStand;
const PATIENCE_SIT = BALANCE.patienceSit;

/** Weighted illness pick using the scenario's pool, unlock months and weights. */
export function pickIllnessFor(w: World): IllnessType {
  const s = w.state;
  const sc = scenarioById(s.scenario);
  const mi = calendar(s.t).monthIndex;
  const all = (sc.pool ?? (Object.keys(ILLNESSES) as IllnessType[]));
  const pool = all.filter((k) => s.sandbox || (sc.months?.[k] ?? ILLNESSES[k].month) <= mi);
  if (!pool.length) return 'chromaticFlu';
  const weight = (k: IllnessType) => ILLNESSES[k].weight * (sc.weights?.[k] ?? 1);
  const total = pool.reduce((a, k) => a + weight(k), 0);
  let r = rand(s.rng) * total;
  for (const k of pool) {
    r -= weight(k);
    if (r <= 0) return k;
  }
  return pool[0];
}

export function spawnPatient(w: World, illness?: IllnessType, opts: SpawnOpts = {}): Patient {
  const s = w.state;
  const ill = illness ?? pickIllnessFor(w);
  const fromLeft = chance(s.rng, 0.5);
  const x = opts.at?.x ?? (illness ? 21.5 + range(s.rng, -1, 2) : fromLeft ? 0.5 : 47.5);
  const z = opts.at?.z ?? 33.5 + range(s.rng, -0.3, 0.3);
  const speed = ill === 'jellylegs' ? 1.0 : ill === 'heliumLungs' ? 1.3 : 1.55;
  const p: Patient = {
    id: s.nextId++, x, z, px: x, pz: z, face: 0, path: [], pathI: 0, dest: null, pathVer: 0,
    speed: speed * range(s.rng, 0.9, 1.1), pose: 'stand', spot: null, name: randomName(s.rng), look: int(s.rng, 0, 1 << 20),
    illness: ill, diagnosed: false, certainty: 0, patience: 100, thirst: range(s.rng, 0, 45), happiness: 70,
    gpVisits: 0, scans: 0, state: 'arriving', need: null, target: -1, desk: -1, timer: 0, cured: false,
    leaveReason: '', thought: '', waitedFor: 0, arrivedAt: s.t, emergency: false, vip: false, litterT: range(s.rng, 60, 200),
  };
  if (opts.emergency) { p.emergency = true; p.diagnosed = true; p.certainty = 0.9; }
  if (opts.vip) { p.vip = true; p.cured = true; p.patience = 1e9; p.speed = 1.2; }
  s.patients.push(p);
  const e = w.grid.building.entrance;
  goTo(w.grid, p, e.x + int(s.rng, 0, 1) + 0.5, e.z + 0.5);
  w.emit({ type: 'arrived', id: p.id });
  return p;
}

// ---------- comfort ----------

let comfortCache: { ver: number; n: number; map: Float32Array } | null = null;
/** 0..0.4 comfort per tile from nearby decor and warmth. */
export function comfortAt(w: World, x: number, z: number) {
  const g = w.grid;
  if (!comfortCache || comfortCache.ver !== g.version || comfortCache.n !== w.state.items.length) {
    const map = new Float32Array(g.w * g.h);
    for (const it of w.state.items) {
      const def = ITEMS[it.type];
      const v = def.decor + (def.warmth ?? 0) * 0.6;
      if (v <= 0) continue;
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        const tx = it.x + dx, tz = it.z + dz;
        if (!g.inside(tx, tz)) continue;
        map[g.idx(tx, tz)] += v * (1 - Math.hypot(dx, dz) / 4.5);
      }
    }
    for (let i = 0; i < map.length; i++) map[i] = Math.max(0, Math.min(0.4, map[i] * 0.05));
    comfortCache = { ver: g.version, n: w.state.items.length, map };
  }
  const tx = Math.floor(x), tz = Math.floor(z);
  return g.inside(tx, tz) ? comfortCache.map[g.idx(tx, tz)] : 0;
}

function drainPatience(w: World, p: Patient, dt: number) {
  const base = p.pose === 'sit' ? PATIENCE_SIT : PATIENCE_STAND;
  const thirsty = p.thirst > 85 ? 1.3 : 1;
  const messy = litterNear(w.state, p.x, p.z) ? 1 + BALANCE.litterPatience : 1;
  p.patience -= dt * base * thirsty * messy * boosts(w.state).patience * (1 - comfortAt(w, p.x, p.z));
  p.waitedFor += dt;
  if (p.patience <= 0) leave(w, p, 'impatient');
}

// ---------- reception ----------

function deskStaffed(w: World, desk: Item) {
  const idx = ITEMS.reception.spots.findIndex((s) => s.kind === 'staff');
  const id = desk.claims[idx];
  if (id === -1) return false;
  const st = w.staffById(id);
  return !!st && st.state === 'atPost';
}

function deskSlots(w: World, desk: Item, n: number): Pt[] {
  const g = w.grid;
  const use = itemSpots(desk).find((s) => s.kind === 'use')!;
  let cx = Math.floor(use.ax), cz = Math.floor(use.az);
  const slots: Pt[] = [{ x: cx + 0.5, z: cz + 0.5 }];
  const used = new Set([cz * 1000 + cx]);
  let dir: Dir = OPP[use.face];
  while (slots.length < n) {
    let moved = false;
    for (const d of [dir, LEFT[dir], RIGHT[dir]]) {
      const v = DIR_VEC[d];
      const nx = cx + v.dx, nz = cz + v.dz;
      if (!g.isCorridor(nx, nz) || g.isBlocked(nx, nz) || used.has(nz * 1000 + nx) || !g.canStep(cx, cz, v.dx, v.dz)) continue;
      cx = nx; cz = nz; dir = d; moved = true;
      used.add(nz * 1000 + nx);
      slots.push({ x: nx + 0.5, z: nz + 0.5 });
      break;
    }
    if (!moved) break;
  }
  return slots;
}

function joinDesk(w: World, p: Patient) {
  let best: Item | null = null;
  for (const it of w.state.items) {
    if (it.type !== 'reception') continue;
    if (!best || it.queue.length < best.queue.length) best = it;
  }
  if (!best) return false;
  best.queue.push(p.id);
  p.desk = best.id;
  p.state = 'queueReception';
  stop(p);
  return true;
}

// ---------- rooms ----------

function nextNeed(w: World, p: Patient): RoomType {
  if (!p.diagnosed) {
    if (p.gpVisits === 0) return 'gp';
    if (p.scans < 1 && w.state.rooms.some((r) => r.type === 'scan')) return 'scan';
    return 'gp';
  }
  return ILLNESSES[p.illness].room;
}

function seekRoom(w: World, p: Patient) {
  releaseSpot(w, p);
  const need = nextNeed(w, p);
  p.need = need;
  const rooms = w.state.rooms.filter((r) => r.type === need);
  p.state = 'waiting';
  stop(p);
  if (!rooms.length) {
    p.target = -1;
    needHint(w, need);
    return;
  }
  let best = rooms[0], bestS = Infinity;
  for (const r of rooms) {
    const score = r.queue.length * 2 + r.occupants.length + (r.staffId === -1 ? 6 : 0) +
      (Math.abs(r.door.x - p.x) + Math.abs(r.door.z - p.z)) / 15;
    if (score < bestS) { bestS = score; best = r; }
  }
  if (p.emergency) {
    // emergencies go in behind other emergencies, ahead of everyone else
    let i = 0;
    while (i < best.queue.length && w.patient(best.queue[i])?.emergency) i++;
    best.queue.splice(i, 0, p.id);
  } else best.queue.push(p.id);
  p.target = best.id;
}

/** The inspector strolls between room doors until the inspection ends. */
function updateVip(w: World, p: Patient, dt: number) {
  if (p.state === 'arriving') {
    if (step(w.grid, p, dt) || !p.dest) { p.state = 'waiting'; p.timer = 1; stop(p); }
    return;
  }
  if (moving(p)) { step(w.grid, p, dt); return; }
  p.timer -= dt;
  if (p.timer > 0) return;
  p.timer = range(w.state.rng, 2.5, 5);
  const rooms = w.state.rooms;
  if (rooms.length && chance(w.state.rng, 0.75)) {
    const r = rooms[int(w.state.rng, 0, rooms.length - 1)];
    const v = DIR_VEC[r.door.dir];
    goTo(w.grid, p, r.door.x + v.dx + 0.5, r.door.z + v.dz + 0.5);
    p.face = Math.atan2(-v.dx, -v.dz);
  } else {
    const b = w.grid.building;
    const x = b.x + int(w.state.rng, 0, b.w - 1), z = b.z + int(w.state.rng, 0, b.h - 1);
    if (w.grid.isCorridor(x, z) && !w.grid.isBlocked(x, z)) goTo(w.grid, p, x + 0.5, z + 0.5);
  }
}

function needHint(w: World, need: RoomType) {
  const def = ROOMS[need];
  if (!isRoomUnlocked(w.state, need)) w.hint(`need:${need}`, `Patients need ${def.name}. Research it in a Research Lab first. ${def.icon}`);
  else w.hint(`need:${need}`, `Patients need a ${def.name}! ${def.icon}`);
}

function refPoint(w: World, p: Patient): Pt {
  const room = p.target >= 0 ? w.room(p.target) : undefined;
  if (room) {
    const v = DIR_VEC[room.door.dir];
    return { x: room.door.x + v.dx + 0.5, z: room.door.z + v.dz + 0.5 };
  }
  const desk = w.state.items.find((i) => i.type === 'reception');
  if (desk) {
    const u = itemSpots(desk).find((s) => s.kind === 'use')!;
    return { x: u.ax, z: u.az };
  }
  const e = w.grid.building.entrance;
  return { x: e.x + 1, z: e.z - 2 };
}

/** Pick a bench seat near the room, or a free corridor tile to stand on. */
function settleWait(w: World, p: Patient) {
  const ref = refPoint(w, p);
  let best: { it: Item; idx: number } | null = null;
  let bestD = 14;
  for (const it of w.state.items) {
    if (it.roomId !== -1) continue;
    const spots = ITEMS[it.type].spots;
    for (let idx = 0; idx < spots.length; idx++) {
      if (spots[idx].kind !== 'seat' || it.claims[idx] !== -1) continue;
      const sp = spotOf(it, idx);
      const d = Math.hypot(sp.ax - ref.x, sp.az - ref.z);
      if (d < bestD) { bestD = d; best = { it, idx }; }
    }
  }
  if (best) {
    const sp = spotOf(best.it, best.idx);
    if (goTo(w.grid, p, sp.ax, sp.az)) {
      best.it.claims[best.idx] = p.id;
      p.spot = { item: best.it.id, idx: best.idx };
      return;
    }
  }
  const g = w.grid;
  for (let i = 0; i < 12; i++) {
    const x = Math.floor(ref.x) + int(w.state.rng, -3, 3);
    const z = Math.floor(ref.z) + int(w.state.rng, -3, 3);
    if (g.isCorridor(x, z) && !g.isBlocked(x, z) && goTo(g, p, x + range(w.state.rng, 0.3, 0.7), z + range(w.state.rng, 0.3, 0.7))) return;
  }
  goTo(g, p, ref.x, ref.z);
}

function findDrink(w: World, p: Patient): { it: Item; idx: number } | null {
  let best: { it: Item; idx: number } | null = null;
  let bestD = 24;
  for (const it of w.state.items) {
    if (it.type !== 'vending' && it.type !== 'cooler') continue;
    if (it.roomId !== -1) continue;
    if (it.claims[0] !== -1) continue;
    const sp = spotOf(it, 0);
    const d = Math.hypot(sp.ax - p.x, sp.az - p.z);
    if (d < bestD) { bestD = d; best = { it, idx: 0 }; }
  }
  return best;
}

function patientSpots(w: World, room: Room) {
  const out: { item: Item; idx: number }[] = [];
  for (const iid of room.items) {
    const it = w.item(iid);
    if (!it) continue;
    ITEMS[it.type].spots.forEach((s, idx) => { if (s.kind === 'patient') out.push({ item: it, idx }); });
  }
  return out;
}

/** Call waiting patients into rooms that have a free spot and a working staff member. */
export function updateRooms(w: World, dt: number) {
  const queued = new Map<string, number>();
  for (const room of w.state.rooms) queued.set(room.type, (queued.get(room.type) ?? 0) + room.queue.length);
  for (const [type, n] of queued) {
    const count = w.state.rooms.filter((r) => r.type === type).length;
    if (n / count >= 6) w.hint(`queue:${type}`, `The ${ROOMS[type as RoomType].name} queue is getting long. Build another one?`, 'warn', 90);
  }
  for (const room of w.state.rooms) {
    const svc = ROOMS[room.type].service;
    if (svc === 'none' || svc === 'research') continue;
    if (roomBroken(w, room)) {
      if (room.queue.length && !w.state.staff.some((x) => x.role === 'janitor')) w.hint('needJanitor', 'A machine is broken and patients are waiting. Hire a Janitor!', 'warn', 60);
      continue;
    }
    const st = staffed(w, room);
    if (st) st.busy = room.occupants.some((id) => w.patient(id)?.state === 'inRoom');
    if (!st) {
      const role = ROOMS[room.type].staff;
      if (room.queue.length && role) {
        w.hint(`staff:${room.type}`, `${ROOMS[room.type].name} needs a ${ROLES[role].name}. Hire one in Staff.`);
      }
      continue;
    }
    for (const sp of patientSpots(w, room)) {
      if (sp.item.claims[sp.idx] !== -1) continue;
      const pid = room.queue.find((id) => w.patient(id)?.state === 'waiting');
      if (pid === undefined) break;
      const p = w.patient(pid)!;
      releaseSpot(w, p);
      const spot = spotOf(sp.item, sp.idx);
      if (!goTo(w.grid, p, spot.ax, spot.az)) continue;
      room.queue = room.queue.filter((id) => id !== pid);
      room.occupants.push(pid);
      sp.item.claims[sp.idx] = pid;
      p.spot = { item: sp.item.id, idx: sp.idx };
      p.state = 'toRoom';
    }
  }
  void dt;
}

function completeService(w: World, p: Patient, room: Room, skill: number, trait: string) {
  const s = w.state;
  const def = ROOMS[room.type];
  const ill = ILLNESSES[p.illness];
  releaseSpot(w, p);
  room.occupants = room.occupants.filter((id) => id !== p.id);
  w.emit({ type: 'service', roomId: room.id, patientId: p.id, phase: 'end' });
  wearMachines(w, room);
  if (def.service === 'gp' || def.service === 'diagnose') {
    let base = def.service === 'gp' ? BALANCE.gpBase + BALANCE.gpPerSkill * skill : BALANCE.scanBase + BALANCE.scanPerSkill * skill;
    if (trait === 'Sharp Eye') base += 8;
    base += boosts(s).diagnosis;
    p.certainty = Math.min(1, p.certainty + (base / 100) * (1 - 0.35 * ill.difficulty));
    if (def.service === 'gp') p.gpVisits++;
    else p.scans++;
    const fee = Math.round(def.fee * s.priceMult);
    earn(s, fee);
    s.stats.visits++;
    w.emit({ type: 'paid', amount: fee, x: p.x, z: p.z, label: def.name });
    if (p.certainty >= DIAGNOSIS_THRESHOLD - 1e-9 || p.gpVisits >= MAX_GP_VISITS) {
      p.diagnosed = true;
      w.emit({ type: 'diagnosed', id: p.id, illness: p.illness });
    }
    p.state = 'seekRoom';
    return;
  }
  const chanceOk = Math.min(BALANCE.cureCap, BALANCE.cureBase + BALANCE.curePerSkill * skill + (trait === 'Steady Hands' ? 0.05 : 0) + boosts(s).cure) * (1 - BALANCE.certaintyWeight + BALANCE.certaintyWeight * p.certainty);
  const force = w.opts.forceTreatment;
  const success = force ? force === 'success' : rand(s.rng) < chanceOk;
  if (success) {
    const fee = Math.round(ill.fee * s.priceMult);
    earn(s, fee);
    p.cured = true;
    s.stats.cured++;
    s.monthStats.cured++;
    adjustRep(s, BALANCE.repCured * (2 - s.priceMult));
    w.emit({ type: 'cured', id: p.id, x: p.x, z: p.z, fee });
    p.leaveReason = 'cured';
    if (p.emergency && s.event?.kind === 'emergency' && s.event.ids.includes(p.id)) s.event.cured++;
  } else {
    s.stats.failed++;
    s.monthStats.failed++;
    adjustRep(s, BALANCE.repFailed);
    w.emit({ type: 'failed', id: p.id, x: p.x, z: p.z });
    p.leaveReason = 'treatment failed';
  }
  p.state = 'leaving';
  stop(p);
}

function unqueue(w: World, p: Patient) {
  for (const r of w.state.rooms) {
    if (r.queue.includes(p.id)) r.queue = r.queue.filter((id) => id !== p.id);
    if (r.occupants.includes(p.id)) r.occupants = r.occupants.filter((id) => id !== p.id);
  }
  for (const it of w.state.items) if (it.queue.includes(p.id)) it.queue = it.queue.filter((id) => id !== p.id);
  p.desk = -1;
}

export function leave(w: World, p: Patient, reason: string) {
  const s = w.state;
  unqueue(w, p);
  releaseSpot(w, p);
  p.state = 'leaving';
  p.leaveReason = reason;
  stop(p);
  if (reason === 'impatient') {
    s.stats.left++;
    s.monthStats.left++;
    adjustRep(s, BALANCE.repLeft);
    w.emit({ type: 'left', id: p.id, reason });
    w.hint('leaving', 'Patients are storming out after waiting too long! 😤');
  }
}

/** Release patients tied to a room or item that is being sold. */
export function releasePatientsFrom(w: World, what: { room?: Room; item?: Item }) {
  for (const p of w.state.patients) {
    if (what.room && p.target === what.room.id) {
      unqueue(w, p);
      releaseSpot(w, p);
      p.target = -1;
      if (p.state === 'toRoom' || p.state === 'inRoom' || p.state === 'waiting') p.state = 'seekRoom';
      stop(p);
    }
    const seatGone = p.spot && ((what.item && p.spot.item === what.item.id) || (what.room && what.room.items.includes(p.spot.item)));
    if (seatGone) {
      releaseSpot(w, p);
      stop(p);
      if (p.state === 'toVending' || p.state === 'atVending') p.state = 'waiting';
    }
    if (what.item && what.item.type === 'reception' && p.desk === what.item.id) {
      p.desk = -1;
      p.state = 'queueReception';
      stop(p);
    }
  }
}

export function updatePatients(w: World, dt: number) {
  const s = w.state;
  const slotCache = new Map<number, Pt[]>();
  for (const p of s.patients) {
    if (p.vip && p.state !== 'leaving' && p.state !== 'gone') { updateVip(w, p, dt); continue; }
    p.thirst = Math.min(100, p.thirst + dt * THIRST_RATE);
    switch (p.state) {
      case 'arriving':
        if (step(w.grid, p, dt) || !p.dest) {
          if (p.emergency) p.state = 'seekRoom';
          else if (!joinDesk(w, p)) p.state = 'queueReception';
        }
        break;

      case 'queueReception': {
        if (p.desk === -1) {
          if (!joinDesk(w, p)) {
            if (!moving(p)) settleWait(w, p);
            step(w.grid, p, dt);
            drainPatience(w, p, dt);
            p.thought = 'lost';
          }
          break;
        }
        const desk = w.item(p.desk);
        if (!desk) { p.desk = -1; break; }
        let slots = slotCache.get(desk.id);
        if (!slots) { slots = deskSlots(w, desk, desk.queue.length); slotCache.set(desk.id, slots); }
        const idx = desk.queue.indexOf(p.id);
        const slot = slots[Math.min(idx, slots.length - 1)];
        if (!p.dest || Math.abs(p.dest.x - slot.x) > 0.01 || Math.abs(p.dest.z - slot.z) > 0.01) goTo(w.grid, p, slot.x, slot.z);
        const arrived = step(w.grid, p, dt);
        drainPatience(w, p, dt);
        if (p.state !== 'queueReception') break;
        if (idx === 0 && arrived) {
          const use = itemSpots(desk).find((x) => x.kind === 'use')!;
          p.face = use.angle;
          if (deskStaffed(w, desk)) {
            p.state = 'atReception';
            p.timer = RECEPTION_DURATION;
          } else {
            w.hint('desk', 'The Front Desk needs an Assistant. Hire one in Staff.');
          }
        }
        p.thought = '';
        break;
      }

      case 'atReception': {
        const desk = w.item(p.desk);
        if (!desk) { p.desk = -1; p.state = 'queueReception'; break; }
        if (deskStaffed(w, desk)) p.timer -= dt;
        if (p.timer <= 0) {
          desk.queue = desk.queue.filter((id) => id !== p.id);
          p.desk = -1;
          p.state = 'seekRoom';
        }
        break;
      }

      case 'seekRoom':
        seekRoom(w, p);
        break;

      case 'waiting': {
        if (p.target >= 0 && !w.room(p.target)) { p.target = -1; p.state = 'seekRoom'; break; }
        if (p.target === -1 && p.need && s.rooms.some((r) => r.type === p.need)) { p.state = 'seekRoom'; break; }
        if (p.target === -1 && p.need) needHint(w, p.need);
        if (!p.spot && !p.dest) settleWait(w, p);
        if (!p.spot && !moving(p) && w.grid.room(Math.floor(p.x), Math.floor(p.z)) !== -1) stop(p);
        const arrived = step(w.grid, p, dt);
        if (p.spot && arrived && p.pose !== 'sit') {
          const it = w.item(p.spot.item);
          if (it) hop(p, spotOf(it, p.spot.idx));
        }
        if (p.thirst > 70 && (!moving(p))) {
          const drink = findDrink(w, p);
          if (drink) {
            releaseSpot(w, p);
            const sp = spotOf(drink.it, drink.idx);
            if (goTo(w.grid, p, sp.ax, sp.az)) {
              drink.it.claims[drink.idx] = p.id;
              p.spot = { item: drink.it.id, idx: drink.idx };
              p.state = 'toVending';
              break;
            }
          }
        }
        p.thought = p.target === -1 ? 'noRoom' : p.thirst > 70 ? 'thirsty' : p.patience < 30 ? 'impatient' : '';
        p.litterT -= dt;
        if (p.litterT <= 0) {
          p.litterT = range(s.rng, BALANCE.wrapperMin, BALANCE.wrapperMax);
          if (!(binNear(w, p.x, p.z) && rand(s.rng) < 0.7)) dropLitter(w, p.x + range(s.rng, -0.5, 0.5), p.z + range(s.rng, -0.5, 0.5), 'wrapper');
        }
        drainPatience(w, p, dt);
        break;
      }

      case 'toVending': {
        if (!p.spot) { p.state = 'waiting'; break; }
        const it = w.item(p.spot.item);
        if (!it) { p.spot = null; p.state = 'waiting'; break; }
        if (step(w.grid, p, dt)) {
          hop(p, spotOf(it, p.spot.idx));
          p.state = 'atVending';
          p.timer = 2.5;
        }
        drainPatience(w, p, dt);
        break;
      }

      case 'atVending': {
        p.timer -= dt;
        if (p.timer <= 0) {
          const it = p.spot ? w.item(p.spot.item) : undefined;
          if (it?.type === 'vending') {
            const amount = Math.round(boosts(s).vending * s.priceMult);
            earn(s, amount);
            w.emit({ type: 'paid', amount, x: p.x, z: p.z, label: 'Fizz' });
          }
          const dropChance = it?.type === 'vending' ? BALANCE.litterCan : it?.type === 'cooler' ? BALANCE.litterPuddle : 0;
          if (dropChance > 0 && !binNear(w, p.x, p.z) && rand(s.rng) < dropChance) {
            dropLitter(w, p.x + range(s.rng, -0.6, 0.6), p.z + range(s.rng, 0.3, 0.9), it?.type === 'cooler' ? 'puddle' : 'can');
          }
          p.thirst = 0;
          releaseSpot(w, p);
          p.state = 'waiting';
          stop(p);
        }
        break;
      }

      case 'toRoom': {
        const room = w.room(p.target);
        if (!room || !p.spot) { p.state = 'seekRoom'; break; }
        if (step(w.grid, p, dt)) {
          const it = w.item(p.spot.item);
          if (!it) { p.state = 'seekRoom'; break; }
          hop(p, spotOf(it, p.spot.idx));
          p.state = 'inRoom';
          const st = w.staffById(room.staffId);
          const skill = st?.skill ?? 1;
          p.timer = ROOMS[room.type].duration * (1.15 - 0.06 * skill);
          w.emit({ type: 'service', roomId: room.id, patientId: p.id, phase: 'start' });
        }
        break;
      }

      case 'inRoom': {
        const room = w.room(p.target);
        if (!room) { p.state = 'seekRoom'; break; }
        const st = staffed(w, room);
        if (!st) break;
        p.timer -= dt * (st.energy < 20 ? 1 / 1.5 : 1);
        if (p.timer <= 0) {
          completeService(w, p, room, st.skill, st.trait);
          gainXp(w, st);
        }
        break;
      }

      case 'leaving': {
        if (!p.dest) {
          const exitX = p.x < 24 ? 0.5 : 47.5;
          if (!goTo(w.grid, p, exitX, 33.5)) { p.state = 'gone'; break; }
        }
        if (step(w.grid, p, dt)) p.state = 'gone';
        break;
      }

      case 'gone':
        break;
    }
  }
}
