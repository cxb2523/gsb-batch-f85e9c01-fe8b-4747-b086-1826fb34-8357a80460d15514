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
import { releaseShadowMap } from './quality';

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 p = projectionMatrix * viewMatrix * vec4((modelMatrix * vec4(position, 1.0)).xyz, 1.0);
  gl_Position = p.xyww;
}`;

const frag = /* glsl */ `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 groundCol;
uniform vec3 sunDir;
uniform vec3 sunCol;
uniform vec3 moonDir;
uniform float night;
uniform float time;
varying vec3 vDir;

float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(vec3(i, 1.0)), b = hash(vec3(i + vec2(1, 0), 1.0));
  float c = hash(vec3(i + vec2(0, 1), 1.0)), d = hash(vec3(i + vec2(1, 1), 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55));
  col = mix(col, groundCol, smoothstep(0.0, -0.2, h));
  float sd = max(dot(d, sunDir), 0.0);
  col += sunCol * (pow(sd, 900.0) * 30.0 + pow(sd, 12.0) * 0.6 + pow(sd, 3.0) * 0.12) * (1.0 - night);
  float md = max(dot(d, moonDir), 0.0);
  col += vec3(0.75, 0.85, 1.0) * (smoothstep(0.9995, 0.9998, md) * 6.0 + pow(md, 60.0) * 0.25) * night;
  if (h > 0.0) {
    vec3 sp = floor(d * 380.0);
    float s = hash(sp);
    float tw = 0.6 + 0.4 * sin(time * 3.0 + s * 50.0);
    col += vec3(1.0, 0.95, 0.85) * step(0.9975, s) * tw * night * smoothstep(0.0, 0.25, h) * 2.5;
    vec2 cp = d.xz / (h + 0.08) * 1.6 + vec2(time * 0.01, time * 0.004);
    float c = smoothstep(0.45, 0.8, fbm(cp));
    vec3 cloudCol = mix(vec3(1.0, 0.98, 0.95), sunCol * 0.9 + 0.2, 0.25) * (1.0 - night * 0.85);
    col = mix(col, cloudCol, c * 0.75 * smoothstep(0.0, 0.2, h));
  }
  gl_FragColor = vec4(col, 1.0);
}`;

const lerpC = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, t);

const C = {
  dayZenith: new THREE.Color('#3a8ee8'), dayHorizon: new THREE.Color('#bfe6ff'),
  duskZenith: new THREE.Color('#41428f'), duskHorizon: new THREE.Color('#ff9a62'),
  nightZenith: new THREE.Color('#050a1e'), nightHorizon: new THREE.Color('#1b2a52'),
  ground: new THREE.Color('#5c7d47'),
  sunNoon: new THREE.Color('#fff3dc'), sunLow: new THREE.Color('#ff9a4d'),
  moon: new THREE.Color('#7f9dff'),
  hemiSkyDay: new THREE.Color('#cfe8ff'), hemiSkyNight: new THREE.Color('#4a63c9'),
  hemiGround: new THREE.Color('#d9b98d'), hemiGroundNight: new THREE.Color('#2b2a3d'),
};

export class Sky {
  readonly dome: THREE.Mesh;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly fill: THREE.DirectionalLight;
  private mat: THREE.ShaderMaterial;
  /** 0 = full day, 1 = full night */
  night = 0;
  /** 0 clear .. 1 stormy; dims the sun and greys the sky */
  overcast = 0;
  /** 0 at night, 1 at noon */
  daylight = 1;
  sunDir = new THREE.Vector3();
  private center = new THREE.Vector3(24, 0, 20);

  constructor(private scene: THREE.Scene, shadowSize: number) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, side: THREE.BackSide, depthWrite: false,
      uniforms: {
        zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, groundCol: { value: C.ground.clone() },
        sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() }, moonDir: { value: new THREE.Vector3(0.3, 0.7, -0.6).normalize() },
        night: { value: 0 }, time: { value: 0 },
      },
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), this.mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = shadowSize > 0;
    this.configureShadow(shadowSize);
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(C.hemiSkyDay, C.hemiGround, 1.1);
    scene.add(this.hemi);
    // soft cool fill from the opposite side so shadowed faces keep shape
    this.fill = new THREE.DirectionalLight(0xbfd8ff, 0.35);
    scene.add(this.fill, this.fill.target);
    scene.fog = new THREE.Fog(C.dayHorizon.clone(), 70, 190);
  }

  configureShadow(size: number) {
    this.sun.castShadow = size > 0;
    if (size <= 0) {
      // Shadows are off: free the old map instead of leaving a dead preset-sized texture
      // resident. three.js allocates a fresh one on the next shadow render.
      releaseShadowMap(this.sun.shadow);
      return;
    }
    const s = this.sun.shadow;
    s.mapSize.set(size, size);
    const cam = s.camera;
    cam.left = -34; cam.right = 34; cam.top = 34; cam.bottom = -34; cam.near = 1; cam.far = 140;
    s.bias = -0.0004;
    s.normalBias = 0.025;
    s.radius = size >= 4096 ? 4 : 3;
    s.blurSamples = 12;
    // Drop the old map so the renderer rebuilds at the new size instead of resizing in place.
    releaseShadowMap(s);
    cam.updateProjectionMatrix();
  }

  /** tod: 0..1 (0.5 noon). Returns night factor. */
  update(tod: number, time: number) {
    const theta = (tod - 0.25) * Math.PI * 2;
    const elev = Math.sin(theta);
    // light comes from screen top-left (west) for most of the day so shadows fall toward the viewer
    this.sunDir.set(-0.8, Math.max(elev, -0.3) * 0.9, -0.45 * Math.cos(theta) + 0.12).normalize();
    const day = THREE.MathUtils.smoothstep(elev, -0.12, 0.25);
    const dusk = 1 - Math.min(1, Math.abs(elev) / 0.35);
    this.night = 1 - day;
    this.daylight = day;

    const grey = new THREE.Color('#8e9aaa');
    const zen = lerpC(lerpC(lerpC(C.nightZenith, C.dayZenith, day), C.duskZenith, dusk * 0.6), grey.clone().multiplyScalar(0.3 + 0.7 * day), this.overcast * 0.8);
    const hor = lerpC(lerpC(lerpC(C.nightHorizon, C.dayHorizon, day), C.duskHorizon, dusk * 0.75), grey.clone().multiplyScalar(0.3 + 0.7 * day), this.overcast * 0.7);
    const u = this.mat.uniforms;
    (u.zenith.value as THREE.Color).copy(zen);
    (u.horizon.value as THREE.Color).copy(hor);
    (u.sunDir.value as THREE.Vector3).copy(this.sunDir);
    const sunCol = lerpC(C.sunLow, C.sunNoon, THREE.MathUtils.smoothstep(elev, 0.0, 0.5));
    (u.sunCol.value as THREE.Color).copy(sunCol);
    u.night.value = this.night;
    u.time.value = time;
    (this.scene.fog as THREE.Fog).color.copy(hor);

    // key light: sun by day, moon by night
    const moonDir = (u.moonDir.value as THREE.Vector3);
    const dir = day > 0.15 ? this.sunDir : moonDir;
    this.sun.position.copy(this.center).addScaledVector(dir, 60);
    this.sun.target.position.copy(this.center);
    this.sun.color.copy(day > 0.15 ? sunCol : C.moon);
    this.sun.intensity = (day > 0.15 ? 0.6 + 1.85 * day : 0.42) * (1 - this.overcast * 0.65);
    this.hemi.color.copy(lerpC(C.hemiSkyNight, C.hemiSkyDay, day));
    this.hemi.groundColor.copy(lerpC(C.hemiGroundNight, C.hemiGround, day));
    this.hemi.intensity = 0.16 + 0.44 * day;
    this.fill.position.copy(this.center).add(new THREE.Vector3(30, 25, 30).multiplyScalar(dir.x > 0 ? -1 : 1));
    this.fill.target.position.copy(this.center);
    this.fill.intensity = 0.15 + 0.1 * day;
    this.scene.environmentIntensity = 0.06 + 0.22 * day;
    return this.night;
  }
}
