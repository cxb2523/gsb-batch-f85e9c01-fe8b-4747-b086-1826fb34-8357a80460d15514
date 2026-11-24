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
import { BALANCE, ITEMS, ROOMS } from './catalog';
import { itemFootprint, itemSpots } from './build';
import { DIR_VEC, DIRS } from './grid';
import { goTo, moving, step, stop } from './move';
import { int, rand, range } from './rng';
import type { Item, Litter, Room, Staff, WorldState } from './state';
import type { World } from './world';
import { boosts } from './research';
import { tryBreak } from './staff';

const MAX_LITTER = 200;

export function dropLitter(w: World, x: number, z: number, kind: Litter['kind']) {
  const s = w.state;
  if (s.litter.length >= MAX_LITTER) return;
  const tx = Math.floor(x), tz = Math.floor(z);
  if (!w.grid.inBuilding(tx, tz) || w.grid.isBlocked(tx, tz)) return;
  s.litter.push({ id: s.nextId++, x: tx + range(s.rng, 0.2, 0.8), z: tz + range(s.rng, 0.2, 0.8), kind, t: s.t });
}

/** 1 = spotless, 0 = a tip. */
export function cleanliness(s: WorldState): number {
  return 1 - Math.min(1, s.litter.length / 25);
}

export function binNear(w: World, x: number, z: number, r = 4): boolean {
  return w.state.items.some((it) => it.type === 'bin' && Math.abs(it.x + 0.5 - x) <= r && Math.abs(it.z + 0.5 - z) <= r);
}

export function litterNear(s: WorldState, x: number, z: number, r = 2): boolean {
  for (const l of s.litter) if (Math.abs(l.x - x) <= r && Math.abs(l.z - z) <= r) return true;
  return false;
}

export function machinesOf(w: World, room: Room): Item[] {
  const out: Item[] = [];
  for (const iid of room.items) {
    const it = w.item(iid);
    if (it && ITEMS[it.type].machine) out.push(it);
  }
  return out;
}

export function roomBroken(w: World, room: Room): boolean {
  return machinesOf(w, room).some((m) => m.broken);
}

/** Called after every completed service in a room. */
export function wearMachines(w: World, room: Room) {
  const k = boosts(w.state).wear;
  for (const m of machinesOf(w, room)) {
    if (m.broken) continue;
    m.wear = Math.min(100, m.wear + BALANCE.wearPerService * k);
    if (m.wear >= 100) {
      m.broken = true;
      w.emit({ type: 'broke', itemId: m.id, roomId: room.id });
      const hasJanitor = w.state.staff.some((st) => st.role === 'janitor' && st.state !== 'leaving');
      w.emit({ type: 'toast', tone: 'bad', text: `The ${ITEMS[m.type].name} in the ${ROOMS[room.type].name} broke down!${hasJanitor ? '' : ' Hire a Janitor to fix it.'}` });
    }
  }
}

function claimedBy(w: World, kind: 'litter' | 'repair', id: number, me: Staff) {
  return w.state.staff.some((o) => o !== me && o.job && o.job.kind === kind && o.job.id === id);
}

/** A walkable tile next to a machine, inside its room. */
function serviceTile(w: World, it: Item): { x: number; z: number } | null {
  for (const sp of itemSpots(it)) {
    const tx = Math.floor(sp.ax), tz = Math.floor(sp.az);
    if (!w.grid.isBlocked(tx, tz)) return { x: sp.ax, z: sp.az };
  }
  const cells = itemFootprint(it.type, it.x, it.z, it.rot);
  for (const c of cells) {
    for (const d of DIRS) {
      const v = DIR_VEC[d];
      const nx = c.x + v.dx, nz = c.z + v.dz;
      if (cells.some((o) => o.x === nx && o.z === nz)) continue;
      if (w.grid.isBlocked(nx, nz) || w.grid.room(nx, nz) !== it.roomId) continue;
      if (!w.grid.canStep(nx, nz, -v.dx, -v.dz) && !w.grid.isBlocked(c.x, c.z)) continue;
      return { x: nx + 0.5, z: nz + 0.5 };
    }
  }
  return null;
}

function pickJob(w: World, st: Staff): boolean {
  const s = w.state;
  const dist = (x: number, z: number) => Math.abs(x - st.x) + Math.abs(z - st.z);
  const machines = s.items.filter((it) => ITEMS[it.type].machine);
  const tryMachine = (filter: (it: Item) => boolean) => {
    let best: { it: Item; at: { x: number; z: number } } | null = null;
    let bd = Infinity;
    for (const it of machines) {
      if (!filter(it) || claimedBy(w, 'repair', it.id, st)) continue;
      const at = serviceTile(w, it);
      if (!at) continue;
      const d = dist(at.x, at.z);
      if (d < bd) { bd = d; best = { it, at }; }
    }
    if (best && goTo(w.grid, st, best.at.x, best.at.z)) {
      st.job = { kind: 'repair', id: best.it.id, timer: 6 };
      st.state = 'toJob';
      return true;
    }
    return false;
  };
  if (tryMachine((it) => it.broken)) return true;
  let bestL: Litter | null = null;
  let bd = Infinity;
  for (const l of s.litter) {
    if (claimedBy(w, 'litter', l.id, st)) continue;
    const d = dist(l.x, l.z);
    if (d < bd) { bd = d; bestL = l; }
  }
  if (bestL && goTo(w.grid, st, Math.floor(bestL.x) + 0.5, Math.floor(bestL.z) + 0.5)) {
    st.job = { kind: 'litter', id: bestL.id, timer: 2 };
    st.state = 'toJob';
    return true;
  }
  return tryMachine((it) => it.wear > 70);
}

export function updateJanitor(w: World, st: Staff, dt: number) {
  const s = w.state;
  switch (st.state) {
    case 'idle':
      if (tryBreak(w, st)) break;
      if (pickJob(w, st)) break;
      if (!moving(st)) {
        if (rand(s.rng) < dt * 0.3) {
          const b = w.grid.building;
          for (let i = 0; i < 6; i++) {
            const x = b.x + int(s.rng, 0, b.w - 1), z = b.z + int(s.rng, 0, b.h - 1);
            if (w.grid.isCorridor(x, z) && !w.grid.isBlocked(x, z)) { goTo(w.grid, st, x + 0.5, z + 0.5); break; }
          }
        }
      } else step(w.grid, st, dt * 0.6);
      break;
    case 'toJob': {
      const job = st.job;
      const valid = job && (job.kind === 'litter' ? s.litter.some((l) => l.id === job.id) : !!w.item(job.id));
      if (!job || !valid) { st.job = null; st.state = 'idle'; stop(st); break; }
      if (step(w.grid, st, dt) || !st.dest) {
        st.state = 'doingJob';
        st.pose = 'work';
      }
      break;
    }
    case 'doingJob': {
      const job = st.job;
      if (!job) { st.state = 'idle'; st.pose = 'stand'; break; }
      job.timer -= dt * (0.8 + st.skill * 0.1) * (st.energy < 20 ? 1 / 1.5 : 1);
      if (job.timer > 0) break;
      if (job.kind === 'litter') {
        const l = s.litter.find((x) => x.id === job.id);
        s.litter = s.litter.filter((x) => x.id !== job.id);
        if (l) w.emit({ type: 'cleaned', x: l.x, z: l.z });
      } else {
        const it = w.item(job.id);
        if (it) {
          it.wear = 0;
          if (it.broken) w.emit({ type: 'repaired', itemId: it.id });
          it.broken = false;
        }
      }
      st.job = null;
      st.pose = 'stand';
      st.state = 'idle';
      break;
    }
  }
}
