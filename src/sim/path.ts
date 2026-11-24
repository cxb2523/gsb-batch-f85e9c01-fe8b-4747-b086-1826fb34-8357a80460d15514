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
import type { Grid } from './grid';

export interface Pt { x: number; z: number }

const SQRT2 = Math.SQRT2;
const NB: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];

/** Binary min-heap keyed by f-score. */
class Heap {
  private ids: number[] = [];
  private fs: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, f: number) {
    const a = this.ids, b = this.fs;
    let i = a.length;
    a.push(id); b.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (b[p] <= f) break;
      a[i] = a[p]; b[i] = b[p]; i = p;
    }
    a[i] = id; b[i] = f;
  }
  pop(): number {
    const a = this.ids, b = this.fs;
    const top = a[0];
    const lid = a.pop()!, lf = b.pop()!;
    if (a.length) {
      let i = 0;
      const n = a.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && b[c + 1] < b[c]) c++;
        if (b[c] >= lf) break;
        a[i] = a[c]; b[i] = b[c]; i = c;
      }
      a[i] = lid; b[i] = lf;
    }
    return top;
  }
}

/**
 * 8-directional A* from tile to tile. Returns tile-centre waypoints including the
 * start centre, string-pulled so consecutive points have clear line of sight.
 */
export function findPath(g: Grid, from: Pt, to: Pt): Pt[] | null {
  const sx = Math.floor(from.x), sz = Math.floor(from.z);
  const tx = Math.floor(to.x), tz = Math.floor(to.z);
  if (!g.inside(sx, sz) || !g.inside(tx, tz)) return null;
  if (g.isBlocked(tx, tz)) return null;
  const n = g.w * g.h;
  const gs = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const start = g.idx(sx, sz), goal = g.idx(tx, tz);
  const h = (x: number, z: number) => {
    const dx = Math.abs(x - tx), dz = Math.abs(z - tz);
    return dx + dz + (SQRT2 - 2) * Math.min(dx, dz);
  };
  const open = new Heap();
  gs[start] = 0;
  open.push(start, h(sx, sz));
  let found = start === goal;
  while (open.size && !found) {
    const cur = open.pop();
    if (closed[cur]) continue;
    if (cur === goal) { found = true; break; }
    closed[cur] = 1;
    const cx = cur % g.w, cz = (cur / g.w) | 0;
    for (const [dx, dz, c] of NB) {
      if (!g.canStep(cx, cz, dx, dz)) continue;
      const ni = cur + dz * g.w + dx;
      if (closed[ni]) continue;
      const ng = gs[cur] + c;
      if (ng < gs[ni]) {
        gs[ni] = ng;
        came[ni] = cur;
        open.push(ni, ng + h(cx + dx, cz + dz));
      }
    }
  }
  if (!found) return null;
  const raw: Pt[] = [];
  for (let i = goal; i !== -1; i = came[i]) {
    raw.push({ x: (i % g.w) + 0.5, z: ((i / g.w) | 0) + 0.5 });
    if (i === start) break;
  }
  raw.reverse();
  return smooth(g, raw);
}

/** Greedy string-pulling: from each anchor jump to the farthest waypoint with clearance. */
export function smooth(g: Grid, raw: Pt[]): Pt[] {
  if (raw.length <= 2) return raw;
  const out: Pt[] = [raw[0]];
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !clearance(g, raw[i], raw[j])) j--;
    out.push(raw[j]);
    i = j;
  }
  return out;
}

const CLEAR = 0.2;
export function clearance(g: Grid, a: Pt, b: Pt): boolean {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const ox = (-dz / len) * CLEAR, oz = (dx / len) * CLEAR;
  return (
    lineClear(g, a.x, a.z, b.x, b.z) &&
    lineClear(g, a.x + ox, a.z + oz, b.x + ox, b.z + oz) &&
    lineClear(g, a.x - ox, a.z - oz, b.x - ox, b.z - oz)
  );
}

/** Amanatides–Woo traversal; every tile transition must be a legal step. */
export function lineClear(g: Grid, ax: number, az: number, bx: number, bz: number): boolean {
  let x = Math.floor(ax), z = Math.floor(az);
  const tx = Math.floor(bx), tz = Math.floor(bz);
  const dx = bx - ax, dz = bz - az;
  const stepX = Math.sign(dx), stepZ = Math.sign(dz);
  const tDX = stepX ? 1 / Math.abs(dx) : Infinity;
  const tDZ = stepZ ? 1 / Math.abs(dz) : Infinity;
  let tMX = stepX > 0 ? (x + 1 - ax) / dx : stepX < 0 ? (ax - x) / -dx : Infinity;
  let tMZ = stepZ > 0 ? (z + 1 - az) / dz : stepZ < 0 ? (az - z) / -dz : Infinity;
  if (g.isBlocked(x, z)) return false;
  for (let guard = 0; (x !== tx || z !== tz) && guard < 512; guard++) {
    if (Math.abs(tMX - tMZ) < 1e-9) {
      if (!g.canStep(x, z, stepX, stepZ)) return false;
      x += stepX; z += stepZ; tMX += tDX; tMZ += tDZ;
    } else if (tMX < tMZ) {
      if (!g.canStep(x, z, stepX, 0)) return false;
      x += stepX; tMX += tDX;
    } else {
      if (!g.canStep(x, z, 0, stepZ)) return false;
      z += stepZ; tMZ += tDZ;
    }
  }
  return true;
}
