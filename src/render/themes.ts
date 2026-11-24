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
import type { BuildingRect } from '../sim/grid';
import type { Theme } from '../sim/scenarios';
import { glow, matte, metal, plastic } from './materials';
import { rampTex, tex } from './textures';
import { bake } from './itemMeshes';

export interface ThemeExtras {
  /** chimney tops that puff smoke */
  smokeStacks: THREE.Vector3[];
  update(time: number, night: number): void;
}

type Overlaps = (x0: number, z0: number, x1: number, z1: number) => boolean;

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function shadowed<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  return o;
}

/** Spots around the lot that stay clear of the building, the plaza, the road and the camera's foreground. */
function propSpots(b: BuildingRect, r: () => number, n: number, minGap: number, far = 26): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (let tries = 0; out.length < n && tries < n * 40; tries++) {
    const side = r();
    let x: number, z: number;
    if (side < 0.5) { x = -14 + r() * 76; z = b.z - 6 - r() * far; }
    else if (side < 0.75) { x = b.x - 6 - r() * far * 0.8; z = -10 + r() * 40; }
    else { x = b.x + b.w + 6 + r() * far * 0.8; z = -10 + r() * 40; }
    if (z > 31) continue;
    if (out.some((p) => p.distanceTo(new THREE.Vector2(x, z)) < minGap)) continue;
    out.push(new THREE.Vector2(x, z));
  }
  return out;
}

function windowTexture(lit: boolean) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = lit ? '#000000' : '#6f8fb0';
  ctx.fillRect(0, 0, 128, 256);
  const r = rng(lit ? 3 : 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 6; x++) {
    const on = r() > 0.45;
    ctx.fillStyle = lit ? (on ? (r() > 0.5 ? '#ffd79a' : '#fff2c8') : '#000000') : r() > 0.5 ? '#a9d6ff' : '#cfe8ff';
    ctx.fillRect(8 + x * 20, 6 + y * 15.5, 13, 9);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function snow(group: THREE.Group, b: BuildingRect, overlaps: Overlaps): ThemeExtras {
  const r = rng(77);
  const white = plastic('#f6fafd', 0.6, 0.2);
  const banks = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 10), white, 80);
  const m = new THREE.Matrix4();
  let n = 0;
  for (let i = 0; i < 80; i++) {
    const x = -40 + i * 1.6 + r();
    const z = i % 2 ? 32.3 : 39.6;
    if (z < 33 && x > 19 && x < 25) continue;
    m.compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion(), new THREE.Vector3(0.9 + r() * 0.8, 0.35 + r() * 0.25, 0.5 + r() * 0.3));
    banks.setMatrixAt(n++, m);
  }
  banks.count = n;
  banks.receiveShadow = true;
  group.add(banks);
  const makeSnowman = (x: number, z: number, rot: number) => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), white).translateY(0.45));
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.36, 20, 14), white).translateY(1.12));
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.26, 20, 14), white).translateY(1.62));
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.28, 10), plastic('#ff8a3d', 0.4, 0.6));
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 1.62, 0.36);
    g.add(nose);
    for (const s of [-1, 1]) g.add(new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), matte('#1d2128')).translateY(1.7).translateX(s * 0.09).translateZ(0.23));
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.26, 16), matte('#1d2128'));
    hat.position.y = 1.95;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.03, 16), matte('#1d2128'));
    brim.position.y = 1.83;
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.06, 8, 20), plastic('#ff5c8a', 0.6, 0.2));
    scarf.rotation.x = Math.PI / 2;
    scarf.position.y = 1.42;
    g.add(hat, brim, scarf);
    g.position.set(x, 0, z);
    g.rotation.y = rot;
    group.add(bake(shadowed(g)));
  };
  if (!overlaps(4, 28.5, 6, 30.5)) makeSnowman(5, 29.6, 0.6);
  if (!overlaps(38, 28.5, 40, 30.5)) makeSnowman(39, 29.6, -0.5);
  void b;
  return { smokeStacks: [], update() {} };
}

