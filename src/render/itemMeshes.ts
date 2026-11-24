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
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ItemType } from '../sim/catalog';
import { glass, glow, matte, metal, plastic, wood } from './materials';
import { fx } from './shaderfx';

export interface AnimState {
  active: boolean;
  night: number;
  /** 0..1 activity blend, eased by the view */
  level: number;
}

export type Animate = (t: number, dt: number, s: AnimState) => void;

export interface Emitter {
  kind: 'steam' | 'spark' | 'bubble' | 'drip' | 'smoke';
  at: THREE.Vector3;
  rate: number;
  whenActive: boolean;
}

// ---------- tiny builders ----------

type Mat = THREE.Material;
function rbox(w: number, h: number, d: number, r: number, m: Mat, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2) * 0.999), m);
  mesh.position.set(x, y, z);
  return mesh;
}
function box(w: number, h: number, d: number, m: Mat, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
}
function cyl(rt: number, rb: number, h: number, m: Mat, x = 0, y = 0, z = 0, seg = 20) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y, z);
  return mesh;
}
function sph(r: number, m: Mat, x = 0, y = 0, z = 0, seg = 18) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg * 0.6)), m);
  mesh.position.set(x, y, z);
  return mesh;
}

/** Merge all static meshes under root by material; animated parts listed in `keep` stay live. */
export function bake(root: THREE.Group, keep: THREE.Object3D[] = []): THREE.Group {
  const keepSet = new Set<THREE.Object3D>();
  for (const k of keep) k.traverse((o) => keepSet.add(o));
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const remove: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || keepSet.has(m) || Array.isArray(m.material)) return;
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g = g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const mat = m.material as THREE.Material;
    let arr = byMat.get(mat);
    if (!arr) byMat.set(mat, (arr = []));
    arr.push(g);
    remove.push(m);
  });
  for (const m of remove) m.parent?.remove(m);
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = mat.transparent ? false : true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && keepSet.has(m)) { m.castShadow = !(m.material as THREE.Material).transparent; m.receiveShadow = true; }
  });
  return root;
}

// ---------- shared animated textures ----------

class Screens {
  canvas = document.createElement('canvas');
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  heart = document.createElement('canvas');
  hctx: CanvasRenderingContext2D;
  htex: THREE.CanvasTexture;
  private hx = 0;
  private last = 0;
  constructor() {
    this.canvas.width = 128; this.canvas.height = 96;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.heart.width = 128; this.heart.height = 64;
    this.hctx = this.heart.getContext('2d')!;
    this.hctx.fillStyle = '#04140e';
    this.hctx.fillRect(0, 0, 128, 64);
    this.htex = new THREE.CanvasTexture(this.heart);
    this.htex.colorSpace = THREE.SRGBColorSpace;
  }
  update(t: number) {
    if (t - this.last < 1 / 20) return;
    this.last = t;
    const c = this.ctx;
    c.fillStyle = '#0d2747';
    c.fillRect(0, 0, 128, 96);
    c.fillStyle = '#3fd0ff';
    for (let i = 0; i < 6; i++) {
      const w = 30 + ((Math.sin(t * 0.7 + i * 1.7) + 1) * 40);
      c.fillRect(10, 12 + i * 12, w, 6);
    }
    c.strokeStyle = '#7dffb0';
    c.lineWidth = 2;
    c.beginPath();
    for (let x = 0; x < 128; x += 4) c.lineTo(x, 84 + Math.sin(x * 0.12 + t * 4) * 6);
    c.stroke();
    this.tex.needsUpdate = true;
    // ECG sweep
    const h = this.hctx;
    for (let k = 0; k < 3; k++) {
      this.hx = (this.hx + 1) % 128;
      const ph = (t * 1.4 * 128 + this.hx) % 128;
      let y = 34;
      const p = ph % 42;
      if (p > 18 && p < 21) y = 34 - (p - 18) * 9;
      else if (p >= 21 && p < 24) y = 7 + (p - 21) * 14;
      else if (p >= 24 && p < 26) y = 49 - (p - 24) * 7;
      h.fillStyle = '#04140e';
      h.fillRect(this.hx, 0, 6, 64);
      h.fillStyle = '#39ff8f';
      h.fillRect(this.hx, y, 2, 3);
    }
    this.htex.needsUpdate = true;
  }
}
export const screens = new Screens();
const screenMat = () => new THREE.MeshStandardMaterial({ map: screens.tex, emissiveMap: screens.tex, emissive: '#ffffff', emissiveIntensity: 1.6, roughness: 0.25 });
const heartMat = () => new THREE.MeshStandardMaterial({ map: screens.htex, emissiveMap: screens.htex, emissive: '#ffffff', emissiveIntensity: 2.2, roughness: 0.25 });

/** Lamp shades glow with the night; one shared material driven by the view. */
export const lampShadeMat = glow('#ffcf8a', 0.4).clone();

// ---------- colours ----------
const C = {
  white: plastic('#f7f7f4', 0.35, 0.8),
  cream: plastic('#fff4e0', 0.4, 0.6),
  teal: plastic('#2fb8a6', 0.3, 0.9),
  coral: plastic('#ff6b6b', 0.3, 0.9),
  sun: plastic('#ffc845', 0.3, 0.9),
  navy: plastic('#26415f', 0.35, 0.8),
  grey: plastic('#b8c2cf', 0.4, 0.5),
  dark: plastic('#2c3440', 0.4, 0.6),
  chrome: metal('#e3e8ee', 0.18),
  steel: metal('#aab4c0', 0.35),
  gold: metal('#ffcf5a', 0.2),
  black: matte('#1d2128', 0.5),
  terracotta: plastic('#d9774c', 0.5, 0.4),
  leaf: plastic('#3fae4f', 0.45, 0.6),
  leafDark: plastic('#2c8a3e', 0.45, 0.6),
  cushion: plastic('#ff8a5c', 0.6, 0.3),
  lilac: plastic('#9a6cf0', 0.3, 0.9),
  yellowHaz: plastic('#ffd23f', 0.4, 0.6),
};

function chair(color: THREE.Material, x: number, z: number, face: number) {
  const g = new THREE.Group();
  g.add(cyl(0.04, 0.04, 0.36, C.chrome, 0, 0.18, 0, 8));
  g.add(cyl(0.22, 0.22, 0.03, C.dark, 0, 0.02, 0, 16));
  g.add(rbox(0.46, 0.1, 0.44, 0.04, color, 0, 0.42, 0));
  g.add(rbox(0.44, 0.46, 0.08, 0.04, color, 0, 0.7, -0.2));
  g.position.set(x, 0, z);
  g.rotation.y = face;
  return g;
}

