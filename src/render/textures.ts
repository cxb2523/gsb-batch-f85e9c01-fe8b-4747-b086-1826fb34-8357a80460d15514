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

/**
 * Procedural canvas textures. Every texture is painted twice: a colour canvas and a
 * height canvas; the height is turned into a tangent-space normal map with a Sobel pass.
 */

type Ctx2D = CanvasRenderingContext2D;
const SIZE = 512;

function mkCanvas(w = SIZE, h = SIZE) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d', { willReadFrequently: true })! };
}

let seed = 1337;
function rnd() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function speckle(ctx: Ctx2D, w: number, h: number, n: number, colors: string[], rMin: number, rMax: number, alpha = 1) {
  ctx.globalAlpha = alpha;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[(rnd() * colors.length) | 0];
    const r = rMin + rnd() * (rMax - rMin);
    ctx.beginPath();
    ctx.arc(rnd() * w, rnd() * h, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function heightToNormal(height: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const w = height.width, h = height.height;
  const src = height.getContext('2d')!.getImageData(0, 0, w, h).data;
  const { c, ctx } = mkCanvas(w, h);
  const out = ctx.createImageData(w, h);
  const H = (x: number, y: number) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
      const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * w + x) * 4;
      out.data[i] = (nx * 0.5 + 0.5) * 255;
      out.data[i + 1] = (-ny * 0.5 + 0.5) * 255;
      out.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

export interface TexSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap?: THREE.Texture;
  /** world units covered by one texture repeat */
  scale: number;
}

function finish(color: HTMLCanvasElement, height: HTMLCanvasElement, strength: number, scale: number, rough?: HTMLCanvasElement): TexSet {
  const map = new THREE.CanvasTexture(color);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = new THREE.CanvasTexture(heightToNormal(height, strength));
  const set: TexSet = { map, normalMap, scale };
  if (rough) set.roughnessMap = new THREE.CanvasTexture(rough);
  for (const t of [set.map, set.normalMap, set.roughnessMap]) {
    if (!t) continue;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.generateMipmaps = true;
  }
  return set;
}

/** Glossy ceramic tiles, `n`×`n` per texture, alternating colours with recessed grout. */
function tiles(a: string, b: string, grout: string, n: number, scale: number, gloss = 0.18) {
  const { c, ctx } = mkCanvas();
  const { c: hc, ctx: hx } = mkCanvas();
  const { c: rc, ctx: rx } = mkCanvas();
  const s = SIZE / n;
  const g = Math.max(3, s * 0.05);
  ctx.fillStyle = grout;
  ctx.fillRect(0, 0, SIZE, SIZE);
  hx.fillStyle = '#000';
  hx.fillRect(0, 0, SIZE, SIZE);
  rx.fillStyle = '#d0d0d0';
  rx.fillRect(0, 0, SIZE, SIZE);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const col = (x + y) % 2 === 0 ? a : b;
      ctx.fillStyle = col;
      ctx.fillRect(x * s + g / 2, y * s + g / 2, s - g, s - g);
      // subtle per-tile variation
      ctx.fillStyle = `rgba(255,255,255,${0.04 + rnd() * 0.06})`;
      ctx.fillRect(x * s + g / 2, y * s + g / 2, s - g, (s - g) * 0.5);
      hx.fillStyle = '#fff';
      hx.fillRect(x * s + g / 2, y * s + g / 2, s - g, s - g);
      // bevelled edge
      hx.fillStyle = '#c8c8c8';
      hx.fillRect(x * s + g / 2, y * s + g / 2, s - g, 2);
      hx.fillRect(x * s + g / 2, y * s + g / 2, 2, s - g);
      const r = Math.round(gloss * 255);
      rx.fillStyle = `rgb(${r},${r},${r})`;
      rx.fillRect(x * s + g / 2, y * s + g / 2, s - g, s - g);
    }
  }
  speckle(ctx, SIZE, SIZE, 900, ['rgba(0,0,0,0.05)', 'rgba(255,255,255,0.08)'], 0.5, 1.6);
  return finish(c, hc, 2.2, scale, rc);
}

