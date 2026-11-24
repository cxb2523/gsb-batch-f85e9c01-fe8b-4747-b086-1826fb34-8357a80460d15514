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
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Grid, WallEdge } from '../sim/grid';
import { ROOMS, type FloorKind } from '../sim/catalog';
import type { World } from '../sim/world';
import { floorMat, glass, matte, plastic, texScale, metal } from './materials';
import { radialTex, rampTex, tex } from './textures';
import { fx, wallShading, worldMapped } from './shaderfx';
import type { Preset } from './engine';

export const WALL_H = 2.4;
const CUT_H = 0.32;
const T = 0.075; // half wall thickness
const SILL = 0.9;
const LINTEL = 2.0;
const DOOR_H = 2.1;
const CORRIDOR_WALL = new THREE.Color('#fbf1e2');

type Space = { kind: 'out' } | { kind: 'corr' } | { kind: 'room'; id: number; color: THREE.Color };

interface EdgeRec {
  key: string;
  axis: 'h' | 'v';
  x: number;
  z: number;
  wall: WallEdge;
  a: Space; // north / west side
  b: Space; // south / east side
  h: number;
  v: number;
  target: number;
  /** instance slots: [mesh, index, part] */
  slots: { mesh: 'wall' | 'brick'; i: number; side: 'a' | 'b'; part: 'full' | 'sill' | 'lintel' | 'header' }[];
  glass?: number;
  mullion?: number;
  shaft?: number;
  door?: DoorRec;
}