function potion(color: string, x: number, y: number, z: number, s = 1) {
  const g = new THREE.Group();
  g.add(sph(0.07 * s, glass('#ffffff', 0.35), 0, 0.07 * s, 0, 12));
  g.add(sph(0.058 * s, glow(color, 2.2), 0, 0.065 * s, 0, 10));
  g.add(cyl(0.022 * s, 0.022 * s, 0.07 * s, glass('#ffffff', 0.35), 0, 0.16 * s, 0, 8));
  g.add(cyl(0.026 * s, 0.026 * s, 0.025 * s, C.terracotta, 0, 0.2 * s, 0, 8));
  g.position.set(x, y, z);
  return g;
}

// ---------- items ----------

type Built = { root: THREE.Group; animate?: Animate; emitters?: Emitter[] };

function reception(): Built {
  const g = new THREE.Group();
  // desk: front half of a 3x2 footprint (local z 0..1)
  g.add(rbox(2.9, 1.0, 0.75, 0.12, C.white, 0, 0.5, 0.48));
  g.add(rbox(2.96, 0.08, 0.92, 0.04, wood('#e2b27a'), 0, 1.04, 0.42));
  g.add(rbox(2.7, 0.5, 0.04, 0.02, C.teal, 0, 0.55, 0.87));
  const strip = box(2.6, 0.05, 0.02, glow('#5ff5e0', 3), 0, 0.85, 0.9);
  g.add(strip);
  // inner low shelf
  g.add(rbox(2.6, 0.7, 0.3, 0.05, C.cream, 0, 0.35, 0.1));
  // monitor
  g.add(cyl(0.03, 0.06, 0.22, C.dark, -0.6, 1.18, 0.3, 10));
  g.add(rbox(0.56, 0.36, 0.05, 0.03, C.dark, -0.6, 1.42, 0.3));
  const scr = box(0.5, 0.3, 0.01, screenMat(), -0.6, 1.42, 0.27);
  scr.rotation.y = Math.PI;
  g.add(scr);
  // bell + plant
  g.add(cyl(0.05, 0.11, 0.08, C.gold, 0.55, 1.12, 0.62, 16));
  g.add(sph(0.025, C.gold, 0.55, 1.18, 0.62, 8));
  g.add(cyl(0.12, 0.09, 0.2, C.terracotta, 1.2, 1.18, 0.4, 14));
  for (let i = 0; i < 6; i++) {
    const l = sph(0.12, i % 2 ? C.leaf : C.leafDark, 1.2 + Math.cos(i) * 0.08, 1.38 + (i % 3) * 0.05, 0.4 + Math.sin(i) * 0.08, 10);
    l.scale.set(0.6, 1.4, 0.6);
    l.rotation.z = Math.cos(i * 2) * 0.6;
    g.add(l);
  }
  g.add(chair(C.teal, 0, -0.45, Math.PI));
  // floating rotating cross
  const cross = new THREE.Group();
  const cm = glow('#4ff0d0', 3.5);
  cross.add(rbox(0.5, 0.16, 0.12, 0.05, cm), rbox(0.16, 0.5, 0.12, 0.05, cm));
  cross.position.set(0, 2.35, 0.2);
  g.add(cross);
  bake(g, [cross, scr]);
  return {
    root: g,
    animate: (t) => {
      cross.rotation.y = t * 1.2;
      cross.position.y = 2.35 + Math.sin(t * 2) * 0.08;
    },
  };
}

function bench(): Built {
  const g = new THREE.Group();
  for (const x of [-0.85, 0.85]) {
    g.add(box(0.06, 0.38, 0.5, C.steel, x, 0.19, -0.05));
  }
  g.add(rbox(1.9, 0.1, 0.55, 0.05, C.cushion, 0, 0.42, -0.05));
  g.add(rbox(1.9, 0.48, 0.1, 0.05, C.cushion, 0, 0.72, -0.34));
  g.add(box(1.8, 0.04, 0.04, C.steel, 0, 0.36, 0.18));
  return { root: bake(g) };
}

function vending(): Built {
  const g = new THREE.Group();
  g.add(rbox(0.86, 1.95, 0.78, 0.08, C.coral, 0, 0.975, -0.02));
  const panel = rbox(0.6, 1.2, 0.05, 0.03, glow('#ffe7b0', 1.4).clone(), -0.08, 1.15, 0.37);
  g.add(panel);
  const cols = ['#3ec1d3', '#ffd447', '#7b61ff', '#2ec4b6', '#ff6fa8'];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    g.add(cyl(0.045, 0.045, 0.14, plastic(cols[(r + c) % cols.length], 0.25, 1), -0.3 + c * 0.14, 0.72 + r * 0.26, 0.42, 10));
  }
  g.add(rbox(0.6, 1.24, 0.03, 0.02, glass('#ffffff', 0.18), -0.08, 1.15, 0.47));
  g.add(rbox(0.14, 0.5, 0.05, 0.02, C.dark, 0.32, 1.2, 0.39));
  const btns: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const b = sph(0.025, glow(['#ff4060', '#40ff9a', '#40c8ff', '#ffd447'][i], 3).clone(), 0.32, 1.38 - i * 0.1, 0.42, 8);
    g.add(b);
    btns.push(b);
  }
  g.add(rbox(0.6, 0.18, 0.05, 0.03, C.dark, -0.08, 0.3, 0.37));
  const logo = rbox(0.6, 0.16, 0.03, 0.03, glow('#ffffff', 2.5), -0.08, 1.86, 0.37);
  g.add(logo);
  bake(g, [panel, ...btns]);
  const pm = panel.material as THREE.MeshStandardMaterial;
  return {
    root: g,
    animate: (t, _dt, s) => {
      pm.emissiveIntensity = 1.2 + Math.sin(t * 3) * 0.15 + s.night * 0.8 + s.level * 1.2;
      btns.forEach((b, i) => {
        (b.material as THREE.MeshStandardMaterial).emissiveIntensity = Math.sin(t * 4 + i * 1.3) > 0.2 ? 3.5 : 0.4;
      });
    },
  };
}

