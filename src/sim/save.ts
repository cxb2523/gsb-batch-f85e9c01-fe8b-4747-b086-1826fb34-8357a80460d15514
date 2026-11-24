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
import { emptyStats, type WorldState } from './state';
import type { World } from './world';

export const SAVE_VERSION = 2;

export type LoadResult = { ok: true; state: WorldState } | { ok: false; reason: string };

export function serialize(w: World): string {
  return JSON.stringify({ version: SAVE_VERSION, savedAt: Date.now(), state: w.state });
}

/** Fill fields added after milestone 1 so old saves keep working. */
export function migrateState(s: WorldState): WorldState {
  const d = s as Partial<WorldState> & WorldState;
  d.version = SAVE_VERSION;
  d.scenario ??= 'quackwell';
  d.sandbox ??= false;
  d.litter ??= [];
  d.research ??= { points: 0, current: null, done: [] };
  d.event ??= null;
  d.nextEventAt ??= Math.max(d.t + 450, 450 * 2.5);
  d.yearStats ??= emptyStats();
  d.goals ??= {};
  d.stars ??= 0;
  for (const st of [d.stats, d.monthStats, d.yearStats]) { st.emergencies ??= 0; st.inspection ??= 0; }
  for (const st of d.staff) {
    st.energy ??= 100;
    st.mood ??= 80;
    st.xp ??= 0;
    st.trainLeft ??= 0;
    st.job ??= null;
  }
  for (const it of d.items) {
    it.wear ??= 0;
    it.broken ??= false;
    it.queue ??= [];
  }
  for (const p of d.patients) {
    p.emergency ??= false;
    p.vip ??= false;
    p.litterT ??= 120;
  }
  return d;
}

const isArr = (v: unknown) => Array.isArray(v);

export function deserialize(json: string): LoadResult {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'the save file is not readable' };
  }
  if (!data || typeof data !== 'object') return { ok: false, reason: 'damaged save' };
  const { version, state } = data as { version?: number; state?: WorldState };
  if (typeof version === 'number' && version > SAVE_VERSION) return { ok: false, reason: 'made by a newer version' };
  if (!state || typeof state !== 'object') return { ok: false, reason: 'damaged save' };
  if (typeof state.money !== 'number' || typeof state.t !== 'number' || !isArr(state.rooms) || !isArr(state.items) || !isArr(state.staff) || !isArr(state.patients) || !state.rng) {
    return { ok: false, reason: 'damaged save' };
  }
  return { ok: true, state: migrateState(state) };
}
