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
import { DIRS, DIR_VEC, Grid, LOT_H, LOT_W, applyShell, type Dir } from './grid';
import { ITEMS, ROOMS, roomCost, type ItemType, type Pose, type RoomType, type SpotDef } from './catalog';
import type { Ctx, DoorSpec, Item, Rect, Room, WorldState } from './state';
import { isItemUnlocked, isRoomUnlocked } from './unlocks';
import { scenarioById } from './scenarios';

// ---------- item geometry ----------

export function rotatedSize(type: ItemType, rot: number) {
  const d = ITEMS[type];
  return rot % 2 === 0 ? { w: d.w, d: d.d } : { w: d.d, d: d.w };
}

/** Map an item-local continuous point to world, given the item's world min corner. */
export function rotPoint(type: ItemType, lx: number, lz: number, rot: number) {
  const { w, d } = ITEMS[type];
  switch (((rot % 4) + 4) % 4) {
    case 0: return { x: lx, z: lz };
    case 1: return { x: d - lz, z: lx };
    case 2: return { x: w - lx, z: d - lz };
    default: return { x: lz, z: w - lx };
  }
}

export function rotDir(d: Dir, rot: number): Dir {
  return DIRS[(DIRS.indexOf(d) + rot) % 4];
}

export const DIR_ANGLE: Record<Dir, number> = { S: 0, E: Math.PI / 2, N: Math.PI, W: -Math.PI / 2 };

export interface Cell { x: number; z: number; solid: boolean }

export function itemFootprint(type: ItemType, x: number, z: number, rot: number): Cell[] {
  const def = ITEMS[type];
  const out: Cell[] = [];
  for (let cz = 0; cz < def.d; cz++) {
    for (let cx = 0; cx < def.w; cx++) {
      const p = rotPoint(type, cx + 0.5, cz + 0.5, rot);
      out.push({ x: x + Math.floor(p.x), z: z + Math.floor(p.z), solid: def.cells[cz][cx] === '#' });
    }
  }
  return out;
}

export interface WorldSpot {
  idx: number;
  kind: SpotDef['kind'];
  /** where the character ends up */
  x: number;
  z: number;
  /** where the character walks to (equals x,z unless the spot sits on a solid cell) */
  ax: number;
  az: number;
  face: Dir;
  angle: number;
  pose: Pose;
}

export function spotsFor(type: ItemType, x: number, z: number, rot: number): WorldSpot[] {
  return ITEMS[type].spots.map((s, idx) => {
    const at = rotPoint(type, s.at.x, s.at.z, rot);
    const ap = s.approach ? rotPoint(type, s.approach.x, s.approach.z, rot) : at;
    const face = rotDir(s.face, rot);
    return { idx, kind: s.kind, x: x + at.x, z: z + at.z, ax: x + ap.x, az: z + ap.z, face, angle: DIR_ANGLE[face], pose: s.pose };
  });
}

export function itemSpots(item: Pick<Item, 'type' | 'x' | 'z' | 'rot'>): WorldSpot[] {
  return spotsFor(item.type, item.x, item.z, item.rot);
}

// ---------- grid from state ----------

export function rebuildGrid(state: WorldState): Grid {
  const g = new Grid(LOT_W, LOT_H);
  rebuildGridInto(g, state);
  return g;
}

export function rebuildGridInto(g: Grid, state: WorldState) {
  applyShell(g, scenarioById(state.scenario).building);
  for (const r of state.rooms) {
    const { x, z, w, h } = r.rect;
    for (let tz = z; tz < z + h; tz++) for (let tx = x; tx < x + w; tx++) g.roomAt[g.idx(tx, tz)] = r.id;
  }
  for (const r of state.rooms) {
    const { x, z, w, h } = r.rect;
    const edge = (tx: number, tz: number, d: Dir) => {
      const existing = g.wall(tx, tz, d);
      const isDoor = r.door.x === tx && r.door.z === tz && r.door.dir === d;
      if (existing) {
        if (isDoor && existing.kind === 'room') existing.door = true;
        return;
      }
      g.setWall(tx, tz, d, { kind: 'room', door: isDoor, window: false, roomId: r.id });
    };
    for (let tx = x; tx < x + w; tx++) { edge(tx, z, 'N'); edge(tx, z + h - 1, 'S'); }
    for (let tz = z; tz < z + h; tz++) { edge(x, tz, 'W'); edge(x + w - 1, tz, 'E'); }
  }
  for (const it of state.items) {
    for (const c of itemFootprint(it.type, it.x, it.z, it.rot)) if (c.solid && g.inside(c.x, c.z)) g.blocked[g.idx(c.x, c.z)] = 1;
  }
  g.version++;
}