function cooler(): Built {
  const g = new THREE.Group();
  g.add(rbox(0.5, 0.95, 0.45, 0.06, C.white, 0, 0.475, 0));
  g.add(box(0.12, 0.06, 0.04, C.coral, -0.08, 0.72, 0.24));
  g.add(box(0.12, 0.06, 0.04, C.teal, 0.08, 0.72, 0.24));
  const bottle = cyl(0.19, 0.19, 0.5, glass('#7fd8ff', 0.55), 0, 1.22, 0, 24);
  g.add(bottle);
  g.add(cyl(0.17, 0.17, 0.4, plastic('#4fc3f7', 0.05, 1), 0, 1.18, 0, 20));
  const bub: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const b = sph(0.025, glass('#ffffff', 0.7), 0, 1.0, 0, 8);
    g.add(b);
    bub.push(b);
  }
  bake(g, [...bub, bottle]);
  return {
    root: g,
    animate: (t, _dt, s) => {
      bub.forEach((b, i) => {
        const p = (t * (0.4 + s.level * 1.5) + i * 0.2) % 1;
        b.position.set(Math.sin(i * 7 + t) * 0.08, 1.0 + p * 0.4, Math.cos(i * 3) * 0.08);
        b.visible = s.level > 0.05 || i < 2;
      });
    },
  };
}

function plant(): Built {
  const g = new THREE.Group();
  g.add(cyl(0.26, 0.19, 0.42, C.terracotta, 0, 0.21, 0, 20));
  g.add(cyl(0.28, 0.28, 0.06, C.terracotta, 0, 0.42, 0, 20));
  g.add(cyl(0.24, 0.24, 0.02, matte('#4a3020'), 0, 0.44, 0, 16));
  const fronds = new THREE.Group();
  fronds.position.y = 0.45;
  const leafGeo = new THREE.SphereGeometry(1, 12, 8);
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2;
    const len = 0.45 + (i % 3) * 0.12;
    const l = new THREE.Mesh(leafGeo, i % 2 ? C.leaf : C.leafDark);
    l.scale.set(0.07, 0.025, len / 2);
    const holder = new THREE.Group();
    holder.rotation.y = a;
    l.position.set(0, len * 0.35, len * 0.42);
    l.rotation.x = -0.75 + (i % 3) * 0.2;
    holder.add(l);
    fronds.add(holder);
  }
  const tall = new THREE.Mesh(leafGeo, C.leaf);
  tall.scale.set(0.07, 0.4, 0.07);
  tall.position.y = 0.35;
  fronds.add(tall);
  g.add(fronds);
  bake(g, [fronds]);
  return { root: g, animate: (t) => { fronds.rotation.z = Math.sin(t * 1.3) * 0.04; fronds.rotation.x = Math.sin(t * 1.1 + 1) * 0.03; } };
}

function radiator(): Built {
  const g = new THREE.Group();
  for (let i = 0; i < 8; i++) g.add(rbox(0.08, 0.6, 0.18, 0.035, C.white, -0.32 + i * 0.09, 0.42, -0.3));
  g.add(box(0.74, 0.04, 0.04, C.white, 0, 0.14, -0.3));
  g.add(box(0.74, 0.04, 0.04, C.white, 0, 0.7, -0.3));
  const dial = cyl(0.04, 0.04, 0.05, glow('#ff7a3d', 2.5), 0.38, 0.62, -0.3, 10);
  dial.rotation.z = Math.PI / 2;
  g.add(dial);
  return { root: bake(g), emitters: [{ kind: 'steam', at: new THREE.Vector3(0, 0.8, -0.3), rate: 0.6, whenActive: false }] };
}

function bin(): Built {
  const g = new THREE.Group();
  g.add(cyl(0.2, 0.17, 0.55, C.teal, 0, 0.275, 0, 18));
  g.add(cyl(0.22, 0.22, 0.06, C.white, 0, 0.58, 0, 18));
  g.add(rbox(0.12, 0.04, 0.04, 0.02, C.white, 0, 0.63, 0));
  return { root: bake(g) };
}

function lamp(): Built {
  const g = new THREE.Group();
  g.add(cyl(0.2, 0.22, 0.05, C.dark, 0, 0.025, 0, 18));
  g.add(cyl(0.025, 0.025, 1.45, C.gold, 0, 0.75, 0, 8));
  const shade = cyl(0.17, 0.27, 0.32, lampShadeMat, 0, 1.55, 0, 20);
  g.add(shade);
  g.add(sph(0.06, glow('#fff3d0', 4), 0, 1.45, 0, 10));
  return { root: bake(g) };
}

function cabinet(): Built {
  const g = new THREE.Group();
  g.add(rbox(0.6, 1.25, 0.55, 0.04, plastic('#8fa8c8', 0.4, 0.6), 0, 0.625, -0.15));
  for (let i = 0; i < 4; i++) {
    g.add(box(0.5, 0.005, 0.01, C.dark, 0, 0.3 + i * 0.29, 0.13));
    g.add(rbox(0.16, 0.035, 0.04, 0.015, C.chrome, 0, 0.2 + i * 0.29, 0.15));
  }
  return { root: bake(g) };
}

function gpDesk(): Built {
  const g = new THREE.Group();
  // desk on the middle row (local z -0.5..0.5) spanning 2 tiles
  g.add(rbox(1.9, 0.07, 0.86, 0.03, wood('#c98a52'), 0, 0.76, 0));
  g.add(rbox(0.5, 0.72, 0.8, 0.04, C.cream, 0.66, 0.37, 0));
  for (let i = 0; i < 3; i++) g.add(rbox(0.3, 0.02, 0.02, 0.01, C.gold, 0.66, 0.2 + i * 0.22, 0.41));
  g.add(box(0.06, 0.72, 0.7, C.chrome, -0.88, 0.37, 0));
  // monitor faces the doctor (−z)
  g.add(cyl(0.03, 0.07, 0.2, C.dark, -0.2, 0.88, 0.15, 10));
  g.add(rbox(0.6, 0.38, 0.05, 0.03, C.dark, -0.2, 1.12, 0.15));
  const scr = box(0.54, 0.32, 0.01, screenMat(), -0.2, 1.12, 0.12);
  scr.rotation.y = Math.PI;
  g.add(scr);
  // desk lamp, mug, papers, stethoscope tray
  g.add(cyl(0.08, 0.09, 0.03, C.coral, 0.6, 0.81, -0.25, 14));
  const arm = cyl(0.015, 0.015, 0.35, C.coral, 0.6, 0.97, -0.25, 6);
  arm.rotation.z = 0.3;
  g.add(arm);
  g.add(cyl(0.07, 0.04, 0.1, glow('#fff1c0', 2), 0.52, 1.14, -0.2, 12));
  g.add(cyl(0.045, 0.04, 0.1, C.sun, 0.25, 0.85, -0.25, 12));
  g.add(box(0.3, 0.01, 0.22, matte('#ffffff', 0.9), 0.15, 0.8, 0.22));
  g.add(box(0.28, 0.01, 0.2, matte('#e6f2ff', 0.9), 0.17, 0.81, 0.2));
  g.add(chair(C.navy, -0.5, -1.0, 0));
  g.add(chair(C.cushion, -0.5, 1.0, Math.PI));
  // big anatomical poster stand
  bake(g, [scr]);
  return { root: g };
}

