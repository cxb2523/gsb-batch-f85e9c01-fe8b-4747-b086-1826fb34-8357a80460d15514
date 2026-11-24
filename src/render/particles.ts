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
import { radialTex } from './textures';

export type PKind = 'sparkle' | 'spark' | 'steam' | 'dust' | 'bubble' | 'drip' | 'snow' | 'rain' | 'puff' | 'water' | 'heart' | 'soap' | 'smoke';

interface KindDef {
  additive: boolean;
  life: [number, number];
  size: [number, number];
  grow: number;
  gravity: number;
  drag: number;
  colors: THREE.Color[];
  alpha: number;
  stretch?: number;
}

const col = (...c: string[]) => c.map((x) => new THREE.Color(x));

const KINDS: Record<PKind, KindDef> = {
  sparkle: { additive: true, life: [0.6, 1.3], size: [0.08, 0.2], grow: -0.5, gravity: -0.6, drag: 1.5, colors: col('#fff6c8', '#ffd447', '#ffffff', '#9ff0ff'), alpha: 1.6 },
  spark: { additive: true, life: [0.15, 0.4], size: [0.04, 0.09], grow: -0.8, gravity: 4, drag: 0.5, colors: col('#cfeeff', '#8fd3ff', '#ffffff'), alpha: 3, stretch: 2.5 },
  steam: { additive: false, life: [1.5, 2.6], size: [0.15, 0.3], grow: 1.6, gravity: -0.5, drag: 1.2, colors: col('#ffffff', '#f2f6ff'), alpha: 0.32 },
  dust: { additive: false, life: [0.6, 1.1], size: [0.2, 0.4], grow: 1.8, gravity: -0.1, drag: 3.5, colors: col('#efe2c8', '#e3d3b4', '#f7efe0'), alpha: 0.6 },
  bubble: { additive: true, life: [0.8, 1.4], size: [0.04, 0.09], grow: 0.2, gravity: -0.8, drag: 1, colors: col('#ff7ad9', '#7af0ff', '#ffe07a'), alpha: 1.4 },
  drip: { additive: false, life: [0.4, 0.5], size: [0.025, 0.03], grow: 0, gravity: 6, drag: 0, colors: col('#8fdcff'), alpha: 0.9, stretch: 1.8 },
  snow: { additive: false, life: [1.2, 1.8], size: [0.03, 0.06], grow: 0, gravity: 0.6, drag: 2.5, colors: col('#ffffff', '#e8f6ff'), alpha: 0.95 },
  rain: { additive: false, life: [0.5, 0.7], size: [0.015, 0.02], grow: 0, gravity: 14, drag: 0, colors: col('#cfe3ff', '#e3eeff'), alpha: 0.55, stretch: 14 },
  puff: { additive: false, life: [0.8, 1.4], size: [0.3, 0.5], grow: 1.4, gravity: -0.4, drag: 2.5, colors: col('#8a8f99', '#6f7480', '#a3a8b2'), alpha: 0.65 },
  water: { additive: false, life: [0.7, 0.9], size: [0.04, 0.07], grow: 0, gravity: 9.8, drag: 0.1, colors: col('#bdf0ff', '#ffffff', '#8fe1ff'), alpha: 0.85, stretch: 1.6 },
  soap: { additive: false, life: [1.6, 2.6], size: [0.07, 0.15], grow: 0.15, gravity: -0.35, drag: 1.4, colors: col('#d8f6ff', '#ffe0f7', '#e8ffe0', '#fff6d0'), alpha: 0.7 },
  smoke: { additive: false, life: [1.4, 2.4], size: [0.2, 0.4], grow: 1.3, gravity: -0.7, drag: 1.2, colors: col('#4a4f5a', '#5f6470', '#3a3e47'), alpha: 0.55 },
  heart: { additive: true, life: [0.9, 1.4], size: [0.12, 0.2], grow: 0.2, gravity: -1.2, drag: 1.2, colors: col('#ff5c8a', '#ff8fb1'), alpha: 1.4 },
};