function makePalm(r: () => number): THREE.Group {
  const g = new THREE.Group();
  const bark = plastic('#a0764a', 0.8, 0.1);
  const lean = 0.25 + r() * 0.3;
  let x = 0, y = 0;
  for (let i = 0; i < 7; i++) {
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.15 - i * 0.01, 0.17 - i * 0.01, 0.6, 10), bark);
    const a = lean * (i / 7);
    seg.position.set(x, y + 0.3, 0);
    seg.rotation.z = -a;
    g.add(seg);
    x += Math.sin(a) * 0.6;
    y += Math.cos(a) * 0.58;
  }
  const leaf = plastic('#3fa34f', 0.5, 0.5);
  for (let i = 0; i < 8; i++) {
    const f = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), leaf);
    f.scale.set(1.2, 0.07, 0.28);
    const holder = new THREE.Group();
    holder.position.set(x, y, 0);
    holder.rotation.y = (i / 8) * Math.PI * 2;
    f.position.set(0.95, -0.25, 0);
    f.rotation.z = -0.45;
    holder.add(f);
    g.add(holder);
  }
  for (let i = 0; i < 3; i++) g.add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), plastic('#6b4a2a', 0.6, 0.2)).translateX(x + Math.cos(i * 2) * 0.12).translateY(y - 0.12).translateZ(Math.sin(i * 2) * 0.12));
  return shadowed(g);
}

