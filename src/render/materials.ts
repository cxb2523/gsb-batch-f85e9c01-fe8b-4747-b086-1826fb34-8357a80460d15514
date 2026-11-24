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
import { tex, type TexKind } from './textures';
import type { FloorKind } from '../sim/catalog';

const cache = new Map<string, THREE.Material>();
function memo<T extends THREE.Material>(key: string, make: () => T): T {
  let m = cache.get(key) as T | undefined;
  if (!m) { m = make(); cache.set(key, m); }
  return m;
}

const FLOOR_ROUGH: Record<string, number> = {
  corridor: 0.22, mint: 0.25, white: 0.12, wood: 0.38, plank: 0.55, carpet: 0.95, lino: 0.32, rubber: 0.8,
  grass: 0.95, asphalt: 0.85, paving: 0.75, path: 0.8, cork: 0.7, rose: 0.95, snow: 0.55, sand: 0.95, gravel: 0.95, plaza: 0.7,
};

/** Textured floor/ground material. Geometry UVs must be world xz / texture scale. */
export function floorMat(kind: FloorKind | Extract<TexKind, 'grass' | 'asphalt' | 'paving' | 'path' | 'snow' | 'sand' | 'gravel' | 'plaza'>): THREE.MeshStandardMaterial {
  return memo(`floor:${kind}`, () => {
    const t = tex(kind as TexKind);
    const m = new THREE.MeshStandardMaterial({
      map: t.map, normalMap: t.normalMap, roughness: FLOOR_ROUGH[kind] ?? 0.5, metalness: 0,
      normalScale: new THREE.Vector2(0.6, 0.6),
    });
    if (t.roughnessMap) { m.roughnessMap = t.roughnessMap; m.roughness = 1; }
    if (kind === 'corridor' || kind === 'white' || kind === 'mint') m.envMapIntensity = 1.3;
    return m;
  });
}

export function texScale(kind: TexKind) {
  return tex(kind).scale;
}

/** Glossy vinyl-toy plastic. White base so instance colours show true. */
export function vinyl(): THREE.MeshPhysicalMaterial {
  return memo('vinyl', () => new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.42, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.12, sheen: 0.25, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xffffff),
  }));
}

export function plastic(color: THREE.ColorRepresentation, roughness = 0.35, clearcoat = 0.7): THREE.MeshPhysicalMaterial {
  const c = new THREE.Color(color).getHexString();
  return memo(`plastic:${c}:${roughness}:${clearcoat}`, () => new THREE.MeshPhysicalMaterial({ color, roughness, clearcoat, clearcoatRoughness: 0.15 }));
}

export function metal(color: THREE.ColorRepresentation, roughness = 0.25): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color).getHexString();
  return memo(`metal:${c}:${roughness}`, () => new THREE.MeshStandardMaterial({ color, roughness, metalness: 1 }));
}

export function matte(color: THREE.ColorRepresentation, roughness = 0.8): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color).getHexString();
  return memo(`matte:${c}:${roughness}`, () => new THREE.MeshStandardMaterial({ color, roughness }));
}

/** Emissive surface; intensity > 1 drives bloom. */
export function glow(color: THREE.ColorRepresentation, intensity = 3): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color).getHexString();
  return memo(`glow:${c}:${intensity}`, () => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity, roughness: 0.4 }));
}

export function glass(tint: THREE.ColorRepresentation = 0xcfeeff, opacity = 0.28): THREE.MeshPhysicalMaterial {
  const c = new THREE.Color(tint).getHexString();
  return memo(`glass:${c}:${opacity}`, () => new THREE.MeshPhysicalMaterial({
    color: tint, roughness: 0.04, metalness: 0, transparent: true, opacity, clearcoat: 1, clearcoatRoughness: 0.02,
    envMapIntensity: 2.2, depthWrite: false, side: THREE.DoubleSide,
  }));
}

export function wood(color: THREE.ColorRepresentation = '#c98a52'): THREE.MeshStandardMaterial {
  const c = new THREE.Color(color).getHexString();
  return memo(`wood:${c}`, () => {
    const t = tex('plank');
    return new THREE.MeshStandardMaterial({ color, map: t.map, normalMap: t.normalMap, roughness: 0.55 });
  });
}
