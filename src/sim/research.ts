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
import type { WorldState } from './state';
import type { CommandResult } from './events';
import type { World } from './world';
import { gainXp, staffed } from './staff';
import { roomBroken, wearMachines } from './janitor';

export interface ResearchDef { id: string; name: string; cost: number; desc: string; icon: string; requires?: string }

export const RESEARCH: ResearchDef[] = [
  { id: 'fizzDeluxe', name: 'Fizz-O-Matic Deluxe', cost: 60, icon: '🥤', desc: 'Vending machines sell premium fizz for $12 instead of $5.' },
  { id: 'arcade', name: 'Arcade Cabinets', cost: 70, icon: '🕹️', desc: 'Unlocks the Arcade Cabinet, a big comfort boost for waiting patients.' },
  { id: 'bedsideManner', name: 'Bedside Manner', cost: 90, icon: '🤝', desc: 'Patients lose patience 20% more slowly.' },
  { id: 'sharperDiagnosis', name: 'Sharper Diagnosis', cost: 100, icon: '🔎', desc: 'Consult Rooms and Scan Labs diagnose 10 points better.' },
  { id: 'sturdyMachines', name: 'Sturdy Machines', cost: 110, icon: '🔧', desc: 'Machines wear out half as fast.' },
  { id: 'psychiatry', name: 'Talking Therapy', cost: 120, icon: '🛋️', desc: 'Unlocks the Therapy Room for Echo-itis and Backwards Walking.' },
  { id: 'localBuzz', name: 'Local Buzz', cost: 130, icon: '📣', desc: 'Word gets around: 20% more patients turn up.' },
  { id: 'duckStatue', name: 'Golden Duck Statue', cost: 140, icon: '🦆', desc: 'Unlocks the hospital mascot statue, the comfiest decor there is.' },
  { id: 'steadyCures', name: 'Steady Cures', cost: 140, icon: '💪', desc: 'Every treatment is 5% more likely to work.' },
  { id: 'miracleCures', name: 'Miracle Cures', cost: 220, icon: '✨', desc: 'Another 5% on every treatment.', requires: 'steadyCures' },
];

const byId = new Map(RESEARCH.map((r) => [r.id, r]));
export const researchDef = (id: string) => byId.get(id);

export function availableResearch(s: WorldState): ResearchDef[] {
  return RESEARCH.filter((r) => !s.research.done.includes(r.id) && (!r.requires || s.research.done.includes(r.requires)));
}

export function boosts(s: WorldState) {
  const has = (id: string) => s.research.done.includes(id);
  return {
    diagnosis: has('sharperDiagnosis') ? 10 : 0,
    cure: (has('steadyCures') ? 0.05 : 0) + (has('miracleCures') ? 0.05 : 0),
    wear: has('sturdyMachines') ? 0.5 : 1,
    patience: has('bedsideManner') ? 0.8 : 1,
    arrivals: has('localBuzz') ? 1.2 : 1,
    vending: has('fizzDeluxe') ? 12 : 5,
  };
}

export function chooseResearch(w: World, id: string): CommandResult {
  const s = w.state;
  if (!byId.has(id)) return { ok: false, reason: 'no such project' };
  if (s.research.done.includes(id)) return { ok: false, reason: 'already researched' };
  if (!availableResearch(s).some((r) => r.id === id)) return { ok: false, reason: 'not available yet' };
  s.research.current = id;
  return { ok: true };
}

/** Labs with a doctor at the bench turn time into research points. */
export function updateResearch(w: World, dt: number) {
  const s = w.state;
  const r = s.research as WorldState['research'] & { acc?: number };
  for (const room of s.rooms) {
    if (room.type !== 'research') continue;
    const st = staffed(w, room);
    if (!st || roomBroken(w, room)) continue;
    st.busy = !!r.current;
    if (!r.current) continue;
    const pts = (0.5 + 0.15 * st.skill) * dt;
    r.points += pts;
    r.acc = (r.acc ?? 0) + pts;
    if (r.acc >= 30) {
      r.acc -= 30;
      wearMachines(w, room);
      gainXp(w, st);
    }
  }
  const cur = r.current ? byId.get(r.current) : undefined;
  if (cur && r.points >= cur.cost) {
    r.points -= cur.cost;
    r.done.push(cur.id);
    r.current = null;
    w.emit({ type: 'researched', id: cur.id });
    w.emit({ type: 'toast', tone: 'good', text: `Research complete: ${cur.name}! ${cur.icon}` });
  }
}