function beach(group: THREE.Group, b: BuildingRect, overlaps: Overlaps): ThemeExtras {
  const r = rng(31);
  const shore = b.z - 5;
  const waterNormal = tex('lino').normalMap.clone();
  waterNormal.needsUpdate = true;
  waterNormal.repeat.set(24, 24);
  const ocean = new THREE.Mesh(new THREE.PlaneGeometry(700, 400), new THREE.MeshPhysicalMaterial({
    color: '#1f9fd0', roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05, normalMap: waterNormal, normalScale: new THREE.Vector2(0.7, 0.7), envMapIntensity: 1.6,
  }));
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.set(24, -0.01, shore - 200);
  ocean.receiveShadow = true;
  group.add(ocean);
  const shallow = new THREE.Mesh(new THREE.PlaneGeometry(700, 3), new THREE.MeshBasicMaterial({ color: '#7fe3e8', map: rampTex(), transparent: true, opacity: 0.85, depthWrite: false }));
  shallow.rotation.x = -Math.PI / 2;
  shallow.rotation.z = Math.PI;
  shallow.position.set(24, 0.005, shore - 1.5);
  group.add(shallow);
  const foamMat = new THREE.MeshBasicMaterial({ color: '#ffffff', map: rampTex(), transparent: true, opacity: 0.8, depthWrite: false });
  const foam = new THREE.Mesh(new THREE.PlaneGeometry(700, 0.9), foamMat);
  foam.rotation.x = -Math.PI / 2;
  foam.position.set(24, 0.01, shore);
  group.add(foam);
  const wet = new THREE.Mesh(new THREE.PlaneGeometry(700, 1.6), new THREE.MeshBasicMaterial({ color: '#7a5a2a', transparent: true, opacity: 0.18, depthWrite: false }));
  wet.rotation.x = -Math.PI / 2;
  wet.position.set(24, 0.006, shore + 0.9);
  group.add(wet);
  // palms
  const palms: THREE.Group[] = [];
  const spots: [number, number][] = [];
  for (let i = 0; i < 26 && spots.length < 16; i++) {
    const x = -8 + r() * 60, z = shore + 1.5 + r() * Math.max(2, b.z - shore - 2);
    const side = r();
    const px = side < 0.5 ? x : side < 0.75 ? b.x - 2.5 - r() * 6 : b.x + b.w + 2.5 + r() * 6;
    const pz = side < 0.5 ? z : 2 + r() * 26;
    if (overlaps(px - 1, pz - 1, px + 1, pz + 1)) continue;
    spots.push([px, pz]);
  }
  for (const [x, z] of spots) {
    const p = bake(makePalm(r));
    p.position.set(x, 0, z);
    p.rotation.y = r() * Math.PI * 2;
    group.add(p);
    palms.push(p);
  }
  // umbrellas and towels on the sand
  const stripes = ['#ff5a5f', '#ffd447', '#3ec1d3', '#7b61ff', '#2ec4b6'];
  for (let i = 0; i < 9; i++) {
    const x = -4 + r() * 52, z = shore + 1.2 + r() * Math.max(1.5, b.z - shore - 3);
    if (overlaps(x - 1.5, z - 1.5, x + 1.5, z + 1.5)) continue;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2, 6), metal('#e3e8ee', 0.3)).translateY(1));
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.45, 12, 1, true), new THREE.MeshPhysicalMaterial({ color: stripes[i % stripes.length], roughness: 0.6, side: THREE.DoubleSide }));
    canopy.position.y = 1.95;
    g.add(canopy);
    const towel = new RoundedBoxGeometry(0.8, 0.03, 1.6, 2, 0.01);
    g.add(new THREE.Mesh(towel, plastic(stripes[(i + 2) % stripes.length], 0.8, 0.1)).translateX(0.9).translateY(0.02));
    g.position.set(x, 0, z);
    g.rotation.y = r() * 3;
    group.add(bake(shadowed(g)));
  }
  // beach huts along the sides
  const hutCols = ['#ff9cc4', '#9ff0ff', '#ffe39e', '#c7f9a8', '#d7c4ff'];
  for (const p of propSpots(b, r, 10, 5, 14)) {
    if (overlaps(p.x - 2, p.y - 2, p.x + 2, p.y + 2) || p.y < shore + 1) continue;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new RoundedBoxGeometry(2, 2, 1.8, 2, 0.08), plastic(hutCols[Math.abs(p.x | 0) % hutCols.length], 0.6, 0.3)).translateY(1));
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.6, 0.9, 4), plastic('#ffffff', 0.5, 0.4));
    roof.position.y = 2.45;
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
    g.position.set(p.x, 0, p.y);
    group.add(bake(shadowed(g)));
  }
  return {
    smokeStacks: [],
    update(time) {
      waterNormal.offset.set(time * 0.01, time * 0.018);
      foamMat.opacity = 0.55 + Math.sin(time * 1.3) * 0.3;
      foam.position.z = shore + Math.sin(time * 1.3) * 0.35;
      palms.forEach((p, i) => { p.rotation.z = Math.sin(time * 0.9 + i) * 0.025; });
    },
  };
}

