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
import type { Dir, Grid } from './grid';
import type { Pt } from './path';
import type { IllnessType, ItemType, Pose, Role, RoomType } from './catalog';
import type { RngState } from './rng';

export interface Rect { x: number; z: number; w: number; h: number }
/** door tile is inside the room on its perimeter; dir points out of the room */
export interface DoorSpec { x: number; z: number; dir: Dir }

export interface Room {
  id: number;
  type: RoomType;
  rect: Rect;
  door: DoorSpec;
  items: number[];
  staffId: number;
  /** patients currently being served (or walking in) */
  occupants: number[];
  queue: number[];
  cost: number;
  builtAt: number;
}

export interface Item {
  id: number;
  type: ItemType;
  x: number;
  z: number;
  rot: number;
  roomId: number;
  /** per spot index: entity id that reserved it, or -1 */
  claims: number[];
  /** reception desks: patient ids in line, front first */
  queue: number[];
  /** 0..100 for machines that wear out */
  wear: number;
  broken: boolean;
  cost: number;
  builtAt: number;
}

export interface Mover {
  id: number;
  x: number;
  z: number;
  px: number;
  pz: number;
  /** facing angle in radians (0 = +z) */
  face: number;
  path: Pt[];
  pathI: number;
  /** final destination of the current path (re-pathed when the grid changes) */
  dest: Pt | null;
  pathVer: number;
  speed: number;
  pose: Pose;
  /** item+spot this mover currently holds */
  spot: { item: number; idx: number } | null;
  name: string;
  look: number;
}

export type StaffState =
  | 'idle' | 'toPost' | 'atPost' | 'leaving'
  | 'toBreak' | 'onBreak' | 'toTraining' | 'training'
  | 'toJob' | 'doingJob';

export interface JanitorJob { kind: 'litter' | 'repair'; id: number; timer: number }
export interface Staff extends Mover {
  role: Role;
  skill: number;
  salary: number;
  trait: string;
  state: StaffState;
  /** room id or, for receptionists, -(item id) - 1 */
  post: number;
  busy: boolean;
  hiredAt: number;
  /** 0..100; low energy sends staff on a break */
  energy: number;
  /** 0..100; staff quit at 0 */
  mood: number;
  xp: number;
  /** seconds of training left while training */
  trainLeft: number;
  job: JanitorJob | null;
}

export type PatientState =
  | 'arriving' | 'toReception' | 'queueReception' | 'atReception'
  | 'seekRoom' | 'waiting' | 'toRoom' | 'inRoom'
  | 'toVending' | 'atVending' | 'leaving' | 'gone';

export interface Patient extends Mover {
  illness: IllnessType;
  diagnosed: boolean;
  certainty: number;
  patience: number;
  thirst: number;
  happiness: number;
  gpVisits: number;
  scans: number;
  state: PatientState;
  /** room type the patient needs next */
  need: RoomType | null;
  /** room the patient is heading to / queued at, -1 if none exists yet */
  target: number;
  /** reception desk item id while checking in, else -1 */
  desk: number;
  /** remaining service seconds while being served */
  timer: number;
  cured: boolean;
  leaveReason: string;
  thought: string;
  waitedFor: number;
  arrivedAt: number;
  emergency: boolean;
  vip: boolean;
  /** countdown to dropping a wrapper while waiting */
  litterT: number;
}

export interface Candidate { id: number; role: Role; name: string; skill: number; salary: number; trait: string; look: number }

export interface Stats { cured: number; failed: number; left: number; visits: number; earned: number; spent: number; emergencies: number; inspection: number }

export interface Litter { id: number; x: number; z: number; kind: 'can' | 'wrapper' | 'puddle'; t: number }

export interface ResearchState { points: number; current: string | null; done: string[] }

export type ActiveEvent =
  | { kind: 'emergency'; illness: string; ids: number[]; endsAt: number; needed: number; reward: number; cured: number }
  | { kind: 'inspection'; vipId: number; endsAt: number; samples: number; cleanSum: number; queueSum: number; decorSum: number; brokenSum: number; sampleT: number };

export interface WorldState {
  money: number;
  reputation: number;
  /** total game seconds elapsed */
  t: number;
  priceMult: number;
  rooms: Room[];
  items: Item[];
  staff: Staff[];
  patients: Patient[];
  candidates: Candidate[];
  stats: Stats;
  monthStats: Stats;
  nextId: number;
  rng: RngState;
  spawnTimer: number;
  lastMonth: number;
  hints: Record<string, number>;
  /** save format version */
  version: number;
  scenario: string;
  sandbox: boolean;
  litter: Litter[];
  research: ResearchState;
  event: ActiveEvent | null;
  nextEventAt: number;
  yearStats: Stats;
  /** goal id → game time it was met */
  goals: Record<string, number>;
  stars: number;
}

export interface Ctx { state: WorldState; grid: Grid }

/** Patients in the hospital, not counting a visiting health inspector. */
export function patientCount(s: WorldState): number {
  let n = 0;
  for (const p of s.patients) if (!p.vip) n++;
  return n;
}

export function emptyStats(): Stats {
  return { cured: 0, failed: 0, left: 0, visits: 0, earned: 0, spent: 0, emergencies: 0, inspection: 0 };
}

export function createState(seed = 1): WorldState {
  return {
    money: 80000,
    reputation: 50,
    t: 0,
    priceMult: 1,
    rooms: [],
    items: [],
    staff: [],
    patients: [],
    candidates: [],
    stats: emptyStats(),
    monthStats: emptyStats(),
    nextId: 1,
    rng: { s: seed },
    spawnTimer: 4,
    lastMonth: 0,
    hints: {},
    version: 2,
    scenario: 'quackwell',
    sandbox: false,
    litter: [],
    research: { points: 0, current: null, done: [] },
    event: null,
    nextEventAt: 450 * 2.5,
    yearStats: emptyStats(),
    goals: {},
    stars: 0,
  };
}