function pharmacyCounter(): Built {
  const g = new THREE.Group();
  // counter on the front row (z 0..1)
  g.add(rbox(1.9, 0.95, 0.7, 0.08, C.white, 0, 0.475, 0.5));
  g.add(rbox(1.96, 0.06, 0.82, 0.03, C.teal, 0, 0.98, 0.45));
  g.add(rbox(1.7, 0.55, 0.04, 0.02, glass('#bff7ea', 0.3), 0, 0.5, 0.86));
  const cols = ['#ff4fa3', '#4ff0d0', '#ffd447', '#9a6cff', '#ff8a3d', '#5fc8ff'];
  const pots: THREE.Group[] = [];
  for (let i = 0; i < 6; i++) {
    const p = potion(cols[i], -0.7 + i * 0.28, 0.28, 0.65, 1.2);
    g.add(p);
    pots.push(p);
  }
  // hero flask on top
  const hero = new THREE.Group();
  hero.add(sph(0.16, glass('#ffffff', 0.3), 0, 0, 0, 20));
  const liquid = sph(0.13, glow('#ff4fd8', 3).clone(), 0, -0.01, 0, 16);
  hero.add(liquid);
  hero.add(cyl(0.05, 0.05, 0.16, glass('#ffffff', 0.3), 0, 0.2, 0, 10));
  hero.position.set(0.55, 1.2, 0.45);
  g.add(hero);
  // slim shelf along the back edge
  g.add(rbox(1.9, 1.6, 0.14, 0.03, C.cream, 0, 0.8, -0.92));
  for (let r = 0; r < 3; r++) {
    g.add(box(1.8, 0.03, 0.18, C.teal, 0, 0.5 + r * 0.45, -0.86));
    for (let i = 0; i < 6; i++) g.add(cyl(0.05, 0.05, 0.16, plastic(cols[(i + r) % 6], 0.2, 1), -0.75 + i * 0.3, 0.6 + r * 0.45, -0.84, 10));
  }
  bake(g, [hero]);
  const lm = liquid.material as THREE.MeshStandardMaterial;
  return {
    root: g,
    animate: (t, _dt, s) => {
      hero.position.y = 1.2 + Math.sin(t * 2.2) * 0.04 + s.level * 0.15;
      hero.rotation.y = t * 0.8;
      lm.emissiveIntensity = 2.5 + Math.sin(t * 5) * 0.8 + s.level * 3;
      lm.emissive.setHSL((t * 0.15) % 1, 0.9, 0.6);
    },
    emitters: [{ kind: 'bubble', at: new THREE.Vector3(0.55, 1.4, 0.45), rate: 3, whenActive: true }],
  };
}

