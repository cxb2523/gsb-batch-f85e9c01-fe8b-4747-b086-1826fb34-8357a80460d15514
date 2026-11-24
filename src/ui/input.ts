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
import type { Engine } from '../render/engine';
import type { World } from '../sim/world';
import type { Ghost } from '../render/ghost';
import { ITEMS, ROOMS, roomCost, type ItemType, type RoomType } from '../sim/catalog';
import { itemFootprint, rotatedSize, validateItem, validateRoom } from '../sim/build';
import type { Dir } from '../sim/grid';
import type { DoorSpec, Rect } from '../sim/state';

export type Tool =
  | { kind: 'select' }
  | { kind: 'room'; type: RoomType }
  | { kind: 'item'; type: ItemType; rot: number }
  | { kind: 'sell' };

export type Selection = { kind: 'patient' | 'staff' | 'room' | 'item'; id: number } | null;

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

/** Translates pointer/keyboard input into tool previews and sim commands. */
export class Input {
  tool: Tool = { kind: 'select' };
  /** false on the title screen */
  enabled = true;
  selection: Selection = null;
  hintText = '';
  hintBad = false;
  onToolChange: (() => void)[] = [];
  onSelect: (() => void)[] = [];
  onSpeedKey: ((s: number | 'toggle') => void) | null = null;
  onSfx: ((name: 'click' | 'build' | 'error' | 'drop' | 'whoosh') => void) | null = null;
  onToast: ((text: string, tone: 'info' | 'warn' | 'bad' | 'good') => void) | null = null;
  private mouse = { x: 0, y: 0, inside: false };
  private drag: { ax: number; az: number; bx: number; bz: number } | null = null;
  private roomRect: Rect | null = null;
  private door: DoorSpec | null = null;
  private down: { x: number; y: number; button: number } | null = null;
  private pendingSell: { id: number; until: number } | null = null;
  private moveKey = '';
  private ring: THREE.Mesh;
  private hoverRing: THREE.Mesh;

