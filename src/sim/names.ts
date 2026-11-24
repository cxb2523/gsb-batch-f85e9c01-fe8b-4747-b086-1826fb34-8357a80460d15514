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
import { pick, type RngState } from './rng';

const FIRST = [
  'Ada', 'Bram', 'Cleo', 'Dex', 'Edie', 'Fitz', 'Gus', 'Hattie', 'Ivo', 'Juno', 'Kit', 'Lark', 'Milo', 'Nell', 'Otto',
  'Pip', 'Quinn', 'Rosa', 'Sol', 'Tess', 'Umi', 'Vic', 'Wren', 'Xavi', 'Yara', 'Zed', 'Bea', 'Cosmo', 'Dot', 'Elmo',
  'Flo', 'Hugo', 'Iris', 'Jojo', 'Kip', 'Lula', 'Moss', 'Nico', 'Opal', 'Pearl', 'Rex', 'Suki', 'Tibbs', 'Vera',
];
const LAST = [
  'Puddleby', 'Wobblesworth', 'Fizzwick', 'Bramblecot', 'Higgins', 'Nutterby', 'Plimsoll', 'Quibble', 'Rumbold',
  'Snodgrass', 'Tumbleweed', 'Underfoot', 'Vantablack', 'Whistlecraft', 'Yarrow', 'Crumpet', 'Dimbleby', 'Ellsworth',
  'Figgins', 'Gooseberry', 'Honk', 'Inkpen', 'Jollop', 'Kettleby', 'Lumpkin', 'Mudge', 'Noodle', 'Ogg', 'Pickle',
];

export const TRAITS = ['Speedy', 'Steady Hands', 'Sharp Eye', 'Cheerful', 'Night Owl', 'Tea Fiend', 'Punctual', 'Dramatic'];

export function randomName(r: RngState) {
  return `${pick(r, FIRST)} ${pick(r, LAST)}`;
}
