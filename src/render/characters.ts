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
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { World } from '../sim/world';
import type { Mover, Patient, Staff } from '../sim/state';
import type { IllnessType, Pose } from '../sim/catalog';
import { glow, metal, plastic, vinyl } from './materials';

const SKIN = ['#ffdcc2', '#f6c6a2', '#e3aa84', '#c98a63', '#9e6845', '#6f4a33'].map((c) => new THREE.Color(c));
const HAIR = ['#2b1d14', '#5a3a22', '#a0642e', '#e8c26b', '#d6d6d6', '#c0392b', '#3b5bdb', '#ff7eb6'].map((c) => new THREE.Color(c));
const SHIRT = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#c77dff', '#ff9f1c', '#2ec4b6', '#f15bb5', '#9b5de5', '#00bbf9'].map((c) => new THREE.Color(c));
const PANTS = ['#2f4b7c', '#6b5b45', '#1f2937', '#8d6e63', '#3a506b'].map((c) => new THREE.Color(c));
const ROLE_TOP: Record<string, THREE.Color> = {
  doctor: new THREE.Color('#ffffff'), nurse: new THREE.Color('#36c2b4'), assistant: new THREE.Color('#ffc845'), janitor: new THREE.Color('#6d8cff'),
};
const ROLE_PANTS: Record<string, THREE.Color> = {
  doctor: new THREE.Color('#2f4b7c'), nurse: new THREE.Color('#2aa597'), assistant: new THREE.Color('#374151'), janitor: new THREE.Color('#3a506b'),
};
const BLACK = new THREE.Color('#15171c');
const CHEEK = new THREE.Color('#ff8fa3');
const WHITE = new THREE.Color('#ffffff');
const FROST_SKIN = new THREE.Color('#bfe6ff');
const GHOST_SKIN = new THREE.Color('#e8f4ff');
const VIP_SUIT = new THREE.Color('#2c3440');
const VIP_HAT = new THREE.Color('#15171c');
const JANITOR_CAP = new THREE.Color('#3b5bdb');
const MOP = new THREE.Color('#d9b38c');
const CLIPBOARD = new THREE.Color('#c98a52');

/** item types whose lie spot sits at a given mattress height */
const LIE_Y: Record<string, number> = { bed: 0.83, scanner: 0.78 };

type Part =
  | 'leg' | 'shoe' | 'torso' | 'coat' | 'arm' | 'hand' | 'head' | 'eye' | 'mouth' | 'cheek'
  | 'hairCap' | 'hairBun' | 'hairSpikes' | 'nurseCap' | 'mirror' | 'belly' | 'cloud'
  | 'cap' | 'mop' | 'topHat' | 'clipboard' | 'badge';

const PER: Record<Part, number> = {
  leg: 2, shoe: 2, torso: 1, coat: 1, arm: 2, hand: 2, head: 1, eye: 2, mouth: 1, cheek: 2,
  hairCap: 1, hairBun: 1, hairSpikes: 1, nurseCap: 1, mirror: 1, belly: 1, cloud: 1,
  cap: 1, mop: 1, topHat: 1, clipboard: 1, badge: 1,
};

function lathe(pts: [number, number][], seg = 20) {
  return new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
}

