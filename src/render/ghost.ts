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
import type { DoorSpec, Rect } from '../sim/state';
import type { ItemType } from '../sim/catalog';
import { itemFootprint, spotsFor } from '../sim/build';
import { buildItemMesh } from './itemMeshes';
import { placeObject } from './itemsView';

const OK = new THREE.Color('#38f0c0');
const BAD = new THREE.Color('#ff4d6d');

/** Translucent previews for room and item placement. */
export class Ghost {
  readonly group = new THREE.Group();
  private tiles: THREE.InstancedMesh;
  private tileMat: THREE.MeshBasicMaterial;
  private border: THREE.InstancedMesh;
  private borderMat: THREE.MeshBasicMaterial;
  private door: THREE.Mesh;
  private doorMat: THREE.MeshBasicMaterial;
  private item: THREE.Group | null = null;
  private itemType: ItemType | null = null;
  private ghostMat: THREE.MeshStandardMaterial;
  private spots: THREE.InstancedMesh;
  private pulse = 0;

  constructor(scene: THREE.Scene) {
    this.tileMat = new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.5, depthWrite: false });
    this.tiles = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.94, 0.94).rotateX(-Math.PI / 2), this.tileMat, 400);
    this.tiles.count = 0;
    this.tiles.renderOrder = 30;
    this.tiles.frustumCulled = false;
    this.borderMat = new THREE.MeshBasicMaterial({ color: OK.clone().multiplyScalar(2.2) });
    this.border = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.borderMat, 4);
    this.border.renderOrder = 31;
    this.border.frustumCulled = false;
    this.doorMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd447').multiplyScalar(2.5), transparent: true, opacity: 0.95, depthTest: false });
    const arrow = new THREE.ConeGeometry(0.22, 0.42, 3).rotateX(Math.PI / 2);
    this.door = new THREE.Mesh(arrow, this.doorMat);
    this.door.renderOrder = 32;
    this.ghostMat = new THREE.MeshStandardMaterial({ color: OK, transparent: true, opacity: 0.55, emissive: OK, emissiveIntensity: 0.6, depthWrite: false });
    this.spots = new THREE.InstancedMesh(new THREE.RingGeometry(0.16, 0.24, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, depthWrite: false }), 8);
    this.spots.count = 0;
    this.spots.renderOrder = 33;
    this.group.add(this.tiles, this.border, this.door, this.spots);
    scene.add(this.group);
    this.hide();
  }

  hide() {
    this.tiles.count = 0;
    this.border.visible = false;
    this.door.visible = false;
    this.spots.count = 0;
    if (this.item) this.item.visible = false;
  }

  private colorize(ok: boolean) {
    const c = ok ? OK : BAD;
    this.tileMat.color.copy(c);
    this.borderMat.color.copy(c).multiplyScalar(2.2);
    this.ghostMat.color.copy(c);
    this.ghostMat.emissive.copy(c);
  }

  /** Room footprint preview; door optional. */
  room(rect: Rect, door: DoorSpec | null, ok: boolean) {
    this.colorize(ok);
    if (this.item) this.item.visible = false;
    this.spots.count = 0;
    const m = new THREE.Matrix4();
    let n = 0;
    for (let z = rect.z; z < rect.z + rect.h; z++) for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (n >= 400) break;
      m.makeTranslation(x + 0.5, 0.04, z + 0.5);
      this.tiles.setMatrixAt(n++, m);
    }
    this.tiles.count = n;
    this.tiles.instanceMatrix.needsUpdate = true;
    const t = 0.09, x0 = rect.x, z0 = rect.z, x1 = rect.x + rect.w, z1 = rect.z + rect.h;
    const bars: [number, number, number, number][] = [
      [(x0 + x1) / 2, z0, rect.w + t, t], [(x0 + x1) / 2, z1, rect.w + t, t], [x0, (z0 + z1) / 2, t, rect.h + t], [x1, (z0 + z1) / 2, t, rect.h + t],
    ];
    bars.forEach(([cx, cz, sx, sz], i) => {
      m.compose(new THREE.Vector3(cx, 0.08, cz), new THREE.Quaternion(), new THREE.Vector3(sx, 0.12, sz));
      this.border.setMatrixAt(i, m);
    });
    this.border.instanceMatrix.needsUpdate = true;
    this.border.visible = true;
    if (door) {
      const v = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[door.dir];
      this.door.position.set(door.x + 0.5 + v[0] * 0.55, 0.35, door.z + 0.5 + v[1] * 0.55);
      this.door.rotation.set(0, Math.atan2(v[0], v[1]), 0);
      this.door.visible = true;
    } else this.door.visible = false;
  }

  /** Item preview at its footprint origin. */
  itemAt(type: ItemType, x: number, z: number, rot: number, ok: boolean) {
    this.colorize(ok);
    this.border.visible = false;
    this.door.visible = false;
    if (this.itemType !== type) {
      if (this.item) {
        this.group.remove(this.item);
        this.item.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      }
      this.item = buildItemMesh(type);
      this.item.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) { mesh.material = this.ghostMat; mesh.castShadow = false; }
        if ((o as THREE.LineSegments).isLineSegments) o.visible = false;
      });
      this.itemType = type;
      this.group.add(this.item);
    }
    this.item!.visible = true;
    placeObject(this.item!, { type, x, z, rot });
    this.item!.position.y = 0.02 + Math.sin(this.pulse * 4) * 0.03;
    const cells = itemFootprint(type, x, z, rot);
    const m = new THREE.Matrix4();
    cells.forEach((c, i) => {
      m.makeTranslation(c.x + 0.5, 0.03, c.z + 0.5);
      this.tiles.setMatrixAt(i, m);
    });
    this.tiles.count = cells.length;
    this.tiles.instanceMatrix.needsUpdate = true;
    const spots = spotsFor(type, x, z, rot);
    spots.forEach((s, i) => {
      m.makeTranslation(s.ax, 0.05, s.az);
      this.spots.setMatrixAt(i, m);
    });
    this.spots.count = spots.length;
    this.spots.instanceMatrix.needsUpdate = true;
  }

  update(dt: number) {
    this.pulse += dt;
    this.tileMat.opacity = 0.42 + Math.sin(this.pulse * 5) * 0.1;
  }
}
