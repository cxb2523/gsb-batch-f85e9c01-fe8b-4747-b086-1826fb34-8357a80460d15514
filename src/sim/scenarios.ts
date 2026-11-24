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
import type { IllnessType, RoomType } from './catalog';
import type { BuildingRect } from './grid';
import { createState, type WorldState } from './state';

export type Theme = 'meadow' | 'snow' | 'beach' | 'industrial' | 'city';
export type GoalKind = 'cured' | 'money' | 'rep' | 'research' | 'emergencies' | 'inspection' | 'room';

export interface GoalDef { kind: GoalKind; target: number; room?: RoomType; text: string }

export interface ScenarioDef {
  id: string;
  name: string;
  tagline: string;
  icon: string;
  theme: Theme;
  building: BuildingRect;
  money: number;
  reputation: number;
  /** illnesses that can turn up (default: all) */
  pool?: IllnessType[];
  /** month each illness starts appearing, overriding the catalog */
  months?: Partial<Record<IllnessType, number>>;
  /** weight multipliers */
  weights?: Partial<Record<IllnessType, number>>;
  spawnMult: number;
  /** months between events */
  eventEvery: [number, number];
  emergencyChance: number;
  /** forced weather; undefined means seasonal */
  weather?: 'snow' | 'rain';
  stars: [GoalDef[], GoalDef[], GoalDef[]];
}

const E = { x: 21, z: 27 };
const g = (kind: GoalKind, target: number, text: string, room?: RoomType): GoalDef => ({ kind, target, text, room });

export const SCENARIOS: ScenarioDef[] = [
  {
    id: 'quackwell', name: 'Quackwell General', icon: '🦆', theme: 'meadow',
    tagline: 'A sleepy meadow town and an empty hospital. Learn the ropes.',
    building: { x: 8, z: 6, w: 28, h: 22, entrance: E }, money: 80_000, reputation: 50,
    spawnMult: 1, eventEvery: [1.2, 2], emergencyChance: 0.6,
    stars: [
      [g('cured', 15, 'Cure 15 patients'), g('rep', 55, 'Reach 55 reputation')],
      [g('cured', 60, 'Cure 60 patients'), g('money', 120_000, 'Have $120,000 in the bank')],
      [g('cured', 200, 'Cure 200 patients'), g('rep', 75, 'Reach 75 reputation'), g('research', 3, 'Finish 3 research projects')],
    ],
  },
  {
    id: 'frostmere', name: 'Frostmere Clinic', icon: '❄️', theme: 'snow',
    tagline: 'Endless winter, a cramped clinic and a lot of tiny personal snowstorms.',
    building: { x: 12, z: 10, w: 20, h: 18, entrance: E }, money: 60_000, reputation: 45,
    pool: ['chromaticFlu', 'jellylegs', 'frostbiteFever', 'bubbleTrouble', 'glowbelly', 'echoItis', 'ghosting'],
    months: { frostbiteFever: 0, glowbelly: 2 }, weights: { frostbiteFever: 3 },
    spawnMult: 0.9, eventEvery: [1.2, 2], emergencyChance: 0.6, weather: 'snow',
    stars: [
      [g('cured', 20, 'Cure 20 patients'), g('room', 1, 'Build a Thaw Sauna', 'sauna')],
      [g('cured', 80, 'Cure 80 patients'), g('rep', 60, 'Reach 60 reputation')],
      [g('cured', 180, 'Cure 180 patients'), g('money', 150_000, 'Have $150,000 in the bank'), g('emergencies', 2, 'Handle 2 emergencies')],
    ],
  },
  {
    id: 'sunnyside', name: 'Sunnyside Seaside', icon: '🏖️', theme: 'beach',
    tagline: 'Tourists, sunburn and an ambulance that never stops. Long, narrow and busy.',
    building: { x: 4, z: 14, w: 36, h: 14, entrance: E }, money: 90_000, reputation: 50,
    months: { heliumLungs: 0, glowbelly: 1 }, weights: { heliumLungs: 2, glowbelly: 2 },
    spawnMult: 1.15, eventEvery: [0.6, 1.2], emergencyChance: 0.85,
    stars: [
      [g('cured', 25, 'Cure 25 patients'), g('emergencies', 1, 'Handle an emergency')],
      [g('cured', 100, 'Cure 100 patients'), g('emergencies', 3, 'Handle 3 emergencies')],
      [g('cured', 220, 'Cure 220 patients'), g('rep', 80, 'Reach 80 reputation'), g('money', 200_000, 'Have $200,000 in the bank')],
    ],
  },
  {
    id: 'voltwick', name: 'Voltwick Works', icon: '⚡', theme: 'industrial',
    tagline: 'A factory town crackling with static. The board wants research, and lots of it.',
    building: { x: 10, z: 4, w: 24, h: 24, entrance: E }, money: 70_000, reputation: 45,
    months: { staticCling: 0, bubbleTrouble: 1 }, weights: { staticCling: 2.5 },
    spawnMult: 1, eventEvery: [1, 2], emergencyChance: 0.5,
    stars: [
      [g('cured', 25, 'Cure 25 patients'), g('research', 2, 'Finish 2 research projects')],
      [g('cured', 100, 'Cure 100 patients'), g('research', 6, 'Finish 6 research projects')],
      [g('cured', 200, 'Cure 200 patients'), g('research', 10, 'Finish every research project'), g('inspection', 4, 'Get a 4-star inspection')],
    ],
  },
  {
    id: 'duckington', name: 'Grand Duckington', icon: '🏙️', theme: 'city',
    tagline: 'The big city. A huge building, every illness at once and inspectors with clipboards.',
    building: { x: 3, z: 2, w: 40, h: 26, entrance: E }, money: 150_000, reputation: 40,
    months: { heliumLungs: 0, frostbiteFever: 0, glowbelly: 1, staticCling: 1, bubbleTrouble: 1, echoItis: 2, backwardsWalking: 3, ghosting: 3 },
    spawnMult: 1.25, eventEvery: [0.8, 1.4], emergencyChance: 0.45,
    stars: [
      [g('cured', 40, 'Cure 40 patients'), g('rep', 55, 'Reach 55 reputation')],
      [g('cured', 150, 'Cure 150 patients'), g('inspection', 4, 'Get a 4-star inspection')],
      [g('cured', 350, 'Cure 350 patients'), g('rep', 85, 'Reach 85 reputation'), g('money', 400_000, 'Have $400,000 in the bank')],
    ],
  },
];

