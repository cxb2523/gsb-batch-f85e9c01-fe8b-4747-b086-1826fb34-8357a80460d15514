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
import type { Item } from '../sim/state';
import { rotatedSize } from '../sim/build';
import { buildItemMesh, updateSharedItemFx, type AnimState, type Animate, type Emitter } from './itemMeshes';
import { radialTex } from './textures';

const ROT_ANGLE = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

interface Rec {
  id: number;
  obj: THREE.Group;
  anim?: Animate;
  emitters: Emitter[];
  state: AnimState;
  drop: number;
  baseY: number;
}

export function placeObject(obj: THREE.Object3D, item: Pick<Item, 'type' | 'x' | 'z' | 'rot'>) {
  const sz = rotatedSize(item.type, item.rot);
  obj.position.set(item.x + sz.w / 2, 0, item.z + sz.d / 2);
  obj.rotation.y = ROT_ANGLE[item.rot % 4];
}

/** Keeps one mesh per sim item; drives machine animations from room activity. */
export class ItemsView {
  readonly group = new THREE.Group();
  private recs = new Map<number, Rec>();
  /** called for each emitter each frame so the particle system can spawn */
  onEmit: ((kind: Emitter['kind'], world: THREE.Vector3, rate: number, dt: number) => void) | null = null;
  onLanded: ((x: number, z: number) => void) | null = null;
  private tmp = new THREE.Vector3();
  private blobs: THREE.InstancedMesh;
  private blobVer = '';

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    this.blobs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#1a1030', map: radialTex(), transparent: true, opacity: 0.5, depthWrite: false }), 600);
    this.blobs.count = 0;
    this.blobs.renderOrder = 1;
    this.blobs.frustumCulled = false;
    scene.add(this.blobs);
  }

  private syncBlobs(world: World) {
    const sig = world.state.items.map((i) => i.id).join(',');
    if (sig === this.blobVer) return;
    this.blobVer = sig;
    const m = new THREE.Matrix4();
    let n = 0;
    for (const it of world.state.items) {
      if (n >= 600) break;
      const sz = rotatedSize(it.type, it.rot);
      m.compose(new THREE.Vector3(it.x + sz.w / 2, 0.008, it.z + sz.d / 2), new THREE.Quaternion(), new THREE.Vector3(sz.w * 1.35, 1, sz.d * 1.35));
      this.blobs.setMatrixAt(n++, m);
    }
    this.blobs.count = n;
    this.blobs.instanceMatrix.needsUpdate = true;
  }

  sync(world: World, animateNew: boolean) {
    this.syncBlobs(world);
    const seen = new Set<number>();
    for (const it of world.state.items) {
      seen.add(it.id);
      if (this.recs.has(it.id)) continue;
      const obj = buildItemMesh(it.type);
      placeObject(obj, it);
      this.group.add(obj);
      const rec: Rec = {
        id: it.id, obj, anim: obj.userData.animate, emitters: obj.userData.emitters,
        state: { active: false, night: 0, level: 0 }, drop: animateNew ? 1 : 0, baseY: 0,
      };
      if (animateNew) obj.position.y = 3;
      this.recs.set(it.id, rec);
    }
    for (const [id, rec] of this.recs) {
      if (seen.has(id)) continue;
      this.group.remove(rec.obj);
      rec.obj.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.recs.delete(id);
    }
  }

  update(dt: number, t: number, world: World, night: number) {
    updateSharedItemFx(t, night);
    const busyRooms = new Set<number>();
    for (const p of world.state.patients) if (p.state === 'inRoom' && p.target >= 0) busyRooms.add(p.target);
    for (const it of world.state.items) {
      const rec = this.recs.get(it.id);
      if (!rec) continue;
      const busy = it.roomId !== -1 ? busyRooms.has(it.roomId) || (it.type === 'researchBench' && !!world.state.research.current && world.room(it.roomId)?.staffId !== -1) : it.claims.some((c) => c !== -1 && world.patient(c)?.state === 'atVending');
      const active = busy && !it.broken;
      if (it.broken && this.onEmit) {
        this.tmp.set(rec.obj.position.x, 1.3, rec.obj.position.z);
        this.onEmit('smoke', this.tmp, 3, dt);
        this.onEmit('spark', this.tmp.setY(1.0), 2.5, dt);
      }
      rec.state.active = active;
      rec.state.night = night;
      rec.state.level += ((active ? 1 : 0) - rec.state.level) * (1 - Math.exp(-4 * dt));
      rec.anim?.(t, dt, rec.state);
      if (rec.drop > 0) {
        // drop in from above with a bounce
        rec.drop = Math.max(0, rec.drop - dt * 2.2);
        const p = 1 - rec.drop;
        const bounce = p < 0.6 ? 3 * (1 - (p / 0.6) ** 2) : Math.abs(Math.sin((p - 0.6) * Math.PI * 2.5)) * 0.25 * (1 - p) * 2.5;
        rec.obj.position.y = bounce;
        const squash = p > 0.55 && p < 0.75 ? 1 - Math.sin(((p - 0.55) / 0.2) * Math.PI) * 0.18 : 1;
        rec.obj.scale.set(2 - squash, squash, 2 - squash);
        if (rec.drop === 0) {
          rec.obj.position.y = 0;
          rec.obj.scale.set(1, 1, 1);
        }
        if (p >= 0.6 && p - dt * 2.2 < 0.6) this.onLanded?.(rec.obj.position.x, rec.obj.position.z);
      }
      if (this.onEmit) {
        for (const e of rec.emitters) {
          if (e.whenActive && rec.state.level < 0.3) continue;
          this.tmp.copy(e.at);
          rec.obj.localToWorld(this.tmp);
          this.onEmit(e.kind, this.tmp, e.rate * (e.whenActive ? rec.state.level : 1), dt);
        }
      }
    }
  }
}
