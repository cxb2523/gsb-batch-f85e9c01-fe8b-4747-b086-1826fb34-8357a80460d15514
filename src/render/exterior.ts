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
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { floorMat, glow, glass, matte, metal, plastic, texScale } from './materials';
import { radialTex, tex } from './textures';
import { fx, windSway, worldMapped } from './shaderfx';
import type { Preset } from './engine';
import type { BuildingRect } from '../sim/grid';
import type { Theme } from '../sim/scenarios';
import { addThemeProps, type ThemeExtras } from './themes';
import { bake } from './itemMeshes';

type Rect = { x0: number; z0: number; x1: number; z1: number };

/** Areas where grass blades and trees must not grow (index 0 is the building, set per map). */
const HARD: Rect[] = [
  { x0: 7.4, z0: 5.4, x1: 36.6, z1: 28.6 }, // building plinth
  { x0: 16.6, z0: 28, x1: 27.4, z1: 31.2 }, // plaza
  { x0: 19.6, z0: 31, x1: 24.4, z1: 33 }, // path
  { x0: 27.6, z0: 28, x1: 36, z1: 32.6 }, // ambulance bay
  { x0: -400, z0: 32.6, x1: 400, z1: 39.4 }, // sidewalks + road
  { x0: 11.2, z0: 28.9, x1: 15.8, z1: 32.1 }, // fountain
];
const inHard = (x: number, z: number, m = 0) => HARD.some((r) => x > r.x0 - m && x < r.x1 + m && z > r.z0 - m && z < r.z1 + m);
const overlapsHard = (x0: number, z0: number, x1: number, z1: number) => HARD.some((r) => x0 < r.x1 && x1 > r.x0 && z0 < r.z1 && z1 > r.z0);

export interface ExteriorOptions { building: BuildingRect; theme: Theme; name: string }

const GROUND: Record<Theme, 'grass' | 'snow' | 'sand' | 'gravel' | 'plaza'> = { meadow: 'grass', snow: 'snow', beach: 'sand', industrial: 'gravel', city: 'plaza' };
const GRASS_FACTOR: Record<Theme, number> = { meadow: 1, snow: 0, beach: 0.12, industrial: 0.15, city: 0 };
const GRASS_COLS: Record<Theme, string[]> = {
  meadow: ['#6fbf3f', '#5aae35', '#82cc4a', '#4f9f30', '#9bd65a'],
  snow: ['#dfeee6', '#c7dccf', '#f2f8f4', '#b9cfc0'],
  beach: ['#b9c76a', '#a8b85a', '#d1d88a', '#93a64a'],
  industrial: ['#7f9a5a', '#6b8550', '#94a86e'],
  city: ['#6fbf3f', '#5aae35', '#82cc4a'],
};

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function plane(w: number, d: number, x: number, z: number, y: number, mat: THREE.Material, uvScale: number) {
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  g.translate(x + w / 2, y, z + d / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / uvScale, -pos.getZ(i) / uvScale);
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  return m;
}

function shadowed<T extends THREE.Object3D>(o: T, cast = true, receive = true): T {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = cast;
      c.receiveShadow = receive;
    }
  });
  return o;
}

// ---------- vehicles ----------

const CAR_COLORS = ['#ff5a5f', '#ffc145', '#3ec1d3', '#7b61ff', '#2ec4b6', '#ff8a3d', '#f4f1de', '#4361ee'];