const byId = new Map(SCENARIOS.map((s) => [s.id, s]));
export function scenarioById(id: string): ScenarioDef {
  return byId.get(id) ?? SCENARIOS[0];
}

export function createScenarioState(id: string, seed = Date.now() % 100000, sandbox = false): WorldState {
  const sc = scenarioById(id);
  const s = createState(seed);
  s.scenario = sc.id;
  s.sandbox = sandbox;
  s.money = sandbox ? 1_000_000 : sc.money;
  s.reputation = sc.reputation;
  return s;
}

export function goalValue(s: WorldState, goal: GoalDef): number {
  switch (goal.kind) {
    case 'cured': return s.stats.cured;
    case 'money': return s.money;
    case 'rep': return s.reputation;
    case 'research': return s.research.done.length;
    case 'emergencies': return s.stats.emergencies;
    case 'inspection': return s.stats.inspection;
    case 'room': return s.rooms.filter((r) => r.type === goal.room).length;
  }
}

export const goalId = (scenario: string, star: number, i: number) => `${scenario}:${star}:${i}`;

/** Stars earned so far. Goals stay met once reached; stars must be earned in order. */
export function evaluateStars(s: WorldState): number {
  if (s.sandbox) return 0;
  const sc = scenarioById(s.scenario);
  let stars = 0;
  for (let k = 0; k < 3; k++) {
    let all = true;
    sc.stars[k].forEach((goal, i) => {
      const id = goalId(sc.id, k, i);
      if (s.goals[id] === undefined && goalValue(s, goal) >= goal.target) s.goals[id] = s.t;
      if (s.goals[id] === undefined) all = false;
    });
    if (!all) break;
    stars = k + 1;
  }
  return stars;
}

/** The Quackwell "getting started" checklist only makes sense in the first town, outside sandbox. */
export function starterGoalsActive(s: WorldState): boolean {
  return s.scenario === 'quackwell' && !s.sandbox;
}

export interface Progress { stars: Record<string, number> }

export function parseProgress(raw: string | null): Progress {
  const out: Progress = { stars: {} };
  if (!raw) return out;
  try {
    const data = JSON.parse(raw) as { stars?: unknown };
    if (data && typeof data === 'object' && data.stars && typeof data.stars === 'object' && !Array.isArray(data.stars)) {
      for (const [k, v] of Object.entries(data.stars as Record<string, unknown>)) {
        if (byId.has(k) && typeof v === 'number' && v >= 0 && v <= 3) out.stars[k] = Math.floor(v);
      }
    }
  } catch {
    /* corrupt progress counts as fresh */
  }
  return out;
}

export function recordStars(p: Progress, id: string, stars: number): Progress {
  return { stars: { ...p.stars, [id]: Math.max(p.stars[id] ?? 0, stars) } };
}

export function isScenarioUnlocked(p: Progress, id: string): boolean {
  const i = SCENARIOS.findIndex((s) => s.id === id);
  if (i <= 0) return i === 0;
  return (p.stars[SCENARIOS[i - 1].id] ?? 0) >= 1;
}
