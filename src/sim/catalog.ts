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
import type { Dir } from './grid';

export type Role = 'doctor' | 'nurse' | 'assistant' | 'janitor';
export type RoomType = 'gp' | 'pharmacy' | 'scan' | 'ward' | 'ballast' | 'grounding' | 'sauna' | 'staffRoom' | 'training' | 'research' | 'psych';
export type ItemType =
  | 'reception' | 'bench' | 'vending' | 'cooler' | 'plant' | 'radiator' | 'bin' | 'lamp' | 'cabinet'
  | 'gpDesk' | 'pharmacyCounter' | 'scanner' | 'controlPanel' | 'bed' | 'nurseStation'
  | 'ballastBooth' | 'teslaCoil' | 'groundPad' | 'saunaStove' | 'saunaBench'
  | 'sofa' | 'coffeeMachine' | 'lectern' | 'studyDesk' | 'researchBench' | 'psychCouch' | 'armchair' | 'arcade' | 'duckStatue';
export type IllnessType =
  | 'heliumLungs' | 'chromaticFlu' | 'staticCling' | 'jellylegs' | 'glowbelly' | 'frostbiteFever'
  | 'bubbleTrouble' | 'echoItis' | 'backwardsWalking' | 'ghosting';
export type FloorKind = 'corridor' | 'wood' | 'mint' | 'white' | 'lino' | 'rubber' | 'plank' | 'carpet' | 'cork' | 'rose';
export type Pose = 'stand' | 'sit' | 'lie' | 'work';

/**
 * A spot where a character interacts with an item, in item-local coordinates
 * (footprint spans [0,w]×[0,d], front faces +z). `approach` is the tile centre a
 * character walks to before hopping onto `at` (used when `at` sits on a solid cell).
 */
export interface SpotDef {
  kind: 'staff' | 'patient' | 'seat' | 'use' | 'rest' | 'study';
  at: { x: number; z: number };
  approach?: { x: number; z: number };
  face: Dir;
  pose: Pose;
}

export interface ItemDef {
  name: string;
  w: number;
  d: number;
  /** rows along local z, chars along local x: '#' solid, '.' walkable */
  cells: string[];
  cost: number;
  where: 'corridor' | 'room' | 'any';
  /** prefer the back (local z=0) against a wall during auto-layout */
  wall: boolean;
  spots: SpotDef[];
  /** attractiveness contributed to nearby tiles */
  decor: number;
  warmth?: number;
  desc: string;
  /** shown in the corridor item shop */
  buyable: boolean;
  /** wears out with use and needs a janitor */
  machine?: boolean;
  /** research project that unlocks it */
  unlock?: string;
}

