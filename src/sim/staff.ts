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
import { ITEMS, ROLES, ROOMS, type Role } from './catalog';
import { itemSpots } from './build';
import { salaryFor } from './economy';
import { goTo, hop, moving, spotOf, step, stop } from './move';
import { randomName, TRAITS } from './names';
import { int, pick, rand, range } from './rng';
import type { Item, Mover, Room, Staff } from './state';
import type { CommandResult } from './events';
import type { World } from './world';
import { updateJanitor } from './janitor';

export const HIRE_ROLES: Role[] = ['doctor', 'nurse', 'assistant', 'janitor'];

const ENERGY_POST = 0.25;
const ENERGY_BUSY = 0.45;
const BREAK_AT = 22;
const BREAK_DONE = 95;
const RECOVER = 3.5;
export const XP_PER_STAR = 30;
export const TRAIN_COST_PER_STAR = 1500;
const TRAIN_SECONDS_PER_STAR = 50;
const PER_ROLE = 3;
export const EXIT = { x: 0.5, z: 33.5 };

function rollSkill(w: World) {
  const r = rand(w.state.rng);
  return r < 0.35 ? 1 : r < 0.65 ? 2 : r < 0.85 ? 3 : r < 0.95 ? 4 : 5;
}

export function genCandidates(w: World) {
  const s = w.state;
  s.candidates = [];
  for (const role of HIRE_ROLES) for (let i = 0; i < PER_ROLE; i++) s.candidates.push(newCandidate(w, role));
}

function newCandidate(w: World, role: Role) {
  const s = w.state;
  const skill = rollSkill(w);
  return {
    id: s.nextId++, role, name: randomName(s.rng), skill,
    salary: salaryFor(role, skill), trait: pick(s.rng, TRAITS), look: int(s.rng, 0, 1 << 20),
  };
}

export function signingBonus(salary: number) {
  return Math.round(salary * 0.25);
}

export function hireCandidate(w: World, candidateId: number): CommandResult {
  const s = w.state;
  const c = s.candidates.find((x) => x.id === candidateId);
  if (!c) return { ok: false, reason: 'no such candidate' };
  const salary = salaryFor(c.role, c.skill);
  const bonus = signingBonus(salary);
  if (s.money < bonus) return { ok: false, reason: 'not enough money' };
  s.money -= bonus;
  s.stats.spent += bonus;
  s.monthStats.spent += bonus;
  const x = 21.5 + range(s.rng, -1, 2), z = 33.5;
  const st: Staff = {
    id: s.nextId++, x, z, px: x, pz: z, face: Math.PI, path: [], pathI: 0, dest: null, pathVer: 0,
    speed: c.trait === 'Speedy' ? 2.4 : 2.0, pose: 'stand', spot: null, name: c.name, look: c.look,
    role: c.role, skill: c.skill, salary, trait: c.trait, state: 'idle', post: -1, busy: false, hiredAt: s.t,
    energy: 100, mood: 80, xp: 0, trainLeft: 0, job: null,
  };
  s.staff.push(st);
  s.candidates = s.candidates.filter((x) => x.id !== candidateId);
  s.candidates.push(newCandidate(w, c.role));
  w.emit({ type: 'hired', id: st.id });
  return { ok: true, id: st.id };
}

export function fireStaff(w: World, id: number): CommandResult {
  const st = w.staffById(id);
  if (!st || st.state === 'leaving') return { ok: false, reason: 'no such staff' };
  unpost(w, st);
  st.state = 'leaving';
  goTo(w.grid, st, EXIT.x, EXIT.z);
  w.emit({ type: 'fired', id });
  return { ok: true, id };
}

/** The item + spot index a room's staff member works at. */
export function staffSpotOf(w: World, room: Room): { item: Item; idx: number } | null {
  for (const iid of room.items) {
    const it = w.item(iid);
    if (!it) continue;
    const idx = ITEMS[it.type].spots.findIndex((sp) => sp.kind === 'staff');
    if (idx >= 0) return { item: it, idx };
  }
  return null;
}