function wood(base: string, dark: string, planks: number, scale: number) {
  const { c, ctx } = mkCanvas();
  const { c: hc, ctx: hx } = mkCanvas();
  const ph = SIZE / planks;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, SIZE, SIZE);
  hx.fillStyle = '#fff';
  hx.fillRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < planks; i++) {
    const y = i * ph;
    const tint = rnd() * 0.18 - 0.09;
    ctx.fillStyle = tint > 0 ? `rgba(255,240,210,${tint})` : `rgba(60,30,10,${-tint})`;
    ctx.fillRect(0, y, SIZE, ph);
    // grain
    for (let k = 0; k < 18; k++) {
      ctx.strokeStyle = `rgba(80,40,15,${0.05 + rnd() * 0.08})`;
      ctx.lineWidth = 0.6 + rnd() * 1.4;
      ctx.beginPath();
      const gy = y + rnd() * ph;
      ctx.moveTo(0, gy);
      for (let x = 0; x <= SIZE; x += 32) ctx.lineTo(x, gy + Math.sin(x * 0.02 + k) * 2 + rnd() * 1.5);
      ctx.stroke();
    }
    // seams
    ctx.fillStyle = dark;
    ctx.fillRect(0, y, SIZE, 2);
    hx.fillStyle = '#777';
    hx.fillRect(0, y, SIZE, 2);
    const off = rnd() * SIZE;
    for (const sx of [off, (off + SIZE / 2) % SIZE]) {
      ctx.fillRect(sx, y, 2, ph);
      hx.fillRect(sx, y, 2, ph);
    }
  }
  return finish(c, hc, 1.5, scale);
}

function fuzz(base: string, colors: string[], scale: number, strength = 0.8) {
  const { c, ctx } = mkCanvas();
  const { c: hc, ctx: hx } = mkCanvas();
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, SIZE, SIZE);
  speckle(ctx, SIZE, SIZE, 14000, colors, 0.6, 1.8, 0.5);
  hx.fillStyle = '#888';
  hx.fillRect(0, 0, SIZE, SIZE);
  speckle(hx, SIZE, SIZE, 14000, ['#fff', '#444'], 0.6, 1.6, 0.6);
  return finish(c, hc, strength, scale);
}

function lino(base: string, flecks: string[], scale: number) {
  const { c, ctx } = mkCanvas();
  const { c: hc, ctx: hx } = mkCanvas();
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, SIZE, SIZE);
  speckle(ctx, SIZE, SIZE, 2500, flecks, 0.8, 2.6, 0.7);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, SIZE, SIZE);
  // sheet seam
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(0, SIZE / 2, SIZE, 2);
  hx.fillStyle = '#555';
  hx.fillRect(0, SIZE / 2, SIZE, 2);
  return finish(c, hc, 0.8, scale);
}

function rubber(scale: number) {
  const { c, ctx } = mkCanvas();
  const { c: hc, ctx: hx } = mkCanvas();
  ctx.fillStyle = '#3a3f4a';
  ctx.fillRect(0, 0, SIZE, SIZE);
  hx.fillStyle = '#333';
  hx.fillRect(0, 0, SIZE, SIZE);
  const n = 16, s = SIZE / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const cx = x * s + s / 2, cy = y * s + s / 2;
    ctx.fillStyle = '#454b57';
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.28, 0, Math.PI * 2); ctx.fill();
    const grd = hx.createRadialGradient(cx, cy, 0, cx, cy, s * 0.3);
    grd.addColorStop(0, '#fff'); grd.addColorStop(0.8, '#ddd'); grd.addColorStop(1, '#333');
    hx.fillStyle = grd;
    hx.beginPath(); hx.arc(cx, cy, s * 0.3, 0, Math.PI * 2); hx.fill();
  }
  return finish(c, hc, 2.5, scale);
}

function grass(scale: number) {
  const { c, ctx } = mkCanvas();
  const { c: hc, ctx: hx } = mkCanvas();
  ctx.fillStyle = '#5fae3c';
  ctx.fillRect(0, 0, SIZE, SIZE);
  // large soft patches
  for (let i = 0; i < 40; i++) {
    const x = rnd() * SIZE, y = rnd() * SIZE, r = 40 + rnd() * 90;
    const grd = ctx.createRadialGradient(x, y, 0, x, y, r);
    const col = rnd() > 0.5 ? '120,190,70' : '70,140,45';
    grd.addColorStop(0, `rgba(${col},0.35)`);
    grd.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = grd;
    for (const ox of [-SIZE, 0, SIZE]) for (const oy of [-SIZE, 0, SIZE]) {
      ctx.save(); ctx.translate(ox, oy); ctx.fillRect(x - r, y - r, r * 2, r * 2); ctx.restore();
    }
  }
  // blades
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * SIZE, y = rnd() * SIZE;
    const l = 3 + rnd() * 6;
    ctx.strokeStyle = rnd() > 0.5 ? 'rgba(150,215,90,0.55)' : 'rgba(45,110,35,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (rnd() - 0.5) * 3, y - l); ctx.stroke();
  }
  hx.fillStyle = '#777';
  hx.fillRect(0, 0, SIZE, SIZE);
  speckle(hx, SIZE, SIZE, 9000, ['#fff', '#333'], 0.6, 1.5, 0.5);
  return finish(c, hc, 1.2, scale);
}