export const ITEMS: Record<ItemType, ItemDef> = {
  reception: {
    name: 'Front Desk', w: 3, d: 2, cells: ['...', '###'], cost: 1500, where: 'corridor', wall: false, decor: 0, buyable: true,
    spots: [
      { kind: 'staff', at: { x: 1.5, z: 0.5 }, face: 'S', pose: 'work' },
      { kind: 'use', at: { x: 1.5, z: 2.5 }, face: 'N', pose: 'stand' },
    ],
    desc: 'Every patient checks in here first. Needs an Assistant.',
  },
  bench: {
    name: 'Comfy Bench', w: 2, d: 1, cells: ['##'], cost: 220, where: 'any', wall: true, decor: 0.5, buyable: true,
    spots: [
      { kind: 'seat', at: { x: 0.5, z: 0.45 }, approach: { x: 0.5, z: 1.5 }, face: 'S', pose: 'sit' },
      { kind: 'seat', at: { x: 1.5, z: 0.45 }, approach: { x: 1.5, z: 1.5 }, face: 'S', pose: 'sit' },
    ],
    desc: 'Waiting is less awful sitting down.',
  },
  vending: {
    name: 'Fizz-O-Matic', w: 1, d: 1, cells: ['#'], cost: 900, where: 'corridor', wall: true, decor: 0.5, buyable: true,
    spots: [{ kind: 'use', at: { x: 0.5, z: 1.5 }, face: 'N', pose: 'stand' }],
    desc: 'Glowing soda dispenser. Quenches thirst, earns pocket change.',
  },
  cooler: {
    name: 'Water Cooler', w: 1, d: 1, cells: ['#'], cost: 350, where: 'any', wall: true, decor: 0.2, buyable: true,
    spots: [{ kind: 'use', at: { x: 0.5, z: 1.5 }, face: 'N', pose: 'stand' }],
    desc: 'Free water. Patients love free.',
  },
  plant: {
    name: 'Potted Fern', w: 1, d: 1, cells: ['#'], cost: 120, where: 'any', wall: false, decor: 2, buyable: true, spots: [],
    desc: 'Makes everyone around it a little calmer.',
  },
  radiator: {
    name: 'Radiator', w: 1, d: 1, cells: ['#'], cost: 300, where: 'any', wall: true, decor: 0.5, warmth: 3, buyable: true, spots: [],
    desc: 'Keeps the chill off. Patients wait longer when warm.',
  },
  bin: {
    name: 'Bin', w: 1, d: 1, cells: ['#'], cost: 80, where: 'any', wall: false, decor: 0.3, buyable: true, spots: [],
    desc: 'Somewhere for the empty cans to go.',
  },
  lamp: {
    name: 'Floor Lamp', w: 1, d: 1, cells: ['#'], cost: 260, where: 'any', wall: false, decor: 1.2, buyable: true, spots: [],
    desc: 'Warm light. Looks gorgeous at night.',
  },
  cabinet: {
    name: 'Filing Cabinet', w: 1, d: 1, cells: ['#'], cost: 180, where: 'room', wall: true, decor: 0.3, buyable: true, spots: [],
    desc: 'Paperwork lives here.',
  },
  gpDesk: {
    name: 'Consult Desk', w: 2, d: 3, cells: ['..', '##', '..'], cost: 1200, where: 'room', wall: true, decor: 0, buyable: false,
    spots: [
      { kind: 'staff', at: { x: 0.5, z: 0.5 }, face: 'S', pose: 'sit' },
      { kind: 'patient', at: { x: 0.5, z: 2.5 }, face: 'N', pose: 'sit' },
    ],
    desc: 'Where the diagnosing happens.',
  },
  pharmacyCounter: {
    name: 'Dispensary Counter', w: 2, d: 2, cells: ['..', '##'], cost: 1800, where: 'room', wall: true, decor: 0, buyable: false,
    spots: [
      { kind: 'staff', at: { x: 0.5, z: 0.5 }, face: 'S', pose: 'work' },
      { kind: 'patient', at: { x: 0.5, z: 2.5 }, face: 'N', pose: 'stand' },
    ],
    desc: 'Potions, pills and suspiciously glowing tonics.',
  },
  scanner: {
    machine: true, name: 'Omni-Scanner 3000', w: 3, d: 2, cells: ['###', '...'], cost: 7000, where: 'room', wall: true, decor: 0, buyable: false,
    spots: [{ kind: 'patient', at: { x: 1.5, z: 0.5 }, approach: { x: 1.5, z: 1.5 }, face: 'E', pose: 'lie' }],
    desc: 'Sees through everything. Including your excuses.',
  },
  controlPanel: {
    name: 'Control Console', w: 1, d: 1, cells: ['#'], cost: 900, where: 'room', wall: true, decor: 0, buyable: false,
    spots: [{ kind: 'staff', at: { x: 0.5, z: 1.5 }, face: 'N', pose: 'work' }],
    desc: 'Blinking lights. Important buttons.',
  },
  bed: {
    name: 'Ward Bed', w: 1, d: 2, cells: ['#', '#'], cost: 900, where: 'room', wall: true, decor: 0, buyable: false,
    spots: [{ kind: 'patient', at: { x: 0.5, z: 1.0 }, approach: { x: 1.5, z: 1.5 }, face: 'S', pose: 'lie' }],
    desc: 'Crisp sheets, beeping monitor.',
  },
  nurseStation: {
    name: 'Nurse Station', w: 1, d: 1, cells: ['#'], cost: 700, where: 'room', wall: true, decor: 0, buyable: false,
    spots: [{ kind: 'staff', at: { x: 0.5, z: 1.5 }, face: 'N', pose: 'work' }],
    desc: 'Charts, clipboards and a very important mug.',
  },
  ballastBooth: {
    machine: true, name: 'Ballast Booth', w: 2, d: 2, cells: ['##', '##'], cost: 6500, where: 'room', wall: true, decor: 0, buyable: false,
    spots: [{ kind: 'patient', at: { x: 1, z: 1 }, approach: { x: 0.5, z: 2.5 }, face: 'S', pose: 'stand' }],
    desc: 'Pumps the floaty right out of you.',
  },
  teslaCoil: {
    machine: true, name: 'Grounding Coil', w: 2, d: 2, cells: ['##', '##'], cost: 7500, where: 'room', wall: true, decor: 0, buyable: false, spots: [],
    desc: 'Drinks static. Spits lightning.',
  },
  groundPad: {
    name: 'Rubber Pad', w: 1, d: 1, cells: ['.'], cost: 600, where: 'room', wall: false, decor: 0, buyable: false,
    spots: [{ kind: 'patient', at: { x: 0.5, z: 0.5 }, face: 'N', pose: 'stand' }],
    desc: 'Stand here. Do not touch anything.',
  },
  saunaStove: {
    machine: true, name: 'Sauna Stove', w: 1, d: 1, cells: ['#'], cost: 2500, where: 'room', wall: true, decor: 0, warmth: 6, buyable: false,
    spots: [{ kind: 'staff', at: { x: 0.5, z: 1.5 }, face: 'N', pose: 'work' }],
    desc: 'Hot rocks. Hotter steam.',
  },
  sofa: {
    name: 'Squishy Sofa', w: 2, d: 1, cells: ['##'], cost: 600, where: 'room', wall: true, decor: 0.5, buyable: false,
    spots: [
      { kind: 'rest', at: { x: 0.5, z: 0.45 }, approach: { x: 0.5, z: 1.5 }, face: 'S', pose: 'sit' },
      { kind: 'rest', at: { x: 1.5, z: 0.45 }, approach: { x: 1.5, z: 1.5 }, face: 'S', pose: 'sit' },
    ],
    desc: 'Sink in. Recharge.',
  },
  coffeeMachine: {
    name: 'Bean Cannon', w: 1, d: 1, cells: ['#'], cost: 700, where: 'room', wall: true, decor: 0.5, buyable: false,
    spots: [{ kind: 'rest', at: { x: 0.5, z: 1.5 }, face: 'N', pose: 'stand' }],
    desc: 'Industrial-strength coffee for heroic shifts.',
  },
  lectern: {
    name: 'Lectern', w: 1, d: 1, cells: ['#'], cost: 500, where: 'room', wall: true, decor: 0.3, buyable: false, spots: [],
    desc: 'For important speeches about hand washing.',
  },
  studyDesk: {
    name: 'Study Desk', w: 1, d: 2, cells: ['#', '.'], cost: 450, where: 'room', wall: true, decor: 0, buyable: false,
    spots: [{ kind: 'study', at: { x: 0.5, z: 1.5 }, face: 'N', pose: 'sit' }],
    desc: 'Textbooks, highlighters, ambition.',
  },
  researchBench: {
    machine: true, name: 'Research Bench', w: 2, d: 2, cells: ['##', '..'], cost: 4000, where: 'room', wall: true, decor: 0, buyable: false,
    spots: [{ kind: 'staff', at: { x: 0.5, z: 1.5 }, face: 'N', pose: 'work' }],
    desc: 'Bubbling flasks and a very confident microscope.',
  },
  psychCouch: {
    name: 'Therapy Couch', w: 2, d: 1, cells: ['##'], cost: 1500, where: 'room', wall: true, decor: 0, buyable: false,
    spots: [{ kind: 'patient', at: { x: 1, z: 0.5 }, approach: { x: 0.5, z: 1.5 }, face: 'E', pose: 'lie' }],
    desc: 'Tell it about your mother.',
  },
  armchair: {
    name: 'Thinking Chair', w: 1, d: 1, cells: ['#'], cost: 800, where: 'room', wall: false, decor: 0, buyable: false,
    spots: [{ kind: 'staff', at: { x: 0.5, z: 0.5 }, approach: { x: 0.5, z: 1.5 }, face: 'S', pose: 'sit' }],
    desc: 'Hmm. Interesting. Go on.',
  },
  arcade: {
    name: 'Arcade Cabinet', w: 1, d: 1, cells: ['#'], cost: 1500, where: 'corridor', wall: true, decor: 3.5, buyable: true, unlock: 'arcade', spots: [],
    desc: 'Blinking lights keep waiting patients calm for ages.',
  },
  duckStatue: {
    name: 'Golden Duck Statue', w: 2, d: 2, cells: ['##', '##'], cost: 5000, where: 'any', wall: false, decor: 9, buyable: true, unlock: 'duckStatue', spots: [],
    desc: 'The hospital mascot, in solid(ish) gold. Huge morale boost.',
  },
  saunaBench: {
    name: 'Sauna Bench', w: 2, d: 1, cells: ['##'], cost: 800, where: 'room', wall: true, decor: 0, buyable: false,
    spots: [{ kind: 'patient', at: { x: 1, z: 0.45 }, approach: { x: 1.5, z: 1.5 }, face: 'S', pose: 'sit' }],
    desc: 'Cedar slats. Sweat optional.',
  },
};

