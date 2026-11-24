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
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, TiltShiftEffect, ToneMappingEffect, ToneMappingMode,
  HueSaturationEffect, BrightnessContrastEffect, VignetteEffect, NoiseEffect, SMAAEffect, SMAAPreset, KernelSize, BlendFunction, type Effect,
} from 'postprocessing';
// @ts-expect-error n8ao ships without type declarations
import { N8AOPostPass } from 'n8ao';
import type { Preset } from './engine';
import { disposePostResources } from './quality';

export interface PostStack {
  composer: EffectComposer;
  bloom: BloomEffect | null;
  tilt: TiltShiftEffect | null;
  ao: { configuration: Record<string, unknown>; setSize(w: number, h: number): void } | null;
  dispose(): void;
}

export function buildPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, p0: Preset, w: number, h: number): PostStack {
  const off = new Set((new URLSearchParams(location.search).get('off') ?? '').split(','));
  const p: Preset = { ...p0, ao: off.has('ao') ? 'off' : p0.ao, bloom: p0.bloom && !off.has('bloom'), tiltShift: p0.tiltShift && !off.has('tilt'), smaa: p0.smaa && !off.has('smaa') };
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  composer.addPass(new RenderPass(scene, camera));
  let ao: PostStack['ao'] = null;
  if (p.ao !== 'off') {
    const n8 = new N8AOPostPass(scene, camera, w, h);
    const c = n8.configuration;
    c.aoRadius = 1.6;
    c.distanceFalloff = 0.9;
    c.intensity = 3.2;
    c.color = new THREE.Color('#2a1a2e');
    c.halfRes = p.ao === 'half';
    c.depthAwareUpsampling = true;
    c.gammaCorrection = false;
    n8.setQualityMode(new URLSearchParams(location.search).get('aoq') ?? (p.ao === 'full' ? 'High' : 'Medium'));
    const dbg = new URLSearchParams(location.search);
    if (dbg.has('aoit')) c.denoiseIterations = Number(dbg.get('aoit'));
    if (dbg.has('aoup')) c.depthAwareUpsampling = dbg.get('aoup') === '1';
    composer.addPass(n8);
    ao = n8;
  }
  let bloom: BloomEffect | null = null;
  if (p.bloom) {
    bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 1.35, luminanceSmoothing: 0.35, intensity: 1.2, radius: 0.7, levels: p.ao === 'full' ? 7 : 5 });
    composer.addPass(new EffectPass(camera, bloom));
  }
  let tilt: TiltShiftEffect | null = null;
  if (p.tiltShift) {
    tilt = new TiltShiftEffect({ offset: 0.0, rotation: 0, focusArea: 0.95, feather: 0.6, kernelSize: KernelSize.SMALL, resolutionScale: 0.5 });
    composer.addPass(new EffectPass(camera, tilt));
  }
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
  const sat = new HueSaturationEffect({ saturation: 0.2 });
  const bc = new BrightnessContrastEffect({ brightness: -0.01, contrast: 0.1 });
  const vig = new VignetteEffect({ darkness: 0.42, offset: 0.32 });
  const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
  noise.blendMode.opacity.value = 0.05;
  // grading, vignette and grain share one pass; SMAA runs last on the final LDR image
  const grade: Effect[] = off.has('grade') ? [tone] : [tone, sat, bc];
  if (!off.has('vig')) grade.push(vig, noise);
  composer.addPass(new EffectPass(camera, ...grade));
  if (p.smaa) composer.addPass(new EffectPass(camera, new SMAAEffect({ preset: p.ao === 'full' ? SMAAPreset.HIGH : SMAAPreset.MEDIUM })));
  return {
    composer, bloom, tilt, ao,
    dispose() {
      // Composer.dispose() only walks properties it recognises as render targets,
      // materials, textures or passes. The n8ao pass keeps its targets and shader
      // materials inside plain helper objects and has no dispose() of its own, so free
      // those first or every rebuild strands a float render target plus its programs.
      for (const pass of composer.passes) disposePostResources(pass);
      composer.dispose();
    },
  };
}
