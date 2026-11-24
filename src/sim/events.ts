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
import type { IllnessType, ItemType, RoomType } from './catalog';
import type { DoorSpec, Rect } from './state';

export type SimEvent =
  | { type: 'cured'; id: number; x: number; z: number; fee: number }
  | { type: 'failed'; id: number; x: number; z: number }
  | { type: 'paid'; amount: number; x: number; z: number; label: string }
  | { type: 'left'; id: number; reason: string }
  | { type: 'arrived'; id: number }
  | { type: 'diagnosed'; id: number; illness: IllnessType }
  | { type: 'built'; kind: 'room' | 'item'; id: number }
  | { type: 'sold'; kind: 'room' | 'item'; id: number; refund: number; x: number; z: number }
  | { type: 'hired'; id: number }
  | { type: 'promoted'; id: number; skill: number }
  | { type: 'trained'; id: number; skill: number }
  | { type: 'quit'; id: number }
  | { type: 'broke'; itemId: number; roomId: number }
  | { type: 'repaired'; itemId: number }
  | { type: 'cleaned'; x: number; z: number }
  | { type: 'researched'; id: string }
  | { type: 'eventStart'; kind: 'emergency' | 'inspection'; text: string }
  | { type: 'eventEnd'; kind: 'emergency' | 'inspection'; success: boolean; stars?: number; text: string }
  | { type: 'awards'; year: number; won: string[]; lost: string[]; bonus: number }
  | { type: 'star'; stars: number; scenario: string }
  | { type: 'fired'; id: number }
  | { type: 'service'; roomId: number; patientId: number; phase: 'start' | 'end' }
  | { type: 'toast'; text: string; tone: 'info' | 'warn' | 'good' | 'bad' }
  | { type: 'month'; salaries: number; label: string };

export type Command =
  | { type: 'buildRoom'; room: RoomType; rect: Rect; door: DoorSpec }
  | { type: 'placeItem'; item: ItemType; x: number; z: number; rot: number }
  | { type: 'sellRoom'; id: number }
  | { type: 'sellItem'; id: number }
  | { type: 'hire'; candidateId: number }
  | { type: 'fire'; id: number }
  | { type: 'train'; id: number }
  | { type: 'research'; id: string }
  | { type: 'setPriceMult'; value: number };

export interface CommandResult { ok: boolean; reason?: string; id?: number }
