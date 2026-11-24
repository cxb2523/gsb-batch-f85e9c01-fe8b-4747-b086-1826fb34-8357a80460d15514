// Water and ice on the glass. Rain does not fall inside the cabin: it lands on
// the windscreen and windows, sits in beads while the aircraft is slow, and
// once the air over the glass is fast enough to push it, runs up the
// windscreen and back along the side windows in streams. Out of the rain the
// glass dries in the airflow. When the airframe ices (systems.ice), the water
// already on the glass freezes into a static rime layer and stops running;
// warm air thaws it again.
//
// All of that lifecycle lives in ./glass-state.js, which is plain deterministic
// state testable under node. This file only draws that state on the canopy's
// own triangles. Each pane is read flat in the plane it mostly faces
// (windscreen: across and up; side windows: along and up; a bubble canopy's
// roof: across and along), and the water moves in that plane: gravity pulls it
// down, the airflow pushes it the way the air goes over that pane. Three
// layers of streams move at different speeds so they do not slide as one sheet.
import * as THREE from '../vendor/three.module.js';
import { GlassState, CELLS, PACE, PERIOD } from './glass-state.js';

const VERT = /* glsl */`
varying vec3 vPos;
varying vec3 vNrm;
void main() {
  vPos = position;
  vNrm = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
uniform float uWet;
uniform float uFrost;
uniform vec4 uDens;            // beads, stream layers 1..3
uniform vec2 uOff[9];          // per pane kind (windscreen, side, roof) and layer: how far the water has moved
uniform vec2 uDir[3];          // per pane kind: which way the water runs
uniform vec3 uTail[3];         // per pane kind: streak length of each layer, in cells
uniform vec3 uSky;             // what the glass reflects
uniform vec3 uGlint;           // the highlight on a drop
varying vec3 vPos;
varying vec3 vNrm;
vec3 gHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}
// One layer of drops: x body, y dark rim, z highlight, w height within the drop (-1 bottom, 1 top).
// A drop is a small lens: it shows the world upside down, bright sky at its
// foot and dark ground at its crown, with a pin-point highlight.
vec4 drops(vec2 p, float cell, float dens, vec2 dir, float tail, float aa, float seed, float size) {
  vec4 o = vec4(0.0);
  if (dens <= 0.0) return o;
  vec2 q = p / cell, id0 = floor(q);
  float w = max(aa / cell, 0.02);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 id = id0 + vec2(float(i), float(j));
    vec3 h = gHash(mod(id, ${PERIOD}.0) + seed);
    if (h.z > dens) continue;
    vec2 a = id + 0.5 + (h.xy - 0.5) * 0.7;
    float r = mix(0.09, 0.30, h.x * h.y) * size;
    vec2 b = a - dir * tail * (0.6 + 0.8 * h.y);
    vec2 pa = q - a, ba = b - a;
    float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    float rr = mix(r, r * 0.22, t);
    float d = length(pa - ba * t) - rr;
    float body = smoothstep(w, -w, d);
    if (body > o.x) { o.x = body; o.w = clamp((q.y - a.y) / r, -1.0, 1.0) * (1.0 - t); }
    o.y = max(o.y, body * smoothstep(-rr * 0.35 - w, -w * 0.3, d));
    o.z = max(o.z, body * smoothstep(r * 0.20, r * 0.04, length(q - a - vec2(-0.30, 0.42) * r)) * (1.0 - t));
  }
  return o;
}
// ---- frost: static patchy rime with a fine crystal grain
float frHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float frNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = frHash(i);
  float b = frHash(i + vec2(1.0, 0.0));
  float c = frHash(i + vec2(0.0, 1.0));
  float d = frHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float frFbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * frNoise(p); p = p * 2.07 + 11.3; a *= 0.5; }
  return v;
}
void main() {
  if (uWet < 0.002 && uFrost < 0.002) discard;
  vec3 an = abs(normalize(vNrm));
  int k; vec2 p;
  if (an.z > max(an.x, an.y)) { k = 0; p = vPos.xy; }          // windscreen and rear window
  else if (an.x > an.y) { k = 1; p = vPos.zy; }                // side windows
  else { k = 2; p = vPos.xz; }                                 // canopy roof
  float aa = length(fwidth(vPos));
  vec4 d = drops(p, ${CELLS[0]}, uDens.x, vec2(0.0, 1.0), 0.0, aa, 0.0, 1.0);
  vec4 e = drops(p - uOff[k * 3], ${CELLS[1]}, uDens.y, uDir[k], uTail[k].x, aa, 17.0, 0.7);
  if (e.x > d.x) d = vec4(e.x, max(e.y, d.y), max(e.z, d.z), e.w); else d.yz = max(d.yz, e.yz);
  e = drops(p - uOff[k * 3 + 1], ${CELLS[2]}, uDens.z, uDir[k], uTail[k].y, aa, 41.0, 0.6);
  if (e.x > d.x) d = vec4(e.x, max(e.y, d.y), max(e.z, d.z), e.w); else d.yz = max(d.yz, e.yz);
  e = drops(p - uOff[k * 3 + 2], ${CELLS[3]}, uDens.w, uDir[k], uTail[k].z, aa, 73.0, 0.5);
  if (e.x > d.x) d = vec4(e.x, max(e.y, d.y), max(e.z, d.z), e.w); else d.yz = max(d.yz, e.yz);
  // a thin film first, then the drops as lenses, their rims, and the highlights
  vec3 col = uSky * 0.8; float A = 0.03 * uWet;
  vec3 lens = mix(uSky * 1.15, uSky * 0.28, smoothstep(-0.7, 0.6, d.w));
  float a = 0.30 * d.x; col = mix(col, lens, a / max(A + a * (1.0 - A), 1e-4)); A += a * (1.0 - A);
  a = 0.14 * d.y; col = mix(col, vec3(0.0), a / max(A + a * (1.0 - A), 1e-4)); A += a * (1.0 - A);
  a = 0.90 * d.z; col = mix(col, uGlint, a / max(A + a * (1.0 - A), 1e-4)); A += a * (1.0 - A);
  // frost forms where the water was: the same pane space, but its offsets have
  // stopped, so the rime is pinned to the glass. Fine crystalline grain and
  // feathery ridges at moderate alpha: it roughens and whitens the view without
  // ever becoming an opaque sheet.
  if (uFrost > 0.003) {
    float coarse = frFbm(p / 0.05);
    float mid = frFbm(p / 0.012 + 5.0);
    float grain = frNoise(p / 0.003);
    float ridges = 1.0 - abs(2.0 * frFbm(p / 0.018 - 3.0) - 1.0);
    float patchAmt = smoothstep(0.32, 0.70, coarse);
    // A thin widespread rime film, feathery ridge build-up and sparse crystals.
    float aFilm = uFrost * (0.14 + 0.22 * patchAmt) * (0.8 + 0.5 * mid);
    float aFeather = uFrost * ridges * ridges * 0.2;
    float spark = smoothstep(0.86, 0.995, grain);
    float aSpark = spark * uFrost * 0.5;
    float fa = clamp(aFilm + aFeather + aSpark, 0.0, 0.62);
    // Rime reflects the ambient sky like the drops do, so it stays correctly
    // exposed instead of being an unlit constant white; crystal tips catch the
    // same key light as the drop highlights. ACES rolls the bright cores off.
    vec3 frostCol = uSky * (2.6 + 2.6 * grain) + uGlint * aSpark * 1.6;
    col = mix(col, frostCol, fa / max(A + fa * (1.0 - A), 1e-4));
    A += fa * (1.0 - A);
  }
  gl_FragColor = vec4(col, A);
}`;