function scanner(): Built {
  const g = new THREE.Group();
  // bed along x on the back row (z -1..0); patient lies at local (0, -0.5)
  g.add(rbox(2.7, 0.5, 0.75, 0.1, C.white, 0, 0.25, -0.5));
  g.add(rbox(2.5, 0.12, 0.62, 0.06, plastic('#5aa9e6', 0.5, 0.4), 0, 0.56, -0.5));
  g.add(rbox(0.4, 0.1, 0.45, 0.05, C.white, -1.05, 0.66, -0.5));
  const ring = new THREE.Group();
  const torus = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.2, 20, 48), C.white);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.035, 10, 48), glow('#3fb6ff', 4).clone());
  const lights: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const l = sph(0.035, glow('#7dffef', 4), Math.cos(a) * 0.78, Math.sin(a) * 0.78, 0.2, 8);
    ring.add(l);
    lights.push(l);
  }
  ring.add(torus, inner);
  ring.rotation.y = Math.PI / 2;
  ring.position.set(0.2, 0.85, -0.5);
  g.add(ring);
  g.add(rbox(0.5, 0.35, 0.95, 0.08, C.white, 0.2, 0.18, -0.5));
  const beam = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 1.1), new THREE.MeshBasicMaterial({ color: '#4fe3ff', transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  beam.rotation.y = Math.PI / 2;
  beam.position.set(0, 0.85, -0.5);
  beam.scale.set(1, 1, 1);
  g.add(beam);
  const fan = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0), new THREE.MeshBasicMaterial({ color: '#2ad0ff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  fan.rotation.y = Math.PI / 2;
  g.add(fan);
  bake(g, [ring, beam, fan]);
  const im = inner.material as THREE.MeshStandardMaterial;
  return {
    root: g,
    animate: (t, _dt, s) => {
      const sweep = Math.sin(t * 1.6) * 0.9;
      ring.position.x = 0.2 + sweep * s.level;
      inner.rotation.z = t * (1 + s.level * 8);
      im.emissiveIntensity = 2 + s.level * 5 + Math.sin(t * 10) * s.level;
      lights.forEach((l, i) => { l.visible = s.level < 0.1 || Math.sin(t * 12 + i) > -0.3; });
      fan.position.set(ring.position.x, 0.85, -0.5);
      (fan.material as THREE.MeshBasicMaterial).opacity = 0.18 * s.level;
      beam.position.x = ring.position.x;
      (beam.material as THREE.MeshBasicMaterial).opacity = 0.9 * s.level;
    },
  };
}

function controlPanel(): Built {
  const g = new THREE.Group();
  g.add(rbox(0.8, 0.85, 0.55, 0.06, C.grey, 0, 0.425, -0.1));
  const top = rbox(0.82, 0.08, 0.5, 0.03, C.dark, 0, 0.92, 0.0);
  top.rotation.x = -0.45;
  g.add(top);
  const btns: THREE.Mesh[] = [];
  const cols = ['#ff4060', '#40ff9a', '#40c8ff', '#ffd447', '#c77dff'];
  for (let i = 0; i < 10; i++) {
    const b = sph(0.03, glow(cols[i % cols.length], 3).clone(), -0.3 + (i % 5) * 0.15, 0.97 - Math.floor(i / 5) * 0.08, 0.02 + Math.floor(i / 5) * 0.16, 8);
    g.add(b);
    btns.push(b);
  }
  g.add(rbox(0.7, 0.45, 0.05, 0.03, C.dark, 0, 1.3, -0.3));
  g.add(box(0.64, 0.38, 0.01, screenMat(), 0, 1.3, -0.27));
  const lever = new THREE.Group();
  lever.add(cyl(0.015, 0.015, 0.2, C.chrome, 0, 0.1, 0, 6), sph(0.04, C.coral, 0, 0.2, 0, 10));
  lever.position.set(0.33, 0.96, 0.08);
  g.add(lever);
  bake(g, [...btns, lever]);
  return {
    root: g,
    animate: (t, _dt, s) => {
      btns.forEach((b, i) => {
        const on = Math.sin(t * (2 + s.level * 6) + i * 2.1) > 0.1;
        (b.material as THREE.MeshStandardMaterial).emissiveIntensity = on ? 3 + s.level * 2 : 0.3;
      });
      lever.rotation.x = -0.4 + s.level * 0.9;
    },
  };
}

function bed(): Built {
  const g = new THREE.Group();
  // head at local z -1, foot at +1
  g.add(rbox(0.86, 0.2, 1.9, 0.06, C.chrome, 0, 0.42, 0));
  for (const x of [-0.38, 0.38]) for (const z of [-0.85, 0.85]) g.add(cyl(0.025, 0.025, 0.42, C.chrome, x, 0.21, z, 8));
  g.add(rbox(0.8, 0.16, 1.8, 0.07, C.white, 0, 0.58, 0));
  g.add(rbox(0.6, 0.12, 0.32, 0.06, matte('#ffffff', 0.9), 0, 0.71, -0.68));
  g.add(rbox(0.84, 0.08, 1.15, 0.04, plastic('#5aa9e6', 0.7, 0.2), 0, 0.68, 0.32));
  g.add(rbox(0.9, 0.6, 0.06, 0.03, C.white, 0, 0.75, -0.96));
  g.add(rbox(0.9, 0.35, 0.05, 0.03, C.white, 0, 0.6, 0.96));
  // IV stand and heart monitor on the right side
  g.add(cyl(0.012, 0.012, 1.7, C.chrome, 0.52, 0.85, -0.7, 6));
  g.add(cyl(0.12, 0.12, 0.02, C.chrome, 0.52, 0.02, -0.7, 12));
  const bag = rbox(0.14, 0.22, 0.05, 0.03, glass('#b8f0ff', 0.6), 0.52, 1.55, -0.7);
  g.add(bag);
  g.add(cyl(0.012, 0.012, 0.6, C.chrome, -0.52, 0.3, -0.85, 6));
  g.add(rbox(0.36, 0.26, 0.08, 0.03, C.dark, -0.52, 0.75, -0.85));
  const mon = box(0.31, 0.2, 0.01, heartMat(), -0.52, 0.75, -0.80);
  g.add(mon);
  bake(g, [mon]);
  return { root: g, emitters: [{ kind: 'drip', at: new THREE.Vector3(0.52, 1.42, -0.7), rate: 1.2, whenActive: true }] };
}

function nurseStation(): Built {
  const g = new THREE.Group();
  g.add(rbox(0.9, 0.95, 0.6, 0.06, C.white, 0, 0.475, -0.15));
  g.add(rbox(0.94, 0.06, 0.7, 0.03, C.teal, 0, 0.98, -0.12));
  g.add(rbox(0.3, 0.02, 0.4, 0.01, matte('#ffffff', 0.9), -0.15, 1.02, 0));
  g.add(cyl(0.05, 0.045, 0.1, C.coral, 0.28, 1.06, 0.05, 12));
  g.add(rbox(0.5, 0.32, 0.05, 0.03, C.dark, 0.05, 1.3, -0.3));
  g.add(box(0.44, 0.26, 0.01, heartMat(), 0.05, 1.3, -0.27));
  return { root: bake(g) };
}

function ballastBooth(): Built {
  const g = new THREE.Group();
  g.add(cyl(0.95, 1.0, 0.18, C.steel, 0, 0.09, 0, 36));
  g.add(cyl(0.82, 0.82, 0.04, glow('#b37dff', 2.5).clone(), 0, 0.19, 0, 36));
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.78, 1.9, 40, 1, true), glass('#e6d6ff', 0.2));
  tube.position.y = 1.15;
  g.add(tube);
  g.add(cyl(0.9, 0.95, 0.22, C.steel, 0, 2.18, 0, 36));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.75, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), C.lilac);
  dome.position.y = 2.28;
  g.add(dome);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    g.add(cyl(0.06, 0.06, 2.0, C.chrome, Math.cos(a) * 0.86, 1.1, Math.sin(a) * 0.86, 10));
  }
  // gauge
  g.add(cyl(0.18, 0.18, 0.06, C.white, 0, 2.55, 0.0, 24));
  const needle = box(0.015, 0.14, 0.01, C.coral, 0, 2.55, 0.04);
  const gauge = new THREE.Group();
  gauge.position.set(0, 2.62, 0.55);
  gauge.rotation.x = -0.6;
  g.add(gauge);
  gauge.add(cyl(0.17, 0.17, 0.05, C.white, 0, 0, 0, 24).rotateX(Math.PI / 2));
  needle.position.set(0, 0.05, 0.03);
  const needleHolder = new THREE.Group();
  needleHolder.position.set(0, 0, 0.03);
  needleHolder.add(needle);
  gauge.add(needleHolder);
  // descending weights
  const weights = new THREE.Group();
  const wm = glow('#c58bff', 1.5).clone();
  for (let i = 0; i < 3; i++) weights.add(cyl(0.3 - i * 0.05, 0.3 - i * 0.05, 0.12, wm, 0, -i * 0.14, 0, 24));
  weights.position.y = 2.0;
  g.add(weights);
  const glowFloor = g.children[1] as THREE.Mesh;
  bake(g, [tube, weights, gauge, glowFloor]);
  return {
    root: g,
    animate: (t, _dt, s) => {
      weights.position.y = 2.0 - s.level * (0.4 + Math.abs(Math.sin(t * 3)) * 0.35);
      wm.emissiveIntensity = 1.5 + s.level * 5;
      needleHolder.rotation.z = -1.2 + s.level * (2.0 + Math.sin(t * 17) * 0.15);
      (glowFloor.material as THREE.MeshStandardMaterial).emissiveIntensity = 2 + s.level * 6 + Math.sin(t * 6) * 0.5;
    },
  };
}

