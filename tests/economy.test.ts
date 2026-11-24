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
import { calendar, timeOfDay, DAY, MONTH, salaryFor } from '../src/sim/economy';

describe('calendar', () => {
  it('starts on day 1 of month 0, year 1, at 8am', () => {
    expect(calendar(0)).toMatchObject({ day: 1, month: 0, year: 1, monthIndex: 0 });
    expect(timeOfDay(0)).toBeCloseTo(8 / 24, 5);
  });
  it('rolls days, months and years', () => {
    expect(DAY).toBe(90);
    expect(MONTH).toBe(450);
    expect(calendar(DAY)).toMatchObject({ day: 2, month: 0 });
    expect(calendar(MONTH)).toMatchObject({ day: 1, month: 1, monthIndex: 1 });
    expect(calendar(MONTH * 12)).toMatchObject({ month: 0, year: 2, monthIndex: 12 });
  });
  it('pays base salary plus a per-star raise', () => {
    expect(salaryFor('doctor', 3)).toBe(3000);
    expect(salaryFor('nurse', 1)).toBe(1700);
    expect(salaryFor('assistant', 2)).toBe(1400);
  });
});
