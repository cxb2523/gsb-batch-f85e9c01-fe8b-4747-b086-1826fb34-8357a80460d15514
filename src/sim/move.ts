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
import { findPath } from './path';
import type { Grid } from './grid';
import type { Item, Mover } from './state';
import { itemSpots, type WorldSpot } from './build';

/** Path a mover toward a continuous world point. Returns false if unreachable. */
export function goTo(grid: Grid, m: Mover, x: number, z: number): boolean {
  const path = findPath(grid, { x: m.x, z: m.z }, { x, z });
  m.pathI = 0;
  if (!path) {
    m.path = [];
    m.dest = null;
    return false;
  }
  const pts = path.slice(1);
  if (pts.length) pts[pts.length - 1] = { x, z };
  else pts.push({ x, z });
  m.path = pts;
  m.dest = { x, z };
  m.pathVer = grid.version;
  return true;
}

export function moving(m: Mover) {
  return m.pathI < m.path.length;
}

/** Advance along the path. Returns true once the path is complete. */
export function step(grid: Grid, m: Mover, dt: number): boolean {
  if (m.dest && m.pathVer !== grid.version && moving(m)) {
    const d = m.dest;
    if (!goTo(grid, m, d.x, d.z)) {
      // destination sealed off: stop where we are
      m.path = [];
      m.pathI = 0;
      m.dest = null;
    }
  }
  let remaining = m.speed * dt;
  while (remaining > 1e-9 && m.pathI < m.path.length) {
    const p = m.path[m.pathI];
    const dx = p.x - m.x, dz = p.z - m.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-4) m.face = Math.atan2(dx, dz);
    if (d <= remaining) {
      m.x = p.x;
      m.z = p.z;
      remaining -= d;
      m.pathI++;
    } else {
      m.x += (dx / d) * remaining;
      m.z += (dz / d) * remaining;
      remaining = 0;
    }
  }
  return m.pathI >= m.path.length;
}

export function stop(m: Mover) {
  m.path = [];
  m.pathI = 0;
  m.dest = null;
}

export function spotOf(item: Item, idx: number): WorldSpot {
  return itemSpots(item)[idx];
}

/** Snap onto a spot (sit, lie, stand at a machine). */
export function hop(m: Mover, s: WorldSpot) {
  m.x = s.x;
  m.z = s.z;
  m.face = s.angle;
  m.pose = s.pose;
  stop(m);
}