function industrial(group: THREE.Group, b: BuildingRect, overlaps: Overlaps): ThemeExtras {
  const r = rng(13);
  const stacks: THREE.Vector3[] = [];
  const bodies = ['#a65f45', '#8d6e63', '#7f8c99', '#b07a5a'];
  for (const p of propSpots(b, r, 7, 14, 20)) {
    const w = 8 + r() * 6, d = 6 + r() * 5, h = 4 + r() * 3;
    if (overlaps(p.x - w / 2, p.y - d / 2, p.x + w / 2, p.y + d / 2)) continue;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), plastic(bodies[stacks.length % bodies.length], 0.85, 0.1)).translateY(h / 2));
    const teeth = Math.floor(w / 2.2);
    for (let i = 0; i < teeth; i++) {
      const prism = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 1.2, d, 3), plastic('#5f6b78', 0.6, 0.3));
      prism.rotation.x = Math.PI / 2;
      prism.rotation.y = 0;
      prism.position.set(-w / 2 + 1.1 + i * 2.2, h + 0.5, 0);
      g.add(prism);
      g.add(new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8), glow('#ffd79a', 1.2)).translateX(-w / 2 + 1.1 + i * 2.2).translateY(h + 0.5).translateZ(d / 2 + 0.01));
    }
    const chimneys = 1 + Math.floor(r() * 2);
    for (let c = 0; c < chimneys; c++) {
      const ch = 7 + r() * 5;
      const cx = -w / 2 + 1.5 + c * 2.4, cz = -d / 2 + 1.2;
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.6, ch, 14), plastic('#d9d4cc', 0.7, 0.2)).translateX(cx).translateY(ch / 2).translateZ(cz));
      for (let s = 0; s < 3; s++) g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.5, 0.4, 14), plastic('#e04848', 0.5, 0.3)).translateX(cx).translateY(ch - 0.6 - s * 1.4).translateZ(cz));
      stacks.push(new THREE.Vector3(p.x + cx, ch + 0.3, p.y + cz));
    }
    for (let t = 0; t < 2; t++) g.add(new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 2.6, 18), metal('#c9d2dc', 0.35)).translateX(w / 2 + 1.5).translateY(1.3).translateZ(-d / 4 + t * 2.5));
    g.position.set(p.x, 0, p.y);
    group.add(bake(shadowed(g)));
  }
  return { smokeStacks: stacks, update() {} };
}

function city(group: THREE.Group, b: BuildingRect, overlaps: Overlaps): ThemeExtras {
  const r = rng(57);
  const day = windowTexture(false);
  const lit = windowTexture(true);
  const towerMat = new THREE.MeshStandardMaterial({ color: '#ffffff', map: day, emissiveMap: lit, emissive: '#ffffff', emissiveIntensity: 0, roughness: 0.35, metalness: 0.2 });
  const tints = ['#dfe8f2', '#f2e6da', '#e3f2e6', '#e8e1f5'];
  for (const p of propSpots(b, r, 14, 9, 24)) {
    const w = 5 + r() * 4, d = 5 + r() * 4, h = 8 + r() * 16;
    if (overlaps(p.x - w / 2, p.y - d / 2, p.x + w / 2, p.y + d / 2)) continue;
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(w, h, d);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 6), uv.getY(i) * (h / 12));
    const body = new THREE.Mesh(geo, towerMat);
    body.position.y = h / 2;
    g.add(body);
    g.add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.4, d + 0.3), plastic(tints[Math.abs(p.x | 0) % tints.length], 0.6, 0.3)).translateY(h + 0.2));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 1.2), metal('#aab4c0', 0.4)).translateY(h + 0.8).translateX(w / 4));
    if (r() > 0.5) g.add(new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), glow('#ff3040', 6)).translateY(h + 1.6));
    g.position.set(p.x, 0, p.y);
    group.add(bake(shadowed(g), [body]));
  }
  // street trees in planters
  const leaf = plastic('#4aa83f', 0.6, 0.3);
  for (let i = 0; i < 12; i++) {
    const x = -20 + i * 7 + r() * 2, z = r() > 0.5 ? 39.6 : 32.4;
    if (z < 33 && x > 17 && x < 27) continue;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new RoundedBoxGeometry(1, 0.5, 1, 2, 0.08), plastic('#cfc8bb', 0.7, 0.2)).translateY(0.25));
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 1.2, 8), matte('#7a5232')).translateY(1));
    g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 2), leaf).translateY(1.9));
    g.position.set(x, 0.08, z);
    group.add(bake(shadowed(g)));
  }
  return { smokeStacks: [], update(_t, night) { towerMat.emissiveIntensity = night * 1.4; } };
}

export function addThemeProps(group: THREE.Group, theme: Theme, b: BuildingRect, overlaps: Overlaps): ThemeExtras {
  switch (theme) {
    case 'snow': return snow(group, b, overlaps);
    case 'beach': return beach(group, b, overlaps);
    case 'industrial': return industrial(group, b, overlaps);
    case 'city': return city(group, b, overlaps);
    default: return { smokeStacks: [], update() {} };
  }
}