interface DoorRec {
  edge?: EdgeRec;
  jambs: THREE.Object3D[];
  group: THREE.Group;
  leaf: THREE.Object3D;
  leaf2?: THREE.Object3D;
  kind: 'room' | 'entrance';
  cx: number;
  cz: number;
  open: number;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function spaceOf(world: World, g: Grid, x: number, z: number): Space {
  if (!g.inBuilding(x, z)) return { kind: 'out' };
  const id = g.room(x, z);
  if (id === -1) return { kind: 'corr' };
  const r = world.room(id);
  return { kind: 'room', id, color: new THREE.Color(r ? ROOMS[r.type].wall : '#ffffff') };
}

const shaftVert = /* glsl */ `
attribute float aOn;
uniform vec3 uLight;
varying float vT;
varying vec2 vUv;
varying float vFacing;
void main() {
  vec4 base = instanceMatrix * vec4(position.x, position.y, 0.0, 1.0);
  vec3 n = normalize(mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
  vFacing = max(0.0, dot(n, normalize(uLight))) * aOn;
  vec3 wp = base.xyz + position.z * uLight;
  vT = position.z;
  vUv = position.xy;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const shaftFrag = /* glsl */ `
uniform float uStrength;
uniform float uTime;
uniform vec3 uColor;
varying float vT;
varying vec2 vUv;
varying float vFacing;
void main() {
  float edge = smoothstep(0.0, 0.25, vUv.x) * smoothstep(1.0, 0.75, vUv.x) * smoothstep(0.0, 0.2, vUv.y) * smoothstep(1.0, 0.8, vUv.y);
  float a = uStrength * vFacing * pow(1.0 - vT, 1.4) * edge;
  a *= 0.8 + 0.2 * sin(uTime * 1.7 + vUv.x * 13.0 + vT * 9.0);
  gl_FragColor = vec4(uColor * a, a);
}`;

export class BuildingView {
  readonly group = new THREE.Group();
  private floorMeshes = new Map<string, THREE.Mesh>();
  private wallMesh: THREE.InstancedMesh;
  private brickMesh: THREE.InstancedMesh;
  private posts: THREE.InstancedMesh;
  private glassMesh: THREE.InstancedMesh;
  private mullions: THREE.InstancedMesh;
  private shafts: THREE.InstancedMesh;
  private shaftMat: THREE.ShaderMaterial;
  private mats: THREE.InstancedMesh;
  private pools: THREE.InstancedMesh;
  private poolMat: THREE.MeshBasicMaterial;
  private contact: THREE.InstancedMesh;
  private edges = new Map<string, EdgeRec>();
  private postList: { x: number; z: number; edges: EdgeRec[] }[] = [];
  private doors: DoorRec[] = [];
  private ver = -1;
  private roomsSig = '';
  private quadrant = 0;
  private dirty = true;
  private first = true;

  constructor(private scene: THREE.Scene, private preset: Preset) {
    scene.add(this.group);
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const wallMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.78 });
    wallShading(wallMat, WALL_H);
    this.wallMesh = new THREE.InstancedMesh(box, wallMat, 3000);
    const brickMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, map: tex('brick').map });
    worldMapped(brickMat, texScale('brick'));
    this.brickMesh = new THREE.InstancedMesh(box, brickMat, 600);
    const postMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 });
    wallShading(postMat, WALL_H);
    this.posts = new THREE.InstancedMesh(box, postMat, 2000);
    this.glassMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), glass('#d9f3ff', 0.22), 200);
    this.mullions = new THREE.InstancedMesh(box, plastic('#ffffff', 0.35, 0.6), 400);
    for (const m of [this.wallMesh, this.brickMesh, this.posts, this.mullions]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
    }
    this.glassMesh.frustumCulled = false;
    this.glassMesh.renderOrder = 3;

    this.shaftMat = new THREE.ShaderMaterial({
      vertexShader: shaftVert, fragmentShader: shaftFrag, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uLight: { value: new THREE.Vector3(1, -1, 0) }, uStrength: { value: 0.3 }, uTime: fx.uTime, uColor: { value: new THREE.Color('#ffe2b0') } },
    });
    const shaftGeo = new THREE.BoxGeometry(1, 1, 1).translate(0.5, 0.5, 0.5);
    this.shafts = new THREE.InstancedMesh(shaftGeo, this.shaftMat, 200);
    this.shafts.geometry.setAttribute('aOn', new THREE.InstancedBufferAttribute(new Float32Array(200), 1));
    this.shafts.frustumCulled = false;
    this.shafts.renderOrder = 4;

    this.mats = new THREE.InstancedMesh(new RoundedBoxGeometry(0.9, 0.03, 0.55, 2, 0.012), plastic('#ffffff', 0.85, 0.1), 200);
    this.mats.receiveShadow = true;
    this.poolMat = new THREE.MeshBasicMaterial({ map: radialTex(), color: '#ffc98a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.poolMat, 300);
    this.pools.renderOrder = 2;
    this.pools.frustumCulled = false;
    // baked contact shading along wall bases: cheap stand-in for screen-space AO
    const strip = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5);
    this.contact = new THREE.InstancedMesh(strip, new THREE.MeshBasicMaterial({ color: '#1a1030', map: rampTex(), transparent: true, opacity: preset.ao === 'off' ? 0.42 : 0.22, depthWrite: false }), 4000);
    this.contact.count = 0;
    this.contact.renderOrder = 1;
    this.contact.frustumCulled = false;
    this.group.add(this.wallMesh, this.brickMesh, this.posts, this.glassMesh, this.mullions, this.shafts, this.mats, this.pools, this.contact);
  }

  setQuadrant(q: number) {
    this.quadrant = q;
    for (const e of this.edges.values()) e.target = this.targetHeight(e);
  }

  /** Adopt a new graphics preset without rebuilding geometry. */
  setPreset(preset: Preset) {
    this.preset = preset;
    // The baked contact strips stand in for screen-space AO, so they get fainter when a
    // preset actually turns AO on.
    (this.contact.material as THREE.MeshBasicMaterial).opacity = preset.ao === 'off' ? 0.42 : 0.22;
  }

  private targetHeight(e: EdgeRec): number {
    const yaw = Math.PI / 4 + this.quadrant * (Math.PI / 2);
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    let near: Space, far: Space;
    if (e.axis === 'h') {
      // a = north (z-1), b = south (z); looking toward -z puts the camera on the south side
      [near, far] = dz < 0 ? [e.b, e.a] : [e.a, e.b];
    } else {
      [near, far] = dx < 0 ? [e.b, e.a] : [e.a, e.b];
    }
    const full = far.kind === 'out' || (near.kind === 'room' && far.kind === 'corr');
    return full ? WALL_H : CUT_H;
  }

  /** Rebuild everything that depends on the grid. Cheap enough to do on every structural change. */
  sync(world: World) {
    const g = world.grid;
    const sig = world.state.rooms.map((r) => r.id).join(',');
    if (g.version === this.ver && sig === this.roomsSig) return;
    this.ver = g.version;
    this.roomsSig = sig;
    this.rebuildFloors(world);
    this.rebuildWalls(world);
    this.rebuildDecor(world);
    this.dirty = true;
    this.first = false;
  }

  private rebuildFloors(world: World) {
    const g = world.grid;
    const byKind = new Map<FloorKind, number[]>();
    for (let z = g.building.z; z < g.building.z + g.building.h; z++) {
      for (let x = g.building.x; x < g.building.x + g.building.w; x++) {
        const id = g.room(x, z);
        const r = id === -1 ? undefined : world.room(id);
        const kind: FloorKind = r ? ROOMS[r.type].floor : 'corridor';
        let arr = byKind.get(kind);
        if (!arr) byKind.set(kind, (arr = []));
        arr.push(x, z);
      }
    }
    for (const m of this.floorMeshes.values()) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.floorMeshes.clear();
    for (const [kind, tiles] of byKind) {
      const n = tiles.length / 2;
      const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), nrm = new Float32Array(n * 12);
      const idx = new Uint32Array(n * 6);
      const sc = texScale(kind);
      for (let i = 0; i < n; i++) {
        const x = tiles[i * 2], z = tiles[i * 2 + 1];
        const v = [x, z, x + 1, z, x + 1, z + 1, x, z + 1];
        for (let k = 0; k < 4; k++) {
          pos.set([v[k * 2], 0.002, v[k * 2 + 1]], i * 12 + k * 3);
          uv.set([v[k * 2] / sc, -v[k * 2 + 1] / sc], i * 8 + k * 2);
          nrm.set([0, 1, 0], i * 12 + k * 3);
        }
        idx.set([i * 4, i * 4 + 3, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 1], i * 6);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, floorMat(kind));
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.floorMeshes.set(kind, mesh);
    }
  }

  private rebuildWalls(world: World) {
    const g = world.grid;
    const old = this.edges;
    this.edges = new Map();
    for (const d of this.doors) {
      this.group.remove(d.group);
      d.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    const oldDoors = new Map(this.doors.map((d) => [`${d.cx},${d.cz}`, d]));
    this.doors = [];
    let nw = 0, nb = 0, ng = 0, nm = 0, ns = 0;
    const shaftOn = this.shafts.geometry.getAttribute('aOn') as THREE.InstancedBufferAttribute;
    for (const [key, wall] of g.walls) {
      const [axis, xs, zs] = key.split(',');
      const x = +xs, z = +zs;
      const a = axis === 'h' ? spaceOf(world, g, x, z - 1) : spaceOf(world, g, x - 1, z);
      const b = axis === 'h' ? spaceOf(world, g, x, z) : spaceOf(world, g, x, z);
      const prev = old.get(key);
      const e: EdgeRec = { key, axis: axis as 'h' | 'v', x, z, wall, a, b, h: 0, v: 0, target: 0, slots: [] };
      e.target = this.targetHeight(e);
      e.h = prev ? prev.h : this.first ? e.target : 0;
      e.v = prev ? prev.v : 0;
      const sides: ('a' | 'b')[] = ['a', 'b'];
      for (const side of sides) {
        const sp = side === 'a' ? a : b;
        const mesh = sp.kind === 'out' ? 'brick' : 'wall';
        const parts: EdgeRec['slots'][number]['part'][] = wall.door ? ['header'] : wall.window ? ['sill', 'lintel'] : ['full'];
        for (const part of parts) {
          const i = mesh === 'brick' ? nb++ : nw++;
          e.slots.push({ mesh, i, side, part });
          if (mesh === 'wall') this.wallMesh.setColorAt(i, sp.kind === 'room' ? sp.color : CORRIDOR_WALL);
        }
      }
      if (wall.window) {
        e.glass = ng++;
        e.mullion = nm++;
        // shafts on windows: inward normal points from the outside space to the inside space
        e.shaft = ns++;
        const inward = new THREE.Vector3();
        const corner = new THREE.Vector3();
        const right = new THREE.Vector3();
        if (e.axis === 'h') {
          inward.set(0, 0, a.kind === 'out' ? 1 : -1);
          corner.set(x, SILL, z);
          right.set(1, 0, 0);
        } else {
          inward.set(b.kind === 'out' ? -1 : 1, 0, 0);
          corner.set(x, SILL, z);
          right.set(0, 0, 1);
        }
        tmpM.makeBasis(right, new THREE.Vector3(0, LINTEL - SILL, 0), inward).setPosition(corner);
        this.shafts.setMatrixAt(e.shaft, tmpM);
        shaftOn.setX(e.shaft, 0);
      }
      if (wall.door) {
        const key2 = `${axis === 'h' ? x + 0.5 : x},${axis === 'h' ? z : z + 0.5}`;
        const d = this.makeDoor(world, e, oldDoors.get(key2));
        d.edge = e;
        e.door = d;
        this.doors.push(d);
        this.group.add(d.group);
      }
      this.edges.set(key, e);
    }
    let nc = 0;
    const width = 0.5;
    for (const e of this.edges.values()) {
      if (e.wall.door) continue;
      for (const side of ['a', 'b'] as const) {
        const sp = side === 'a' ? e.a : e.b;
        // strip runs along the wall and extends away from it into `side`
        let yaw: number;
        let x: number, z: number;
        if (e.axis === 'h') { x = e.x + 0.5; z = e.z + (side === 'a' ? -T : T); yaw = side === 'a' ? Math.PI : 0; }
        else { x = e.x + (side === 'a' ? -T : T); z = e.z + 0.5; yaw = side === 'a' ? -Math.PI / 2 : Math.PI / 2; }
        tmpQ.setFromAxisAngle(Y_AXIS, yaw);
        tmpM.compose(tmpP.set(x, sp.kind === 'out' ? 0.005 : 0.006, z), tmpQ, tmpS.set(1.02, 1, sp.kind === 'out' ? width * 1.3 : width));
        if (nc < 4000) this.contact.setMatrixAt(nc++, tmpM);
      }
    }
    this.contact.count = nc;
    this.contact.instanceMatrix.needsUpdate = true;
    this.wallMesh.count = nw;
    this.brickMesh.count = nb;
    this.glassMesh.count = ng;
    this.mullions.count = nm;
    this.shafts.count = ns;
    shaftOn.needsUpdate = true;
    if (this.wallMesh.instanceColor) this.wallMesh.instanceColor.needsUpdate = true;
    // posts at every grid vertex touched by a wall
    const verts = new Map<string, { x: number; z: number; edges: EdgeRec[] }>();
    const touch = (vx: number, vz: number, e: EdgeRec) => {
      const k = `${vx},${vz}`;
      let v = verts.get(k);
      if (!v) verts.set(k, (v = { x: vx, z: vz, edges: [] }));
      v.edges.push(e);
    };
    for (const e of this.edges.values()) {
      if (e.axis === 'h') { touch(e.x, e.z, e); touch(e.x + 1, e.z, e); } else { touch(e.x, e.z, e); touch(e.x, e.z + 1, e); }
    }
    this.postList = [...verts.values()];
    this.posts.count = this.postList.length;
    const postCol = new THREE.Color('#ffffff');
    this.postList.forEach((p, i) => {
      const room = p.edges.map((e) => (e.a.kind === 'room' ? e.a : e.b.kind === 'room' ? e.b : null)).find((s) => s);
      const outer = p.edges.some((e) => e.a.kind === 'out' || e.b.kind === 'out');
      this.posts.setColorAt(i, outer ? new THREE.Color('#f4ede2') : room && room.kind === 'room' ? room.color : postCol);
    });
    if (this.posts.instanceColor) this.posts.instanceColor.needsUpdate = true;
  }

  private makeDoor(world: World, e: EdgeRec, prev?: DoorRec): DoorRec {
    const group = new THREE.Group();
    const along = e.axis === 'h';
    const cx = along ? e.x + 0.5 : e.x;
    const cz = along ? e.z : e.z + 0.5;
    group.position.set(cx, 0, cz);
    group.rotation.y = along ? 0 : Math.PI / 2;
    if (e.wall.kind === 'outer') {
      // sliding glass panel
      const pane = new THREE.Group();
      const g = new THREE.Mesh(new THREE.BoxGeometry(0.96, DOOR_H + 0.1, 0.04), glass('#bfeaff', 0.35));
      g.position.y = (DOOR_H + 0.1) / 2;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.07, 0.06), metal('#c9d2dc', 0.3));
      frame.position.y = 0.04;
      const top = frame.clone();
      top.position.y = DOOR_H + 0.1;
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.6, 0.08), metal('#e8edf2', 0.2));
      handle.position.set(e.x === world.grid.building.entrance.x ? 0.42 : -0.42, 1.05, 0);
      pane.add(g, frame, top, handle);
      group.add(pane);
      const d: DoorRec = { group, leaf: pane, kind: 'entrance', cx, cz, open: prev?.open ?? 0, jambs: [] };
      return d;
    }
    const roomSpace = e.a.kind === 'room' ? e.a : e.b;
    const accent = roomSpace.kind === 'room' ? world.room(roomSpace.id) : undefined;
    const col = accent ? ROOMS[accent.type].accent : '#88aadd';
    const hinge = new THREE.Group();
    hinge.position.x = -0.46;
    const leaf = new THREE.Mesh(new RoundedBoxGeometry(0.9, 2.02, 0.06, 2, 0.02), plastic(col, 0.35, 0.8));
    leaf.position.set(0.45, 1.02, 0);
    leaf.castShadow = true;
    const port = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.07, 20), glass('#d8f4ff', 0.5));
    port.rotation.x = Math.PI / 2;
    port.position.set(0.45, 1.5, 0);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.025, 8, 24), metal('#e6ecf2', 0.25));
    ring.position.set(0.45, 1.5, 0.035);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), metal('#ffd166', 0.2));
    knob.position.set(0.8, 1.0, 0.06);
    hinge.add(leaf, port, ring, knob);
    group.add(hinge);
    // frame posts
    const jamb = matte('#ffffff', 0.5);
    const jambs: THREE.Object3D[] = [];
    for (const s of [-1, 1]) {
      const j = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1, 0.2).translate(0, 0.5, 0), jamb);
      j.position.set(s * 0.47, 0, 0);
      j.scale.y = DOOR_H;
      j.castShadow = true;
      group.add(j);
      jambs.push(j);
    }
    return { group, leaf: hinge, kind: 'room', cx, cz, open: prev?.open ?? 0, jambs };
  }

  private rebuildDecor(world: World) {
    // door mats outside each room, tinted with the room accent
    let n = 0;
    for (const r of world.state.rooms) {
      const v = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[r.door.dir];
      const ox = r.door.x + 0.5 + v[0] * 0.78, oz = r.door.z + 0.5 + v[1] * 0.78;
      tmpQ.setFromAxisAngle(Y_AXIS, r.door.dir === 'E' || r.door.dir === 'W' ? Math.PI / 2 : 0);
      tmpM.compose(tmpP.set(ox, 0.012, oz), tmpQ, tmpS.set(1, 1, 1));
      this.mats.setMatrixAt(n, tmpM);
      this.mats.setColorAt(n++, new THREE.Color(ROOMS[r.type].accent));
    }
    this.mats.count = n;
    this.mats.instanceMatrix.needsUpdate = true;
    if (this.mats.instanceColor) this.mats.instanceColor.needsUpdate = true;
    // night light pools
    let p = 0;
    if (this.preset.lightPools) {
      for (const r of world.state.rooms) {
        const s = Math.max(r.rect.w, r.rect.h) * 1.5;
        tmpM.compose(tmpP.set(r.rect.x + r.rect.w / 2, 0.02, r.rect.z + r.rect.h / 2), tmpQ.identity(), tmpS.set(s, 1, s));
        this.pools.setMatrixAt(p, tmpM);
        this.pools.setColorAt(p++, new THREE.Color(ROOMS[r.type].wall).lerp(new THREE.Color('#ffd7a0'), 0.6));
      }
      const g = world.grid;
      let row = 0;
      for (let z = g.building.z + 3; z < g.building.z + g.building.h; z += 6, row++) {
        for (let x = g.building.x + 3 + (row % 2) * 3; x < g.building.x + g.building.w; x += 7) {
          if (!g.isCorridor(x, z)) continue;
          tmpM.compose(tmpP.set(x + 0.5, 0.02, z + 0.5), tmpQ.identity(), tmpS.set(9, 1, 9));
          this.pools.setMatrixAt(p, tmpM);
          this.pools.setColorAt(p++, new THREE.Color('#ffdcaa'));
        }
      }
    }
    this.pools.count = p;
    this.pools.instanceMatrix.needsUpdate = true;
    if (this.pools.instanceColor) this.pools.instanceColor.needsUpdate = true;
  }

  private setSlab(mesh: THREE.InstancedMesh, i: number, e: EdgeRec, side: 'a' | 'b', y0: number, h: number) {
    const off = side === 'a' ? -T / 2 : T / 2;
    if (e.axis === 'h') {
      tmpP.set(e.x + 0.5, y0, e.z + off);
      tmpQ.identity();
    } else {
      tmpP.set(e.x + off, y0, e.z + 0.5);
      tmpQ.setFromAxisAngle(Y_AXIS, Math.PI / 2);
    }
    tmpS.set(1, Math.max(h, 0.0001), T);
    if (h <= 0.001) tmpS.set(0, 0, 0);
    tmpM.compose(tmpP, tmpQ, tmpS);
    mesh.setMatrixAt(i, tmpM);
  }

  private writeEdge(e: EdgeRec) {
    const h = e.h;
    for (const s of e.slots) {
      const mesh = s.mesh === 'brick' ? this.brickMesh : this.wallMesh;
      if (s.part === 'full') this.setSlab(mesh, s.i, e, s.side, 0, h);
      else if (s.part === 'sill') this.setSlab(mesh, s.i, e, s.side, 0, Math.min(h, SILL));
      else if (s.part === 'lintel') this.setSlab(mesh, s.i, e, s.side, LINTEL, h - LINTEL);
      else this.setSlab(mesh, s.i, e, s.side, DOOR_H, h - DOOR_H);
    }
    if (e.glass !== undefined) {
      const gh = Math.max(0, Math.min(h, LINTEL) - SILL);
      if (e.axis === 'h') { tmpP.set(e.x + 0.5, SILL, e.z); tmpQ.identity(); } else { tmpP.set(e.x, SILL, e.z + 0.5); tmpQ.setFromAxisAngle(Y_AXIS, Math.PI / 2); }
      tmpS.set(gh > 0.01 ? 1 : 0, gh, 1);
      tmpM.compose(tmpP, tmpQ, tmpS);
      this.glassMesh.setMatrixAt(e.glass, tmpM);
      tmpS.set(gh > 0.01 ? 0.05 : 0, gh, 0.06);
      tmpM.compose(tmpP, tmpQ, tmpS);
      this.mullions.setMatrixAt(e.mullion!, tmpM);
      (this.shafts.geometry.getAttribute('aOn') as THREE.InstancedBufferAttribute).setX(e.shaft!, gh > 1.0 ? 1 : 0);
    }
  }

  update(dt: number, world: World, sunDir: THREE.Vector3, daylight: number, night: number) {
    this.sync(world);
    let moved = this.dirty;
    for (const e of this.edges.values()) {
      if (Math.abs(e.h - e.target) < 0.0005 && Math.abs(e.v) < 0.0005) {
        if (e.h !== e.target) { e.h = e.target; moved = true; this.writeEdge(e); }
        continue;
      }
      // springy rise/fall: slight overshoot reads as a satisfying "pop"
      const k = 140, c = 15;
      e.v += (k * (e.target - e.h) - c * e.v) * dt;
      e.h += e.v * dt;
      moved = true;
      this.writeEdge(e);
    }
    if (this.dirty) for (const e of this.edges.values()) this.writeEdge(e);
    if (moved) {
      this.postList.forEach((p, i) => {
        const h = Math.max(...p.edges.map((e) => e.h));
        tmpM.compose(tmpP.set(p.x, 0, p.z), tmpQ.identity(), tmpS.set(T * 2.2, Math.max(h, 0.0001) + 0.02, T * 2.2));
        this.posts.setMatrixAt(i, tmpM);
      });
      for (const m of [this.wallMesh, this.brickMesh, this.posts, this.glassMesh, this.mullions]) m.instanceMatrix.needsUpdate = true;
      this.shafts.instanceMatrix.needsUpdate = true;
      (this.shafts.geometry.getAttribute('aOn') as THREE.InstancedBufferAttribute).needsUpdate = true;
      this.dirty = false;
    }
    // doors
    const movers = [...world.state.staff, ...world.state.patients];
    for (const d of this.doors) {
      let near = false;
      for (const m of movers) {
        if (Math.abs(m.x - d.cx) < 1.2 && Math.abs(m.z - d.cz) < 1.2 && (m.x - d.cx) ** 2 + (m.z - d.cz) ** 2 < 1.1) { near = true; break; }
      }
      d.open += ((near ? 1 : 0) - d.open) * (1 - Math.exp(-(near ? 10 : 4) * dt));
      const visible = !d.edge || d.edge.h > DOOR_H;
      const jh = Math.max(0.001, Math.min(d.edge ? d.edge.h : WALL_H, DOOR_H));
      for (const j of d.jambs) j.scale.y = jh;
      d.group.visible = visible || d.kind === 'room';
      if (d.kind === 'room') {
        d.leaf.rotation.y = -d.open * 1.45;
        d.leaf.visible = visible;
        d.leaf.scale.y = 1;
      } else {
        d.leaf.position.x = (d.cx < world.grid.building.entrance.x + 1 ? -1 : 1) * d.open * 0.9;
        d.group.visible = visible;
      }
    }
    // light shafts: strongest with a low sun
    const elev = Math.max(0, sunDir.y);
    this.shaftMat.uniforms.uStrength.value = daylight * (0.12 + 0.5 * (1 - elev));
    (this.shaftMat.uniforms.uLight.value as THREE.Vector3).copy(sunDir).multiplyScalar(-4.5);
    this.poolMat.opacity = night * 0.5;
  }
}
