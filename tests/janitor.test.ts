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
import { describe, it, expect, afterEach } from 'vitest';
import { World } from '../src/sim/world';
import { createState } from '../src/sim/state';
import { BALANCE, type Role } from '../src/sim/catalog';
import { cleanliness, dropLitter } from '../src/sim/janitor';
import type { SimEvent } from '../src/sim/events';

const saved = { ...BALANCE };
afterEach(() => Object.assign(BALANCE, saved));

function world() {
  const s = createState(4);
  s.money = 1_000_000;
  return new World(s, { autoSpawn: false, forceTreatment: 'success' });
}
function hire(w: World, role: Role, skill = 3) {
  const c = w.state.candidates.find((x) => x.role === role)!;
  c.skill = skill;
  const id = w.cmd({ type: 'hire', candidateId: c.id }).id;
  return w.state.staff.find((s) => s.id === id)!;
}
function run(w: World, secs: number, until?: () => boolean, sink?: SimEvent[]) {
  for (let t = 0; t < secs; t += 1 / 30) {
    w.tick(1 / 30);
    sink?.push(...w.drainEvents());
    if (until?.()) return true;
  }
  return false;
}
function scanSetup() {
  const w = world();
  w.cmd({ type: 'placeItem', item: 'reception', x: 20, z: 20, rot: 0 });
  w.cmd({ type: 'buildRoom', room: 'gp', rect: { x: 12, z: 8, w: 3, h: 3 }, door: { x: 13, z: 10, dir: 'S' } });
  const scan = w.cmd({ type: 'buildRoom', room: 'scan', rect: { x: 24, z: 8, w: 4, h: 4 }, door: { x: 25, z: 11, dir: 'S' } });
  hire(w, 'assistant'); hire(w, 'doctor', 1); hire(w, 'doctor', 1);
  const scanner = w.state.items.find((i) => i.type === 'scanner')!;
  return { w, scanId: scan.id!, scanner };
}

describe('litter', () => {
  it('a janitor walks over and sweeps up litter', () => {
    const w = world();
    dropLitter(w, 25.5, 20.5, 'wrapper');
    dropLitter(w, 15.5, 22.5, 'can');
    expect(w.state.litter.length).toBe(2);
    expect(cleanliness(w.state)).toBeLessThan(1);
    hire(w, 'janitor');
    expect(run(w, 120, () => w.state.litter.length === 0)).toBe(true);
    expect(cleanliness(w.state)).toBe(1);
  });

  it('thirsty patients leave cans behind when there is no bin nearby', () => {
    BALANCE.litterCan = 1;
    const w = world();
    w.cmd({ type: 'placeItem', item: 'reception', x: 20, z: 20, rot: 0 });
    w.cmd({ type: 'placeItem', item: 'vending', x: 26, z: 20, rot: 0 });
    hire(w, 'assistant');
    const p = w.spawnPatient('jellylegs');
    run(w, 200, () => p.state === 'waiting');
    p.thirst = 95;
    expect(run(w, 120, () => w.state.litter.some((l) => l.kind === 'can'))).toBe(true);
  });

  it('a bin nearby keeps the floor clean', () => {
    BALANCE.litterCan = 1;
    const w = world();
    w.cmd({ type: 'placeItem', item: 'reception', x: 20, z: 20, rot: 0 });
    w.cmd({ type: 'placeItem', item: 'vending', x: 26, z: 20, rot: 0 });
    w.cmd({ type: 'placeItem', item: 'bin', x: 27, z: 21, rot: 0 });
    hire(w, 'assistant');
    const p = w.spawnPatient('jellylegs');
    run(w, 200, () => p.state === 'waiting');
    p.thirst = 95;
    run(w, 120, () => p.thirst < 5 && p.state === 'waiting');
    expect(w.state.litter.filter((l) => l.kind === 'can').length).toBe(0);
  });
});

describe('janitor energy', () => {
  it('drains while a janitor is working', () => {
    const w = world();
    for (let i = 0; i < 12; i++) dropLitter(w, 12.5 + i * 2, 12.5 + (i % 3) * 4, 'wrapper');
    const j = hire(w, 'janitor');
    run(w, 40);
    expect(j.energy).toBeLessThan(100);
  });

  it('a tired janitor rests in the Staff Room, then gets back to sweeping', () => {
    const w = world();
    expect(w.cmd({ type: 'buildRoom', room: 'staffRoom', rect: { x: 24, z: 8, w: 3, h: 3 }, door: { x: 25, z: 10, dir: 'S' } }).ok).toBe(true);
    const j = hire(w, 'janitor');
    j.energy = 10;
    dropLitter(w, 15.5, 22.5, 'can');
    expect(run(w, 60, () => j.state === 'onBreak')).toBe(true);
    expect(w.state.litter.length).toBe(1);
    expect(run(w, 120, () => w.state.litter.length === 0)).toBe(true);
    expect(j.energy).toBeGreaterThan(80);
  });
});

describe('machine wear', () => {
  it('a worn machine breaks after a service, the patient still finishes, and the room stops admitting (Review Focus 3)', () => {
    const { w, scanId, scanner } = scanSetup();
    scanner.wear = 99;
    const p1 = w.spawnPatient('chromaticFlu');
    const ev: SimEvent[] = [];
    expect(run(w, 400, () => p1.scans === 1, ev)).toBe(true);
    expect(scanner.broken).toBe(true);
    expect(ev.some((e) => e.type === 'broke')).toBe(true);
    const p2 = w.spawnPatient('chromaticFlu');
    run(w, 300, () => p2.target === scanId && p2.state === 'waiting');
    run(w, 60);
    expect(p2.state).not.toBe('inRoom');
  });

  it('a janitor repairs a broken machine and the room reopens', () => {
    const { w, scanner } = scanSetup();
    scanner.wear = 100;
    scanner.broken = true;
    hire(w, 'janitor');
    expect(run(w, 120, () => !scanner.broken)).toBe(true);
    expect(scanner.wear).toBe(0);
  });

  it('janitors fix broken machines before sweeping litter', () => {
    const { w, scanner } = scanSetup();
    scanner.broken = true;
    scanner.wear = 100;
    dropLitter(w, 20.5, 25.5, 'wrapper');
    const j = hire(w, 'janitor');
    run(w, 5, () => j.job !== null);
    expect(j.job?.kind).toBe('repair');
  });
});