/** Jagged lightning bolts between points, rebuilt every few frames. */
class Bolts {
  readonly mesh: THREE.LineSegments;
  private pos: Float32Array;
  constructor(private n: number, color: string) {
    this.pos = new Float32Array(n * 12 * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(color).multiplyScalar(6), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.mesh.frustumCulled = false;
  }
  regen(from: THREE.Vector3, targets: THREE.Vector3[], jag: number) {
    let k = 0;
    for (let b = 0; b < this.n; b++) {
      const to = targets[b % targets.length];
      let prev = from.clone();
      for (let i = 1; i <= 12; i++) {
        const t = i / 12;
        const p = from.clone().lerp(to, t);
        if (i < 12) p.add(new THREE.Vector3((Math.random() - 0.5) * jag, (Math.random() - 0.5) * jag, (Math.random() - 0.5) * jag));
        this.pos.set([prev.x, prev.y, prev.z, p.x, p.y, p.z], k);
        k += 6;
        prev = p;
      }
    }
    (this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}

function teslaCoil(): Built {
  const g = new THREE.Group();
  g.add(rbox(1.7, 0.4, 1.7, 0.1, C.dark, 0, 0.2, 0));
  for (let i = 0; i < 6; i++) {
    const s = box(0.25, 0.41, 1.72, i % 2 ? C.black : C.yellowHaz, -0.75 + i * 0.3, 0.2, 0);
    g.add(s);
  }
  g.add(cyl(0.22, 0.3, 1.6, C.white, 0, 1.2, 0, 24));
  for (let i = 0; i < 12; i++) g.add(new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.025, 8, 24), metal('#d48a3a', 0.25)).translateY(0.5 + i * 0.12).rotateX(Math.PI / 2));
  const top = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.18, 20, 40), C.chrome);
  top.rotation.x = Math.PI / 2;
  top.position.y = 2.15;
  g.add(top);
  const core = sph(0.16, glow('#b9e8ff', 6).clone(), 0, 2.15, 0, 16);
  g.add(core);
  const bolts = new Bolts(4, '#9fd8ff');
  g.add(bolts.mesh);
  bake(g, [core, bolts.mesh]);
  const cm = core.material as THREE.MeshStandardMaterial;
  let acc = 0;
  const from = new THREE.Vector3(0, 2.15, 0);
  return {
    root: g,
    animate: (t, dt, s) => {
      acc += dt;
      const rate = s.level > 0.1 ? 0.05 : 0.25;
      if (acc > rate) {
        acc = 0;
        const n = s.level > 0.1 ? 5 : 2;
        const targets: THREE.Vector3[] = [];
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = s.level > 0.1 ? 1.3 + Math.random() * 0.8 : 0.55 + Math.random() * 0.4;
          targets.push(new THREE.Vector3(Math.cos(a) * r, s.level > 0.1 ? 0.2 + Math.random() * 1.6 : 1.6 + Math.random() * 0.8, Math.sin(a) * r + (s.level > 0.1 ? 0.8 : 0)));
        }
        bolts.regen(from, targets, s.level > 0.1 ? 0.35 : 0.18);
        bolts.mesh.visible = s.level > 0.1 || Math.random() < 0.6;
      }
      cm.emissiveIntensity = 4 + Math.random() * (2 + s.level * 10);
    },
    emitters: [{ kind: 'spark', at: new THREE.Vector3(0, 2.15, 0), rate: 6, whenActive: true }],
  };
}

function groundPad(): Built {
  const g = new THREE.Group();
  g.add(rbox(0.96, 0.05, 0.96, 0.02, C.black, 0, 0.025, 0));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.025, 8, 36), glow('#ffd23f', 1).clone());
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.06;
  g.add(ring);
  for (let i = 0; i < 4; i++) g.add(box(0.9, 0.052, 0.06, C.yellowHaz, 0, 0.026, -0.45 + i * 0.3).rotateY(i % 2 ? 0 : 0));
  bake(g, [ring]);
  const rm = ring.material as THREE.MeshStandardMaterial;
  return { root: g, animate: (t, _dt, s) => { rm.emissiveIntensity = 0.8 + s.level * (4 + Math.sin(t * 20) * 2); } };
}

function saunaStove(): Built {
  const g = new THREE.Group();
  g.add(rbox(0.75, 0.75, 0.6, 0.06, metal('#3a3f48', 0.5), 0, 0.375, -0.1));
  g.add(box(0.8, 0.1, 0.65, wood('#b07a48'), 0, 0.8, -0.1));
  const coalMat = glow('#ff6a1a', 3).clone();
  const coals = new THREE.Group();
  for (let i = 0; i < 9; i++) {
    const c = sph(0.1, i % 3 ? matte('#4a4a50', 0.9) : coalMat, -0.22 + (i % 3) * 0.22, 0.9, -0.3 + Math.floor(i / 3) * 0.2, 8);
    c.scale.y = 0.6;
    coals.add(c);
  }
  g.add(coals);
  const bucket = new THREE.Group();
  bucket.add(cyl(0.14, 0.11, 0.2, wood('#c98a52'), 0, 0.1, 0, 12), cyl(0.012, 0.012, 0.4, wood('#8a5a2c'), 0.08, 0.3, 0, 6).rotateZ(-0.6));
  bucket.position.set(0.5, 0, 0.2);
  g.add(bucket);
  bake(g, [coals]);
  return {
    root: g,
    animate: (t, _dt, s) => {
      coalMat.emissiveIntensity = 2.5 + Math.sin(t * 3) * 0.6 + Math.sin(t * 7.3) * 0.3 + s.level * 3;
    },
    emitters: [{ kind: 'steam', at: new THREE.Vector3(0, 1.0, -0.1), rate: 4, whenActive: false }],
  };
}

function saunaBench(): Built {
  const g = new THREE.Group();
  const w = wood('#d9a66a');
  for (let i = 0; i < 4; i++) g.add(rbox(1.9, 0.05, 0.12, 0.02, w, 0, 0.45, -0.3 + i * 0.15));
  for (let i = 0; i < 3; i++) g.add(rbox(1.9, 0.12, 0.05, 0.02, w, 0, 0.62 + i * 0.16, -0.43));
  for (const x of [-0.85, 0, 0.85]) g.add(box(0.08, 0.45, 0.5, w, x, 0.22, -0.15));
  return { root: bake(g) };
}


