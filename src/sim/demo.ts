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
import { World } from './world';
import { createState } from './state';
import type { Role, IllnessType } from './catalog';
import type { Command } from './events';

/** A fully built, staffed, busy hospital for screenshots and the title screen. */
export function createDemoWorld(seed = 11, warmup = 45): World {
  const s = createState(seed);
  s.money = 2_000_000;
  s.t = 15;
  s.research.done = ['psychiatry', 'arcade', 'duckStatue'];
  const w = new World(s);
  const cmds: Command[] = [
    { type: 'buildRoom', room: 'gp', rect: { x: 8, z: 6, w: 4, h: 4 }, door: { x: 10, z: 9, dir: 'S' } },
    { type: 'buildRoom', room: 'gp', rect: { x: 12, z: 6, w: 4, h: 4 }, door: { x: 13, z: 9, dir: 'S' } },
    { type: 'buildRoom', room: 'scan', rect: { x: 16, z: 6, w: 5, h: 4 }, door: { x: 18, z: 9, dir: 'S' } },
    { type: 'buildRoom', room: 'ward', rect: { x: 21, z: 6, w: 6, h: 4 }, door: { x: 23, z: 9, dir: 'S' } },
    { type: 'buildRoom', room: 'ballast', rect: { x: 27, z: 6, w: 4, h: 4 }, door: { x: 28, z: 9, dir: 'S' } },
    { type: 'buildRoom', room: 'grounding', rect: { x: 31, z: 6, w: 5, h: 4 }, door: { x: 33, z: 9, dir: 'S' } },
    { type: 'buildRoom', room: 'pharmacy', rect: { x: 8, z: 13, w: 4, h: 4 }, door: { x: 11, z: 14, dir: 'E' } },
    { type: 'buildRoom', room: 'sauna', rect: { x: 8, z: 19, w: 4, h: 4 }, door: { x: 11, z: 20, dir: 'E' } },
    { type: 'buildRoom', room: 'research', rect: { x: 32, z: 13, w: 4, h: 3 }, door: { x: 32, z: 14, dir: 'W' } },
    { type: 'buildRoom', room: 'psych', rect: { x: 32, z: 17, w: 4, h: 4 }, door: { x: 32, z: 18, dir: 'W' } },
    { type: 'buildRoom', room: 'staffRoom', rect: { x: 32, z: 22, w: 4, h: 4 }, door: { x: 32, z: 23, dir: 'W' } },
    { type: 'buildRoom', room: 'training', rect: { x: 8, z: 23, w: 3, h: 4 }, door: { x: 10, z: 24, dir: 'E' } },
    { type: 'placeItem', item: 'reception', x: 20, z: 19, rot: 0 },
    { type: 'placeItem', item: 'bench', x: 14, z: 12, rot: 2 },
    { type: 'placeItem', item: 'bench', x: 18, z: 12, rot: 2 },
    { type: 'placeItem', item: 'bench', x: 25, z: 12, rot: 2 },
    { type: 'placeItem', item: 'bench', x: 29, z: 12, rot: 2 },
    { type: 'placeItem', item: 'bench', x: 14, z: 16, rot: 1 },
    { type: 'placeItem', item: 'bench', x: 29, z: 16, rot: 3 },
    { type: 'placeItem', item: 'vending', x: 28, z: 26, rot: 2 },
    { type: 'placeItem', item: 'cooler', x: 15, z: 26, rot: 2 },
    { type: 'placeItem', item: 'arcade', x: 27, z: 26, rot: 2 },
    { type: 'placeItem', item: 'duckStatue', x: 25, z: 15, rot: 0 },
    { type: 'placeItem', item: 'plant', x: 16, z: 12, rot: 0 },
    { type: 'placeItem', item: 'plant', x: 27, z: 12, rot: 0 },
    { type: 'placeItem', item: 'plant', x: 19, z: 26, rot: 0 },
    { type: 'placeItem', item: 'plant', x: 24, z: 26, rot: 0 },
    { type: 'placeItem', item: 'plant', x: 12, z: 26, rot: 0 },
    { type: 'placeItem', item: 'lamp', x: 18, z: 19, rot: 0 },
    { type: 'placeItem', item: 'lamp', x: 24, z: 19, rot: 0 },
    { type: 'placeItem', item: 'radiator', x: 8, z: 11, rot: 3 },
    { type: 'placeItem', item: 'radiator', x: 35, z: 11, rot: 1 },
    { type: 'placeItem', item: 'bin', x: 17, z: 12, rot: 0 },
    { type: 'placeItem', item: 'bin', x: 26, z: 26, rot: 0 },
    { type: 'placeItem', item: 'bench', x: 14, z: 23, rot: 1 },
    { type: 'placeItem', item: 'bench', x: 29, z: 23, rot: 3 },
  ];
  for (const c of cmds) {
    const r = w.cmd(c);
    if (!r.ok) throw new Error(`demo: ${JSON.stringify(c)} failed: ${r.reason}`);
  }
  const hires: [Role, number][] = [
    ['assistant', 1], ['doctor', 7], ['nurse', 3],
  ];
  for (const [role, n] of hires) {
    for (let i = 0; i < n; i++) {
      const cand = w.state.candidates.find((c) => c.role === role)!;
      w.cmd({ type: 'hire', candidateId: cand.id });
    }
  }
  // drop staff straight inside so the demo is busy immediately
  for (const st of w.state.staff) { st.x = 21.5 + (st.id % 3); st.z = 25.5; st.px = st.x; st.pz = st.z; }
  const ills: IllnessType[] = ['heliumLungs', 'chromaticFlu', 'staticCling', 'jellylegs', 'glowbelly', 'frostbiteFever', 'bubbleTrouble', 'echoItis', 'backwardsWalking', 'ghosting'];
  for (let i = 0; i < 16; i++) {
    const p = w.spawnPatient(ills[i % ills.length], { at: { x: 18.5 + (i % 7), z: 24.5 + Math.floor(i / 7) } });
    if (i % 2 === 0) { p.gpVisits = 1; p.certainty = 0.9; p.diagnosed = true; }
  }
  for (let t = 0; t < warmup; t += 1 / 30) {
    w.tick(1 / 30);
    w.drainEvents();
  }
  // land on a sunny early afternoon
  s.t = 20;
  s.lastMonth = 0;
  return w;
}
