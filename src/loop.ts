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
export interface LoopOptions {
  /** fixed simulation step in game seconds */
  fixed: number;
  /** most steps allowed per advance() call; backlog beyond is dropped */
  maxSteps: number;
}

export interface Loop {
  /** Advance by real seconds at a speed multiplier. Returns interpolation alpha in [0,1). */
  advance(realDt: number, speed: number): number;
}

export function createLoop(step: (dt: number) => void, opts: LoopOptions): Loop {
  let acc = 0;
  return {
    advance(realDt, speed) {
      if (speed <= 0) return Math.min(acc / opts.fixed, 0.999);
      acc += Math.max(0, realDt) * speed;
      let n = 0;
      while (acc >= opts.fixed && n < opts.maxSteps) {
        step(opts.fixed);
        acc -= opts.fixed;
        n++;
      }
      if (acc >= opts.fixed) acc = acc % opts.fixed;
      return Math.min(acc / opts.fixed, 0.999);
    },
  };
}