export function refreshGrid(c: Ctx) {
  rebuildGridInto(c.grid, c.state);
}

// ---------- access checks ----------

const key = (x: number, z: number) => z * 1000 + x;

export function doorOutside(door: DoorSpec) {
  const v = DIR_VEC[door.dir];
  return { x: door.x + v.dx, z: door.z + v.dz };
}

/** Every corridor target (entrance, room doors, corridor item spots) reachable from the street. */
export function corridorAccessOk(state: WorldState, g: Grid): boolean {
  const e = g.building.entrance;
  const targets: { x: number; z: number }[] = [
    { x: e.x, z: e.z }, { x: e.x + 1, z: e.z },
  ];
  for (const r of state.rooms) targets.push(doorOutside(r.door));
  for (const it of state.items) {
    if (it.roomId !== -1) continue;
    for (const s of itemSpots(it)) targets.push({ x: Math.floor(s.ax), z: Math.floor(s.az) });
  }
  const seen = bfs(g, e.x, e.z + 1, (x, z) => g.room(x, z) === -1);
  return targets.every((t) => seen.has(key(t.x, t.z)));
}

/** Every spot inside the room reachable from its door tile. */
export function roomAccessOk(state: WorldState, g: Grid, room: Room): boolean {
  const seen = bfs(g, room.door.x, room.door.z, (x, z) => g.room(x, z) === room.id);
  for (const it of state.items) {
    if (it.roomId !== room.id) continue;
    for (const s of itemSpots(it)) if (!seen.has(key(Math.floor(s.ax), Math.floor(s.az)))) return false;
  }
  return true;
}

function bfs(g: Grid, sx: number, sz: number, allow: (x: number, z: number) => boolean): Set<number> {
  const seen = new Set<number>();
  if (!g.inside(sx, sz) || g.isBlocked(sx, sz) || !allow(sx, sz)) return seen;
  const q: number[] = [sx, sz];
  seen.add(key(sx, sz));
  for (let i = 0; i < q.length; i += 2) {
    const x = q[i], z = q[i + 1];
    for (const d of DIRS) {
      const v = DIR_VEC[d];
      const nx = x + v.dx, nz = z + v.dz;
      if (seen.has(key(nx, nz)) || !g.canStep(x, z, v.dx, v.dz) || !allow(nx, nz)) continue;
      seen.add(key(nx, nz));
      q.push(nx, nz);
    }
  }
  return seen;
}

// ---------- rooms ----------

export interface PlannedItem { type: ItemType; x: number; z: number; rot: number }
export interface BuildCheck { ok: boolean; reason?: string; cost: number; layout?: PlannedItem[] }

const MAX_ROOM = 12;
const inRect = (r: Rect, x: number, z: number) => x >= r.x && z >= r.z && x < r.x + r.w && z < r.z + r.h;

function footprintsOf(state: WorldState): Set<number> {
  const s = new Set<number>();
  for (const it of state.items) for (const c of itemFootprint(it.type, it.x, it.z, it.rot)) s.add(key(c.x, c.z));
  return s;
}