function makeCar(color: string, kind: 'car' | 'van' = 'car'): THREE.Group {
  const g = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.28, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05 });
  const len = kind === 'van' ? 2.3 : 1.9;
  const body = new THREE.Mesh(new RoundedBoxGeometry(len, 0.5, 0.95, 4, 0.18), paint);
  body.position.y = 0.42;
  g.add(body);
  const cab = new THREE.Mesh(new RoundedBoxGeometry(kind === 'van' ? 1.5 : 1.05, 0.42, 0.85, 4, 0.16), glass('#1d2a3a', 0.85));
  cab.position.set(kind === 'van' ? -0.25 : -0.1, 0.82, 0);
  g.add(cab);
  const roof = new THREE.Mesh(new RoundedBoxGeometry(kind === 'van' ? 1.45 : 0.95, 0.08, 0.82, 2, 0.04), paint);
  roof.position.set(cab.position.x, 1.04, 0);
  g.add(roof);
  const tire = matte('#1b1b20', 0.7);
  const hub = metal('#d9dde6', 0.3);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 18), tire);
    w.rotation.x = Math.PI / 2;
    w.position.set(sx * len * 0.32, 0.2, sz * 0.46);
    g.add(w);
    const h = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.17, 12), hub);
    h.rotation.x = Math.PI / 2;
    h.position.copy(w.position);
    g.add(h);
  }
  const head = glow('#fff6d8', 4);
  const tail = glow('#ff2a2a', 2.5);
  for (const sz of [-0.32, 0.32]) {
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), head);
    hl.position.set(len / 2 - 0.02, 0.48, sz);
    g.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 0.16), tail);
    tl.position.set(-len / 2 + 0.01, 0.5, sz);
    g.add(tl);
  }
  return bake(shadowed(g, true, false));
}

function makeAmbulance(): { group: THREE.Group; red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const white = new THREE.MeshPhysicalMaterial({ color: '#fbfbfb', roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 });
  const box = new THREE.Mesh(new RoundedBoxGeometry(2.2, 1.35, 1.25, 4, 0.14), white);
  box.position.set(-0.35, 0.95, 0);
  g.add(box);
  const nose = new THREE.Mesh(new RoundedBoxGeometry(1.0, 0.85, 1.2, 4, 0.2), white);
  nose.position.set(1.05, 0.68, 0);
  g.add(nose);
  const wind = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.42, 1.1, 3, 0.1), glass('#1a2636', 0.9));
  wind.position.set(1.12, 1.0, 0);
  wind.rotation.z = -0.35;
  g.add(wind);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(3.25, 0.16, 1.27), plastic('#ff3b4a', 0.3, 1));
  stripe.position.set(0.05, 0.62, 0);
  g.add(stripe);
  // cross decal
  const cross = plastic('#ff3b4a', 0.3, 1);
  for (const [w, h] of [[0.42, 0.13], [0.13, 0.42]]) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.02), cross);
    c.position.set(-0.5, 1.1, 0.64);
    g.add(c);
    const c2 = c.clone();
    c2.position.z = -0.64;
    g.add(c2);
  }
  const red = glow('#ff2030', 6).clone();
  const blue = glow('#2a6bff', 6).clone();
  const bar = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.12, 1.0, 2, 0.05), matte('#222'));
  bar.position.set(0.4, 1.68, 0);
  g.add(bar);
  const l1 = new THREE.Mesh(new RoundedBoxGeometry(0.26, 0.14, 0.42, 2, 0.05), red);
  l1.position.set(0.4, 1.74, -0.24);
  const l2 = new THREE.Mesh(new RoundedBoxGeometry(0.26, 0.14, 0.42, 2, 0.05), blue);
  l2.position.set(0.4, 1.74, 0.24);
  g.add(l1, l2);
  const tire = matte('#1b1b20', 0.7);
  for (const sx of [-1.05, 1.0]) for (const sz of [-0.55, 0.55]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.2, 18), tire);
    w.rotation.x = Math.PI / 2;
    w.position.set(sx, 0.27, sz);
    g.add(w);
  }
  return { group: bake(shadowed(g, true, false), [l1, l2]), red, blue };
}

// ---------- vegetation ----------