export class GlassRain {
  constructor(geometry) {
    // The lifecycle state is the single driver for accumulation, flow, freeze and drying.
    this.state = new GlassState();
    this.uniforms = {
      uWet: { value: 0 },
      uFrost: { value: 0 },
      uDens: { value: new THREE.Vector4() },
      uOff: { value: Array.from({ length: 9 }, () => new THREE.Vector2()) },
      uDir: { value: [new THREE.Vector2(0, 1), new THREE.Vector2(1, 0), new THREE.Vector2(0, 1)] },
      uTail: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      uSky: { value: new THREE.Color(0.5, 0.55, 0.6) },
      uGlint: { value: new THREE.Color(1, 1, 1) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geometry, mat);
    this.mesh.renderOrder = 60;          // after the rain outside, which shows through it
    this.mesh.visible = false;
    this.sync();
  }

  // Backwards-compatible read-only view of the liquid wetness.
  get wet() { return this.state.water; }

  // Clear every persistent trace: bound to Restart / new airport / new aircraft.
  reset() {
    this.state.reset();
    this.sync();
  }

  // Copy the deterministic state into three uniforms. Safe to call under node
  // with no colours and no GL context (uniforms are plain objects).
  sync(sky, glint) {
    const s = this.state, U = this.uniforms;
    U.uWet.value = s.water;
    U.uFrost.value = s.frost;
    U.uDens.value.set(s.dens[0], s.dens[1], s.dens[2], s.dens[3]);
    for (let i = 0; i < 9; i++) U.uOff.value[i].set(s.offX[i], s.offY[i]);
    for (let k = 0; k < 3; k++) {
      U.uDir.value[k].set(s.dirX[k], s.dirY[k]);
      U.uTail.value[k].set(s.tail[k * 3], s.tail[k * 3 + 1], s.tail[k * 3 + 2]);
    }
    if (sky && typeof sky.copy === 'function') U.uSky.value.copy(sky);
    if (glint && typeof glint.copy === 'function') U.uGlint.value.copy(glint);
    this.mesh.visible = s.visible;
  }

  // Accepted forms:
  //   update(dt, { rain, ias, ice, oat, sky, glint })
  //   update(dt, rain, ias, ice, oat, sky, glint)
  //   update(dt, rain, ias, sky, glint)                       (legacy signature)
  // dt === 0 is the pause tick: state is untouched.
  update(dt, rain, ias, ice, oat, sky, glint) {
    let input, sk = null, gl = null;
    if (rain !== null && typeof rain === 'object' && rain !== undefined) {
      input = rain; sk = input.sky ?? null; gl = input.glint ?? null;
    } else if (ice && typeof ice === 'object') {
      input = { rain, ias }; sk = ice; gl = oat;               // legacy (sky, glint)
    } else {
      input = { rain, ias, ice, oat }; sk = sky ?? null; gl = glint ?? null;
    }
    this.state.update(dt, input);
    this.sync(sk, gl);
  }

  dispose() { this.mesh.material.dispose(); }
}