export function releaseSpot(w: World, m: Mover) {
  if (!m.spot) return;
  const it = w.item(m.spot.item);
  if (it) {
    if (it.claims[m.spot.idx] === m.id) it.claims[m.spot.idx] = -1;
    const sp = itemSpots(it)[m.spot.idx];
    if (m.pose !== 'stand' || (Math.abs(m.x - sp.x) < 0.05 && Math.abs(m.z - sp.z) < 0.05)) {
      m.x = sp.ax;
      m.z = sp.az;
    }
  }
  m.spot = null;
  m.pose = 'stand';
}

/** The item + spot index of a staff member's post (room console or front desk). */
export function postSpot(w: World, st: Staff): { item: Item; idx: number } | null {
  if (st.post >= 0) {
    const room = w.room(st.post);
    return room ? staffSpotOf(w, room) : null;
  }
  if (st.post < -1) {
    const it = w.item(-st.post - 1);
    if (!it) return null;
    const idx = ITEMS[it.type].spots.findIndex((sp) => sp.kind === 'staff');
    return idx >= 0 ? { item: it, idx } : null;
  }
  return null;
}

function unpost(w: World, st: Staff) {
  st.job = null;
  const ps = postSpot(w, st);
  if (ps && ps.item.claims[ps.idx] === st.id) ps.item.claims[ps.idx] = -1;
  if (st.post >= 0) {
    const room = w.room(st.post);
    if (room && room.staffId === st.id) room.staffId = -1;
  }
  releaseSpot(w, st);
  st.post = -1;
  st.busy = false;
  stop(st);
}

function freeSpot(w: World, kind: 'rest' | 'study', roomType: 'staffRoom' | 'training', st: Staff): { item: Item; idx: number } | null {
  let best: { item: Item; idx: number } | null = null;
  let bestD = Infinity;
  for (const room of w.state.rooms) {
    if (room.type !== roomType) continue;
    for (const iid of room.items) {
      const it = w.item(iid);
      if (!it) continue;
      ITEMS[it.type].spots.forEach((sp, idx) => {
        if (sp.kind !== kind || it.claims[idx] !== -1) return;
        const ws = itemSpots(it)[idx];
        const d = Math.abs(ws.ax - st.x) + Math.abs(ws.az - st.z);
        if (d < bestD) { bestD = d; best = { item: it, idx }; }
      });
    }
  }
  return best;
}

/** Leave the post spot without giving up the post, and walk to `target`. */
function stepAway(w: World, st: Staff, target: { item: Item; idx: number }, state: Staff['state']) {
  const cur = st.spot ? w.item(st.spot.item) : undefined;
  if (cur && st.spot) {
    const sp = itemSpots(cur)[st.spot.idx];
    st.x = sp.ax;
    st.z = sp.az;
  }
  st.pose = 'stand';
  target.item.claims[target.idx] = st.id;
  st.spot = { item: target.item.id, idx: target.idx };
  const ts = spotOf(target.item, target.idx);
  if (!goTo(w.grid, st, ts.ax, ts.az)) {
    target.item.claims[target.idx] = -1;
    st.spot = null;
    return false;
  }
  st.state = state;
  return true;
}

/** +1 xp per completed service; every XP_PER_STAR earns a star and a raise. */
export function gainXp(w: World, st: Staff) {
  st.xp++;
  if (st.xp >= XP_PER_STAR) {
    st.xp = 0;
    if (st.skill < 5) {
      st.skill++;
      st.salary = salaryFor(st.role, st.skill);
      w.emit({ type: 'promoted', id: st.id, skill: st.skill });
    }
  }
}

