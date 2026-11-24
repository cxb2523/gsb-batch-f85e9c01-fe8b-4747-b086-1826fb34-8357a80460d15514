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
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { releaseShadowMap, recompileSceneMaterials, disposePostResources } from '../src/render/quality';

describe('releaseShadowMap', () => {
  it('disposes the shadow map and drops the reference so nothing samples a dead texture', () => {
    const map = new THREE.WebGLRenderTarget(1024, 1024);
    let disposed = 0;
    map.addEventListener('dispose', () => disposed++);
    const shadow = { map: map as THREE.RenderTarget | null, mapPass: null };
    expect(releaseShadowMap(shadow)).toBe(true);
    expect(disposed).toBe(1);
    expect(shadow.map).toBeNull();
  });

  it('also frees a leftover VSM distribution map', () => {
    const mapPass = new THREE.WebGLRenderTarget(512, 512);
    let disposed = 0;
    mapPass.addEventListener('dispose', () => disposed++);
    const shadow = { map: null, mapPass: mapPass as THREE.RenderTarget | null };
    expect(releaseShadowMap(shadow)).toBe(true);
    expect(disposed).toBe(1);
    expect(shadow.mapPass).toBeNull();
  });

  it('is a no-op when there is nothing to free', () => {
    const shadow = { map: null, mapPass: null };
    expect(releaseShadowMap(shadow)).toBe(false);
    expect(shadow.map).toBeNull();
  });

  it('can run twice (a quality switch followed by a shadow toggle) without throwing', () => {
    const map = new THREE.WebGLRenderTarget(2048, 2048);
    const shadow = { map: map as THREE.RenderTarget | null, mapPass: null };
    expect(releaseShadowMap(shadow)).toBe(true);
    expect(releaseShadowMap(shadow)).toBe(false);
  });
});

describe('recompileSceneMaterials', () => {
  function sceneWithSharedMaterial() {
    const scene = new THREE.Scene();
    const shared = new THREE.MeshStandardMaterial();
    const own = new THREE.MeshBasicMaterial();
    const multi = new THREE.MeshStandardMaterial();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), shared));
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), shared));
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), own));
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), [multi, new THREE.MeshBasicMaterial()]));
    return { scene, shared, own, multi };
  }

  it('bumps every material in the scene, so pre-existing meshes pick up new shadow state', () => {
    const { scene, shared, own, multi } = sceneWithSharedMaterial();
    expect(recompileSceneMaterials(scene)).toBe(4);
    expect(shared.version).toBe(1);
    expect(own.version).toBe(1);
    expect(multi.version).toBe(1);
  });

  it('ignores objects without a material', () => {
    const scene = new THREE.Scene();
    scene.add(new THREE.Group());
    expect(recompileSceneMaterials(scene)).toBe(0);
  });

  it('touches a shared material only once, even when many meshes use it', () => {
    const { scene, shared } = sceneWithSharedMaterial();
    recompileSceneMaterials(scene);
    recompileSceneMaterials(scene);
    expect(shared.version).toBe(2); // one bump per call, not one per mesh
  });

  it('handles an empty scene', () => {
    expect(recompileSceneMaterials(new THREE.Scene())).toBe(0);
  });
});

describe('disposePostResources', () => {
  // Mirrors how n8ao's N8AOPostPass holds its work: no dispose() of its own, a depth-mip
  // atlas with a render target, and fullscreen quads that hide their material in a mesh.
  // The quad geometry is a module-level singleton shared by every pass, as in n8ao.
  const sharedGeometry = new THREE.BufferGeometry();
  let sharedGeometryDisposals = 0;
  sharedGeometry.addEventListener('dispose', () => sharedGeometryDisposals++);

  function fakeN8aoPass() {
    const target = new THREE.WebGLRenderTarget(64, 64, { type: THREE.FloatType });
    const quadMaterial = new THREE.ShaderMaterial();
    const atlasQuadMaterial = new THREE.ShaderMaterial();
    const atlas = {
      target: target as THREE.RenderTarget | null,
      quad: {
        _mesh: new THREE.Mesh(sharedGeometry, atlasQuadMaterial),
        get material() { return this._mesh.material as THREE.Material; },
        dispose() { this.material.dispose(); sharedGeometry.dispose(); },
      },
      dispose() {
        this.target?.dispose();
        this.target = null;
        this.quad.dispose();
      },
    };
    const quad = {
      _mesh: new THREE.Mesh(sharedGeometry, quadMaterial),
      get material() { return this._mesh.material as THREE.Material; },
      dispose() { this.material.dispose(); sharedGeometry.dispose(); },
    };
    const pass = {
      depthMipAtlas: atlas,
      effectShaderQuad: quad,
      writeTargetInternal: new THREE.WebGLRenderTarget(8, 8),
      configuration: { aoSamples: 16 },
      width: 8,
      height: 8,
    };
    const disposed = { target: 0, quadMaterial: 0, atlasQuadMaterial: 0 };
    target.addEventListener('dispose', () => disposed.target++);
    quadMaterial.addEventListener('dispose', () => disposed.quadMaterial++);
    atlasQuadMaterial.addEventListener('dispose', () => disposed.atlasQuadMaterial++);
    return { pass, atlas, target, disposed };
  }

  it('frees the depth-mip atlas render target that the composer cannot see', () => {
    const { pass, disposed } = fakeN8aoPass();
    disposePostResources(pass);
    expect(disposed.target).toBe(1);
  });

  it('frees the fullscreen-quad shader materials', () => {
    const { pass, disposed } = fakeN8aoPass();
    disposePostResources(pass);
    expect(disposed.quadMaterial).toBe(1);
    expect(disposed.atlasQuadMaterial).toBe(1);
  });

  it('never disposes the module-shared fullscreen geometry', () => {
    const before = sharedGeometryDisposals;
    const { pass } = fakeN8aoPass();
    disposePostResources(pass);
    disposePostResources(pass);
    expect(sharedGeometryDisposals).toBe(before);
  });

  it('leaves properties the composer already owns alone', () => {
    const { pass } = fakeN8aoPass();
    let renderTargetDisposed = 0;
    (pass.writeTargetInternal as THREE.RenderTarget).addEventListener('dispose', () => renderTargetDisposed++);
    disposePostResources(pass);
    expect(renderTargetDisposed).toBe(0);
  });

  it('tolerates passes with none of these shapes, and null/undefined', () => {
    expect(() => disposePostResources({})).not.toThrow();
    expect(() => disposePostResources({ configuration: {}, width: 1 })).not.toThrow();
    expect(() => disposePostResources(null)).not.toThrow();
    expect(() => disposePostResources(undefined)).not.toThrow();
    expect(() => disposePostResources(42)).not.toThrow();
  });

  it('does not free the same material twice when a pass shares it across fields', () => {
    const material = new THREE.ShaderMaterial();
    let disposed = 0;
    material.addEventListener('dispose', () => disposed++);
    const mesh = (m: THREE.Material) => ({ _mesh: new THREE.Mesh(sharedGeometry, m), get material() { return this._mesh.material; } });
    disposePostResources({ a: mesh(material), b: mesh(material) });
    expect(disposed).toBe(1);
  });
});