const vert = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aCol;
attribute vec3 aSize; // x size, y stretch, z rotation
varying vec4 vCol;
varying vec2 vUv;
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float c = cos(aSize.z), s = sin(aSize.z);
  vec2 q = vec2(position.x, position.y * aSize.y);
  vec2 p = vec2(q.x * c - q.y * s, q.x * s + q.y * c) * aSize.x;
  vec3 wp = aPos + right * p.x + up * p.y;
  vUv = uv;
  vCol = aCol;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const frag = /* glsl */ `
uniform sampler2D map;
uniform float additive;
varying vec4 vCol;
varying vec2 vUv;
void main() {
  float a = texture2D(map, vUv).r * vCol.a;
  if (a < 0.003) discard;
  gl_FragColor = additive > 0.5 ? vec4(vCol.rgb * a, a) : vec4(vCol.rgb, min(a, 1.0));
}`;

/** Struct-of-arrays pool of camera-facing sprites. */
class SpritePool {
  readonly mesh: THREE.Mesh;
  private n = 0;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private size: Float32Array;
  private kind: Uint8Array;
  private rot: Float32Array;
  private colr: Float32Array;
  private aPos: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private kinds: PKind[];

  constructor(readonly cap: number, additive: boolean) {
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.attributes.position);
    this.geo.setAttribute('uv', base.attributes.uv);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aCol', this.aCol);
    this.geo.setAttribute('aSize', this.aSize);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { map: { value: radialTex() }, additive: { value: additive ? 1 : 0 } },
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 20 : 19;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.kind = new Uint8Array(cap);
    this.rot = new Float32Array(cap);
    this.colr = new Float32Array(cap * 3);
    this.kinds = Object.keys(KINDS) as PKind[];
  }

  get count() { return this.n; }

  spawn(kind: PKind, p: THREE.Vector3, v: THREE.Vector3, color?: THREE.Color) {
    if (this.n >= this.cap) return;
    const d = KINDS[kind];
    const i = this.n++;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.max[i] = this.life[i] = d.life[0] + Math.random() * (d.life[1] - d.life[0]);
    this.size[i] = d.size[0] + Math.random() * (d.size[1] - d.size[0]);
    this.kind[i] = this.kinds.indexOf(kind);
    this.rot[i] = d.stretch ? 0 : Math.random() * 6.28;
    const c = color ?? d.colors[(Math.random() * d.colors.length) | 0];
    this.colr.set([c.r, c.g, c.b], i * 3);
  }

  update(dt: number) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      const d = KINDS[this.kinds[this.kind[i]]];
      const k = Math.exp(-d.drag * dt);
      let vx = this.vel[i * 3] * k, vy = this.vel[i * 3 + 1] * k - d.gravity * dt, vz = this.vel[i * 3 + 2] * k;
      let px = this.pos[i * 3] + vx * dt, py = this.pos[i * 3 + 1] + vy * dt, pz = this.pos[i * 3 + 2] + vz * dt;
      if (py < 0.02 && d.gravity > 0) { py = 0.02; vy *= -0.2; vx *= 0.5; vz *= 0.5; if (d.stretch) this.life[i] = Math.min(this.life[i], 0.05); }
      const t = 1 - this.life[i] / this.max[i];
      this.size[i] *= 1 + d.grow * dt;
      // compact the pool in place
      if (w !== i) {
        this.max[w] = this.max[i]; this.life[w] = this.life[i]; this.size[w] = this.size[i]; this.kind[w] = this.kind[i]; this.rot[w] = this.rot[i];
        this.colr[w * 3] = this.colr[i * 3]; this.colr[w * 3 + 1] = this.colr[i * 3 + 1]; this.colr[w * 3 + 2] = this.colr[i * 3 + 2];
      }
      this.pos[w * 3] = px; this.pos[w * 3 + 1] = py; this.pos[w * 3 + 2] = pz;
      this.vel[w * 3] = vx; this.vel[w * 3 + 1] = vy; this.vel[w * 3 + 2] = vz;
      const fade = Math.min(1, t * 6) * (1 - t * t);
      const tw = this.kinds[this.kind[w]] === 'sparkle' ? 0.6 + 0.4 * Math.sin(this.life[w] * 30 + w) : 1;
      this.aPos.setXYZ(w, px, py, pz);
      this.aCol.setXYZW(w, this.colr[w * 3], this.colr[w * 3 + 1], this.colr[w * 3 + 2], d.alpha * fade * tw);
      let rot = this.rot[w];
      if (d.stretch) {
        // align streaks with velocity in screen-ish space: use vertical by default
        rot = 0;
      }
      this.aSize.setXYZ(w, this.size[w], d.stretch ?? 1, rot);
      w++;
    }
    this.n = w;
    this.geo.instanceCount = w;
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aSize.needsUpdate = true;
  }
}