function geometries(): Record<Part, THREE.BufferGeometry> {
  const leg = new THREE.CapsuleGeometry(0.078, 0.26, 4, 12).translate(0, -0.2, 0);
  const shoe = new THREE.SphereGeometry(1, 14, 10).scale(0.095, 0.06, 0.14);
  const torso = lathe([[0, 0.36], [0.16, 0.37], [0.2, 0.46], [0.21, 0.58], [0.19, 0.72], [0.14, 0.82], [0.06, 0.86], [0, 0.865]]);
  const coat = lathe([[0, 0.24], [0.2, 0.25], [0.225, 0.4], [0.22, 0.58], [0.2, 0.72], [0.15, 0.83], [0.06, 0.87], [0, 0.875]]);
  const arm = new THREE.CapsuleGeometry(0.058, 0.22, 4, 10).translate(0, -0.165, 0);
  const hand = new THREE.SphereGeometry(0.064, 12, 8);
  const head = new THREE.SphereGeometry(0.25, 28, 18);
  const eye = new THREE.SphereGeometry(0.036, 12, 8);
  const mouth = new THREE.TorusGeometry(0.045, 0.013, 6, 14, Math.PI);
  const cheek = new THREE.SphereGeometry(1, 10, 6).scale(0.04, 0.025, 0.015);
  const hairCap = new THREE.SphereGeometry(0.268, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.52).rotateX(-0.28);
  const hairBun = new THREE.SphereGeometry(0.11, 14, 10);
  const spikes: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2;
    const tilt = i === 0 ? 0 : 0.75;
    const c = new THREE.ConeGeometry(0.06, 0.26, 8).translate(0, 0.33, 0);
    c.rotateX(tilt).rotateY(a);
    spikes.push(c.toNonIndexed());
  }
  const hairSpikes = mergeGeometries(spikes)!;
  const nurseCap = new THREE.BoxGeometry(0.26, 0.1, 0.18);
  const mirror = new THREE.CylinderGeometry(0.075, 0.075, 0.018, 18).rotateX(Math.PI / 2);
  const belly = new THREE.SphereGeometry(0.11, 16, 10);
  const puffs: THREE.BufferGeometry[] = [];
  for (const [x, y, z, r] of [[0, 0, 0, 0.17], [0.17, -0.03, 0, 0.13], [-0.17, -0.02, 0.02, 0.13], [0.05, 0.08, -0.05, 0.12]]) {
    puffs.push(new THREE.SphereGeometry(r, 12, 8).translate(x, y, z).toNonIndexed());
  }
  const cloud = mergeGeometries(puffs)!;
  const cap = mergeGeometries([
    new THREE.SphereGeometry(0.272, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.42).toNonIndexed(),
    new THREE.CylinderGeometry(0.2, 0.2, 0.025, 20, 1, false, -Math.PI / 2, Math.PI).translate(0, 0.08, 0.13).toNonIndexed(),
  ])!;
  const mop = mergeGeometries([
    new THREE.CylinderGeometry(0.018, 0.018, 1.25, 6).translate(0, -0.35, 0).toNonIndexed(),
    new THREE.BoxGeometry(0.34, 0.06, 0.12).translate(0, -0.98, 0).toNonIndexed(),
  ])!;
  const topHat = mergeGeometries([
    new THREE.CylinderGeometry(0.17, 0.17, 0.32, 20).translate(0, 0.38, 0).toNonIndexed(),
    new THREE.CylinderGeometry(0.29, 0.29, 0.03, 24).translate(0, 0.23, 0).toNonIndexed(),
  ])!;
  const clipboard = new THREE.BoxGeometry(0.2, 0.27, 0.02);
  const badge = mergeGeometries([new THREE.BoxGeometry(0.22, 0.07, 0.04).toNonIndexed(), new THREE.BoxGeometry(0.07, 0.22, 0.04).toNonIndexed()])!;
  return { leg, shoe, torso, coat, arm, hand, head, eye, mouth, cheek, hairCap, hairBun, hairSpikes, nurseCap, mirror, belly, cloud, cap, mop, topHat, clipboard, badge };
}

interface RS {
  x: number;
  z: number;
  y: number;
  face: number;
  phase: number;
  walk: number;
  blinkT: number;
  celebrate: number;
  slump: number;
  seen: boolean;
  lastX: number;
  lastZ: number;
}

const tmp = {
  root: new THREE.Matrix4(),
  local: new THREE.Matrix4(),
  out: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  e: new THREE.Euler(),
  p: new THREE.Vector3(),
  s: new THREE.Vector3(),
  c: new THREE.Color(),
};

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const tmpV = new THREE.Vector3();
const tmpQ2 = new THREE.Quaternion();
const tmpE2 = new THREE.Euler();
const tmpS2 = new THREE.Vector3();

function hash(n: number, shift: number, mod: number) {
  return ((n >>> shift) ^ (n * 2654435761 >>> (shift + 3))) % mod;
}

export class Characters {
  readonly group = new THREE.Group();
  private meshes = {} as Record<Part, THREE.InstancedMesh>;
  private xray: THREE.InstancedMesh[] = [];
  private states = new Map<number, RS>();
  private n = 0;
  onEmit: ((kind: 'spark' | 'snow' | 'bubble', pos: THREE.Vector3, rate: number, dt: number) => void) | null = null;

