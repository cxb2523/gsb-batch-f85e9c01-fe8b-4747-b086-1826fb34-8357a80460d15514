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
 * Resource bookkeeping for graphics-preset changes.
 *
 * Everything here is plain scene-graph plumbing with no renderer or DOM dependency, so
 * the same code both drives `Engine.setQuality` and can be exercised from unit tests.
 */

/** The slice of a light's shadow state we need to free. */
export interface ShadowTargets {
  map: THREE.RenderTarget | null;
  mapPass: THREE.RenderTarget | null;
}

/**
 * Release a light's shadow map and drop the reference, so nothing keeps sampling a
 * texture that is about to be (or has been) deleted. three.js allocates a fresh map on
 * the next shadow render. Returns whether anything was actually freed.
 */
export function releaseShadowMap(shadow: ShadowTargets): boolean {
  let freed = false;
  if (shadow.map) {
    // A render target owns its depth texture, so this frees both attachments.
    shadow.map.dispose();
    shadow.map = null;
    freed = true;
  }
  if (shadow.mapPass) {
    // Only used by VSM, but free it whenever it exists so a preset change never strands it.
    shadow.mapPass.dispose();
    shadow.mapPass = null;
    freed = true;
  }
  return freed;
}

/**
 * Mark every material reachable from `root` for recompilation, so meshes that already
 * exist pick up the new shadow state instead of only objects built later. Materials are
 * shared, so each is bumped once. Returns the number of distinct materials touched.
 */
export function recompileSceneMaterials(root: THREE.Object3D): number {
  const seen = new Set<THREE.Material>();
  root.traverse((o) => {
    const material = (o as THREE.Mesh).material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) {
      if (seen.has(m)) continue;
      seen.add(m);
      m.needsUpdate = true;
    }
  });
  return seen.size;
}

interface Disposable {
  dispose(): void;
}

/**
 * Free GPU resources that a post-processing pass keeps in plain helper objects, which
 * `postprocessing`'s shallow `Pass.dispose()` cannot see.
 *
 * `Pass.dispose()` only frees own properties that are `instanceof` RenderTarget, Material,
 * Texture or Pass. The n8ao AO pass has no `dispose()` of its own and nests its per-frame
 * work in helpers that match none of those shapes:
 *   - `depthMipAtlas` (a `DepthMipAtlas`) owns a FloatType render target;
 *   - every fullscreen quad (`FullScreenTriangle`) hides its shader material inside a
 *     private mesh.
 * Freeing those is what stops `renderer.info.memory.textures` from creeping up on every
 * quality switch.
 *
 * Deliberately does NOT call `DepthMipAtlas.dispose()` or `FullScreenTriangle.dispose()`:
 * both end in `geometry.dispose()` on `FullScreenTriangle`'s *module-level shared*
 * geometry, so calling them per rebuild would tear down a singleton every other pass is
 * using. Only the render target and the per-pass materials are freed here.
 *
 * Safe on passes that own none of these shapes, and idempotent within a call.
 */
export function disposePostResources(pass: unknown): void {
  if (typeof pass !== 'object' || pass === null) return;
  const fields = pass as Record<string, unknown>;
  const freed = new Set<Disposable>();

  const free = (d: Disposable | undefined) => {
    if (!d || freed.has(d)) return;
    freed.add(d);
    d.dispose();
  };
  const freeQuadMaterial = (quad: unknown) => {
    if (typeof quad !== 'object' || quad === null) return;
    const q = quad as Record<string, unknown>;
    if (q._mesh) free(q.material as Disposable | undefined);
  };

  // The depth-mip atlas: its float render target and its quad's material, but not its
  // (shared) geometry.
  const atlas = fields.depthMipAtlas as Record<string, unknown> | null;
  if (typeof atlas === 'object' && atlas !== null) {
    free(atlas.target as Disposable | undefined);
    freeQuadMaterial(atlas.quad);
  }

  for (const key of Object.keys(fields)) {
    if (key === 'depthMipAtlas') continue;
    freeQuadMaterial(fields[key]);
  }
}
