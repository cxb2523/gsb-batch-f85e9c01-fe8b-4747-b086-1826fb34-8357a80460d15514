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
import '@fontsource/baloo-2/600.css';
import '@fontsource/baloo-2/700.css';
import '@fontsource/baloo-2/800.css';
import '@fontsource/nunito/600.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/800.css';
import './ui/ui.css';
import type * as THREE from 'three';
import { Vector3 } from 'three';
import { Engine, type Quality } from './render/engine';
import { View } from './render/view';
import { World } from './sim/world';
import { createDemoWorld } from './sim/demo';
import { createLoop } from './loop';
import { ITEMS, type ItemType } from './sim/catalog';
import { buildItemMesh } from './render/itemMeshes';
import { placeObject } from './render/itemsView';
import { Ghost } from './render/ghost';
import { Input } from './ui/input';
import { Hud } from './ui/hud';
import { Sfx } from './audio/sfx';
import { deserialize, serialize } from './sim/save';
import { SCENARIOS, createScenarioState, isScenarioUnlocked, recordStars, scenarioById } from './sim/scenarios';
import { Menu, loadProgress, saveProgress } from './ui/menu';
import { readSave, writeSave, type Slot } from './ui/storage';
import { calendar, monthLabel } from './sim/economy';
import { startEmergency, startInspection } from './sim/happenings';
import { dropLitter } from './sim/janitor';

const params = new URLSearchParams(location.search);
const app = document.getElementById('app')!;
const engine = new Engine(app, (params.get('q') as Quality) || undefined);
const demo = params.get('demo');
const menuMode = !demo && !params.has('play') && !params.has('load');
let loadError = '';
function bootWorld(): World {
  if (demo === '1' || menuMode) return createDemoWorld();
  const slot = params.get('load');
  if (slot) {
    const raw = readSave(slot);
    const res = raw ? deserialize(raw) : { ok: false as const, reason: 'that slot is empty' };
    if (res.ok) return new World(res.state);
    loadError = `Couldn't load that save: ${res.reason}. Starting a fresh hospital instead.`;
  }
  const play = params.get('play');
  if (play) return new World(createScenarioState(play, undefined, params.has('sandbox')));
  return new World();
}
const world = bootWorld();
const overlay = document.createElement('div');
overlay.id = 'overlay';
document.body.appendChild(overlay);
const view = new View(engine, world, overlay);
if (params.get('event') === 'emergency') startEmergency(world, 'chromaticFlu', 6);
if (params.get('event') === 'inspection') startInspection(world);
if (params.has('mess')) {
  for (let i = 0; i < 14; i++) dropLitter(world, 14 + Math.random() * 18, 13 + Math.random() * 12, (['can', 'wrapper', 'puddle'] as const)[i % 3]);
  const m = world.state.items.find((it) => it.type === 'teslaCoil');
  if (m) { m.broken = true; m.wear = 100; }
  const c = world.state.candidates.find((x) => x.role === 'janitor');
  if (c) world.cmd({ type: 'hire', candidateId: c.id });
}
if (params.has('grass')) view.exterior.setGrass(Number(params.get('grass')));
if (params.has('shadow')) engine.sky.configureShadow(Number(params.get('shadow')));
if (params.has('weather')) view.weatherOverride = params.get('weather') as 'rain';
if (params.has('t')) view.todOverride = Number(params.get('t'));
if (params.has('cam')) engine.rig.setView(Number(params.get('cam')));
if (params.has('zoom')) engine.rig.focus(Number(params.get('fx') ?? 22), Number(params.get('fz') ?? 18), Number(params.get('zoom')));

const galleryObjs: THREE.Object3D[] = [];
if (demo === 'items') {
  (Object.keys(ITEMS) as ItemType[]).forEach((type, i) => {
    const o = buildItemMesh(type);
    placeObject(o, { type, x: 11 + (i % 7) * 3.5, z: 9 + Math.floor(i / 7) * 4, rot: 0 });
    o.userData.anim = { active: true, night: 0, level: 1 };
    galleryObjs.push(o);
    engine.scene.add(o);
  });
  engine.rig.focus(22, 13, 26);
}