export function validateRoom(c: Ctx, type: RoomType, rect: Rect, door: DoorSpec): BuildCheck {
  const def = ROOMS[type];
  const cost = roomCost(type, rect.w, rect.h);
  const fail = (reason: string): BuildCheck => ({ ok: false, reason, cost });
  const g = c.grid;
  if (!isRoomUnlocked(c.state, type)) return fail('not researched yet');
  if (!((rect.w >= def.minW && rect.h >= def.minH) || (rect.w >= def.minH && rect.h >= def.minW))) return fail('too small');
  if (rect.w > MAX_ROOM || rect.h > MAX_ROOM) return fail('too big');
  const occupied = footprintsOf(c.state);
  for (let z = rect.z; z < rect.z + rect.h; z++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (!g.inBuilding(x, z)) return fail('must be inside the hospital');
    }
  }
  for (let z = rect.z; z < rect.z + rect.h; z++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (g.room(x, z) !== -1) return fail('overlaps another room');
      if (occupied.has(key(x, z)) || g.isBlocked(x, z)) return fail('space occupied');
    }
  }
  const onEdge =
    inRect(rect, door.x, door.z) &&
    ((door.dir === 'N' && door.z === rect.z) ||
      (door.dir === 'S' && door.z === rect.z + rect.h - 1) ||
      (door.dir === 'W' && door.x === rect.x) ||
      (door.dir === 'E' && door.x === rect.x + rect.w - 1));
  if (!onEdge) return fail('door must be on the room edge');
  const out = doorOutside(door);
  if (!g.isCorridor(out.x, out.z) || g.isBlocked(out.x, out.z) || occupied.has(key(out.x, out.z))) return fail('door must open onto a corridor');

  const room: Room = { id: -999, type, rect, door, items: [], staffId: -1, occupants: [], queue: [], cost, builtAt: 0 };
  const layout = layoutRoom(c.state, room);
  if (!layout) return fail('not enough space for the equipment');
  const hyp: WorldState = {
    ...c.state,
    rooms: [...c.state.rooms, room],
    items: [...c.state.items, ...layout.map((p, i) => mkItem(-1000 - i, p, room.id, 0, 0))],
  };
  if (!corridorAccessOk(hyp, rebuildGrid(hyp))) return fail('blocks access');
  if (c.state.money < cost) return fail('not enough money');
  return { ok: true, cost, layout };
}

function mkItem(id: number, p: PlannedItem, roomId: number, cost: number, t: number): Item {
  return { id, type: p.type, x: p.x, z: p.z, rot: p.rot, roomId, claims: ITEMS[p.type].spots.map(() => -1), queue: [], wear: 0, broken: false, cost, builtAt: t };
}

