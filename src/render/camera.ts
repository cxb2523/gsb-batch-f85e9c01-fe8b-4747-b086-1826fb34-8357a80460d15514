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

const damp = (a: number, b: number, lambda: number, dt: number) => a + (b - a) * (1 - Math.exp(-lambda * dt));

/** Sim-game camera: pan (keys / right-drag / middle-drag), zoom to cursor, 90° rotation steps. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3(22, 0, 18);
  private goalTarget = this.target.clone();
  dist = 38;
  private goalDist = 38;
  yaw = Math.PI / 4;
  private goalYaw = Math.PI / 4;
  pitch = THREE.MathUtils.degToRad(52);
  private keys = new Set<string>();
  private drag: { x: number; y: number; ground: THREE.Vector3 } | null = null;
  private shakeAmt = 0;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  bounds = { minX: -2, maxX: 50, minZ: -2, maxZ: 42 };
  onYawStep: ((quadrant: number) => void) | null = null;
  private lastQuadrant = -1;

  constructor(private dom: HTMLElement, aspect: number) {
    this.camera = new THREE.PerspectiveCamera(30, aspect, 0.5, 900);
    this.attach();
    this.apply(0);
  }

  /** yaw snapped to 0..3 (which diagonal the camera looks from) */
  quadrant() {
    const q = Math.round((this.goalYaw - Math.PI / 4) / (Math.PI / 2));
    return ((q % 4) + 4) % 4;
  }

  rotate(dir: 1 | -1) {
    this.goalYaw += (dir * Math.PI) / 2;
  }

  focus(x: number, z: number, dist?: number) {
    this.goalTarget.set(x, 0, z);
    if (dist) this.goalDist = dist;
  }

  /** slow title-screen orbit */
  spin(dt: number) {
    this.goalYaw += dt * 0.07;
    this.yaw = this.goalYaw;
  }

  shake(a: number) {
    this.shakeAmt = Math.min(0.6, this.shakeAmt + a);
  }

  setView(yawQuadrant: number, dist?: number) {
    this.goalYaw = this.yaw = Math.PI / 4 + yawQuadrant * (Math.PI / 2);
    if (dist) this.goalDist = this.dist = dist;
  }

  groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.plane, out) ? out : null;
  }

  private attach() {
    const el = this.dom;
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if (k === 'q') this.rotate(-1);
      if (k === 'e') this.rotate(1);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 1 && e.button !== 2) return;
      const g = this.groundAt(e.clientX, e.clientY);
      if (!g) return;
      this.drag = { x: e.clientX, y: e.clientY, ground: g };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const g = this.groundAt(e.clientX, e.clientY);
      if (!g) return;
      const delta = this.drag.ground.clone().sub(g);
      this.goalTarget.add(delta);
      this.target.add(delta);
      this.apply(0);
    });
    const end = () => { this.drag = null; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 200) * 0.0022);
      const next = THREE.MathUtils.clamp(this.goalDist * f, 9, 85);
      const g = this.groundAt(e.clientX, e.clientY);
      if (g) {
        const k = 1 - next / this.goalDist;
        this.goalTarget.addScaledVector(g.sub(this.goalTarget), k * 0.9);
      }
      this.goalDist = next;
    }, { passive: false });
  }

  update(dt: number) {
    const sp = this.goalDist * 0.9 * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.goalYaw), 0, -Math.cos(this.goalYaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const k = this.keys;
    if (k.has('w') || k.has('arrowup')) this.goalTarget.addScaledVector(fwd, sp);
    if (k.has('s') || k.has('arrowdown')) this.goalTarget.addScaledVector(fwd, -sp);
    if (k.has('a') || k.has('arrowleft')) this.goalTarget.addScaledVector(right, -sp);
    if (k.has('d') || k.has('arrowright')) this.goalTarget.addScaledVector(right, sp);
    const b = this.bounds;
    this.goalTarget.x = THREE.MathUtils.clamp(this.goalTarget.x, b.minX, b.maxX);
    this.goalTarget.z = THREE.MathUtils.clamp(this.goalTarget.z, b.minZ, b.maxZ);
    this.apply(dt);
  }

  private apply(dt: number) {
    if (dt > 0) {
      this.target.x = damp(this.target.x, this.goalTarget.x, 10, dt);
      this.target.z = damp(this.target.z, this.goalTarget.z, 10, dt);
      this.dist = damp(this.dist, this.goalDist, 9, dt);
      this.yaw = damp(this.yaw, this.goalYaw, 7, dt);
      this.shakeAmt = Math.max(0, this.shakeAmt - dt * 1.8);
    }
    // closer zoom → slightly lower pitch for a more personal angle
    const zoomT = THREE.MathUtils.clamp((this.dist - 9) / 50, 0, 1);
    const pitch = THREE.MathUtils.lerp(this.pitch - 0.16, this.pitch + 0.06, zoomT);
    const c = this.camera;
    c.position.set(
      this.target.x + Math.sin(this.yaw) * Math.cos(pitch) * this.dist,
      this.target.y + Math.sin(pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * Math.cos(pitch) * this.dist,
    );
    if (this.shakeAmt > 0) {
      const s = this.shakeAmt * this.shakeAmt * 0.35;
      c.position.x += (Math.random() - 0.5) * s;
      c.position.y += (Math.random() - 0.5) * s;
    }
    c.lookAt(this.target);
    const q = this.quadrant();
    if (q !== this.lastQuadrant) {
      this.lastQuadrant = q;
      this.onYawStep?.(q);
    }
  }
}