  constructor(scene: THREE.Scene, private capacity = 260) {
    scene.add(this.group);
    const geo = geometries();
    const skinMat = vinyl();
    const mats: Partial<Record<Part, THREE.Material>> = {
      eye: plastic('#ffffff', 0.15, 1),
      mouth: plastic('#ffffff', 0.4, 0.3),
      cheek: new THREE.MeshStandardMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, roughness: 0.6 }),
      mirror: metal('#e9eef5', 0.12),
      belly: glow('#ffb43d', 5),
      cloud: plastic('#ffffff', 0.7, 0.2),
      badge: glow('#ff2a48', 4),
    };
    for (const part of Object.keys(PER) as Part[]) {
      const m = new THREE.InstancedMesh(geo[part], mats[part] ?? skinMat, capacity * PER[part]);
      m.count = 0;
      m.frustumCulled = false;
      const casts: Part[] = ['leg', 'torso', 'coat', 'arm', 'head', 'hairCap', 'hairBun', 'hairSpikes', 'cloud', 'cap', 'topHat', 'mop'];
      m.castShadow = casts.includes(part);
      m.receiveShadow = part !== 'belly' && part !== 'badge';
      if (part !== 'belly' && part !== 'badge') m.setColorAt(0, WHITE);
      this.meshes[part] = m;
      this.group.add(m);
    }
    // silhouettes through walls
    const xm = new THREE.MeshBasicMaterial({ color: '#8fe3ff', transparent: true, opacity: 0.32, depthFunc: THREE.GreaterDepth, depthWrite: false });
    // pull the silhouette 0.7 units toward the camera so only real occluders (walls) reveal it, not own hair/arms
    xm.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
  mvPosition.z += 0.7;
  gl_Position = projectionMatrix * mvPosition;`);
    };
    for (const part of ['torso', 'coat', 'head'] as Part[]) {
      const src = this.meshes[part];
      const x = new THREE.InstancedMesh(src.geometry, xm, capacity);
      x.instanceMatrix = src.instanceMatrix;
      x.frustumCulled = false;
      x.renderOrder = 10;
      x.count = 0;
      this.xray.push(x);
      this.group.add(x);
    }
  }

  /** called by the view on sim events */
  celebrate(id: number) {
    const s = this.states.get(id);
    if (s) s.celebrate = 1.6;
  }
  slump(id: number) {
    const s = this.states.get(id);
    if (s) s.slump = 2.5;
  }

  sync(world: World, alpha: number, dt: number, t: number) {
    this.n = 0;
    const counts = {} as Record<Part, number>;
    for (const p of Object.keys(PER) as Part[]) counts[p] = 0;
    const alive = new Set<number>();
    const draw = (m: Mover, kind: 'staff' | 'patient') => {
      if (this.n >= this.capacity) return;
      alive.add(m.id);
      this.drawOne(world, m, kind, alpha, dt, t, counts);
      this.n++;
    };
    for (const s of world.state.staff) draw(s, 'staff');
    for (const p of world.state.patients) draw(p, 'patient');
    for (const id of [...this.states.keys()]) if (!alive.has(id)) this.states.delete(id);
    for (const part of Object.keys(PER) as Part[]) {
      const m = this.meshes[part];
      m.count = counts[part];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    for (const x of this.xray) x.count = this.n;
    // xray uses torso/coat/head slots, which are filled for every character index
  }

  private put(part: Part, counts: Record<Part, number>, mat: THREE.Matrix4, color?: THREE.Color) {
    const m = this.meshes[part];
    const i = counts[part]++;
    m.setMatrixAt(i, mat);
    if (color) m.setColorAt(i, color);
  }

  private drawOne(world: World, m: Mover, kind: 'staff' | 'patient', alpha: number, dt: number, t: number, counts: Record<Part, number>) {
    const staff = kind === 'staff' ? (m as Staff) : null;
    const pat = kind === 'patient' ? (m as Patient) : null;
    const tx = m.px + (m.x - m.px) * alpha;
    const tz = m.pz + (m.z - m.pz) * alpha;
    let rs = this.states.get(m.id);
    if (!rs) {
      rs = { x: tx, z: tz, y: 0, face: m.face, phase: Math.random() * 6, walk: 0, blinkT: Math.random() * 4, celebrate: 0, slump: 0, seen: true, lastX: tx, lastZ: tz };
      this.states.set(m.id, rs);
    }
    // hops onto seats/beds glide instead of teleporting
    const jump = Math.hypot(tx - rs.x, tz - rs.z);
    if (jump > 0.25) {
      const k = 1 - Math.exp(-14 * dt);
      rs.x += (tx - rs.x) * k;
      rs.z += (tz - rs.z) * k;
    } else {
      rs.x = tx;
      rs.z = tz;
    }
    const moved = Math.hypot(rs.x - rs.lastX, rs.z - rs.lastZ);
    rs.lastX = rs.x;
    rs.lastZ = rs.z;
    const speed = dt > 0 ? moved / dt : 0;
    rs.walk += ((speed > 0.2 && m.pose === 'stand' ? 1 : 0) - rs.walk) * (1 - Math.exp(-10 * dt));
    rs.phase += moved * 7.5;
    let df = m.face - rs.face;
    df = Math.atan2(Math.sin(df), Math.cos(df));
    rs.face += df * (1 - Math.exp(-12 * dt));
    rs.blinkT -= dt;
    if (rs.blinkT < -0.12) rs.blinkT = 2 + Math.random() * 3.5;
    rs.celebrate = Math.max(0, rs.celebrate - dt);
    rs.slump = Math.max(0, rs.slump - dt);

    const look = m.look;
    const ill: IllnessType | null = pat && !pat.cured ? pat.illness : null;
    const scale = (staff ? 1 : 0.92 + hash(look, 15, 8) * 0.02) * 1.0;

    // colours
    const skin = tmp.c.copy(SKIN[hash(look, 0, SKIN.length)]);
    if (ill === 'chromaticFlu') skin.setHSL((t * 0.35 + m.id * 0.13) % 1, 0.75, 0.62);
    if (ill === 'frostbiteFever') skin.lerp(FROST_SKIN, 0.55);
    if (ill === 'ghosting') skin.lerp(GHOST_SKIN, 0.6);
    const skinC = skin.clone();
    const vip = !!pat?.vip;
    const janitor = staff?.role === 'janitor';
    const top = vip ? VIP_SUIT : staff ? ROLE_TOP[staff.role] : SHIRT[hash(look, 8, SHIRT.length)];
    const pants = vip ? VIP_SUIT : staff ? ROLE_PANTS[staff.role] : PANTS[hash(look, 12, PANTS.length)];
    let hairStyle = staff?.role === 'nurse' ? 2 : hash(look, 3, 4); // 0 cap,1 bun,2 short cap,3 bald-ish cap
    if (ill === 'staticCling') hairStyle = 9;
    if (vip || janitor) hairStyle = -1;
    const hairC = ill === 'staticCling' ? new THREE.Color('#ffe066') : HAIR[hash(look, 5, HAIR.length)];

    // root transform
    const pose: Pose = m.pose;
    let baseY = 0;
    let pitch = 0;
    const lieItem = m.spot ? world.item(m.spot.item)?.type : undefined;
    if (pose === 'sit') baseY = 0.06;
    if (pose === 'lie') { baseY = LIE_Y[lieItem ?? 'bed'] ?? 0.8; pitch = -Math.PI / 2; }
    if (ill === 'heliumLungs') baseY += 0.28 + Math.sin(t * 2.4 + m.id) * 0.07;
    const bob = Math.abs(Math.sin(rs.phase)) * 0.045 * rs.walk;
    let hop = 0;
    if (rs.celebrate > 0) hop = Math.abs(Math.sin(rs.celebrate * 9)) * 0.35 * Math.min(1, rs.celebrate);
    rs.y = baseY + bob + hop;
    const sway = ill === 'jellylegs' ? Math.sin(t * 7 + m.id) * 0.12 : 0;
    const backwards = ill === 'backwardsWalking' && rs.walk > 0.3 ? Math.PI : 0;
    tmp.q.setFromEuler(tmp.e.set(pitch, rs.face + backwards, sway, 'YXZ'));
    if (pose === 'lie') {
      // lie along the facing direction, head toward the back of the spot
      const fx = Math.sin(rs.face), fz = Math.cos(rs.face);
      tmp.q.setFromEuler(tmp.e.set(-Math.PI / 2, rs.face, 0, 'YXZ'));
      tmp.p.set(rs.x + fx * 0.58, rs.y, rs.z + fz * 0.58);
    } else {
      tmp.p.set(rs.x, rs.y, rs.z);
    }
    // squash on footfall, stretch on hops
    const squash = 1 - Math.max(0, Math.cos(rs.phase * 2)) * 0.035 * rs.walk + hop * 0.15;
    tmp.s.set(scale * (2 - squash) * 0.5 + scale * 0.5, scale * squash, scale * (2 - squash) * 0.5 + scale * 0.5);
    if (ill === 'ghosting') {
      const g = Math.sin(t * 1.3 + m.id * 2.1);
      const vis = g > 0.7 ? Math.max(0.001, 1 - (g - 0.7) / 0.2) : 1;
      tmp.s.multiplyScalar(vis);
    }
    tmp.root.compose(tmp.p, tmp.q, tmp.s);

    const L = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
      tmp.local.compose(tmpV.set(x, y, z), tmpQ2.setFromEuler(tmpE2.set(rx, ry, rz)), tmpS2.set(sx, sy, sz));
      return tmp.out.multiplyMatrices(tmp.root, tmp.local);
    };

    // legs
    const swing = Math.sin(rs.phase) * 0.62 * rs.walk;
    const wob = ill === 'jellylegs' ? Math.sin(t * 13 + m.id) * 0.35 : 0;
    const sitLeg = pose === 'sit' ? -Math.PI / 2 : 0;
    for (const side of [-1, 1]) {
      const a = sitLeg + swing * side + wob * side;
      const legM = L(side * 0.095, 0.42, 0, a, 0, wob * 0.3 * side).clone();
      this.put('leg', counts, legM, pants);
      tmp.local.compose(tmpV.set(0, -0.4, 0.035), tmpQ2.setFromEuler(tmpE2.set(-a * 0.2, 0, 0)), tmpS2.set(1, 1, 1));
      this.put('shoe', counts, tmp.out.multiplyMatrices(legM, tmp.local), BLACK);
    }
    // torso (doctors wear a coat instead)
    const inflate = ill === 'heliumLungs' ? 1.3 : 1;
    const breathe = 1 + Math.sin(t * 2.2 + m.id) * 0.012;
    const torsoM = L(0, 0, 0, 0, 0, 0, inflate, breathe, inflate).clone();
    if (staff?.role === 'doctor') {
      this.put('coat', counts, torsoM, top);
      this.put('torso', counts, ZERO, top);
    } else {
      this.put('torso', counts, torsoM, top);
      this.put('coat', counts, ZERO, top);
    }
    // arms
    let armA = -swing * 0.9;
    let armSpread = 0.12;
    const working = pose === 'work' || (pose === 'sit' && staff) || (staff?.busy && pose !== 'stand');
    for (const side of [-1, 1]) {
      let ax = armA * side;
      let az = side * armSpread;
      if (working) { ax = -1.1 + Math.sin(t * 9 + side) * 0.12; az = side * 0.05; }
      if (pose === 'lie') { ax = 0; az = side * 0.18; }
      if (rs.celebrate > 0) { ax = -2.8 + Math.sin(t * 16 + side) * 0.2; az = side * 0.35; }
      if (rs.slump > 0) { ax = 0.15; az = side * 0.02; }
      if (ill === 'staticCling') az += side * 0.35;
      const sweeping = janitor && staff?.state === 'doingJob';
      if (janitor && side === 1) { ax = sweeping ? -0.7 + Math.sin(t * 8) * 0.45 : -0.35 + armA * 0.3; az = 0.1; }
      if (vip && side === -1) { ax = -1.0; az = -0.1; }
      const armM = L(side * (0.215 * inflate), 0.79, 0, ax, 0, az).clone();
      this.put('arm', counts, armM, top);
      tmp.local.makeTranslation(0, -0.36, 0);
      const handM = tmp.out.multiplyMatrices(armM, tmp.local).clone();
      this.put('hand', counts, handM, skinC);
      if (side === 1) {
        tmp.local.compose(tmpV.set(0, 0, 0.05), tmpQ2.setFromEuler(tmpE2.set(0.5, 0, 0)), tmpS2.set(1, 1, 1));
        this.put('mop', counts, janitor ? tmp.out.multiplyMatrices(handM, tmp.local) : ZERO, MOP);
      } else {
        tmp.local.compose(tmpV.set(0, -0.02, 0.1), tmpQ2.setFromEuler(tmpE2.set(1.2, 0, 0)), tmpS2.set(1, 1, 1));
        this.put('clipboard', counts, vip ? tmp.out.multiplyMatrices(handM, tmp.local) : ZERO, CLIPBOARD);
      }
    }
    void armA; void armSpread;
    // head
    const tired = staff && staff.energy < 15 && staff.state !== 'onBreak' ? 0.3 + Math.sin(t * 1.2) * 0.1 : 0;
    const nod = rs.slump > 0 ? 0.45 : (working ? 0.18 : 0) + tired + Math.sin(rs.phase * 2) * 0.03 * rs.walk;
    const headM = L(0, 1.07, 0, nod, 0, Math.sin(t * 0.7 + m.id) * 0.04, 1, 0.96, 0.98).clone();
    this.put('head', counts, headM, skinC);
    const sub = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
      tmp.local.compose(tmpV.set(x, y, z), tmpQ2.setFromEuler(tmpE2.set(rx, ry, rz)), tmpS2.set(sx, sy, sz));
      return tmp.out.multiplyMatrices(headM, tmp.local);
    };
    const blink = rs.blinkT < 0 ? 0.12 : 1;
    const happy = rs.celebrate > 0 || (staff ? true : pat ? pat.patience > 35 && rs.slump <= 0 : true);
    for (const side of [-1, 1]) {
      this.put('eye', counts, sub(side * 0.088, 0.025, 0.222, 0, 0, 0, 1, blink * (happy ? 1 : 0.8), 0.7), BLACK);
      this.put('cheek', counts, sub(side * 0.155, -0.045, 0.205, 0, side * 0.5, 0), CHEEK);
    }
    this.put('mouth', counts, sub(0, -0.075, 0.232, 0, 0, happy ? Math.PI : 0, rs.celebrate > 0 ? 1.4 : 1, rs.celebrate > 0 ? 1.4 : 1, 1), BLACK);
    // hair & hats
    const hide = ZERO;
    this.put('hairCap', counts, hairStyle === 0 || hairStyle === 1 || hairStyle === 2 ? sub(0, 0.01, -0.005) : hide, hairC);
    this.put('hairBun', counts, hairStyle === 1 ? sub(0, 0.2, -0.17) : hide, hairC);
    const fizz = ill === 'staticCling' ? 1 + Math.sin(t * 30 + m.id) * 0.06 : 1;
    this.put('hairSpikes', counts, hairStyle === 9 || hairStyle === 3 ? sub(0, 0, 0, 0, t * (ill === 'staticCling' ? 0.5 : 0), 0, fizz, hairStyle === 3 ? 0.55 : fizz, fizz) : hide, hairC);
    this.put('nurseCap', counts, staff?.role === 'nurse' ? sub(0, 0.25, 0.02, -0.15) : hide, WHITE);
    this.put('mirror', counts, staff?.role === 'doctor' ? sub(0, 0.15, 0.225, -0.25) : hide, WHITE);
    this.put('cap', counts, janitor ? sub(0, 0.01, 0, -0.1) : hide, JANITOR_CAP);
    this.put('topHat', counts, vip ? sub(0, 0.02, 0, -0.08) : hide, VIP_HAT);
    if (pat?.emergency && !pat.cured) {
      const b = 1 + Math.sin(t * 6) * 0.12;
      this.put('badge', counts, L(0, 1.78 + Math.sin(t * 3 + m.id) * 0.05, 0, 0, t * 2, 0, b, b, b));
    }
    // illness extras
    if (ill === 'glowbelly') {
      const pulse = 1 + Math.sin(t * 4 + m.id) * 0.15;
      this.put('belly', counts, L(0, 0.57, 0.15 * inflate, 0, 0, 0, pulse, pulse, pulse));
    }
    if (ill === 'frostbiteFever') {
      const cm = L(0, 1.62 + Math.sin(t * 1.5 + m.id) * 0.05, 0, 0, t * 0.4, 0);
      this.put('cloud', counts, cm, WHITE);
      this.onEmit?.('snow', new THREE.Vector3().setFromMatrixPosition(cm), 6, dt);
    }
    if (ill === 'staticCling') {
      this.onEmit?.('spark', new THREE.Vector3().setFromMatrixPosition(headM).setY(rs.y + 1.35), 3, dt);
    }
    if (ill === 'bubbleTrouble') {
      const mouth = new THREE.Vector3().setFromMatrixPosition(sub(0, -0.075, 0.3));
      this.onEmit?.('bubble', mouth, 2.5, dt);
    }
  }
}