/** Greedy auto-layout of a room's required items: wall-backed, away from the door, room stays walkable. */
export function layoutRoom(state: WorldState, room: Room): PlannedItem[] | null {
  const def = ROOMS[room.type];
  const r = room.rect;
  const order = [...def.required].sort((a, b) => ITEMS[b].w * ITEMS[b].d - ITEMS[a].w * ITEMS[a].d);
  const planned: PlannedItem[] = [];
  const taken = new Set<number>();
  const solid = new Set<number>();
  const spotTiles = new Set<number>();
  const doorK = key(room.door.x, room.door.z);
  const out = doorOutside(room.door);

  const connected = (extraSolid: Set<number>, targets: number[]) => {
    const seen = new Set<number>([doorK]);
    const q = [room.door.x, room.door.z];
    for (let i = 0; i < q.length; i += 2) {
      for (const d of DIRS) {
        const v = DIR_VEC[d];
        const nx = q[i] + v.dx, nz = q[i + 1] + v.dz;
        const k = key(nx, nz);
        if (!inRect(r, nx, nz) || seen.has(k) || solid.has(k) || extraSolid.has(k)) continue;
        seen.add(k);
        q.push(nx, nz);
      }
    }
    return targets.every((t) => seen.has(t));
  };

  for (const type of order) {
    const idef = ITEMS[type];
    type Cand = { p: PlannedItem; score: number; cells: Cell[]; spots: number[] };
    const cands: Cand[] = [];
    for (let rot = 0; rot < 4; rot++) {
      const sz = rotatedSize(type, rot);
      for (let z = r.z; z <= r.z + r.h - sz.d; z++) {
        for (let x = r.x; x <= r.x + r.w - sz.w; x++) {
          const cells = itemFootprint(type, x, z, rot);
          if (cells.some((cl) => taken.has(key(cl.x, cl.z)) || key(cl.x, cl.z) === doorK || spotTiles.has(key(cl.x, cl.z)))) continue;
          const spots = spotsFor(type, x, z, rot);
          const sk = spots.map((s) => key(Math.floor(s.ax), Math.floor(s.az)));
          if (spots.some((s) => !inRect(r, Math.floor(s.ax), Math.floor(s.az)))) continue;
          if (sk.some((k) => k === doorK || solid.has(k) || spotTiles.has(k) || cells.some((cl) => cl.solid && key(cl.x, cl.z) === k))) continue;
          let score = 0;
          if (idef.wall) {
            const back = DIR_VEC[rotDir('N', rot)];
            const backRow = itemFootprint(type, x, z, rot).filter((_, i) => Math.floor(i / idef.w) === 0);
            if (backRow.every((cl) => !inRect(r, cl.x + back.dx, cl.z + back.dz))) score += 10;
          }
          const cx = x + sz.w / 2, cz = z + sz.d / 2;
          score += 0.3 * (Math.abs(cx - (room.door.x + 0.5)) + Math.abs(cz - (room.door.z + 0.5)));
          // keep the doorway clear
          for (const cl of cells) if (Math.abs(cl.x - room.door.x) + Math.abs(cl.z - room.door.z) === 1) score -= 4;
          // never park in front of the door from the outside line
          if (cells.some((cl) => cl.x === out.x && cl.z === out.z)) continue;
          cands.push({ p: { type, x, z, rot }, score, cells, spots: sk });
        }
      }
    }
    cands.sort((a, b) => b.score - a.score);
    let chosen: Cand | undefined;
    const prevSpots = [...spotTiles];
    for (const cand of cands) {
      const extra = new Set(cand.cells.filter((cl) => cl.solid).map((cl) => key(cl.x, cl.z)));
      if (connected(extra, [...prevSpots, ...cand.spots])) { chosen = cand; break; }
    }
    if (!chosen) return null;
    planned.push(chosen.p);
    for (const cl of chosen.cells) {
      taken.add(key(cl.x, cl.z));
      if (cl.solid) solid.add(key(cl.x, cl.z));
    }
    for (const k of chosen.spots) spotTiles.add(k);
  }
  return planned;
}

export function applyRoom(c: Ctx, type: RoomType, rect: Rect, door: DoorSpec): number {
  const v = validateRoom(c, type, rect, door);
  if (!v.ok || !v.layout) return -1;
  const s = c.state;
  const room: Room = { id: s.nextId++, type, rect: { ...rect }, door: { ...door }, items: [], staffId: -1, occupants: [], queue: [], cost: v.cost, builtAt: s.t };
  s.rooms.push(room);
  for (const p of v.layout) {
    const it = mkItem(s.nextId++, p, room.id, 0, s.t);
    s.items.push(it);
    room.items.push(it.id);
  }
  s.money -= v.cost;
  s.stats.spent += v.cost;
  s.monthStats.spent += v.cost;
  refreshGrid(c);
  return room.id;
}

/** Removes the room and its items, refunding half. Entity release is the caller's job. Returns refund or -1. */
export function sellRoom(c: Ctx, id: number): number {
  const s = c.state;
  const room = s.rooms.find((r) => r.id === id);
  if (!room) return -1;
  let refund = Math.floor(room.cost / 2);
  for (const it of s.items) if (it.roomId === id) refund += Math.floor(it.cost / 2);
  s.items = s.items.filter((it) => it.roomId !== id);
  s.rooms = s.rooms.filter((r) => r.id !== id);
  s.money += refund;
  refreshGrid(c);
  return refund;
}

// ---------- items ----------

