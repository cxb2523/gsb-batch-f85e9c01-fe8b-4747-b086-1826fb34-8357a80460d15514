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
import type { World } from '../sim/world';
import type { Litter } from '../sim/state';
import { plastic } from './materials';

const CAN_COLS = ['#ff5a5f', '#3ec1d3', '#ffd447', '#7b61ff'].map((c) => new THREE.Color(c));
const WRAP_COLS = ['#ffffff', '#ffb3d1', '#c9efe7', '#ffe39e'].map((c) => new THREE.Color(c));

/** Cans, crumpled wrappers and spilt-water puddles on the floor. */
export class LitterView {
  private cans: THREE.InstancedMesh;
  private wraps: THREE.InstancedMesh;
  private puddles: THREE.InstancedMesh;
  private sig = '';

  constructor(scene: THREE.Scene) {
    this.cans = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.075, 0.075, 0.22, 14).rotateZ(Math.PI / 2), plastic('#ffffff', 0.25, 1), 200);
    this.wraps = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.11, 0), plastic('#ffffff', 0.6, 0.3), 200);
    this.puddles = new THREE.InstancedMesh(new THREE.CircleGeometry(0.32, 20).rotateX(-Math.PI / 2), new THREE.MeshPhysicalMaterial({ color: '#9fd9ff', roughness: 0.02, transparent: true, opacity: 0.55, clearcoat: 1, envMapIntensity: 2 }), 200);
    for (const m of [this.cans, this.wraps, this.puddles]) {
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = m !== this.puddles;
      m.receiveShadow = true;
      scene.add(m);
    }
    this.cans.setColorAt(0, CAN_COLS[0]);
    this.wraps.setColorAt(0, WRAP_COLS[0]);
  }

  sync(world: World) {
    const list = world.state.litter;
    const sig = list.map((l) => l.id).join(',');
    if (sig === this.sig) return;
    this.sig = sig;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const put = (mesh: THREE.InstancedMesh, l: Litter, i: number, y: number, s: number, cols?: THREE.Color[]) => {
      q.setFromEuler(new THREE.Euler(l.id * 1.3, l.id * 2.7, l.id * 0.7));
      if (mesh === this.puddles) q.identity();
      m.compose(new THREE.Vector3(l.x, y, l.z), mesh === this.cans ? new THREE.Quaternion().setFromEuler(new THREE.Euler(0, l.id * 2.7, 0)) : q, new THREE.Vector3(s, s * (mesh === this.puddles ? 1 : 0.8 + (l.id % 3) * 0.1), s));
      mesh.setMatrixAt(i, m);
      if (cols) mesh.setColorAt(i, cols[l.id % cols.length]);
    };
    let nc = 0, nw = 0, np = 0;
    for (const l of list) {
      if (l.kind === 'can') put(this.cans, l, nc++, 0.075, 1, CAN_COLS);
      else if (l.kind === 'wrapper') put(this.wraps, l, nw++, 0.08, 1 + (l.id % 4) * 0.1, WRAP_COLS);
      else put(this.puddles, l, np++, 0.012, 0.7 + (l.id % 5) * 0.12);
    }
    this.cans.count = nc;
    this.wraps.count = nw;
    this.puddles.count = np;
    for (const mesh of [this.cans, this.wraps, this.puddles]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