function asphalt(scale: number) {
  const { c, ctx } = mkCanvas();
  const { c: hc, ctx: hx } = mkCanvas();
  ctx.fillStyle = '#3d4149';
  ctx.fillRect(0, 0, SIZE, SIZE);
  speckle(ctx, SIZE, SIZE, 16000, ['#2c2f35', '#555a63', '#6b6f78', '#24272c'], 0.5, 1.6, 0.8);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, SIZE, SIZE);
  speckle(hx, SIZE, SIZE, 16000, ['#fff', '#222'], 0.5, 1.4, 0.7);
  const { c: rc, ctx: rx } = mkCanvas();
  rx.fillStyle = '#e8e8e8';
  rx.fillRect(0, 0, SIZE, SIZE);
  // wet-looking patches
  for (let i = 0; i < 6; i++) {
    const x = rnd() * SIZE, y = rnd() * SIZE, r = 30 + rnd() * 70;
    const grd = rx.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(90,90,90,0.9)'); grd.addColorStop(1, 'rgba(230,230,230,0)');
    rx.fillStyle = grd; rx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  return finish(c, hc, 1.0, scale, rc);
}

function paving(a: string, b: string, n: number, scale: number) {
  const { c, ctx } = mkCanvas();
  const { c: hc, ctx: hx } = mkCanvas();
  const s = SIZE / n;
  ctx.fillStyle = '#8f8a80';
  ctx.fillRect(0, 0, SIZE, SIZE);
  hx.fillStyle = '#000';
  hx.fillRect(0, 0, SIZE, SIZE);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    ctx.fillStyle = rnd() > 0.5 ? a : b;
    ctx.fillRect(x * s + 2, y * s + 2, s - 4, s - 4);
    hx.fillStyle = '#fff';
    hx.fillRect(x * s + 2, y * s + 2, s - 4, s - 4);
  }
  speckle(ctx, SIZE, SIZE, 5000, ['rgba(0,0,0,0.08)', 'rgba(255,255,255,0.1)'], 0.5, 1.5);
  return finish(c, hc, 2.0, scale);
}

function brick(scale: number) {
  const { c, ctx } = mkCanvas();
  const { c: hc, ctx: hx } = mkCanvas();
  ctx.fillStyle = '#efe4d2';
  ctx.fillRect(0, 0, SIZE, SIZE);
  hx.fillStyle = '#000';
  hx.fillRect(0, 0, SIZE, SIZE);
  const rows = 16, bw = SIZE / 4, bh = SIZE / rows;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? bw / 2 : 0;
    for (let i = -1; i < 5; i++) {
      const x = i * bw + off;
      const t = rnd();
      ctx.fillStyle = t > 0.66 ? '#e99a6b' : t > 0.33 ? '#dd8a5c' : '#f0a77a';
      ctx.fillRect(x + 3, r * bh + 3, bw - 6, bh - 6);
      hx.fillStyle = '#fff';
      hx.fillRect(x + 3, r * bh + 3, bw - 6, bh - 6);
    }
  }
  speckle(ctx, SIZE, SIZE, 4000, ['rgba(120,50,20,0.15)', 'rgba(255,255,255,0.12)'], 0.5, 1.8);
  return finish(c, hc, 2.4, scale);
}