  constructor(private engine: Engine, private world: World, private ghost: Ghost) {
    const el = engine.renderer.domElement;
    el.addEventListener('pointermove', (e) => { this.mouse = { x: e.clientX, y: e.clientY, inside: true }; this.move(); });
    el.addEventListener('pointerleave', () => { this.mouse.inside = false; });
    el.addEventListener('pointerdown', (e) => this.pointerDown(e));
    window.addEventListener('pointerup', (e) => this.pointerUp(e));
    window.addEventListener('keydown', (e) => this.key(e));
    const ringGeo = new THREE.RingGeometry(0.34, 0.46, 40).rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffd447').multiplyScalar(2.2), transparent: true, depthWrite: false }));
    this.ring.renderOrder = 40;
    this.ring.visible = false;
    this.hoverRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, depthWrite: false }));
    this.hoverRing.renderOrder = 40;
    this.hoverRing.visible = false;
    engine.scene.add(this.ring, this.hoverRing);
  }

  setWorld(w: World) {
    this.world = w;
    this.setTool({ kind: 'select' });
    this.select(null);
  }

  setTool(t: Tool) {
    this.tool = t;
    this.drag = null;
    this.roomRect = null;
    this.door = null;
    this.pendingSell = null;
    this.ghost.hide();
    this.refreshHint();
    for (const f of this.onToolChange) f();
  }

  select(s: Selection) {
    this.selection = s;
    for (const f of this.onSelect) f();
  }

  private tileAt(): { x: number; z: number } | null {
    if (!this.mouse.inside) return null;
    const p = this.engine.rig.groundAt(this.mouse.x, this.mouse.y);
    return p ? { x: Math.floor(p.x), z: Math.floor(p.z) } : null;
  }

  private ground(): THREE.Vector3 | null {
    return this.mouse.inside ? this.engine.rig.groundAt(this.mouse.x, this.mouse.y) : null;
  }

  private key(e: KeyboardEvent) {
    if (!this.enabled || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      if (this.tool.kind === 'room' && (this.roomRect || this.drag)) { this.drag = null; this.roomRect = null; this.door = null; this.ghost.hide(); this.refreshHint(); return; }
      if (this.tool.kind !== 'select') this.setTool({ kind: 'select' });
      else this.select(null);
    }
    if (k === 'r' && this.tool.kind === 'item') {
      this.tool = { ...this.tool, rot: (this.tool.rot + 1) % 4 };
      this.onSfx?.('click');
      this.move(true);
    }
    if (k === ' ') { e.preventDefault(); this.onSpeedKey?.('toggle'); }
    if (k === '1' || k === '2' || k === '3') this.onSpeedKey?.(k === '1' ? 1 : k === '2' ? 2 : 4);
    if (k === 'delete') {
      const s = this.selection;
      if (s && (s.kind === 'room' || s.kind === 'item')) {
        const now = performance.now();
        if (s.kind === 'room' && (!this.pendingSell || this.pendingSell.id !== s.id || now > this.pendingSell.until)) {
          this.pendingSell = { id: s.id, until: now + 3000 };
          this.onToast?.('Press Delete again to sell this room.', 'warn');
          return;
        }
        this.pendingSell = null;
        this.sell(s.kind, s.id);
      }
    }
  }

  private pointerDown(e: PointerEvent) {
    if (!this.enabled) return;
    this.down = { x: e.clientX, y: e.clientY, button: e.button };
    if (e.button !== 0) return;
    if (this.tool.kind === 'room' && !this.roomRect) {
      const t = this.tileAt();
      if (t) this.drag = { ax: t.x, az: t.z, bx: t.x, bz: t.z };
    }
  }

  private pointerUp(e: PointerEvent) {
    const d = this.down;
    this.down = null;
    if (!d) return;
    const still = Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6;
    if (d.button === 2 && still) {
      // quick right-click: step back out of the current tool
      if (this.tool.kind === 'room' && this.roomRect) { this.roomRect = null; this.door = null; this.ghost.hide(); this.refreshHint(); }
      else if (this.tool.kind !== 'select') this.setTool({ kind: 'select' });
      return;
    }
    if (d.button !== 0) return;
    switch (this.tool.kind) {
      case 'select':
        if (still) this.pick();
        break;
      case 'room':
        if (this.drag && !this.roomRect) {
          const r = this.rectOf(this.drag);
          this.drag = null;
          this.roomRect = r;
          this.move();
        } else if (this.roomRect && this.door && still) {
          this.confirmRoom();
        }
        break;
      case 'item':
        if (still) this.placeItem();
        break;
      case 'sell':
        if (still) this.sellAtCursor();
        break;
    }
  }

  private rectOf(d: { ax: number; az: number; bx: number; bz: number }): Rect {
    const x = Math.min(d.ax, d.bx), z = Math.min(d.az, d.bz);
    return { x, z, w: Math.abs(d.bx - d.ax) + 1, h: Math.abs(d.bz - d.az) + 1 };
  }

  /** Perimeter edge nearest the cursor. */
  private nearestDoor(r: Rect, p: THREE.Vector3): DoorSpec {
    let best: DoorSpec = { x: r.x, z: r.z + r.h - 1, dir: 'S' };
    let bd = Infinity;
    const consider = (x: number, z: number, dir: Dir, mx: number, mz: number) => {
      const d = (mx - p.x) ** 2 + (mz - p.z) ** 2;
      if (d < bd) { bd = d; best = { x, z, dir }; }
    };
    for (let x = r.x; x < r.x + r.w; x++) {
      consider(x, r.z, 'N', x + 0.5, r.z);
      consider(x, r.z + r.h - 1, 'S', x + 0.5, r.z + r.h);
    }
    for (let z = r.z; z < r.z + r.h; z++) {
      consider(r.x, z, 'W', r.x, z + 0.5);
      consider(r.x + r.w - 1, z, 'E', r.x + r.w, z + 0.5);
    }
    return best;
  }

  /** Any door position that makes the rect valid (used for drag feedback). */
  private anyValidDoor(type: RoomType, r: Rect): { door: DoorSpec | null; reason?: string } {
    let reason: string | undefined;
    const tryDoor = (d: DoorSpec) => {
      const v = validateRoom(this.world, type, r, d);
      if (v.ok) return true;
      if (!reason || v.reason === 'not enough money') reason = v.reason;
      return false;
    };
    const mid = (a: number, n: number) => a + Math.floor(n / 2);
    const cands: DoorSpec[] = [
      { x: mid(r.x, r.w), z: r.z + r.h - 1, dir: 'S' }, { x: mid(r.x, r.w), z: r.z, dir: 'N' },
      { x: r.x, z: mid(r.z, r.h), dir: 'W' }, { x: r.x + r.w - 1, z: mid(r.z, r.h), dir: 'E' },
    ];
    for (const d of cands) if (tryDoor(d)) return { door: d };
    return { door: null, reason };
  }

  move(force = false) {
    const t = this.tileAt();
    const g = this.ground();
    // validation is expensive: only redo it when the hovered tile, door edge, tool or world changed
    const doorKey = this.roomRect && g ? JSON.stringify(this.nearestDoor(this.roomRect, g)) : '';
    const key = `${JSON.stringify(this.tool)}|${t?.x},${t?.z}|${JSON.stringify(this.drag)}|${JSON.stringify(this.roomRect)}|${doorKey}|${this.world.grid.version}|${Math.floor(this.world.state.money / 50)}`;
    if (!force && key === this.moveKey) return;
    this.moveKey = key;
    switch (this.tool.kind) {
      case 'room': {
        const type = this.tool.type;
        if (this.drag && t) {
          this.drag.bx = t.x;
          this.drag.bz = t.z;
          const r = this.rectOf(this.drag);
          const v = this.anyValidDoor(type, r);
          this.ghost.room(r, v.door, !!v.door);
          this.setHint(v.door ? `${r.w}×${r.h} — <b>${money(roomCost(type, r.w, r.h))}</b>. Release to choose the door.` : `${r.w}×${r.h} — <b>${v.reason}</b>`, !v.door);
        } else if (this.roomRect && g) {
          this.door = this.nearestDoor(this.roomRect, g);
          const v = validateRoom(this.world, type, this.roomRect, this.door);
          this.ghost.room(this.roomRect, this.door, v.ok);
          this.setHint(v.ok ? `Click to build for <b>${money(v.cost)}</b>. Move the cursor to place the door.` : `Door here: <b>${v.reason}</b>`, !v.ok);
        } else if (t) {
          const def = ROOMS[type];
          this.ghost.room({ x: t.x, z: t.z, w: 1, h: 1 }, null, this.world.grid.isCorridor(t.x, t.z));
          this.setHint(`Drag out a ${def.name}: at least <b>${def.minW}×${def.minH}</b> tiles.`, false);
        }
        break;
      }
      case 'item': {
        if (!t) { this.ghost.hide(); break; }
        const sz = rotatedSize(this.tool.type, this.tool.rot);
        const x = t.x - Math.floor((sz.w - 1) / 2), z = t.z - Math.floor((sz.d - 1) / 2);
        const v = validateItem(this.world, this.tool.type, x, z, this.tool.rot);
        this.ghost.itemAt(this.tool.type, x, z, this.tool.rot, v.ok);
        this.setHint(v.ok ? `Click to place <b>${ITEMS[this.tool.type].name}</b> for <b>${money(v.cost)}</b>. R rotates.` : `<b>${v.reason}</b>. R rotates.`, !v.ok);
        break;
      }
      case 'sell': {
        if (!t) break;
        const target = this.sellTarget(t.x, t.z);
        if (target?.kind === 'room') {
          const r = this.world.room(target.id)!;
          this.ghost.room(r.rect, null, false);
          this.setHint(`Click to sell the <b>${ROOMS[r.type].name}</b> (refund about ${money(r.cost / 2)}).`, true);
        } else if (target?.kind === 'item') {
          const it = this.world.item(target.id)!;
          this.ghost.itemAt(it.type, it.x, it.z, it.rot, false);
          this.setHint(`Click to sell the <b>${ITEMS[it.type].name}</b> for ${money(it.cost / 2)}.`, true);
        } else {
          this.ghost.hide();
          this.setHint('Point at a room or item to sell it.', false);
        }
        break;
      }
      case 'select':
        break;
    }
  }

  private sellTarget(x: number, z: number): { kind: 'room' | 'item'; id: number } | null {
    for (const it of this.world.state.items) {
      if (it.roomId !== -1 && it.cost === 0) continue;
      if (itemFootprint(it.type, it.x, it.z, it.rot).some((c) => c.x === x && c.z === z)) return { kind: 'item', id: it.id };
    }
    const rid = this.world.grid.room(x, z);
    return rid !== -1 ? { kind: 'room', id: rid } : null;
  }

  private confirmRoom() {
    if (this.tool.kind !== 'room' || !this.roomRect || !this.door) return;
    const res = this.world.cmd({ type: 'buildRoom', room: this.tool.type, rect: this.roomRect, door: this.door });
    if (res.ok) {
      this.onSfx?.('build');
      this.setTool({ kind: 'select' });
      this.select({ kind: 'room', id: res.id! });
    } else {
      this.onSfx?.('error');
      this.onToast?.(`Can't build here: ${res.reason}.`, 'bad');
    }
  }

  private placeItem() {
    if (this.tool.kind !== 'item') return;
    const t = this.tileAt();
    if (!t) return;
    const sz = rotatedSize(this.tool.type, this.tool.rot);
    const x = t.x - Math.floor((sz.w - 1) / 2), z = t.z - Math.floor((sz.d - 1) / 2);
    const res = this.world.cmd({ type: 'placeItem', item: this.tool.type, x, z, rot: this.tool.rot });
    if (res.ok) this.onSfx?.('drop');
    else { this.onSfx?.('error'); this.onToast?.(`Can't place that: ${res.reason}.`, 'bad'); }
    this.move();
  }

  private sell(kind: 'room' | 'item', id: number) {
    const res = this.world.cmd(kind === 'room' ? { type: 'sellRoom', id } : { type: 'sellItem', id });
    if (res.ok) { this.onSfx?.('whoosh'); if (this.selection?.id === id) this.select(null); }
    else this.onToast?.(`Can't sell: ${res.reason}.`, 'bad');
  }

  private sellAtCursor() {
    const t = this.tileAt();
    if (!t) return;
    const target = this.sellTarget(t.x, t.z);
    if (!target) return;
    if (target.kind === 'room') {
      const now = performance.now();
      if (!this.pendingSell || this.pendingSell.id !== target.id || now > this.pendingSell.until) {
        this.pendingSell = { id: target.id, until: now + 3000 };
        this.onToast?.('Click the room again to confirm selling it.', 'warn');
        return;
      }
      this.pendingSell = null;
    }
    this.sell(target.kind, target.id);
    this.move();
  }

  /** Select a character near the cursor, else the room/item under it. */
  private pick() {
    const best = this.characterAtCursor();
    if (best) { this.onSfx?.('click'); this.select(best); return; }
    const t = this.tileAt();
    if (!t) { this.select(null); return; }
    for (const it of this.world.state.items) {
      if (it.roomId !== -1) continue;
      if (itemFootprint(it.type, it.x, it.z, it.rot).some((c) => c.x === t.x && c.z === t.z)) { this.onSfx?.('click'); this.select({ kind: 'item', id: it.id }); return; }
    }
    const rid = this.world.grid.room(t.x, t.z);
    if (rid !== -1) { this.onSfx?.('click'); this.select({ kind: 'room', id: rid }); return; }
    this.select(null);
  }

  private characterAtCursor(): Selection {
    if (!this.mouse.inside) return null;
    const cam = this.engine.camera;
    const v = new THREE.Vector3();
    let best: Selection = null;
    let bd = 34 * 34;
    const check = (kind: 'patient' | 'staff', id: number, x: number, z: number) => {
      v.set(x, 0.7, z).project(cam);
      const sx = (v.x * 0.5 + 0.5) * innerWidth, sy = (-v.y * 0.5 + 0.5) * innerHeight;
      const d = (sx - this.mouse.x) ** 2 + (sy - this.mouse.y) ** 2;
      if (d < bd) { bd = d; best = { kind, id }; }
    };
    for (const s of this.world.state.staff) check('staff', s.id, s.x, s.z);
    for (const p of this.world.state.patients) check('patient', p.id, p.x, p.z);
    return best;
  }

  private setHint(html: string, bad: boolean) {
    this.hintText = html;
    this.hintBad = bad;
  }

  private refreshHint() {
    switch (this.tool.kind) {
      case 'select': this.setHint('', false); break;
      case 'room': this.setHint(`Drag out a ${ROOMS[this.tool.type].name}.`, false); break;
      case 'item': this.setHint(`Click to place. <b>R</b> rotates, <b>Esc</b> finishes.`, false); break;
      case 'sell': this.setHint('Point at a room or item to sell it.', false); break;
    }
  }

  update(t: number) {
    if (!this.enabled) return;
    this.ghost.update(1 / 60);
    // selection ring follows characters; rooms/items get an outline via the ghost
    const s = this.selection;
    this.ring.visible = false;
    if (s && (s.kind === 'patient' || s.kind === 'staff')) {
      const m = s.kind === 'patient' ? this.world.patient(s.id) : this.world.staffById(s.id);
      if (m) {
        this.ring.visible = true;
        this.ring.position.set(m.x, 0.05, m.z);
        const k = 1 + Math.sin(t * 6) * 0.08;
        this.ring.scale.set(k, 1, k);
      } else this.select(null);
    } else if (s && this.tool.kind === 'select') {
      if (s.kind === 'room') {
        const r = this.world.room(s.id);
        if (r) this.ghost.room(r.rect, null, true);
        else { this.select(null); this.ghost.hide(); }
      } else if (s.kind === 'item') {
        const it = this.world.item(s.id);
        if (!it) { this.select(null); this.ghost.hide(); }
      }
    } else if (this.tool.kind === 'select') {
      this.ghost.hide();
    }
    this.hoverRing.visible = false;
    if (this.tool.kind === 'select' && !this.down) {
      const h = this.characterAtCursor();
      this.engine.renderer.domElement.style.cursor = h ? 'pointer' : 'default';
      if (h && (h.kind !== s?.kind || h.id !== s?.id)) {
        const m = h.kind === 'patient' ? this.world.patient(h.id) : this.world.staffById(h.id);
        if (m) { this.hoverRing.visible = true; this.hoverRing.position.set(m.x, 0.05, m.z); }
      }
    } else {
      this.engine.renderer.domElement.style.cursor = this.tool.kind === 'sell' ? 'not-allowed' : 'crosshair';
    }
  }
}
