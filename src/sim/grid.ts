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
export type Dir = 'N' | 'E' | 'S' | 'W';
export const DIRS: Dir[] = ['N', 'E', 'S', 'W'];
export const DIR_VEC: Record<Dir, { dx: number; dz: number }> = {
  N: { dx: 0, dz: -1 },
  E: { dx: 1, dz: 0 },
  S: { dx: 0, dz: 1 },
  W: { dx: -1, dz: 0 },
};

export interface WallEdge {
  kind: 'outer' | 'room';
  door: boolean;
  window: boolean;
  roomId?: number;
}

export interface BuildingRect {
  x: number;
  z: number;
  w: number;
  h: number;
  /** west-most tile of the two-wide entrance, on the building's south row */
  entrance: { x: number; z: number };
}

/**
 * Tile grid. Tile (x,z) spans [x,x+1]×[z,z+1] in world units.
 * Walls live on tile edges: 'h,x,z' is the edge between (x,z-1) and (x,z);
 * 'v,x,z' is the edge between (x-1,z) and (x,z).
 */
export class Grid {
  readonly w: number;
  readonly h: number;
  building: BuildingRect;
  readonly roomAt: Int32Array;
  readonly blocked: Uint8Array;
  readonly walls = new Map<string, WallEdge>();
  /** bumped on any wall/room/block change so caches (renderer, reachability) can invalidate */
  version = 0;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.roomAt = new Int32Array(w * h).fill(-1);
    this.blocked = new Uint8Array(w * h);
    this.building = { x: 0, z: 0, w, h, entrance: { x: 0, z: h - 1 } };
  }

  idx(x: number, z: number) {
    return z * this.w + x;
  }
  inside(x: number, z: number) {
    return x >= 0 && z >= 0 && x < this.w && z < this.h;
  }
  inBuilding(x: number, z: number) {
    const b = this.building;
    return x >= b.x && z >= b.z && x < b.x + b.w && z < b.z + b.h;
  }
  room(x: number, z: number) {
    return this.inside(x, z) ? this.roomAt[this.idx(x, z)] : -1;
  }
  isBlocked(x: number, z: number) {
    return !this.inside(x, z) || this.blocked[this.idx(x, z)] === 1;
  }
  setBlocked(x: number, z: number, b: boolean) {
    this.blocked[this.idx(x, z)] = b ? 1 : 0;
    this.version++;
  }
  /** corridor = inside the building and not part of any room */
  isCorridor(x: number, z: number) {
    return this.inBuilding(x, z) && this.room(x, z) === -1;
  }

  edgeKey(x: number, z: number, d: Dir): string {
    switch (d) {
      case 'N': return `h,${x},${z}`;
      case 'S': return `h,${x},${z + 1}`;
      case 'W': return `v,${x},${z}`;
      case 'E': return `v,${x + 1},${z}`;
    }
  }
  wall(x: number, z: number, d: Dir): WallEdge | undefined {
    return this.walls.get(this.edgeKey(x, z, d));
  }
  setWall(x: number, z: number, d: Dir, e: WallEdge | undefined) {
    const k = this.edgeKey(x, z, d);
    if (e) this.walls.set(k, e);
    else this.walls.delete(k);
    this.version++;
  }

  private edgeOpen(x: number, z: number, d: Dir, allowDoor: boolean) {
    const w = this.wall(x, z, d);
    return !w || (allowDoor && w.door);
  }

  /** Can an entity step from (x,z) to (x+dx,z+dz)? dx,dz ∈ {-1,0,1}. */
  canStep(x: number, z: number, dx: number, dz: number): boolean {
    const nx = x + dx, nz = z + dz;
    if (!this.inside(nx, nz) || this.isBlocked(nx, nz)) return false;
    if (dx !== 0 && dz !== 0) {
      // diagonal: both corner tiles free and no wall/door on any of the four edges
      if (this.isBlocked(x + dx, z) || this.isBlocked(x, z + dz)) return false;
      const hx: Dir = dx > 0 ? 'E' : 'W';
      const hz: Dir = dz > 0 ? 'S' : 'N';
      return (
        this.edgeOpen(x, z, hx, false) &&
        this.edgeOpen(x, z, hz, false) &&
        this.edgeOpen(x + dx, z, hz, false) &&
        this.edgeOpen(x, z + dz, hx, false)
      );
    }
    const d: Dir = dx > 0 ? 'E' : dx < 0 ? 'W' : dz > 0 ? 'S' : 'N';
    return this.edgeOpen(x, z, d, true);
  }
}

export const LOT_W = 48;
export const LOT_H = 40;

/** The hospital lot: lawn + road around a 28×22 building shell with a south entrance. */
export function createLot(): Grid {
  const g = new Grid(LOT_W, LOT_H);
  applyShell(g);
  return g;
}

export const DEFAULT_BUILDING: BuildingRect = { x: 8, z: 6, w: 28, h: 22, entrance: { x: 21, z: 27 } };

/** Reset rooms/blocks/walls and lay down the building's outer walls. */
export function applyShell(g: Grid, building: BuildingRect = DEFAULT_BUILDING) {
  g.walls.clear();
  g.roomAt.fill(-1);
  g.blocked.fill(0);
  const b: BuildingRect = { ...building, entrance: { ...building.entrance } };
  g.building = b;
  const x1 = b.x + b.w - 1;
  const z1 = b.z + b.h - 1;
  const nearEntrance = (x: number) => x >= b.entrance.x - 2 && x <= b.entrance.x + 3;
  for (let x = b.x; x <= x1; x++) {
    const winN = (x - b.x) % 3 === 1 && x > b.x && x < x1;
    const winS = winN && !nearEntrance(x);
    const door = x === b.entrance.x || x === b.entrance.x + 1;
    g.setWall(x, b.z, 'N', { kind: 'outer', door: false, window: winN });
    g.setWall(x, z1, 'S', { kind: 'outer', door, window: winS && !door });
  }
  for (let z = b.z; z <= z1; z++) {
    const win = (z - b.z) % 3 === 1 && z > b.z && z < z1;
    g.setWall(b.x, z, 'W', { kind: 'outer', door: false, window: win });
    g.setWall(x1, z, 'E', { kind: 'outer', door: false, window: win });
  }
}
