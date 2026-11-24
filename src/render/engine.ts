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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CameraRig } from './camera';
import { Sky } from './sky';
import { buildPost, type PostStack } from './post';

export type Quality = 'ultra' | 'high' | 'medium' | 'low';

export interface Preset {
  pixelRatio: number;
  shadow: number;
  ao: 'full' | 'half' | 'off';
  bloom: boolean;
  tiltShift: boolean;
  smaa: boolean;
  grass: number;
  particles: number;
  lightPools: boolean;
}

export const PRESETS: Record<Quality, Preset> = {
  ultra: { pixelRatio: Math.min(window.devicePixelRatio || 1, 2), shadow: 4096, ao: 'full', bloom: true, tiltShift: true, smaa: true, grass: 70000, particles: 4000, lightPools: true },
  high: { pixelRatio: 1, shadow: 2048, ao: 'off', bloom: true, tiltShift: true, smaa: true, grass: 24000, particles: 2500, lightPools: true },
  medium: { pixelRatio: 0.85, shadow: 1024, ao: 'off', bloom: true, tiltShift: false, smaa: true, grass: 7000, particles: 1500, lightPools: true },
  low: { pixelRatio: 0.7, shadow: 0, ao: 'off', bloom: false, tiltShift: false, smaa: false, grass: 0, particles: 600, lightPools: false },
};

export const QUALITY_NAMES: Record<Quality, string> = { ultra: 'Ultra', high: 'High', medium: 'Medium', low: 'Low' };

/** Integrated GPUs default to High; everything else gets Ultra. */
export function detectQuality(renderer: THREE.WebGLRenderer): Quality {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    if (/swiftshader|llvmpipe|software/i.test(name)) return 'low';
    if (/intel|radeon graphics|radeon\(tm\) graphics|renoir|barcelo|cezanne|lucienne|vega \d|apple m1|mali|adreno|powervr/i.test(name)) return 'high';
    return 'ultra';
  } catch {
    return 'high';
  }
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly sky: Sky;
  quality: Quality;
  preset: Preset;
  private post: PostStack;
  /** dynamic resolution multiplier on top of the preset pixel ratio */
  renderScale = 1;
  autoRes = true;
  fps = 60;
  private frameAcc = 0;
  private frames = 0;
  private lowFor = 0;
  private highFor = 0;
  gpuName = '';
  onQualityChange: ((q: Quality) => void)[] = [];

  constructor(private container: HTMLElement, quality?: Quality) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.classList.add('gl');
    try {
      const gl = this.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpuName = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '');
    } catch { /* ignore */ }
    this.quality = quality ?? detectQuality(this.renderer);
    this.preset = PRESETS[this.quality];

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.rig = new CameraRig(this.renderer.domElement, innerWidth / innerHeight);
    this.sky = new Sky(this.scene, this.preset.shadow);
    this.post = this.makePost();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  get camera() {
    return this.rig.camera;
  }

  private makePost() {
    return buildPost(this.renderer, this.scene, this.rig.camera, this.preset, innerWidth, innerHeight);
  }

  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    this.preset = PRESETS[q];
    this.renderScale = 1;
    this.sky.configureShadow(this.preset.shadow);
    this.renderer.shadowMap.enabled = this.preset.shadow > 0;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
    });
    this.post.dispose();
    this.post = this.makePost();
    this.resize();
    for (const f of this.onQualityChange) f(q);
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setPixelRatio(this.preset.pixelRatio * this.renderScale);
    this.renderer.setSize(w, h);
    this.post.composer.setSize(w, h);
    this.rig.camera.aspect = w / h;
    this.rig.camera.updateProjectionMatrix();
  }

  /** Frame-time driven resolution scaling. */
  private adapt(dt: number) {
    this.frameAcc += dt;
    this.frames++;
    if (this.frameAcc < 0.5) return;
    this.fps = this.frames / this.frameAcc;
    this.frameAcc = 0;
    this.frames = 0;
    if (!this.autoRes || document.hidden) return;
    if (this.fps < 45) { this.lowFor += 0.5; this.highFor = 0; } else if (this.fps > 58) { this.highFor += 0.5; this.lowFor = 0; } else { this.lowFor = 0; this.highFor = 0; }
    if (this.lowFor >= 1 && this.renderScale > 0.6) {
      this.renderScale = Math.max(0.6, this.renderScale - 0.1);
      this.lowFor = 0;
      this.resize();
    } else if (this.highFor >= 3 && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale + 0.05);
      this.highFor = 0;
      this.resize();
    }
  }

  private frameNo = 0;

  render(dt: number) {
    this.adapt(dt);
    this.rig.update(dt);
    // below Ultra, refresh the shadow map every other frame: moving shadows at 30 Hz are hard to spot
    const sm = this.renderer.shadowMap;
    sm.autoUpdate = false;
    sm.needsUpdate = this.quality === 'ultra' || this.frameNo++ % 2 === 0;
    this.post.composer.render(dt);
  }
}