/** Physical 3D bits: confetti flakes and coins, tumbling with real lighting. */
class SolidPool {
  readonly mesh: THREE.InstancedMesh;
  private items: { p: THREE.Vector3; v: THREE.Vector3; r: THREE.Euler; spin: THREE.Vector3; life: number; max: number; s: number; flutter: boolean }[] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly cap: number, private flutter: boolean) {
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
  }
  spawn(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color | null, life: number, s = 1) {
    if (this.items.length >= this.cap) return;
    const i = this.items.length;
    this.items.push({ p: p.clone(), v: v.clone(), r: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6), spin: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14), life, max: life, s, flutter: this.flutter });
    if (color) this.mesh.setColorAt(i, color);
  }
  update(dt: number) {
    const keep: typeof this.items = [];
    const cols: THREE.Color[] = [];
    const c = new THREE.Color();
    this.items.forEach((it, i) => {
      it.life -= dt;
      if (it.life <= 0) return;
      if (it.flutter) {
        it.v.multiplyScalar(Math.exp(-2.2 * dt));
        it.v.y -= 3.2 * dt;
        it.v.y = Math.max(it.v.y, -1.1);
        it.v.x += Math.sin(it.life * 7 + i) * dt * 1.5;
      } else {
        it.v.y -= 9 * dt;
      }
      it.p.addScaledVector(it.v, dt);
      if (it.p.y < 0.03) { it.p.y = 0.03; it.v.set(it.v.x * 0.3, Math.abs(it.v.y) * (it.flutter ? 0 : 0.35), it.v.z * 0.3); it.spin.multiplyScalar(0.6); }
      it.r.x += it.spin.x * dt; it.r.y += it.spin.y * dt; it.r.z += it.spin.z * dt;
      if (this.mesh.instanceColor) cols.push(c.fromArray(this.mesh.instanceColor.array as Float32Array, i * 3).clone());
      keep.push(it);
    });
    this.items = keep;
    keep.forEach((it, i) => {
      const fade = Math.min(1, it.life / 0.4);
      this.m.compose(it.p, this.q.setFromEuler(it.r), new THREE.Vector3(it.s * fade, it.s * fade, it.s * fade));
      this.mesh.setMatrixAt(i, this.m);
      if (cols[i]) this.mesh.setColorAt(i, cols[i]);
    });
    this.mesh.count = keep.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

const CONFETTI = col('#ff5a5f', '#ffd447', '#3ec1d3', '#7b61ff', '#2ec4b6', '#ff8a3d', '#ff6fd8', '#7dff8a');

export class Particles {
  readonly group = new THREE.Group();
  private add: SpritePool;
  private alpha: SpritePool;
  private confetti: SolidPool;
  private coins: SolidPool;
  private acc = new Map<string, number>();
  private v = new THREE.Vector3();

  constructor(scene: THREE.Scene, budget: number) {
    this.add = new SpritePool(Math.floor(budget * 0.4), true);
    this.alpha = new SpritePool(Math.floor(budget * 0.6), false);
    const confettiMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4, metalness: 0.1, side: THREE.DoubleSide, emissive: '#222222' });
    this.confetti = new SolidPool(new THREE.PlaneGeometry(0.07, 0.11), confettiMat, 900, true);
    this.confetti.mesh.setColorAt(0, CONFETTI[0]);
    const coinMat = new THREE.MeshStandardMaterial({ color: '#ffcf3a', metalness: 1, roughness: 0.22, emissive: '#7a5200', emissiveIntensity: 0.5 });
    this.coins = new SolidPool(new THREE.CylinderGeometry(0.09, 0.09, 0.025, 20), coinMat, 200, false);
    this.group.add(this.add.mesh, this.alpha.mesh, this.confetti.mesh, this.coins.mesh);
    scene.add(this.group);
  }

  spawn(kind: PKind, p: THREE.Vector3, v: THREE.Vector3, color?: THREE.Color) {
    (KINDS[kind].additive ? this.add : this.alpha).spawn(kind, p, v, color);
  }

  /** Continuous emission at `rate` per second. */
  emit(key: string, kind: PKind, p: THREE.Vector3, rate: number, dt: number, spread = 0.15) {
    let a = (this.acc.get(key) ?? Math.random()) + rate * dt;
    while (a >= 1) {
      a -= 1;
      this.spawn(kind, this.v.set(p.x + (Math.random() - 0.5) * spread, p.y + (Math.random() - 0.5) * spread * 0.5, p.z + (Math.random() - 0.5) * spread), this.initVel(kind));
    }
    this.acc.set(key, a);
  }

  private initVel(kind: PKind) {
    const r = () => Math.random() - 0.5;
    switch (kind) {
      case 'spark': return new THREE.Vector3(r() * 5, Math.random() * 3, r() * 5);
      case 'steam': return new THREE.Vector3(r() * 0.3, 0.6 + Math.random() * 0.4, r() * 0.3);
      case 'bubble': return new THREE.Vector3(r() * 0.3, 0.4, r() * 0.3);
      case 'snow': return new THREE.Vector3(r() * 0.3, -0.2, r() * 0.3);
      case 'soap': return new THREE.Vector3(r() * 0.5, 0.3, r() * 0.5);
      case 'smoke': return new THREE.Vector3(r() * 0.3, 0.5, r() * 0.3);
      case 'drip': return new THREE.Vector3(0, -0.5, 0);
      case 'rain': return new THREE.Vector3(0.8, -9, 0.3);
      default: return new THREE.Vector3(r() * 0.5, Math.random() * 0.5, r() * 0.5);
    }
  }

  /** The big one: patient cured. */
  celebrate(p: THREE.Vector3, coins: number) {
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * Math.PI * 2, s = 1.2 + Math.random() * 2.2;
      this.confetti.spawn(this.v.set(p.x, p.y + 1.4, p.z), new THREE.Vector3(Math.cos(a) * s * 0.7, 2.5 + Math.random() * 3, Math.sin(a) * s * 0.7), CONFETTI[i % CONFETTI.length], 2.2 + Math.random() * 1.2);
    }
    for (let i = 0; i < coins; i++) {
      const a = Math.random() * Math.PI * 2;
      this.coins.spawn(this.v.set(p.x, p.y + 1.2, p.z), new THREE.Vector3(Math.cos(a) * 1.4, 4.5 + Math.random() * 2.5, Math.sin(a) * 1.4), null, 1.6 + Math.random() * 0.5, 1.2);
    }
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * 2;
      this.spawn('sparkle', this.v.set(p.x, p.y + 1, p.z), new THREE.Vector3(Math.cos(a) * s, 1 + Math.random() * 2, Math.sin(a) * s));
    }
    for (let i = 0; i < 6; i++) this.spawn('heart', this.v.set(p.x + (Math.random() - 0.5) * 0.6, p.y + 1.5, p.z + (Math.random() - 0.5) * 0.6), new THREE.Vector3(0, 0.6, 0));
  }

  coinPop(p: THREE.Vector3, n: number) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.coins.spawn(this.v.set(p.x, p.y + 1.1, p.z), new THREE.Vector3(Math.cos(a) * 0.8, 3.5 + Math.random(), Math.sin(a) * 0.8), null, 1.2, 1);
    }
  }

  dustRing(x: number, z: number, n = 14, radius = 0.4) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.spawn('dust', this.v.set(x + Math.cos(a) * radius, 0.1, z + Math.sin(a) * radius), new THREE.Vector3(Math.cos(a) * 2.2, 0.3 + Math.random() * 0.4, Math.sin(a) * 2.2));
    }
  }

  puff(p: THREE.Vector3, n = 12) {
    for (let i = 0; i < n; i++) {
      this.spawn('puff', this.v.set(p.x + (Math.random() - 0.5) * 0.5, p.y + 0.8 + Math.random() * 0.6, p.z + (Math.random() - 0.5) * 0.5), new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.5 + Math.random() * 0.6, (Math.random() - 0.5) * 1.2));
    }
  }

  sparkleBurst(p: THREE.Vector3, n = 20, color?: THREE.Color) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 0.5 + Math.random() * 1.5;
      this.spawn('sparkle', this.v.set(p.x, p.y, p.z), new THREE.Vector3(Math.cos(a) * s, Math.random() * 2, Math.sin(a) * s), color);
    }
  }

  update(dt: number) {
    this.add.update(dt);
    this.alpha.update(dt);
    this.confetti.update(dt);
    this.coins.update(dt);
  }

  get live() {
    return this.add.count + this.alpha.count;
  }
}