export function validateItem(c: Ctx, type: ItemType, x: number, z: number, rot: number): BuildCheck & { roomId: number } {
  const def = ITEMS[type];
  const g = c.grid;
  const cost = def.cost;
  let roomId = -1;
  const fail = (reason: string) => ({ ok: false, reason, cost, roomId });
  if (!isItemUnlocked(c.state, type)) return fail('not researched yet');
  const cells = itemFootprint(type, x, z, rot);
  if (cells.some((cl) => !g.inBuilding(cl.x, cl.z))) return fail('must be inside the hospital');
  const rooms = new Set(cells.map((cl) => g.room(cl.x, cl.z)));
  if (rooms.size > 1) return fail('must fit in one space');
  roomId = [...rooms][0];
  if (def.where === 'corridor' && roomId !== -1) return fail('corridor only');
  if (def.where === 'room' && roomId === -1) return fail('rooms only');
  const occupied = footprintsOf(c.state);
  if (cells.some((cl) => occupied.has(key(cl.x, cl.z)) || g.isBlocked(cl.x, cl.z))) return fail('space occupied');
  // walls inside the footprint are impossible for rooms (rect), but corridor items may straddle a room wall
  for (const cl of cells) {
    for (const cl2 of cells) {
      if (Math.abs(cl.x - cl2.x) + Math.abs(cl.z - cl2.z) !== 1) continue;
      if (!g.canStep(cl.x, cl.z, cl2.x - cl.x, cl2.z - cl.z) && !g.isBlocked(cl2.x, cl2.z)) return fail('space occupied');
    }
  }
  const room = roomId === -1 ? undefined : c.state.rooms.find((r) => r.id === roomId);
  if (room && cells.some((cl) => cl.x === room.door.x && cl.z === room.door.z)) return fail('blocks access');
  const selfSolid = new Set(cells.filter((cl) => cl.solid).map((cl) => key(cl.x, cl.z)));
  for (const s of spotsFor(type, x, z, rot)) {
    const tx = Math.floor(s.ax), tz = Math.floor(s.az);
    if (!g.inBuilding(tx, tz) || g.room(tx, tz) !== roomId || g.isBlocked(tx, tz) || selfSolid.has(key(tx, tz))) return fail('needs space in front');
    // the spot must be reachable from the item side without crossing a wall
    const ref = s.x === s.ax && s.z === s.az ? null : { x: Math.floor(s.x), z: Math.floor(s.z) };
    if (ref && Math.abs(ref.x - tx) + Math.abs(ref.z - tz) === 1 && g.wall(tx, tz, dirBetween(tx, tz, ref.x, ref.z))) return fail('needs space in front');
  }
  const hyp: WorldState = { ...c.state, items: [...c.state.items, mkItem(-1, { type, x, z, rot }, roomId, 0, 0)] };
  const hg = rebuildGrid(hyp);
  if (!corridorAccessOk(hyp, hg)) return fail('blocks access');
  if (room && !roomAccessOk(hyp, hg, room)) return fail('blocks access');
  if (c.state.money < cost) return fail('not enough money');
  return { ok: true, cost, roomId };
}

function dirBetween(x: number, z: number, nx: number, nz: number): Dir {
  return nx > x ? 'E' : nx < x ? 'W' : nz > z ? 'S' : 'N';
}

export function applyItem(c: Ctx, type: ItemType, x: number, z: number, rot: number): number {
  const v = validateItem(c, type, x, z, rot);
  if (!v.ok) return -1;
  const s = c.state;
  const it = mkItem(s.nextId++, { type, x, z, rot }, v.roomId, v.cost, s.t);
  s.items.push(it);
  if (v.roomId !== -1) s.rooms.find((r) => r.id === v.roomId)?.items.push(it.id);
  s.money -= v.cost;
  s.stats.spent += v.cost;
  s.monthStats.spent += v.cost;
  refreshGrid(c);
  return it.id;
}

/** Sells an optional item. Required room equipment (cost 0) cannot be sold alone. Returns refund or -1. */
export function sellItem(c: Ctx, id: number): number {
  const s = c.state;
  const it = s.items.find((i) => i.id === id);
  if (!it || (it.roomId !== -1 && it.cost === 0)) return -1;
  const refund = Math.floor(it.cost / 2);
  s.items = s.items.filter((i) => i.id !== id);
  const room = s.rooms.find((r) => r.id === it.roomId);
  if (room) room.items = room.items.filter((i) => i !== id);
  s.money += refund;
  refreshGrid(c);
  return refund;
}
