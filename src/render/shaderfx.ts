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

/** Uniforms shared by every patched material; updated once per frame by the view. */
export const fx = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  uNight: { value: 0 },
};

type Shader = Parameters<NonNullable<THREE.Material['onBeforeCompile']>>[0];

function patch(mat: THREE.Material, key: string, f: (s: Shader) => void) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (s, r) => {
    prev?.call(mat, s, r);
    s.uniforms.uTime = fx.uTime;
    s.uniforms.uWind = fx.uWind;
    s.uniforms.uNight = fx.uNight;
    s.vertexShader = 'uniform float uTime;\nuniform float uWind;\nuniform float uNight;\n' + s.vertexShader;
    s.fragmentShader = 'uniform float uTime;\nuniform float uWind;\nuniform float uNight;\n' + s.fragmentShader;
    f(s);
  };
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + key;
}

const PROJECT_INSTANCED = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
`;

/**
 * Wind sway for instanced vegetation. `heightAttr`: 'uv' uses uv.y as bend weight
 * (grass blades), 'local' uses local y / height (tree foliage).
 */
export function windSway(mat: THREE.Material, amp: number, mode: 'uv' | 'local', height = 1) {
  patch(mat, `wind:${mode}:${amp}:${height}`, (s) => {
    s.vertexShader = s.vertexShader
      .replace('void main() {', 'varying float vBend;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        PROJECT_INSTANCED + /* glsl */ `
  float bend = ${mode === 'uv' ? 'uv.y * uv.y' : `clamp(position.y / ${height.toFixed(2)}, 0.0, 1.0)`};
  vBend = ${mode === 'uv' ? 'uv.y' : '1.0'};
  vec3 ip = mvPosition.xyz;
  float gust = sin(uTime * 0.6 + ip.x * 0.05) * 0.5 + 0.5;
  float w = sin(uTime * 1.9 + ip.x * 0.42 + ip.z * 0.31) * 0.6 + sin(uTime * 3.7 + ip.x * 1.7 + ip.z * 0.9) * 0.25;
  mvPosition.x += w * bend * ${amp.toFixed(3)} * uWind * (0.5 + gust);
  mvPosition.z += w * bend * ${(amp * 0.6).toFixed(3)} * uWind * (0.5 + gust);
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;
`,
      );
    if (mode === 'uv') {
      s.fragmentShader = s.fragmentShader
        .replace('void main() {', 'varying float vBend;\nvoid main() {')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= mix(0.38, 1.18, vBend);');
    }
  });
}

/** World-space wainscot, baseboard and darker wall caps for instanced wall slabs. */
export function wallShading(mat: THREE.Material, height: number) {
  patch(mat, `wall:${height}`, (s) => {
    s.vertexShader = s.vertexShader
      .replace('void main() {', 'varying vec3 vWPos;\nvarying vec3 vWNorm;\nvoid main() {')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
  vec4 wp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
  #endif
  wp = modelMatrix * wp;
  vWPos = wp.xyz;
  vec3 wn = objectNormal;
  #ifdef USE_INSTANCING
    wn = mat3( instanceMatrix ) * wn;
  #endif
  vWNorm = normalize( mat3( modelMatrix ) * wn );`,
      );
    s.fragmentShader = s.fragmentShader
      .replace('void main() {', 'varying vec3 vWPos;\nvarying vec3 vWNorm;\nvoid main() {')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float y = vWPos.y;
  float cap = step(0.6, vWNorm.y);
  float wains = 1.0 - step(0.92, y);
  float rail = step(0.86, y) * (1.0 - step(0.96, y));
  float base = 1.0 - step(0.12, y);
  vec3 c = diffuseColor.rgb;
  c *= mix(1.0, 0.86, wains);
  c = mix(c, vec3(1.0), rail * 0.55);
  c = mix(c, c * 0.55, base);
  // faint vertical stripes on the upper wall
  float along = abs(vWNorm.x) > 0.5 ? vWPos.z : vWPos.x;
  c *= 1.0 - (1.0 - wains) * step(0.5, fract(along * 4.0)) * 0.035;
  c = mix(c, vec3(0.22, 0.2, 0.26), cap * 0.85);
  diffuseColor.rgb = c;`,
      );
  });
}

/** Triplanar world-space UVs for a mapped material (brick, plinths). */
export function worldMapped(mat: THREE.MeshStandardMaterial, scale: number) {
  patch(mat, `wmap:${scale}`, (s) => {
    s.vertexShader = s.vertexShader
      .replace('void main() {', 'varying vec3 vWP;\nvarying vec3 vWN;\nvoid main() {')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
  vec4 wp2 = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    wp2 = instanceMatrix * wp2;
  #endif
  wp2 = modelMatrix * wp2;
  vWP = wp2.xyz;
  vec3 wn2 = objectNormal;
  #ifdef USE_INSTANCING
    wn2 = mat3( instanceMatrix ) * wn2;
  #endif
  vWN = normalize( mat3( modelMatrix ) * wn2 );`,
      );
    const uvExpr = `(abs(vWN.y) > 0.5 ? vWP.xz : (abs(vWN.x) > 0.5 ? vWP.zy : vWP.xy)) / ${scale.toFixed(2)}`;
    s.fragmentShader = s.fragmentShader
      .replace('void main() {', 'varying vec3 vWP;\nvarying vec3 vWN;\nvoid main() {')
      .replace('#include <map_fragment>', `vec4 sampledDiffuseColor = texture2D( map, ${uvExpr} );\n  diffuseColor *= sampledDiffuseColor;`)
      .replace('#include <normal_fragment_maps>', '');
  });
}
