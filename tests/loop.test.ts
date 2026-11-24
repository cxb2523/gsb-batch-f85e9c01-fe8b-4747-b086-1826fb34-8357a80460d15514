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
import { createLoop } from '../src/loop';

describe('fixed-step loop', () => {
  it('runs one step per fixed interval of scaled time', () => {
    let steps = 0;
    const loop = createLoop(() => steps++, { fixed: 1 / 30, maxSteps: 8 });
    loop.advance(0.1 + 1e-9, 1);
    expect(steps).toBe(3);
  });

  it('scales by game speed', () => {
    let steps = 0;
    const loop = createLoop(() => steps++, { fixed: 1 / 30, maxSteps: 100 });
    loop.advance(0.1 + 1e-9, 4);
    expect(steps).toBe(12);
  });

  it('clamps huge frame gaps to maxSteps and drops the backlog', () => {
    let steps = 0;
    const loop = createLoop(() => steps++, { fixed: 1 / 30, maxSteps: 8 });
    const alpha = loop.advance(10, 4);
    expect(steps).toBe(8);
    expect(alpha).toBeGreaterThanOrEqual(0);
    expect(alpha).toBeLessThan(1);
    steps = 0;
    loop.advance(1 / 60, 1);
    expect(steps).toBeLessThanOrEqual(1);
  });

  it('does not step while paused', () => {
    let steps = 0;
    const loop = createLoop(() => steps++, { fixed: 1 / 30, maxSteps: 8 });
    loop.advance(1, 0);
    expect(steps).toBe(0);
  });
});