function blade(): THREE.BufferGeometry {
  const segs = 3, w = 0.055, h = 0.38;
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [], idx: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const ww = w * (1 - t * 0.85);
    const bend = t * t * 0.08;
    pos.push(-ww / 2, t * h, bend, ww / 2, t * h, bend);
    uv.push(0, t, 1, t);
    nrm.push(0, 1, 0, 0, 1, 0);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

interface TreeSpec { x: number; z: number; kind: 'round' | 'pine' | 'blossom'; s: number }

export class Exterior {
  readonly group = new THREE.Group();
  private cars: { obj: THREE.Group; speed: number; lane: number; x: number }[] = [];
  private amb!: { group: THREE.Group; red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial };
  private lampMat = glow('#ffd59a', 0).clone();
  private poolMat: THREE.MeshBasicMaterial;
  private windowMat = glow('#ffcf7a', 0).clone();
  private waterMat!: THREE.MeshPhysicalMaterial;
  private signMat!: THREE.MeshStandardMaterial;
  private fountainLights = glow('#7fe0ff', 0).clone();
  private grass: THREE.InstancedMesh | null = null;
  private pools: THREE.InstancedMesh | null = null;
  private poolMatrices: THREE.Matrix4[] = [];
  /** One shared plane for the lamp glow pools; the InstancedMeshes come and go with presets. */
  private readonly poolGeo = new THREE.PlaneGeometry(1, 1);

  readonly theme: Theme;
  private b: BuildingRect;
  extras: ThemeExtras | null = null;

  constructor(private scene: THREE.Scene, private preset: Preset, private opts: ExteriorOptions) {
    scene.add(this.group);
    this.theme = opts.theme;
    this.b = opts.building;
    HARD[0] = { x0: this.b.x - 0.6, z0: this.b.z - 0.6, x1: this.b.x + this.b.w + 0.6, z1: this.b.z + this.b.h + 0.6 };
    // the sea: nothing grows below the beach's shoreline
    if (this.theme === 'beach') HARD.push({ x0: -400, z0: -400, x1: 400, z1: this.b.z - 4.4 });
    this.poolMat = new THREE.MeshBasicMaterial({ map: radialTex(), color: '#ffc77a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.ground();
    this.roadAndPaths();
    this.hedgesAndBeds();
    this.trees();
    this.lamps();
    this.vehicles();
    this.fountain();
    this.sign();
    if (this.theme === 'meadow' || this.theme === 'snow') this.town();
    this.extras = addThemeProps(this.group, this.theme, this.b, (x0, z0, x1, z1) => overlapsHard(x0, z0, x1, z1));
    this.setGrass(preset.grass);
  }

  private ground() {
    const gk = GROUND[this.theme];
    const big = plane(700, 700, -326, -330, -0.02, floorMat(gk), texScale(gk));
    this.group.add(big);
    const plinthMat = new THREE.MeshStandardMaterial({ color: '#e9e2d6', roughness: 0.85, map: tex('paving').map });
    worldMapped(plinthMat, 2);
    const b = this.b;
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(b.w + 1.2, 0.24, b.h + 1.2), plinthMat);
    plinth.position.set(b.x + b.w / 2, -0.125, b.z + b.h / 2);
    plinth.receiveShadow = true;
    this.group.add(plinth);
    // entrance steps
    for (let i = 0; i < 2; i++) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(5 - i * 0.4, 0.08, 0.5), plinthMat);
      st.position.set(22, -0.04 - i * 0.07, 28.85 + i * 0.45);
      st.receiveShadow = true;
      this.group.add(st);
    }
  }

  private roadAndPaths() {
    const g = this.group;
    g.add(plane(800, 4.6, -400, 34.2, 0.0, floorMat('asphalt'), texScale('asphalt')));
    g.add(plane(800, 1.6, -400, 32.6, 0.08, floorMat('paving'), texScale('paving')));
    g.add(plane(800, 1.6, -400, 38.8, 0.08, floorMat('paving'), texScale('paving')));
    const curbMat = matte('#cfcac0', 0.7);
    for (const z of [34.2, 38.8]) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(800, 0.12, 0.14), curbMat);
      c.position.set(0, 0.04, z);
      c.receiveShadow = true;
      g.add(c);
    }
    g.add(plane(10.8, 3.2, 16.6, 28, 0.03, floorMat('path'), texScale('path')));
    g.add(plane(4.8, 1.8, 19.6, 31, 0.035, floorMat('path'), texScale('path')));
    g.add(plane(8.4, 4.6, 27.6, 28, 0.025, floorMat('asphalt'), texScale('asphalt')));
    // road markings
    const paint = new THREE.MeshStandardMaterial({ color: '#f5f1e6', roughness: 0.6 });
    const yellow = new THREE.MeshStandardMaterial({ color: '#ffd23f', roughness: 0.6 });
    const dashes = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 0.01, 0.12), paint, 90);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 90; i++) {
      m.makeTranslation(-80 + i * 2.6, 0.012, 36.5);
      dashes.setMatrixAt(i, m);
    }
    dashes.receiveShadow = true;
    g.add(dashes);
    for (let i = 0; i < 6; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.012, 3.6), paint);
      s.position.set(19.9 + i * 0.85, 0.013, 36.5);
      s.receiveShadow = true;
      g.add(s);
    }
    // ambulance bay hatching
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.012, 3.8), yellow);
      s.position.set(28.4 + i * 1.7, 0.03, 30.3);
      s.rotation.y = 0.5;
      s.receiveShadow = true;
      g.add(s);
    }
    const bayEdge = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.013, 0.12), yellow);
    bayEdge.position.set(31.8, 0.03, 32.4);
    g.add(bayEdge);
  }

  private hedgesAndBeds() {
    const leaf = new THREE.MeshStandardMaterial({ color: this.theme === 'snow' ? '#cfe3d6' : this.theme === 'beach' ? '#6f9e3a' : '#3f8f3a', roughness: 0.85, map: tex('carpet').map, normalMap: tex('carpet').normalMap });
    leaf.map = tex('grass').map;
    const runs: [number, number][] = [[-10, 11.2], [15.8, 19.4], [24.6, 27.4], [36.2, 56]];
    for (const [a, b] of runs) {
      const h = new THREE.Mesh(new RoundedBoxGeometry(b - a, 0.7, 0.7, 4, 0.3), leaf);
      h.position.set((a + b) / 2, 0.35, 32.2);
      shadowed(h);
      this.group.add(h);
    }
    // flower beds beside the plaza
    const soil = matte('#6b4630', 0.95);
    const flowers = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.09, 1), plastic('#ffffff', 0.4, 0.6), 420);
    const stems = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 4), matte('#3a7d2c'), 420);
    const r = rng(42);
    const palette = ['#ff6fa8', '#ffd447', '#ffffff', '#b78bff', '#ff8552', '#6fd3ff'].map((c) => new THREE.Color(c));
    let n = 0;
    const m = new THREE.Matrix4();
    for (const [bx, bz, bw, bd] of [[17.0, 28.3, 2.6, 1.1], [24.4, 28.3, 2.6, 1.1], [0.5, 29.5, 3.5, 1.4], [40, 29.4, 3, 1.4]] as const) {
      if (bz < 28 && overlapsHard(bx, bz, bx + bw, bz + bd)) continue;
      const bed = new THREE.Mesh(new RoundedBoxGeometry(bw, 0.24, bd, 3, 0.08), soil);
      bed.position.set(bx + bw / 2, 0.08, bz + bd / 2);
      bed.receiveShadow = true;
      this.group.add(bed);
      const border = new THREE.Mesh(new RoundedBoxGeometry(bw + 0.16, 0.18, bd + 0.16, 3, 0.06), matte('#e8e0d2'));
      border.position.copy(bed.position).setY(0.06);
      border.receiveShadow = true;
      this.group.add(border);
      for (let i = 0; i < 105 && n < 420; i++, n++) {
        const x = bx + 0.15 + r() * (bw - 0.3), z = bz + 0.15 + r() * (bd - 0.3);
        const h = 0.25 + r() * 0.12;
        m.compose(new THREE.Vector3(x, 0.2 + h, z), new THREE.Quaternion(), new THREE.Vector3(1, 0.7, 1).multiplyScalar(0.8 + r() * 0.6));
        flowers.setMatrixAt(n, m);
        flowers.setColorAt(n, palette[(r() * palette.length) | 0]);
        m.makeTranslation(x, 0.2 + h / 2, z);
        stems.setMatrixAt(n, m);
      }
    }
    flowers.count = stems.count = n;
    windSway(flowers.material as THREE.Material, 0.04, 'local', 1);
    shadowed(flowers, true, true);
    this.group.add(flowers, stems);
  }

  private trees() {
    const specs: TreeSpec[] = [];
    const r = rng(7);
    if (this.theme === 'beach' || this.theme === 'city') return;
    const add = (x: number, z: number, kind: TreeSpec['kind'], s = 0.85 + r() * 0.4) => {
      if (inHard(x, z, 1.6)) return;
      if (this.theme === 'snow' && kind === 'blossom') kind = 'pine';
      if (this.theme === 'industrial' && r() < 0.45) return;
      specs.push({ x, z, kind, s });
    };
    // behind the hospital
    for (let i = 0; i < 9; i++) add(4 + i * 5 + r() * 2, 1.2 + r() * 2.5, r() > 0.6 ? 'pine' : 'round');
    // flanks
    for (let i = 0; i < 6; i++) add(1.5 + r() * 3.5, 8 + i * 3.6 + r(), r() > 0.5 ? 'round' : 'blossom');
    for (let i = 0; i < 6; i++) add(39 + r() * 4, 8 + i * 3.4 + r(), r() > 0.65 ? 'blossom' : 'round');
    // across the road (small, sparse)
    for (let i = 0; i < 7; i++) add(-6 + i * 9 + r() * 3, 41.5 + r() * 2, 'round', 0.7 + r() * 0.3);
    // far backdrop
    for (let i = 0; i < 40; i++) {
      const a = r() * Math.PI * 2, d = 40 + r() * 50;
      const x = 24 + Math.cos(a) * d, z = 10 + Math.sin(a) * d * 0.7;
      if (z > 30 && z < 46) continue;
      add(x, z, r() > 0.5 ? 'pine' : 'round', 1 + r() * 0.8);
    }

    const trunkGeo = new THREE.CylinderGeometry(0.1, 0.17, 1.4, 8);
    trunkGeo.translate(0, 0.7, 0);
    const blobGeo = new THREE.IcosahedronGeometry(1, 2);
    const coneGeo = new THREE.ConeGeometry(1, 1.5, 12);
    const foliageMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.6, clearcoat: 0.4, clearcoatRoughness: 0.3, sheen: 0.6, sheenColor: new THREE.Color('#d8ffb0') });
    const coneMat = foliageMat.clone();
    windSway(foliageMat, 0.12, 'local', 5);
    windSway(coneMat, 0.1, 'local', 5);
    const trunks = new THREE.InstancedMesh(trunkGeo, matte('#8a5a3c', 0.8), specs.length);
    const blobs = new THREE.InstancedMesh(blobGeo, foliageMat, specs.length * 5);
    const cones = new THREE.InstancedMesh(coneGeo, coneMat, specs.length * 3);
    let nb = 0, nc = 0;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const greens = (this.theme === 'snow' ? ['#e9f2f5', '#d6e6ea', '#f5fafc'] : this.theme === 'industrial' ? ['#6f8f4a', '#5d7d42', '#7d9a58'] : ['#5cb84a', '#4aa83f', '#73c24f', '#3f9a4a']).map((c) => new THREE.Color(c));
    const pinks = ['#ffb3d1', '#ff9cc4', '#ffc7de'].map((c) => new THREE.Color(c));
    const pineCols = (this.theme === 'snow' ? ['#e6f0f2', '#2f6e4f', '#f2f8fa'] : ['#2f7d4f', '#2a6e48', '#38895a']).map((c) => new THREE.Color(c));
    specs.forEach((t, i) => {
      m.compose(new THREE.Vector3(t.x, 0, t.z), q.setFromEuler(new THREE.Euler(0, r() * 6, 0)), new THREE.Vector3(t.s, t.s * (t.kind === 'pine' ? 0.9 : 1), t.s));
      trunks.setMatrixAt(i, m);
      if (t.kind === 'pine') {
        for (let k = 0; k < 3; k++) {
          const sc = (1.15 - k * 0.3) * t.s;
          m.compose(new THREE.Vector3(t.x, (1.5 + k * 0.85) * t.s, t.z), q.identity(), new THREE.Vector3(sc, sc, sc));
          cones.setMatrixAt(nc, m);
          cones.setColorAt(nc++, pineCols[(r() * 3) | 0]);
        }
      } else {
        const cols = t.kind === 'blossom' ? pinks : greens;
        const n = 3 + ((r() * 3) | 0);
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + r();
          const rr = k === 0 ? 0 : 0.55 * t.s;
          const sc = (k === 0 ? 1.0 : 0.7 + r() * 0.2) * t.s;
          m.compose(new THREE.Vector3(t.x + Math.cos(a) * rr, (2.1 + (k === 0 ? 0.35 : r() * 0.3)) * t.s, t.z + Math.sin(a) * rr), q.identity(), new THREE.Vector3(sc, sc * 0.9, sc));
          blobs.setMatrixAt(nb, m);
          blobs.setColorAt(nb++, cols[(r() * cols.length) | 0]);
        }
      }
    });
    blobs.count = nb;
    cones.count = nc;
    for (const im of [trunks, blobs, cones]) shadowed(im, true, true);
    this.group.add(trunks, blobs, cones);
  }

  setGrass(count0: number) {
    const count = Math.floor(count0 * GRASS_FACTOR[this.theme]);
    if (this.grass) {
      this.group.remove(this.grass);
      this.grass.geometry.dispose();
      // The blade material is created here each time, so free it with the mesh; otherwise
      // a preset switch leaves its program and instance buffers behind.
      const mat = this.grass.material;
      for (const m of Array.isArray(mat) ? mat : [mat]) m.dispose();
      this.grass.dispose();
      this.grass = null;
    }
    if (count <= 0) return;
    const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, side: THREE.DoubleSide });
    windSway(mat, 0.09, 'uv');
    const im = new THREE.InstancedMesh(blade(), mat, count);
    const r = rng(99);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const cols = GRASS_COLS[this.theme].map((c) => new THREE.Color(c));
    let n = 0;
    for (let tries = 0; n < count && tries < count * 4; tries++) {
      // denser near the hospital, sparser at the fringe
      const near = r() < 0.8;
      const x = near ? -4 + r() * 52 : -14 + r() * 72;
      const z = near ? -3 + r() * 36 : -12 + r() * 64;
      if (inHard(x, z)) continue;
      const s = 0.7 + r() * 0.8;
      m.compose(new THREE.Vector3(x, 0, z), q.setFromEuler(e.set(0, r() * Math.PI * 2, (r() - 0.5) * 0.3)), new THREE.Vector3(s, s * (0.8 + r() * 0.6), s));
      im.setMatrixAt(n, m);
      im.setColorAt(n++, cols[(r() * cols.length) | 0]);
    }
    im.count = n;
    im.receiveShadow = true;
    im.castShadow = false;
    im.frustumCulled = false;
    this.grass = im;
    this.group.add(im);
  }

  private lamps() {
    const poleMat = metal('#2f4a3d', 0.4);
    const pools: THREE.Matrix4[] = [];
    const xs: number[] = [];
    for (let x = -30; x <= 78; x += 9) xs.push(x);
    for (const x of xs) {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 3.2, 10), poleMat);
      pole.position.y = 1.6;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.7, 8), poleMat);
      arm.rotation.z = Math.PI / 2;
      arm.position.set(0, 3.1, 0.3);
      arm.rotation.y = Math.PI / 2;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.25, 16, 1, true), poleMat);
      head.position.set(0, 3.02, 0.62);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 10), this.lampMat);
      bulb.position.set(0, 2.92, 0.62);
      g.add(pole, arm, head, bulb);
      g.position.set(x, 0.08, 33.1);
      shadowed(g, true, false);
      this.group.add(bake(g));
      pools.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0.1, 33.7), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), new THREE.Vector3(6, 6, 1)));
    }
    // plaza lamps
    for (const x of [17.2, 26.8]) {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 2.2, 10), poleMat);
      pole.position.y = 1.1;
      const globe = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 12), this.lampMat);
      globe.position.y = 2.3;
      g.add(pole, globe);
      g.position.set(x, 0, 31.2);
      shadowed(g, true, false);
      this.group.add(bake(g));
      pools.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0.06, 31.2), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), new THREE.Vector3(5, 5, 1)));
    }
    this.poolMatrices = pools;
    this.syncPools();
  }

  /** Show or remove the lamp glow pools to match the current preset. */
  private syncPools() {
    const want = this.preset.lightPools;
    if (want && !this.pools) {
      const im = new THREE.InstancedMesh(this.poolGeo, this.poolMat, this.poolMatrices.length);
      this.poolMatrices.forEach((p, i) => im.setMatrixAt(i, p));
      im.renderOrder = 2;
      im.frustumCulled = false;
      this.pools = im;
      this.group.add(im);
    } else if (!want && this.pools) {
      // Detach but keep the shared geometry: the pools come back on the next preset that
      // wants them, and creating a new PlaneGeometry each time grew the geometry count.
      this.group.remove(this.pools);
      this.pools.dispose();
      this.pools = null;
    }
  }

  /** Adopt a new graphics preset, rebuilding only the pieces that depend on it. */
  setPreset(preset: Preset) {
    this.preset = preset;
    this.setGrass(preset.grass);
    this.syncPools();
  }

  private vehicles() {
    const r = rng(5);
    for (const [x, kind] of [[-7, 'car'], [3.5, 'van'], [41, 'car'], [47, 'car']] as const) {
      const c = makeCar(CAR_COLORS[(r() * CAR_COLORS.length) | 0], kind);
      c.position.set(x, 0, 34.85);
      c.rotation.y = r() > 0.5 ? 0 : Math.PI;
      this.group.add(c);
    }
    for (let i = 0; i < 4; i++) {
      const lane = i % 2;
      const c = makeCar(CAR_COLORS[(r() * CAR_COLORS.length) | 0], r() > 0.75 ? 'van' : 'car');
      const speed = (lane ? -1 : 1) * (5 + r() * 3);
      const x = -60 + r() * 160;
      c.position.set(x, 0, lane ? 37.5 : 35.7);
      c.rotation.y = lane ? Math.PI : 0;
      this.group.add(c);
      this.cars.push({ obj: c, speed, lane, x });
    }
    this.amb = makeAmbulance();
    this.amb.group.position.set(31.8, 0.03, 30.2);
    this.amb.group.rotation.y = Math.PI;
    this.group.add(this.amb.group);
  }

  private fountain() {
    const stone = new THREE.MeshPhysicalMaterial({ color: '#efe8dc', roughness: 0.5, clearcoat: 0.3 });
    const pts = [
      new THREE.Vector2(0, 0), new THREE.Vector2(2.0, 0), new THREE.Vector2(2.1, 0.1), new THREE.Vector2(2.1, 0.45),
      new THREE.Vector2(1.95, 0.5), new THREE.Vector2(1.85, 0.45), new THREE.Vector2(1.85, 0.12), new THREE.Vector2(0, 0.12),
    ];
    const basin = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), stone);
    basin.position.set(13.5, 0, 30.5);
    shadowed(basin);
    this.group.add(basin);
    const waterNormal = tex('lino').normalMap.clone();
    waterNormal.needsUpdate = true;
    waterNormal.repeat.set(0.6, 0.6);
    this.waterMat = new THREE.MeshPhysicalMaterial({
      color: '#4fc3e8', roughness: 0.05, transmission: 0, transparent: true, opacity: 0.85, clearcoat: 1, clearcoatRoughness: 0.03,
      normalMap: waterNormal, normalScale: new THREE.Vector2(0.8, 0.8), envMapIntensity: 2,
    });
    const water = new THREE.Mesh(new THREE.CircleGeometry(1.86, 48), this.waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(13.5, 0.36, 30.5);
    water.receiveShadow = true;
    this.group.add(water);
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 1.1, 20), stone);
    col.position.set(13.5, 0.55, 30.5);
    const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.6, 32, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), stone);
    bowl.position.set(13.5, 1.35, 30.5);
    bowl.rotation.x = Math.PI;
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 10), stone);
    top.position.set(13.5, 1.48, 30.5);
    shadowed(col); shadowed(bowl); shadowed(top);
    this.group.add(col, bowl, top);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), this.fountainLights);
      l.position.set(13.5 + Math.cos(a) * 1.4, 0.3, 30.5 + Math.sin(a) * 1.4);
      this.group.add(l);
    }
  }

  private sign() {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 256;
    const ctx = c.getContext('2d')!;
    const draw = () => {
      ctx.clearRect(0, 0, 1024, 256);
      ctx.fillStyle = '#1f3b57';
      ctx.fillRect(0, 0, 1024, 256);
      ctx.fillStyle = '#ffd447';
      ctx.font = '700 118px "Baloo 2", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const words = this.opts.name.toUpperCase().split(' ');
      const big = words[0];
      ctx.font = `700 ${big.length > 9 ? 100 : 118}px "Baloo 2", system-ui, sans-serif`;
      ctx.fillText(big, 512, 100);
      ctx.fillStyle = '#9ff0ff';
      ctx.font = '700 60px "Baloo 2", system-ui, sans-serif';
      ctx.fillText(`✚  ${(words.slice(1).join(' ') || 'HOSPITAL')}  ✚`, 512, 196);
      t.needsUpdate = true;
    };
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    draw();
    document.fonts?.ready.then(draw);
    this.signMat = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: '#ffffff', emissiveIntensity: 0.15, roughness: 0.35 });
    const g = new THREE.Group();
    const base = new THREE.Mesh(new RoundedBoxGeometry(4.2, 0.5, 0.7, 3, 0.1), matte('#e7ddcc', 0.7));
    base.position.y = 0.25;
    const panel = new THREE.Mesh(new RoundedBoxGeometry(4.0, 1.05, 0.22, 3, 0.08), plastic('#1f3b57', 0.4, 0.8));
    panel.position.y = 1.05;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 0.95), this.signMat);
    face.position.set(0, 1.05, 0.115);
    g.add(base, panel, face);
    g.position.set(8.4, 0, 31.3);
    g.rotation.y = 0.35;
    shadowed(g);
    this.group.add(g);
  }

  private town() {
    const r = rng(1234);
    const wallCols = ['#ffe3c2', '#ffd1dc', '#d7f0ff', '#e3ffd6', '#fff4b8', '#e8dcff'];
    const roofCols = this.theme === 'snow' ? ['#f4f8fb', '#eaf2f8'] : ['#d9534f', '#5b7db1', '#4f9d69', '#c06c3e', '#7a5c99'];
    const spots: [number, number][] = [];
    for (let i = 0; i < 9; i++) spots.push([-8 + i * 8 + r() * 3, -12 - r() * 6]);
    for (let i = 0; i < 4; i++) spots.push([-16 - r() * 4, 2 + i * 8]);
    for (let i = 0; i < 4; i++) spots.push([62 + r() * 4, 2 + i * 8]);
    for (const [x, z] of spots) {
      const w = 3.5 + r() * 2, d = 3 + r() * 2, h = 2.4 + r() * 2.5;
      if (overlapsHard(x - w, z - d, x + w, z + d)) continue;
      const g = new THREE.Group();
      const body = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, 0.08), plastic(wallCols[(r() * wallCols.length) | 0], 0.7, 0.2));
      body.position.y = h / 2;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, 1.6, 4), plastic(roofCols[(r() * roofCols.length) | 0], 0.5, 0.4));
      roof.position.y = h + 0.8;
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(1, 1, d / w);
      g.add(body, roof);
      for (let k = 0; k < 3; k++) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.7), this.windowMat);
        win.position.set(-w / 2 + 0.9 + k * (w - 1.8) / 2, h * 0.55, d / 2 + 0.01);
        g.add(win);
      }
      g.position.set(x, 0, z);
      g.rotation.y = z > 0 && z < 40 ? (x < 0 ? Math.PI / 2 : -Math.PI / 2) : 0;
      shadowed(g);
      this.group.add(bake(g));
    }
  }

  update(dt: number, time: number, night: number, alarm = false) {
    this.extras?.update(time, night);
    for (const c of this.cars) {
      c.x += c.speed * dt;
      if (c.x > 110) c.x = -70;
      if (c.x < -70) c.x = 110;
      c.obj.position.x = c.x;
      c.obj.position.y = Math.abs(Math.sin(time * 9 + c.x)) * 0.015;
    }
    const phase = Math.floor(time * (alarm ? 8 : 3)) % 2;
    const peak = alarm ? 16 : 9;
    this.amb.red.emissiveIntensity = phase ? peak : 0.4;
    this.amb.blue.emissiveIntensity = phase ? 0.4 : peak;
    this.lampMat.emissiveIntensity = night * 9;
    this.poolMat.opacity = night * 0.55;
    this.windowMat.emissiveIntensity = night * 3.5;
    this.fountainLights.emissiveIntensity = 0.5 + night * 6;
    this.signMat.emissiveIntensity = 0.15 + night * 1.6;
    this.waterMat.normalMap!.offset.set(time * 0.03, time * 0.05);
    fx.uTime.value = time;
    fx.uNight.value = night;
  }
}