const sfx = new Sfx();
const ghost = new Ghost(engine.scene);
const input = new Input(engine, world, ghost);
let speed = params.has('speed') ? Number(params.get('speed')) : demo || menuMode ? 1 : 0;
let lastSpeed = 1;
const setSpeed = (s: number) => { if (s > 0) lastSpeed = s; speed = s; };
input.onSpeedKey = (s) => setSpeed(s === 'toggle' ? (speed > 0 ? 0 : lastSpeed) : s);
input.onSfx = (n) => sfx.play(n);
const hud = new Hud(world, {
  engine, input, sfx,
  getSpeed: () => speed,
  setSpeed: (s) => setSpeed(s),
  setWeather: (w) => { view.weatherOverride = w; },
  newGame: () => { location.href = location.pathname; },
  save: (slot: Slot) => saveTo(slot),
  load: (slot: Slot) => { location.href = `${location.pathname}?load=${slot}&nowelcome`; },
  toMenu: () => { saveTo('auto'); location.href = location.pathname; },
  toScenario: (id: string) => { saveTo('auto'); location.href = `${location.pathname}?play=${id}`; },
});
if (menuMode) {
  document.getElementById('ui')!.style.display = 'none';
  input.enabled = false;
  engine.rig.focus(22, 17, 46);
  new Menu((n) => sfx.play(n));
}
function onStar(stars: number, scenario: string) {
  if (demo || menuMode || world.state.sandbox) return;
  const progress = recordStars(loadProgress(), scenario, stars);
  saveProgress(progress);
  const i = SCENARIOS.findIndex((x) => x.id === scenario);
  const nextDef = SCENARIOS[i + 1];
  const next = nextDef && isScenarioUnlocked(progress, nextDef.id) ? { id: nextDef.id, name: nextDef.name } : null;
  hud.showStar(stars, next);
}
function saveLabel() {
  const cal = calendar(world.state.t);
  const where = `${scenarioById(world.state.scenario).name}${world.state.sandbox ? ' (sandbox)' : ''}`;
  return `${where}: day ${cal.day}, ${monthLabel(cal.monthIndex)}, $${Math.round(world.state.money).toLocaleString()}`;
}
function saveTo(slot: Slot) {
  if (demo || menuMode) return false;
  return writeSave(slot, serialize(world), saveLabel());
}
if (loadError) hud.toast(loadError, 'bad');
let lastSavedDay = Math.floor(world.state.t / 90);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveTo('auto'); });
window.addEventListener('pagehide', () => saveTo('auto'));
if (!demo && !menuMode && !params.has('nowelcome') && !params.has('load')) hud.welcome();
if (params.has('load') && !loadError) setTimeout(() => { speed = 1; }, 0);
if (params.get('ui') === '0') document.getElementById('ui')!.style.visibility = 'hidden';
if (params.has('tray')) hud.toggleTray(params.get('tray') as 'rooms');
if (params.has('tool')) input.setTool({ kind: 'room', type: params.get('tool') as 'gp' });
window.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
window.addEventListener('keydown', () => sfx.unlock(), { once: true });

const loop = createLoop((dt) => world.tick(dt), { fixed: 1 / 30, maxSteps: 8 });
let last = performance.now();
let frames = 0;
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const alpha = loop.advance(dt, speed);
  const events = world.drainEvents();
  for (const e of events) if (e.type === 'star') onStar(e.stars, e.scenario);
  if (menuMode) engine.rig.spin(dt);
  const today = Math.floor(world.state.t / 90);
  if (today !== lastSavedDay) { lastSavedDay = today; saveTo('auto'); }
  view.handle(events);
  hud.handle(events);
  sfx.handle(events);
  view.frame(dt, alpha);
  for (const o of galleryObjs) o.userData.animate?.(view.time, dt, o.userData.anim);
  input.update(view.time);
  hud.update(dt);
  engine.render(dt);
  if (++frames === 8) (window as any).__ready = true;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
(window as any).__info = () => ({ fps: engine.fps.toFixed(1), q: engine.quality, scale: engine.renderScale, patients: world.state.patients.length, money: world.state.money });
(window as any).__speed = setSpeed;
(window as any).__sfx = sfx;
(window as any).__engine = engine;
(window as any).__input = input;
(window as any).__world = world;
(window as any).__screenOf = (x: number, z: number, y = 0) => {
  const v = new Vector3(x + 0.5, y, z + 0.5).project(engine.camera);
  return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
};