export function trainStaff(w: World, id: number): CommandResult {
  const s = w.state;
  const st = w.staffById(id);
  if (!st || st.state === 'leaving') return { ok: false, reason: 'no such staff' };
  if (st.state === 'toTraining' || st.state === 'training') return { ok: false, reason: 'already training' };
  if (st.skill >= 5) return { ok: false, reason: 'already a five-star expert' };
  if (!s.rooms.some((r) => r.type === 'training')) return { ok: false, reason: 'build a Training Room first' };
  const desk = freeSpot(w, 'study', 'training', st);
  if (!desk) return { ok: false, reason: 'the Training Room is full' };
  const cost = TRAIN_COST_PER_STAR * st.skill;
  if (s.money < cost) return { ok: false, reason: 'not enough money' };
  unpost(w, st);
  if (!stepAway(w, st, desk, 'toTraining')) { st.state = 'idle'; return { ok: false, reason: 'cannot reach the Training Room' }; }
  s.money -= cost;
  s.stats.spent += cost;
  s.monthStats.spent += cost;
  st.trainLeft = TRAIN_SECONDS_PER_STAR * st.skill;
  return { ok: true, id: st.id };
}

function quit(w: World, st: Staff) {
  unpost(w, st);
  st.state = 'leaving';
  goTo(w.grid, st, EXIT.x, EXIT.z);
  w.emit({ type: 'quit', id: st.id });
  w.emit({ type: 'toast', tone: 'bad', text: `${st.name} quit, completely exhausted. A Staff Room keeps people going.` });
}

/** Free any staff working in a room or at an item that is about to disappear. */
export function releaseStaffFrom(w: World, what: { room?: Room; item?: Item }) {
  for (const st of w.state.staff) {
    const inRoom = what.room && st.post === what.room.id;
    const atItem = what.item && (st.spot?.item === what.item.id || st.post === -what.item.id - 1);
    const roomItem = what.room && st.spot && what.room.items.includes(st.spot.item);
    if (inRoom || atItem || roomItem) {
      unpost(w, st);
      if (st.state !== 'leaving') st.state = 'idle';
      st.trainLeft = 0;
    }
  }
}

function findPost(w: World, st: Staff): { room: Room | null; item: Item; idx: number } | null {
  let best: { room: Room | null; item: Item; idx: number } | null = null;
  let bestD = Infinity;
  const consider = (room: Room | null, item: Item, idx: number) => {
    const sp = itemSpots(item)[idx];
    const d = Math.abs(sp.ax - st.x) + Math.abs(sp.az - st.z);
    if (d < bestD) { bestD = d; best = { room, item, idx }; }
  };
  if (st.role === 'assistant') {
    for (const it of w.state.items) {
      if (it.type !== 'reception') continue;
      const idx = ITEMS.reception.spots.findIndex((s) => s.kind === 'staff');
      if (it.claims[idx] === -1) consider(null, it, idx);
    }
  }
  for (const room of w.state.rooms) {
    if (room.staffId !== -1 || ROOMS[room.type].staff !== st.role) continue;
    const ss = staffSpotOf(w, room);
    if (ss && ss.item.claims[ss.idx] === -1) consider(room, ss.item, ss.idx);
  }
  return best;
}

/** Head for a free Staff Room seat. Returns false if there is none. */
export function tryBreak(w: World, st: Staff): boolean {
  if (st.energy >= BREAK_AT) return false;
  const rest = freeSpot(w, 'rest', 'staffRoom', st);
  if (rest && stepAway(w, st, rest, 'toBreak')) return true;
  if (st.energy < 10) w.hint('noStaffRoom', 'Your staff are exhausted and slowing down. Build a Staff Room!', 'warn', 60);
  return false;
}

function needs(w: World, st: Staff, dt: number) {
  if (st.state === 'atPost') st.energy = Math.max(0, st.energy - dt * (st.busy ? ENERGY_BUSY : ENERGY_POST));
  else if (st.state === 'toJob') st.energy = Math.max(0, st.energy - dt * ENERGY_POST);
  else if (st.state === 'doingJob') st.energy = Math.max(0, st.energy - dt * ENERGY_BUSY);
  else if (st.state === 'onBreak') {
    st.energy = Math.min(100, st.energy + dt * RECOVER);
    st.mood = Math.min(100, st.mood + dt * 0.5);
  }
  if (st.energy < 10) st.mood -= dt * 0.25;
  else if (st.energy > 50) st.mood = Math.min(80, st.mood + dt * 0.03);
  st.mood = Math.max(0, st.mood);
  if (st.mood <= 0) quit(w, st);
}