function sofa(): Built {
  const g = new THREE.Group();
  const fab = plastic('#ff8a5c', 0.75, 0.15);
  g.add(rbox(1.92, 0.3, 0.7, 0.12, fab, 0, 0.32, -0.02));
  g.add(rbox(1.92, 0.55, 0.22, 0.1, fab, 0, 0.6, -0.36));
  for (const x of [-0.9, 0.9]) g.add(rbox(0.18, 0.45, 0.72, 0.08, fab, x, 0.45, -0.02));
  for (const x of [-0.45, 0.45]) g.add(rbox(0.86, 0.12, 0.6, 0.06, plastic('#ffb08a', 0.8, 0.1), x, 0.5, 0.02));
  for (const x of [-0.85, 0.85]) for (const z of [-0.3, 0.25]) g.add(cyl(0.03, 0.03, 0.17, C.dark, x, 0.085, z, 8));
  g.add(rbox(0.3, 0.3, 0.12, 0.06, plastic('#7b61ff', 0.6, 0.2), -0.6, 0.72, -0.2).rotateZ(0.2));
  return { root: bake(g) };
}

function coffeeMachine(): Built {
  const g = new THREE.Group();
  g.add(rbox(0.7, 0.9, 0.55, 0.05, wood('#b07a48'), 0, 0.45, -0.15));
  g.add(rbox(0.5, 0.55, 0.4, 0.06, metal('#c7ced8', 0.2), 0, 1.18, -0.18));
  g.add(rbox(0.3, 0.12, 0.08, 0.03, C.dark, 0, 1.3, 0.03));
  const light = sph(0.025, glow('#ff4060', 3).clone(), 0.17, 1.35, 0.03, 8);
  g.add(light);
  g.add(cyl(0.05, 0.04, 0.09, C.white, 0, 0.95, -0.02, 12));
  for (let i = 0; i < 3; i++) g.add(cyl(0.045, 0.04, 0.09, plastic(['#ffc93c', '#2fb8a6', '#ff5c8a'][i], 0.3, 0.9), -0.22 + i * 0.07, 0.95, 0.1, 10));
  bake(g, [light]);
  return { root: g, emitters: [{ kind: 'steam', at: new THREE.Vector3(0, 1.05, 0), rate: 1.2, whenActive: false }] };
}

function lectern(): Built {
  const g = new THREE.Group();
  g.add(cyl(0.22, 0.26, 0.05, wood('#8a5a2c'), 0, 0.025, 0, 16));
  g.add(rbox(0.35, 1.0, 0.3, 0.04, wood('#c98a52'), 0, 0.55, -0.05));
  const top = rbox(0.6, 0.05, 0.45, 0.02, wood('#8a5a2c'), 0, 1.1, 0);
  top.rotation.x = 0.35;
  g.add(top);
  g.add(box(0.36, 0.02, 0.26, matte('#ffffff', 0.9), 0, 1.14, 0.02).rotateX(0.35));
  g.add(cyl(0.012, 0.012, 0.25, C.dark, 0.18, 1.25, -0.1, 6).rotateX(-0.5));
  g.add(sph(0.035, C.dark, 0.18, 1.36, -0.16, 8));
  return { root: bake(g) };
}

function studyDesk(): Built {
  const g = new THREE.Group();
  // desk on the back cell (z -1..0), chair on the front cell
  g.add(rbox(0.9, 0.06, 0.7, 0.02, wood('#e2b27a'), 0, 0.72, -0.5));
  for (const x of [-0.4, 0.4]) g.add(box(0.05, 0.7, 0.6, C.steel, x, 0.35, -0.5));
  g.add(box(0.32, 0.05, 0.24, plastic('#4f7cff', 0.5, 0.3), -0.15, 0.78, -0.45));
  g.add(box(0.3, 0.05, 0.22, plastic('#ffc93c', 0.5, 0.3), -0.13, 0.83, -0.47));
  g.add(cyl(0.012, 0.012, 0.18, plastic('#ff5c8a', 0.3, 0.8), 0.2, 0.76, -0.4, 6).rotateZ(Math.PI / 2));
  g.add(chair(plastic('#4f7cff', 0.4, 0.6), 0, 0.45, Math.PI));
  return { root: bake(g) };
}