export type Service = 'gp' | 'diagnose' | 'treat' | 'research' | 'none';

export interface RoomDef {
  name: string;
  minW: number;
  minH: number;
  staff: Role | null;
  required: ItemType[];
  floor: FloorKind;
  wall: string;
  accent: string;
  baseCost: number;
  tileCost: number;
  service: Service;
  /** game seconds per patient */
  duration: number;
  /** flat fee for gp/diagnose rooms; treatments charge the illness fee */
  fee: number;
  desc: string;
  icon: string;
  /** research project that unlocks it */
  unlock?: string;
}

export const ROOMS: Record<RoomType, RoomDef> = {
  gp: {
    name: 'Consult Room', minW: 3, minH: 3, staff: 'doctor', required: ['gpDesk'], floor: 'wood', wall: '#f3dcb8', accent: '#e9a04b',
    baseCost: 4000, tileCost: 150, service: 'gp', duration: 9, fee: 250, icon: '🩺',
    desc: 'A doctor works out what is wrong. Every patient starts here.',
  },
  pharmacy: {
    name: 'Dispensary', minW: 3, minH: 3, staff: 'nurse', required: ['pharmacyCounter'], floor: 'mint', wall: '#c9f0e1', accent: '#2fb38a',
    baseCost: 5000, tileCost: 150, service: 'treat', duration: 7, fee: 0, icon: '💊',
    desc: 'A nurse hands out cures for Chromatic Flu and Jellylegs.',
  },
  scan: {
    name: 'Scan Lab', minW: 4, minH: 4, staff: 'doctor', required: ['scanner', 'controlPanel'], floor: 'white', wall: '#d9e4ff', accent: '#4f7cff',
    baseCost: 9000, tileCost: 200, service: 'diagnose', duration: 11, fee: 500, icon: '🔬',
    desc: 'Big diagnosis boost for patients the Consult Room is unsure about.',
  },
  ward: {
    name: 'Ward', minW: 4, minH: 4, staff: 'nurse', required: ['bed', 'bed', 'nurseStation'], floor: 'lino', wall: '#d6ecff', accent: '#5aa9e6',
    baseCost: 6000, tileCost: 150, service: 'treat', duration: 26, fee: 0, icon: '🛏️',
    desc: 'Bed rest under a nurse’s eye. Dims Glowbelly. More beds, more patients.',
  },
  ballast: {
    name: 'Ballast Booth', minW: 3, minH: 4, staff: 'doctor', required: ['ballastBooth', 'controlPanel'], floor: 'carpet', wall: '#ecd9ff', accent: '#9a5cf0',
    baseCost: 8000, tileCost: 200, service: 'treat', duration: 12, fee: 0, icon: '🎈',
    desc: 'Squeezes the helium out of Helium Lungs.',
  },
  grounding: {
    name: 'Grounding Room', minW: 4, minH: 4, staff: 'doctor', required: ['teslaCoil', 'groundPad', 'controlPanel'], floor: 'rubber', wall: '#fff1b8', accent: '#f2c230',
    baseCost: 9000, tileCost: 200, service: 'treat', duration: 13, fee: 0, icon: '⚡',
    desc: 'Discharges Static Cling with a very large, very loud coil.',
  },
  sauna: {
    name: 'Thaw Sauna', minW: 3, minH: 3, staff: 'nurse', required: ['saunaStove', 'saunaBench'], floor: 'plank', wall: '#f0c9a0', accent: '#e0703a',
    baseCost: 5500, tileCost: 150, service: 'treat', duration: 15, fee: 0, icon: '♨️',
    desc: 'Steams Frostbite Fever right out of the bones.',
  },
  staffRoom: {
    name: 'Staff Room', minW: 3, minH: 3, staff: null, required: ['sofa', 'coffeeMachine'], floor: 'cork', wall: '#ffe1c7', accent: '#ff8a5c',
    baseCost: 3000, tileCost: 120, service: 'none', duration: 0, fee: 0, icon: '☕',
    desc: 'Tired staff recharge here. Without one they slow down and eventually quit.',
  },
  training: {
    name: 'Training Room', minW: 3, minH: 4, staff: null, required: ['lectern', 'studyDesk', 'studyDesk'], floor: 'wood', wall: '#e3f0ff', accent: '#4f7cff',
    baseCost: 5000, tileCost: 150, service: 'none', duration: 0, fee: 0, icon: '🎓',
    desc: 'Send staff here from their info card to earn another skill star.',
  },
  research: {
    name: 'Research Lab', minW: 4, minH: 3, staff: 'doctor', required: ['researchBench'], floor: 'white', wall: '#e6fff4', accent: '#20c997',
    baseCost: 7000, tileCost: 200, service: 'research', duration: 0, fee: 0, icon: '🧪',
    desc: 'A doctor here works through research projects: new rooms, items and upgrades.',
  },
  psych: {
    name: 'Therapy Room', minW: 4, minH: 4, staff: 'doctor', required: ['psychCouch', 'armchair'], floor: 'rose', wall: '#ffe3ef', accent: '#e05297',
    baseCost: 7000, tileCost: 180, service: 'treat', duration: 16, fee: 0, icon: '🛋️', unlock: 'psychiatry',
    desc: 'Talks Echo-itis and Backwards Walking out of people.',
  },
};

