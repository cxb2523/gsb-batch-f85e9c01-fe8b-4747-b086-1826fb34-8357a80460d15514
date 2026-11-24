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
import { describe, it, expect } from 'vitest';
import { World } from '../src/sim/world';
import { SCENARIOS, createScenarioState, evaluateStars, goalValue, isScenarioUnlocked, parseProgress, recordStars, scenarioById, starterGoalsActive } from '../src/sim/scenarios';
import { patientCount } from '../src/sim/state';
import { findPath } from '../src/sim/path';
import { validateRoom } from '../src/sim/build';
import { deserialize, serialize } from '../src/sim/save';
import { pickIllnessFor } from '../src/sim/patients';
import { isRoomUnlocked } from '../src/sim/unlocks';

describe('scenarios', () => {
  it('has five hospitals in campaign order', () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(['quackwell', 'frostmere', 'sunnyside', 'voltwick', 'duckington']);
  });

  for (const sc of SCENARIOS) {
    it(`${sc.name}: valid lot, reachable entrance, room to build`, () => {
      const w = new World(createScenarioState(sc.id, 3), { autoSpawn: false });
      const b = w.grid.building;
      expect(b).toMatchObject(sc.building);
      expect(b.x).toBeGreaterThanOrEqual(1);
      expect(b.x + b.w).toBeLessThanOrEqual(47);
      expect(b.z + b.h).toBe(28);
      expect(w.state.money).toBe(sc.money);
      expect(findPath(w.grid, { x: 24, z: 36 }, { x: b.x + Math.floor(b.w / 2), z: b.z + 2 })).not.toBeNull();
      const v = validateRoom(w, 'gp', { x: b.x + 1, z: b.z, w: 3, h: 3 }, { x: b.x + 2, z: b.z + 2, dir: 'S' });
      expect(v.ok, v.reason).toBe(true);
      expect(sc.stars.length).toBe(3);
    });
  }

  it('keeps its scenario through save and load', () => {
    const w = new World(createScenarioState('sunnyside', 3), { autoSpawn: false });
    const res = deserialize(serialize(w));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const b = new World(res.state);
    expect(b.grid.building).toMatchObject(scenarioById('sunnyside').building);
  });

  it('uses the scenario illness pool from month zero', () => {
    const w = new World(createScenarioState('frostmere', 8), { autoSpawn: false });
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(pickIllnessFor(w));
    expect(seen.has('frostbiteFever')).toBe(true);
    expect(seen.has('staticCling')).toBe(false);
  });

  it('sandbox: everything unlocked, a million in the bank, no goals', () => {
    const w = new World(createScenarioState('duckington', 3, true), { autoSpawn: false });
    expect(w.state.sandbox).toBe(true);
    expect(w.state.money).toBe(1_000_000);
    expect(isRoomUnlocked(w.state, 'psych')).toBe(true);
    expect(evaluateStars(w.state)).toBe(0);
  });
});

describe('goals', () => {
  it('earns stars in order and remembers goals once met', () => {
    const s = createScenarioState('quackwell', 1);
    expect(evaluateStars(s)).toBe(0);
    const first = scenarioById('quackwell').stars[0];
    for (const g of first) {
      if (g.kind === 'cured') s.stats.cured = g.target;
      if (g.kind === 'rep') s.reputation = g.target;
      if (g.kind === 'money') s.money = g.target;
    }
    expect(evaluateStars(s)).toBe(1);
    s.reputation = 0;
    s.stats.cured = 0;
    expect(evaluateStars(s)).toBe(1);
  });

  it('reports progress values for the goal list', () => {
    const s = createScenarioState('voltwick', 1);
    s.research.done = ['arcade', 'fizzDeluxe'];
    const g = scenarioById('voltwick').stars[0].find((x) => x.kind === 'research')!;
    expect(goalValue(s, g)).toBe(2);
  });
});

describe('hud helpers', () => {
  it('shows the getting-started checklist only in Quackwell, outside sandbox', () => {
    expect(starterGoalsActive(createScenarioState('quackwell', 1))).toBe(true);
    expect(starterGoalsActive(createScenarioState('frostmere', 1))).toBe(false);
    expect(starterGoalsActive(createScenarioState('quackwell', 1, true))).toBe(false);
  });

  it('does not count the health inspector as a patient', () => {
    const w = new World(createScenarioState('quackwell', 1), { autoSpawn: false });
    w.spawnPatient('chromaticFlu');
    w.spawnPatient('jellylegs', { vip: true });
    expect(w.state.patients.length).toBe(2);
    expect(patientCount(w.state)).toBe(1);
  });
});

describe('campaign progress', () => {
  it('tolerates missing or corrupt storage (Review Focus 5)', () => {
    for (const raw of [null, '', '{', 'null', '[]', '{"stars":{"quackwell":"lots"}}', '{"stars":7}']) {
      const p = parseProgress(raw);
      expect(p.stars).toBeTypeOf('object');
      expect(isScenarioUnlocked(p, 'quackwell')).toBe(true);
      expect(isScenarioUnlocked(p, 'frostmere')).toBe(false);
    }
  });

  it('unlocks the next hospital after a star', () => {
    let p = parseProgress(null);
    p = recordStars(p, 'quackwell', 1);
    expect(isScenarioUnlocked(p, 'frostmere')).toBe(true);
    expect(isScenarioUnlocked(p, 'sunnyside')).toBe(false);
    p = recordStars(p, 'quackwell', 0);
    expect(p.stars.quackwell).toBe(1);
    expect(parseProgress(JSON.stringify(p)).stars.quackwell).toBe(1);
  });
});