function researchBench(): Built {
  const g = new THREE.Group();
  g.add(rbox(1.9, 0.9, 0.8, 0.06, C.white, 0, 0.45, -0.5));
  g.add(rbox(1.96, 0.06, 0.88, 0.03, plastic('#20c997', 0.3, 0.8), 0, 0.92, -0.5));
  // microscope
  g.add(cyl(0.1, 0.12, 0.04, C.dark, -0.6, 0.97, -0.55, 14));
  g.add(cyl(0.03, 0.03, 0.35, C.dark, -0.6, 1.15, -0.62, 8).rotateX(0.3));
  g.add(cyl(0.045, 0.035, 0.18, C.white, -0.6, 1.33, -0.55, 10).rotateX(-0.4));
  // flasks with glowing liquids
  const glows: THREE.Mesh[] = [];
  [['#ff4fd8', -0.1], ['#4ff0d0', 0.2], ['#ffd447', 0.5]].forEach(([c, x], i) => {
    g.add(sph(0.11, glass('#ffffff', 0.3), x as number, 1.06, -0.55, 16));
    const liq = sph(0.09, glow(c as string, 2.5).clone(), x as number, 1.04, -0.55, 12);
    g.add(liq);
    glows.push(liq);
    g.add(cyl(0.03, 0.03, 0.14, glass('#ffffff', 0.3), x as number, 1.2, -0.55, 8));
    void i;
  });
  // tube rack
  for (let i = 0; i < 5; i++) g.add(cyl(0.02, 0.02, 0.16, glow(['#7dffb0', '#ff8a3d', '#5fc8ff', '#c77dff', '#ffd447'][i], 1.6), 0.72 + (i % 3) * 0.06, 1.03, -0.7 + Math.floor(i / 3) * 0.08, 6));
  g.add(rbox(0.5, 0.36, 0.05, 0.03, C.dark, 0.75, 1.32, -0.85));
  g.add(box(0.44, 0.3, 0.01, screenMat(), 0.75, 1.32, -0.82));
  bake(g, glows);
  return {
    root: g,
    animate: (t, _dt, s) => glows.forEach((m, i) => { (m.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.6 + s.level * (2 + Math.sin(t * 6 + i * 2) * 1.5); }),
    emitters: [{ kind: 'bubble', at: new THREE.Vector3(0.2, 1.3, -0.55), rate: 4, whenActive: true }],
  };
}

function psychCouch(): Built {
  const g = new THREE.Group();
  const leather = plastic('#a0325a', 0.45, 0.6);
  g.add(rbox(1.9, 0.32, 0.72, 0.12, leather, 0, 0.36, 0));
  g.add(rbox(0.5, 0.42, 0.72, 0.16, leather, 0.72, 0.58, 0).rotateZ(-0.35));
  g.add(rbox(0.36, 0.1, 0.5, 0.05, plastic('#ffd6e6', 0.8, 0.1), 0.62, 0.6, 0));
  for (const x of [-0.85, 0.85]) for (const z of [-0.3, 0.3]) g.add(cyl(0.035, 0.025, 0.2, wood('#6b3e1c'), x, 0.1, z, 8));
  return { root: bake(g) };
}

function armchair(): Built {
  const g = new THREE.Group();
  const fab = plastic('#5b4a8a', 0.7, 0.2);
  g.add(rbox(0.82, 0.3, 0.75, 0.12, fab, 0, 0.32, 0.02));
  g.add(rbox(0.82, 0.75, 0.2, 0.1, fab, 0, 0.62, -0.32));
  for (const x of [-0.38, 0.38]) g.add(rbox(0.16, 0.42, 0.72, 0.08, fab, x, 0.52, 0.02));
  g.add(rbox(0.5, 0.1, 0.5, 0.05, plastic('#7d6bb8', 0.8, 0.1), 0, 0.5, 0.06));
  // side table with a notepad and a tissue box
  g.add(cyl(0.16, 0.16, 0.03, wood('#c98a52'), 0.55, 0.62, 0.35, 14));
  g.add(cyl(0.02, 0.02, 0.6, wood('#8a5a2c'), 0.55, 0.31, 0.35, 6));
  g.add(rbox(0.12, 0.08, 0.1, 0.02, C.white, 0.52, 0.68, 0.35));
  return { root: bake(g) };
}

function arcade(): Built {
  const g = new THREE.Group();
  g.add(rbox(0.8, 1.75, 0.7, 0.06, plastic('#3b2a8a', 0.3, 0.9), 0, 0.875, -0.1));
  const scr = rbox(0.6, 0.5, 0.04, 0.03, glow('#2ad0ff', 1.6).clone(), 0, 1.3, 0.26);
  scr.rotation.x = -0.25;
  g.add(scr);
  const marquee = rbox(0.72, 0.18, 0.06, 0.03, glow('#ff4fd8', 3).clone(), 0, 1.68, 0.24);
  g.add(marquee);
  g.add(rbox(0.74, 0.08, 0.3, 0.03, C.dark, 0, 0.98, 0.32));
  const stick = sph(0.04, C.coral, -0.15, 1.08, 0.33, 10);
  g.add(stick, cyl(0.01, 0.01, 0.08, C.dark, -0.15, 1.03, 0.33, 6));
  const btns: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const b = sph(0.03, glow(['#ffd447', '#40ff9a', '#ff4060'][i], 2.5).clone(), 0.05 + i * 0.09, 1.03, 0.34, 8);
    g.add(b);
    btns.push(b);
  }
  bake(g, [scr, marquee, ...btns]);
  const sm = scr.material as THREE.MeshStandardMaterial, mm = marquee.material as THREE.MeshStandardMaterial;
  return {
    root: g,
    animate: (t) => {
      sm.emissive.setHSL((t * 0.2) % 1, 0.8, 0.55);
      sm.emissiveIntensity = 1.4 + Math.sin(t * 9) * 0.4;
      mm.emissiveIntensity = Math.sin(t * 5) > 0 ? 3.5 : 1.5;
      btns.forEach((b, i) => ((b.material as THREE.MeshStandardMaterial).emissiveIntensity = Math.sin(t * 7 + i * 2) > 0.3 ? 3 : 0.4));
    },
  };
}

function duckStatue(): Built {
  const g = new THREE.Group();
  const gold = new THREE.MeshPhysicalMaterial({ color: '#ffc93c', metalness: 1, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05 });
  g.add(rbox(1.6, 0.4, 1.6, 0.12, plastic('#e9e2d6', 0.6, 0.3), 0, 0.2, 0));
  g.add(rbox(1.3, 0.35, 1.3, 0.1, plastic('#f4efe6', 0.5, 0.4), 0, 0.57, 0));
  const duck = new THREE.Group();
  const body = sph(0.48, gold, 0, 0.45, 0, 32);
  body.scale.set(1.15, 0.85, 0.95);
  const head = sph(0.3, gold, 0.36, 0.98, 0, 28);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 16), plastic('#ff8a3d', 0.3, 0.9));
  beak.rotation.z = -Math.PI / 2;
  beak.position.set(0.72, 0.95, 0);
  beak.scale.set(1, 1, 0.6);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.36, 12), gold);
  tail.rotation.z = Math.PI / 2 + 0.6;
  tail.position.set(-0.55, 0.6, 0);
  duck.add(body, head, beak, tail);
  for (const z of [-0.13, 0.13]) duck.add(sph(0.045, C.black, 0.55, 1.05, z, 10));
  duck.position.y = 0.75;
  duck.rotation.y = Math.PI / 4;
  g.add(duck);
  bake(g, [duck]);
  return { root: g, animate: (t) => { duck.rotation.y = Math.PI / 4 + Math.sin(t * 0.6) * 0.25; } };
}

const BUILDERS: Record<ItemType, () => Built> = {
  reception, bench, vending, cooler, plant, radiator, bin, lamp, cabinet,
  gpDesk, pharmacyCounter, scanner, controlPanel, bed, nurseStation,
  ballastBooth, teslaCoil, groundPad, saunaStove, saunaBench,
  sofa, coffeeMachine, lectern, studyDesk, researchBench, psychCouch, armchair, arcade, duckStatue,
};

export function buildItemMesh(type: ItemType): THREE.Group {
  const b = BUILDERS[type]();
  b.root.userData.animate = b.animate;
  b.root.userData.emitters = b.emitters ?? [];
  b.root.userData.type = type;
  return b.root;
}

export function updateSharedItemFx(t: number, night: number) {
  screens.update(t);
  lampShadeMat.emissiveIntensity = 0.5 + night * 4.5;
  void fx;
}
