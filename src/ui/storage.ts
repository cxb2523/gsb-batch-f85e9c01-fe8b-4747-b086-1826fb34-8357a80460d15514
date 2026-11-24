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
/** localStorage save slots. Every call is guarded: storage can be full, blocked or missing. */
export const SLOTS = ['auto', '1', '2', '3'] as const;
export type Slot = (typeof SLOTS)[number];

export interface SaveMeta { savedAt: number; label: string }

const key = (slot: string) => `qg:save:${slot}`;

export function writeSave(slot: Slot, json: string, label: string): boolean {
  try {
    localStorage.setItem(key(slot), json);
    localStorage.setItem(`${key(slot)}:meta`, JSON.stringify({ savedAt: Date.now(), label } satisfies SaveMeta));
    return true;
  } catch {
    return false;
  }
}

export function readSave(slot: string): string | null {
  try {
    return localStorage.getItem(key(slot));
  } catch {
    return null;
  }
}

export function saveMeta(slot: Slot): SaveMeta | null {
  try {
    const raw = localStorage.getItem(`${key(slot)}:meta`);
    if (!raw) return null;
    const m = JSON.parse(raw) as SaveMeta;
    return typeof m.savedAt === 'number' && typeof m.label === 'string' ? m : null;
  } catch {
    return null;
  }
}
