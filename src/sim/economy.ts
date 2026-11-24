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
import { ROLES, type Role } from './catalog';
import type { WorldState } from './state';

export const DAY = 90;
export const MONTH_DAYS = 5;
export const MONTH = DAY * MONTH_DAYS;
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** t=0 is 8am */
const START_OFFSET = (8 / 24) * DAY;

export function calendar(t: number) {
  const monthIndex = Math.floor(t / MONTH);
  return {
    monthIndex,
    month: monthIndex % 12,
    year: Math.floor(monthIndex / 12) + 1,
    day: Math.floor((t % MONTH) / DAY) + 1,
  };
}

export function monthLabel(monthIndex: number) {
  return `${MONTH_NAMES[monthIndex % 12]} Y${Math.floor(monthIndex / 12) + 1}`;
}

/** 0..1 through the day; 0.5 is noon */
export function timeOfDay(t: number): number {
  return ((t + START_OFFSET) % DAY) / DAY;
}

export function isNight(t: number) {
  const tod = timeOfDay(t);
  return tod < 0.25 || tod > 0.85;
}

export function salaryFor(role: Role, skill: number) {
  return ROLES[role].baseSalary + ROLES[role].perSkill * skill;
}

export function adjustRep(s: WorldState, delta: number) {
  s.reputation = Math.max(0, Math.min(100, s.reputation + delta));
}

export function earn(s: WorldState, amount: number) {
  s.money += amount;
  s.stats.earned += amount;
  s.monthStats.earned += amount;
}