function wallpaper(scale: number) {
  const { c, ctx } = mkCanvas();
  const { c: hc, ctx: hx } = mkCanvas();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  hx.fillStyle = '#808080';
  hx.fillRect(0, 0, SIZE, SIZE);
  for (let x = 0; x < SIZE; x += 32) {
    ctx.fillStyle = 'rgba(0,0,0,0.045)';
    ctx.fillRect(x, 0, 12, SIZE);
    hx.fillStyle = '#8c8c8c';
    hx.fillRect(x, 0, 12, SIZE);
  }
  // wainscot rail at ~1/3 height (texture v maps to wall height)
  const ry = SIZE * (1 - 0.36);
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.fillRect(0, ry, SIZE, 10);
  ctx.fillStyle = 'rgba(0,0,0,0.07)';
  ctx.fillRect(0, ry + 10, SIZE, SIZE - ry - 10);
  hx.fillStyle = '#fff';
  hx.fillRect(0, ry, SIZE, 10);
  for (let x = 0; x < SIZE; x += 64) {
    hx.fillStyle = '#6a6a6a';
    hx.fillRect(x, ry + 14, 3, SIZE - ry - 14);
  }
  return finish(c, hc, 1.6, scale);
}

export type TexKind =
  | 'corridor' | 'wood' | 'mint' | 'white' | 'lino' | 'rubber' | 'plank' | 'carpet'
  | 'grass' | 'asphalt' | 'paving' | 'path' | 'brick' | 'wallpaper' | 'cork' | 'rose'
  | 'snow' | 'sand' | 'gravel' | 'plaza';

const cache = new Map<TexKind, TexSet>();

export function tex(kind: TexKind): TexSet {
  const hit = cache.get(kind);
  if (hit) return hit;
  seed = 1337 + kind.length * 101 + kind.charCodeAt(0);
  let t: TexSet;
  switch (kind) {
    case 'corridor': t = tiles('#f6eee0', '#b9e4d8', '#a99f8e', 4, 2, 0.12); break;
    case 'mint': t = tiles('#d4f5e6', '#bfeed9', '#8ec7ae', 4, 2, 0.15); break;
    case 'white': t = tiles('#f7f9ff', '#e9eefb', '#b9c3d8', 2, 2, 0.08); break;
    case 'wood': t = wood('#c98a52', '#6b3e1c', 8, 2); break;
    case 'plank': t = wood('#e2b27a', '#8a5a2c', 5, 2); break;
    case 'carpet': t = fuzz('#8a63d2', ['#a07ae6', '#6f4cb8', '#9b72e0'], 2); break;
    case 'cork': t = lino('#c99a6b', ['#a7774a', '#e0b88c', '#8a5a2c'], 2); break;
    case 'snow': t = fuzz('#eef5fb', ['#ffffff', '#d9e7f5', '#e6f0fa', '#cfe0f2'], 6, 1.2); break;
    case 'sand': t = fuzz('#efd9a7', ['#f6e5bd', '#e3c98f', '#d9bd85', '#fff0cc'], 6, 1.4); break;
    case 'gravel': t = fuzz('#8d8a83', ['#a29f97', '#6f6c66', '#b5b1a8', '#5f5c57'], 6, 2.2); break;
    case 'plaza': t = paving('#d8d3c9', '#c9c3b6', 6, 6); break;
    case 'rose': t = fuzz('#f2a7c3', ['#ffc4d9', '#e48aad', '#f7b5cd'], 2); break;
    case 'lino': t = lino('#b8dcf7', ['#ffffff', '#8fc3ea', '#d8ecfb'], 2); break;
    case 'rubber': t = rubber(2); break;
    case 'grass': t = grass(6); break;
    case 'asphalt': t = asphalt(6); break;
    case 'paving': t = paving('#d9d2c4', '#cbc3b3', 4, 2); break;
    case 'path': t = paving('#efd9b3', '#e5caa0', 4, 2); break;
    case 'brick': t = brick(3); break;
    case 'wallpaper': t = wallpaper(2.4); break;
  }
  cache.set(kind, t);
  return t;
}

/** Soft radial sprite used by particles and light pools. */
let radial: THREE.Texture | null = null;
export function radialTex(): THREE.Texture {
  if (radial) return radial;
  const { c, ctx } = mkCanvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  radial = new THREE.CanvasTexture(c);
  return radial;
}

/** Vertical alpha ramp (opaque at v=0) for baked contact-shadow strips. */
let ramp: THREE.Texture | null = null;
export function rampTex(): THREE.Texture {
  if (ramp) return ramp;
  const { c, ctx } = mkCanvas(8, 64);
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 64);
  ramp = new THREE.CanvasTexture(c);
  return ramp;
}