export function updateStaff(w: World, dt: number) {
  const s = w.state;
  for (const st of s.staff) {
    if (st.state !== 'leaving') needs(w, st, dt);
    if (st.role === 'janitor' && (st.state === 'idle' || st.state === 'toJob' || st.state === 'doingJob')) {
      updateJanitor(w, st, dt);
      continue;
    }
    switch (st.state) {
      case 'idle': {
        const post = findPost(w, st);
        if (post) {
          if (post.room) post.room.staffId = st.id;
          post.item.claims[post.idx] = st.id;
          st.spot = { item: post.item.id, idx: post.idx };
          st.post = post.room ? post.room.id : -post.item.id - 1;
          const sp = spotOf(post.item, post.idx);
          if (goTo(w.grid, st, sp.ax, sp.az)) {
            st.state = 'toPost';
          } else {
            unpost(w, st);
          }
          break;
        }
        if (!moving(st)) {
          if (rand(s.rng) < dt * 0.25) wander(w, st);
        } else step(w.grid, st, dt * 0.6);
        break;
      }
      case 'toPost': {
        if (!st.spot) { st.state = 'idle'; break; }
        const it = w.item(st.spot.item);
        if (!it) { unpost(w, st); st.state = 'idle'; break; }
        if (step(w.grid, st, dt)) {
          hop(st, spotOf(it, st.spot.idx));
          st.state = 'atPost';
        }
        break;
      }
      case 'atPost': {
        if (!st.busy) tryBreak(w, st);
        break;
      }
      case 'toBreak':
      case 'toTraining': {
        const it = st.spot ? w.item(st.spot.item) : undefined;
        if (!it || !st.spot) { unpost(w, st); st.state = 'idle'; break; }
        if (step(w.grid, st, dt)) {
          hop(st, spotOf(it, st.spot.idx));
          st.state = st.state === 'toBreak' ? 'onBreak' : 'training';
        }
        break;
      }
      case 'onBreak': {
        if (st.energy >= BREAK_DONE) {
          releaseSpot(w, st);
          const ps = postSpot(w, st);
          if (ps && ps.item.claims[ps.idx] === st.id) {
            st.spot = { item: ps.item.id, idx: ps.idx };
            const sp = spotOf(ps.item, ps.idx);
            st.state = goTo(w.grid, st, sp.ax, sp.az) ? 'toPost' : 'idle';
          } else {
            unpost(w, st);
            st.state = 'idle';
          }
        }
        break;
      }
      case 'training': {
        st.trainLeft -= dt;
        if (st.trainLeft <= 0) {
          st.trainLeft = 0;
          st.skill = Math.min(5, st.skill + 1);
          st.salary = salaryFor(st.role, st.skill);
          releaseSpot(w, st);
          st.state = 'idle';
          w.emit({ type: 'trained', id: st.id, skill: st.skill });
        }
        break;
      }
      case 'leaving':
        if (step(w.grid, st, dt) || !st.dest) st.post = -2;
        break;
    }
  }
  s.staff = s.staff.filter((st) => !(st.state === 'leaving' && st.post === -2));
}

function wander(w: World, st: Staff) {
  const g = w.grid;
  const b = g.building;
  for (let i = 0; i < 8; i++) {
    const x = b.x + int(w.state.rng, 0, b.w - 1);
    const z = b.z + int(w.state.rng, 0, b.h - 1);
    if (g.isCorridor(x, z) && !g.isBlocked(x, z) && Math.abs(x - st.x) + Math.abs(z - st.z) < 10) {
      goTo(g, st, x + 0.5, z + 0.5);
      return;
    }
  }
}

/** Is a room's staff member present and working? */
export function staffed(w: World, room: Room): Staff | null {
  if (room.staffId === -1) return null;
  const st = w.staffById(room.staffId);
  return st && st.state === 'atPost' ? st : null;
}

export function roleName(role: Role) {
  return ROLES[role].name;
}