export interface IllnessDef {
  name: string;
  room: RoomType;
  fee: number;
  /** 0..1, slows diagnosis */
  difficulty: number;
  desc: string;
  weight: number;
  /** month index from which this illness starts turning up */
  month: number;
}

export const ILLNESSES: Record<IllnessType, IllnessDef> = {
  heliumLungs: { name: 'Helium Lungs', room: 'ballast', fee: 2000, difficulty: 0.2, weight: 3, month: 1, desc: 'Floats a few inches off the floor and squeaks when talking.' },
  chromaticFlu: { name: 'Chromatic Flu', room: 'pharmacy', fee: 1100, difficulty: 0.1, weight: 5, month: 0, desc: 'Skin cycles through every colour of the rainbow.' },
  staticCling: { name: 'Static Cling', room: 'grounding', fee: 2400, difficulty: 0.4, weight: 3, month: 3, desc: 'Hair on end, sparks on contact, socks stuck to everything.' },
  jellylegs: { name: 'Jellylegs', room: 'pharmacy', fee: 1000, difficulty: 0.15, weight: 4, month: 0, desc: 'Legs wobble like a dessert left in the sun.' },
  glowbelly: { name: 'Glowbelly', room: 'ward', fee: 1700, difficulty: 0.3, weight: 3, month: 2, desc: 'Swallowed a firefly. Possibly several.' },
  bubbleTrouble: { name: 'Bubble Trouble', room: 'pharmacy', fee: 1150, difficulty: 0.2, weight: 3, month: 2, desc: 'Every hiccup comes out as a soap bubble.' },
  echoItis: { name: 'Echo-itis', room: 'psych', fee: 1900, difficulty: 0.35, weight: 3, month: 4, desc: 'Everything they say, they say again. And again.' },
  backwardsWalking: { name: 'Backwards Walking', room: 'psych', fee: 1700, difficulty: 0.3, weight: 2, month: 5, desc: 'Can only walk backwards. Extremely confident about it.' },
  ghosting: { name: 'Ghosting', room: 'ward', fee: 1600, difficulty: 0.45, weight: 2, month: 6, desc: 'Keeps fading out of the room mid-sentence.' },
  frostbiteFever: { name: 'Frostbite Fever', room: 'sauna', fee: 1800, difficulty: 0.25, weight: 3, month: 1, desc: 'Followed everywhere by a tiny personal snowstorm.' },
};

export interface RoleDef {
  name: string;
  plural: string;
  baseSalary: number;
  perSkill: number;
  color: string;
}

export const ROLES: Record<Role, RoleDef> = {
  doctor: { name: 'Doctor', plural: 'Doctors', baseSalary: 1800, perSkill: 400, color: '#ffffff' },
  nurse: { name: 'Nurse', plural: 'Nurses', baseSalary: 1400, perSkill: 300, color: '#36c2b4' },
  assistant: { name: 'Assistant', plural: 'Assistants', baseSalary: 1000, perSkill: 200, color: '#ffc845' },
  janitor: { name: 'Janitor', plural: 'Janitors', baseSalary: 900, perSkill: 150, color: '#6d8cff' },
};

export const RECEPTION_DURATION = 5;
export const DIAGNOSIS_THRESHOLD = 0.8;

/** Balance knobs (tuned with the scripted-player simulation in Task 12). */
export const BALANCE = {
  gpBase: 45, gpPerSkill: 8,
  scanBase: 45, scanPerSkill: 6,
  cureBase: 0.7, curePerSkill: 0.06, cureCap: 0.98,
  certaintyWeight: 0.25,
  repCured: 1.2, repFailed: -2, repLeft: -1,
  /** fraction of the gap to 50 reputation closed each month */
  repDrift: 0.12,
  spawnMin: 4, spawnRange: 14,
  nightSlowdown: 1.8,
  patienceStand: 0.5, patienceSit: 0.3,
  litterCan: 0.45, litterPuddle: 0.2, wrapperMin: 120, wrapperMax: 240,
  /** extra patience drain within 2 tiles of litter */
  litterPatience: 0.35,
  wearPerService: 7,
};
export const MAX_GP_VISITS = 3;

export function roomCost(type: RoomType, w: number, h: number): number {
  const def = ROOMS[type];
  return def.baseCost + def.tileCost * w * h + def.required.reduce((s, it) => s + ITEMS[it].cost, 0);
}
