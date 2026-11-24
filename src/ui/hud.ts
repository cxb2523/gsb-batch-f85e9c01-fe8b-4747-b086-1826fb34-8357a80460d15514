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
import type { World } from '../sim/world';
import type { Engine, Quality } from '../render/engine';
import { QUALITY_NAMES } from '../render/engine';
import type { Input, Selection } from './input';
import type { SimEvent } from '../sim/events';
import { ILLNESSES, ITEMS, ROLES, ROOMS, roomCost, type ItemType, type Role, type RoomType } from '../sim/catalog';
import { calendar, isNight, MONTH_NAMES, timeOfDay } from '../sim/economy';
import { HIRE_ROLES, signingBonus } from '../sim/staff';
import type { Patient, Staff } from '../sim/state';
import { isItemUnlocked, isRoomUnlocked } from '../sim/unlocks';
import { RESEARCH, availableResearch, researchDef } from '../sim/research';
import { TRAIN_COST_PER_STAR, XP_PER_STAR } from '../sim/staff';
import { SLOTS, saveMeta, type Slot } from './storage';
import { DAY } from '../sim/economy';
import { goalId, goalValue, scenarioById, starterGoalsActive } from '../sim/scenarios';
import { patientCount } from '../sim/state';

const money = (n: number) => `${n < 0 ? '−' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const stars = (n: number) => `<span class="stars" aria-label="${n} of 5 stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;

const ITEM_ICON: Partial<Record<ItemType, string>> = {
  reception: '🛎️', bench: '🪑', vending: '🥤', cooler: '💧', plant: '🪴', radiator: '♨️', bin: '🗑️', lamp: '💡', cabinet: '🗄️',
};
/** CPAL-1.0 Exhibit B attribution; must stay visible in derived works. */
export const ATTRIBUTION = {
  copyright: '© 2026 Blaine Bouvier',
  phrase: 'Originally created by Blaine Bouvier',
  url: 'https://github.com/WebWalker3D/Quackwell-General',
};
const creditHtml = () =>
  `<p class="credit"><span>${ATTRIBUTION.copyright}</span><span>${ATTRIBUTION.phrase}</span><a href="${ATTRIBUTION.url}" target="_blank" rel="noopener">${ATTRIBUTION.url.replace('https://', '')}</a></p>`;

const ROLE_ICON: Record<Role, string> = { doctor: '🩺', nurse: '💉', assistant: '📋', janitor: '🧹' };

type TrayName = 'rooms' | 'items' | 'staff' | 'research' | 'hospital' | 'settings';

interface Goal { text: string; done: (w: World) => boolean }
const GOALS: Goal[] = [
  { text: 'Place a Front Desk', done: (w) => w.state.items.some((i) => i.type === 'reception') },
  { text: 'Hire an Assistant for the desk', done: (w) => w.state.staff.some((s) => s.role === 'assistant') },
  { text: 'Build a Consult Room', done: (w) => w.state.rooms.some((r) => r.type === 'gp') },
  { text: 'Hire a Doctor', done: (w) => w.state.staff.some((s) => s.role === 'doctor') },
  { text: 'Build a Dispensary', done: (w) => w.state.rooms.some((r) => r.type === 'pharmacy') },
  { text: 'Hire a Nurse', done: (w) => w.state.staff.some((s) => s.role === 'nurse') },
  { text: 'Put out two benches', done: (w) => w.state.items.filter((i) => i.type === 'bench').length >= 2 },
  { text: 'Cure 10 patients', done: (w) => w.state.stats.cured >= 10 },
  { text: 'Build a Ballast Booth and a Thaw Sauna', done: (w) => ['ballast', 'sauna'].every((t) => w.state.rooms.some((r) => r.type === t)) },
  { text: 'Reach $100,000 in the bank', done: (w) => w.state.money >= 100_000 },
  { text: 'Reach 75 reputation', done: (w) => w.state.reputation >= 75 },
];

export interface HudDeps {
  engine: Engine;
  input: Input;
  getSpeed: () => number;
  setSpeed: (s: number) => void;
  sfx: { play(name: string): void; volume: number; setVolume(v: number): void };
  setWeather: (w: 'clear' | 'rain' | 'snow' | null) => void;
  newGame: () => void;
  save: (slot: Slot) => boolean;
  load: (slot: Slot) => void;
  toMenu: () => void;
  toScenario: (id: string) => void;
}

export class Hud {
  private root: HTMLDivElement;
  private el: Record<string, HTMLElement> = {};
  private tray: TrayName | null = null;
  private trayHtml = '';
  private staffTab: Role = 'doctor';
  private shownMoney = 0;
  private inspectorHtml = '';
  private acc = 0;
  private hidden = false;
  showFps = false;

  constructor(private world: World, private d: HudDeps) {
    this.root = document.createElement('div');
    this.root.id = 'ui';
    document.body.appendChild(this.root);
    this.shownMoney = world.state.money;
    this.root.innerHTML = `
      <div class="strip" role="status">
        <div class="seg money"><span class="odo" data-k="money"></span></div>
        <div class="seg" title="Reputation"><span aria-hidden="true">♥</span><div class="rep"><i data-k="rep"></i></div><span data-k="repn"></span></div>
        <div class="seg clock"><span class="sky" data-k="sky"></span><span data-k="day"></span><small data-k="month"></small></div>
        <div class="seg speed" data-k="speed">
          <button data-speed="0" title="Pause (Space)" aria-label="Pause">❚❚</button>
          <button data-speed="1" title="Normal speed (1)" aria-label="Normal speed">▶</button>
          <button data-speed="2" title="Fast (2)" aria-label="Fast">▶▶</button>
          <button data-speed="4" title="Fastest (3)" aria-label="Fastest">▶▶▶</button>
        </div>
        <div class="seg count"><span>🧍 <b data-k="pats"></b></span><span>✨ <b data-k="cured"></b> cured</span></div>
      </div>
      <div class="panel goals" data-k="goals"></div>
      <div class="panel inspector" data-k="inspector" hidden></div>
      <div class="banner" data-k="banner" hidden></div>
      <div class="toasts" data-k="toasts"></div>
      <div class="hint" data-k="hint" hidden></div>
      <div class="tray" data-k="tray" hidden></div>
      <nav class="toolbar" aria-label="Build tools">
        ${this.capsule('rooms', '🏥', 'Rooms', '#19a7a0', '#e9fbf8', 'B')}
        ${this.capsule('items', '🪴', 'Items', '#ff5c8a', '#fff0f4', 'N')}
        ${this.capsule('staff', '🧑‍⚕️', 'Staff', '#ffc93c', '#fff8e6', 'H')}
        ${this.capsule('research', '🧪', 'Research', '#20c997', '#e9fff6', 'L')}
        ${this.capsule('hospital', '📋', 'Hospital', '#7c8cff', '#eef0ff', 'J')}
        ${this.capsule('settings', '⚙️', 'Settings', '#9fb0c4', '#f3f7fb', '')}
        <button class="capsule" data-tool="sell" title="Sell rooms and items (X)" style="--c1:#1d2b4f;--c2:#f3f7fb"><span class="a" style="color:#fff">✂️</span><span class="b">Sell</span></button>
      </nav>
      <div class="fps" data-k="fps" hidden></div>`;
    this.root.querySelectorAll<HTMLElement>('[data-k]').forEach((e) => (this.el[e.dataset.k!] = e));
    this.root.addEventListener('click', (e) => this.click(e));
    this.root.addEventListener('input', (e) => this.onInput(e));
    window.addEventListener('keydown', (e) => this.escCapture(e), { capture: true });
    window.addEventListener('keydown', (e) => this.key(e));
    d.input.onToolChange.push(() => this.syncToolButtons());
    d.input.onSelect.push(() => { this.inspectorHtml = ''; this.renderInspector(); });
    d.input.onToast = (t, tone) => this.toast(t, tone);
    this.renderGoals();
  }

  setWorld(w: World) {
    this.world = w;
    this.shownMoney = w.state.money;
    this.closeTray();
    this.renderGoals();
  }

  private capsule(name: TrayName, icon: string, label: string, c1: string, c2: string, key: string) {
    return `<button class="capsule" data-tray="${name}" style="--c1:${c1};--c2:${c2}" aria-pressed="false" title="${label}${key ? ` (${key})` : ''}"><span class="a" aria-hidden="true">${icon}</span><span class="b">${label}${key ? `<kbd>${key}</kbd>` : ''}</span></button>`;
  }

  welcome() {
    const sc = scenarioById(this.world.state.scenario);
    const sandbox = this.world.state.sandbox;
    const intro = sandbox ? 'Sandbox: a million dollars, everything unlocked, no goals. Go wild.' : `${sc.tagline} You start with ${money(this.world.state.money)}.`;
    const firstStar = sandbox ? '' : `<p><b>For your first star:</b> ${sc.stars[0].map((g) => g.text.toLowerCase()).join(' and ')}.</p>`;
    const w = document.createElement('div');
    w.className = 'welcome';
    w.innerHTML = `<div class="card" role="dialog" aria-labelledby="wt">
      <h1 id="wt">${sc.name}</h1>
      <p>${intro}</p>
      ${firstStar}
      <ul>
        <li>Drag with the right mouse button, or use WASD, to move around</li>
        <li>Scroll to zoom; Q and E rotate the view</li>
        <li>Space pauses; 1, 2 and 3 set the speed</li>
        <li>The clipboard on the left lists your first goals</li>
      </ul>
      <button class="btn" data-act="start">Open the doors</button>
      ${creditHtml()}
    </div>`;
    this.root.appendChild(w);
    w.querySelector<HTMLButtonElement>('button')!.focus();
  }

  private pauseEl: HTMLElement | null = null;
  resumeSpeed = 1;

  /** Esc with nothing else to cancel opens the pause menu. */
  private escCapture(e: KeyboardEvent) {
    if (e.key !== 'Escape' || this.root.style.display === 'none') return;
    if (this.pauseEl) { this.closePause(); e.stopImmediatePropagation(); return; }
    if (this.root.querySelector('.welcome, .modal')) return;
    if (this.tray || this.d.input.tool.kind !== 'select' || this.d.input.selection) return;
    this.openPause();
    e.stopImmediatePropagation();
  }

  private openPause() {
    this.resumeSpeed = this.d.getSpeed() || this.resumeSpeed || 1;
    this.d.setSpeed(0);
    const el = document.createElement('div');
    el.className = 'welcome pause';
    const slotRow = (slot: Slot) => {
      const m = saveMeta(slot);
      const when = m ? new Date(m.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Empty';
      return `<div class="slot"><div><b>${slot === 'auto' ? 'Autosave' : `Slot ${slot}`}</b><span>${m ? esc(m.label) : ''}</span><small>${when}</small></div>
        <div class="row">${slot !== 'auto' ? `<button class="btn quiet" data-save="${slot}">Save</button>` : ''}<button class="btn" data-load="${slot}" ${m ? '' : 'disabled'}>Load</button></div></div>`;
    };
    el.innerHTML = `<div class="card" role="dialog" aria-labelledby="pt"><h1 id="pt">Paused</h1>
      <div class="slots">${SLOTS.map(slotRow).join('')}</div>
      <div class="row" style="margin-top:16px"><button class="btn" data-act="resume">Resume</button><button class="btn quiet" data-act="menu">Main menu</button></div>
      ${creditHtml()}</div>`;
    this.root.appendChild(el);
    this.pauseEl = el;
    el.querySelector<HTMLButtonElement>('[data-act="resume"]')!.focus();
  }

  private closePause() {
    this.pauseEl?.remove();
    this.pauseEl = null;
    this.d.setSpeed(this.resumeSpeed || 1);
  }

  private doSave(slot: Slot) {
    if (this.d.save(slot)) {
      this.toast(`Saved to slot ${slot}.`, 'good');
      if (this.pauseEl) { this.closePause(); this.openPause(); }
    } else this.toast('Could not save: browser storage is full or blocked.', 'bad');
  }

  private showAwards(e: { year: number; won: string[]; lost: string[]; bonus: number }) {
    this.d.sfx.play('fanfare');
    this.resumeSpeed = this.d.getSpeed() || 1;
    this.d.setSpeed(0);
    const el = document.createElement('div');
    el.className = 'welcome modal';
    const row = (name: string, won: boolean) => `<li class="${won ? 'won' : ''}"><span aria-hidden="true">${won ? '🏆' : '·'}</span>${name}</li>`;
    el.innerHTML = `<div class="card" role="dialog" aria-labelledby="aw"><h1 id="aw">Year ${e.year} in review</h1>
      <p>${e.won.length ? `The town's health board handed out ${e.won.length} award${e.won.length > 1 ? 's' : ''}, worth ${money(e.bonus)}.` : 'No awards this year. There is always next year.'}</p>
      <ul class="awards">${e.won.map((n) => row(n, true)).join('')}${e.lost.map((n) => row(n, false)).join('')}</ul>
      <button class="btn" data-act="closeAwards">Carry on</button></div>`;
    this.root.appendChild(el);
    el.querySelector<HTMLButtonElement>('button')!.focus();
  }

  private renderBanner() {
    const ev = this.world.state.event;
    const b = this.el.banner;
    if (!ev) { b.hidden = true; return; }
    const left = Math.max(0, ev.endsAt - this.world.state.t);
    const d = Math.floor(left / DAY), h = Math.floor(((left % DAY) / DAY) * 24);
    const time = d > 0 ? `${d}d ${h}h left` : `${h}h left`;
    const html = ev.kind === 'emergency'
      ? `<span aria-hidden="true">🚑</span><b>Emergency</b> ${ev.cured} of ${ev.needed} cured, ${time}`
      : `<span aria-hidden="true">🎩</span><b>Inspection</b> under way, ${time}`;
    if (b.innerHTML !== html) b.innerHTML = html;
    b.hidden = false;
    b.classList.toggle('urgent', ev.kind === 'emergency');
  }

  private key(e: KeyboardEvent) {
    if (this.root.style.display === 'none' || (e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    const map: Record<string, TrayName> = { b: 'rooms', n: 'items', h: 'staff', l: 'research', j: 'hospital' };
    if (map[k]) this.toggleTray(map[k]);
    if (k === 'x') this.d.input.setTool(this.d.input.tool.kind === 'sell' ? { kind: 'select' } : { kind: 'sell' });
    if (k === 'escape' && this.tray) this.closeTray();
    if (k === 'p') { this.hidden = !this.hidden; this.root.style.visibility = this.hidden ? 'hidden' : ''; }
  }

  private click(e: MouseEvent) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button, [data-act]');
    if (!t) return;
    const ds = t.dataset;
    if (ds.speed !== undefined) { this.d.setSpeed(Number(ds.speed)); this.d.sfx.play('click'); }
    if (ds.tray) this.toggleTray(ds.tray as TrayName);
    if (ds.tool === 'sell') { this.d.input.setTool(this.d.input.tool.kind === 'sell' ? { kind: 'select' } : { kind: 'sell' }); this.closeTray(); }
    if (ds.room) { this.d.input.setTool({ kind: 'room', type: ds.room as RoomType }); this.closeTray(); this.d.sfx.play('click'); }
    if (ds.item) { this.d.input.setTool({ kind: 'item', type: ds.item as ItemType, rot: 0 }); this.closeTray(); this.d.sfx.play('click'); }
    if (ds.tab) { this.staffTab = ds.tab as Role; this.renderTray(true); this.d.sfx.play('click'); }
    if (ds.research) {
      const r = this.world.cmd({ type: 'research', id: ds.research });
      if (r.ok) this.d.sfx.play('click');
      else this.toast(`Can't research that: ${r.reason}.`, 'bad');
      this.renderTray(true);
    }
    if (ds.train) {
      const r = this.world.cmd({ type: 'train', id: Number(ds.train) });
      if (r.ok) { this.d.sfx.play('hire'); this.toast('Off to the Training Room!', 'good'); }
      else { this.d.sfx.play('error'); this.toast(`Can't train: ${r.reason}.`, 'bad'); }
      this.inspectorHtml = '';
    }
    if (ds.save) this.doSave(ds.save as Slot);
    if (ds.load) this.d.load(ds.load as Slot);
    if (ds.act === 'resume') this.closePause();
    if (ds.act === 'menu') this.d.toMenu();
    if (ds.next) this.d.toScenario(ds.next);
    if (ds.act === 'closeAwards') { (t.closest('.modal') as HTMLElement)?.remove(); this.d.setSpeed(this.resumeSpeed || 1); }
    if (ds.hire) {
      const r = this.world.cmd({ type: 'hire', candidateId: Number(ds.hire) });
      if (r.ok) { this.d.sfx.play('hire'); this.toast('New hire on the way in!', 'good'); }
      else { this.d.sfx.play('error'); this.toast(`Can't hire: ${r.reason}.`, 'bad'); }
      this.renderTray(true);
    }
    if (ds.fire) {
      const st = this.world.staffById(Number(ds.fire));
      const r = this.world.cmd({ type: 'fire', id: Number(ds.fire) });
      if (r.ok && st) this.toast(`${st.name} has cleared out their locker.`, 'info');
      this.renderTray(true);
      this.inspectorHtml = '';
    }
    if (ds.q) { this.d.engine.setQuality(ds.q as Quality); this.renderTray(true); this.toast(`Graphics set to ${QUALITY_NAMES[ds.q as Quality]}.`, 'info'); }
    if (ds.weather) { this.d.setWeather(ds.weather === 'auto' ? null : (ds.weather as 'rain')); this.renderTray(true); }
    if (ds.act === 'autores') { this.d.engine.autoRes = !this.d.engine.autoRes; if (!this.d.engine.autoRes) { this.d.engine.renderScale = 1; this.d.engine.resize(); } this.renderTray(true); }
    if (ds.act === 'fps') { this.showFps = !this.showFps; this.el.fps.hidden = !this.showFps; this.renderTray(true); }
    if (ds.act === 'start') { (t.closest('.welcome') as HTMLElement)?.remove(); this.d.sfx.play('cure'); this.d.setSpeed(1); }
    if (ds.act === 'closeInspector') this.d.input.select(null);
    if (ds.act === 'sell' && ds.id) {
      const kind = ds.kind as 'room' | 'item';
      const r = this.world.cmd(kind === 'room' ? { type: 'sellRoom', id: Number(ds.id) } : { type: 'sellItem', id: Number(ds.id) });
      if (r.ok) { this.d.sfx.play('whoosh'); this.d.input.select(null); }
    }
    if (ds.act === 'goals') this.el.goals.classList.toggle('min');
    if (ds.act === 'newgame') { if (confirm('Start a new hospital? Your current one will be lost.')) this.d.newGame(); }
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.dataset.price !== undefined) {
      this.world.cmd({ type: 'setPriceMult', value: Number(t.value) / 100 });
      const out = this.root.querySelector('[data-k="priceOut"]');
      if (out) out.textContent = `${t.value}%`;
    }
    if (t.dataset.vol !== undefined) this.d.sfx.setVolume(Number(t.value) / 100);
  }

  toggleTray(name: TrayName) {
    if (this.tray === name) { this.closeTray(); return; }
    this.tray = name;
    if (this.d.input.tool.kind !== 'select') this.d.input.setTool({ kind: 'select' });
    this.renderTray(true);
    this.el.tray.hidden = false;
    this.syncToolButtons();
    this.d.sfx.play('click');
  }

  closeTray() {
    this.tray = null;
    this.el.tray.hidden = true;
    this.syncToolButtons();
  }

  private syncToolButtons() {
    this.root.querySelectorAll<HTMLButtonElement>('[data-tray]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tray === this.tray)));
    const sell = this.root.querySelector<HTMLButtonElement>('[data-tool="sell"]');
    sell?.setAttribute('aria-pressed', String(this.d.input.tool.kind === 'sell'));
  }

  private renderTray(force = false) {
    if (!this.tray) return;
    const s = this.world.state;
    let html = '';
    switch (this.tray) {
      case 'rooms': {
        html = `<h2>Rooms</h2><p class="sub">Pick a room, then drag out its floor in the corridor. Equipment is installed for you.</p><div class="grid">`;
        for (const [k, def] of Object.entries(ROOMS) as [RoomType, (typeof ROOMS)[RoomType]][]) {
          const cost = roomCost(k, def.minW, def.minH);
          const locked = !isRoomUnlocked(s, k);
          html += `<button class="card" data-room="${k}" ${s.money < cost || locked ? 'disabled' : ''}>
            <div class="icon" aria-hidden="true">${def.icon}</div><div class="name">${def.name}</div>
            <div class="meta">${locked ? '<span class="tag lock">🔒 research first</span>' : ''}<span class="tag cost">from ${money(cost)}</span><span class="tag">${def.minW}×${def.minH}+</span>${def.staff ? `<span class="tag role">${ROLE_ICON[def.staff]} ${ROLES[def.staff].name}</span>` : '<span class="tag">no staff</span>'}</div>
            <div class="desc">${def.desc}</div></button>`;
        }
        html += '</div>';
        break;
      }
      case 'items': {
        html = `<h2>Items</h2><p class="sub">Decor makes waiting patients calmer. Drinks earn a little and keep them from storming out.</p><div class="grid">`;
        for (const [k, def] of Object.entries(ITEMS) as [ItemType, (typeof ITEMS)[ItemType]][]) {
          if (!def.buyable) continue;
          const locked = !isItemUnlocked(s, k);
          html += `<button class="card" data-item="${k}" ${s.money < def.cost || locked ? 'disabled' : ''}>
            <div class="icon" aria-hidden="true">${ITEM_ICON[k] ?? '📦'}</div><div class="name">${def.name}</div>
            <div class="meta">${locked ? '<span class="tag lock">🔒 research first</span>' : ''}<span class="tag cost">${money(def.cost)}</span>${def.where === 'room' ? '<span class="tag">rooms</span>' : def.where === 'corridor' ? '<span class="tag">corridors</span>' : ''}</div>
            <div class="desc">${def.desc}</div></button>`;
        }
        html += '</div>';
        break;
      }
      case 'staff': {
        const tab = this.staffTab;
        html = `<h2>Staff</h2><p class="sub">Hiring costs a signing bonus of a quarter month's pay. Salaries go out at the end of every month.</p>
          <div class="tabs">${HIRE_ROLES.map((r) => `<button data-tab="${r}" aria-pressed="${r === tab}">${ROLE_ICON[r]} ${ROLES[r].plural}</button>`).join('')}</div><div class="grid">`;
        for (const c of s.candidates.filter((c) => c.role === tab)) {
          const bonus = signingBonus(c.salary);
          html += `<div class="card"><div class="name">${esc(c.name)}</div><div class="meta">${stars(c.skill)}<span class="tag">${esc(c.trait)}</span></div>
            <div class="desc">${money(c.salary)} a month</div>
            <div class="row" style="margin-top:8px"><button class="btn" data-hire="${c.id}" ${s.money < bonus ? 'disabled' : ''}>Hire for ${money(bonus)}</button></div></div>`;
        }
        html += `</div><h2 style="margin-top:16px;font-size:20px">Your team</h2>`;
        const team = s.staff.filter((st) => st.state !== 'leaving');
        if (!team.length) html += `<p class="sub">Nobody yet. Every room needs someone to run it.</p>`;
        for (const st of team) {
          html += `<div class="staffrow"><span>${ROLE_ICON[st.role]} ${esc(st.name)} <small style="color:var(--ink-soft)">${this.staffStatus(st)}</small></span>${stars(st.skill)}<span>${money(st.salary)}/mo</span><button class="btn pink" data-fire="${st.id}">Fire</button></div>`;
        }
        break;
      }
      case 'research': {
        const r = s.research;
        const labs = s.rooms.filter((x) => x.type === 'research');
        const working = labs.filter((x) => x.staffId !== -1).length;
        const cur = r.current ? researchDef(r.current) : undefined;
        html = `<h2>Research</h2><p class="sub">${labs.length ? `${working} of ${labs.length} lab${labs.length > 1 ? 's' : ''} staffed. Pick a project and your researchers get to work.` : 'Build a Research Lab and put a Doctor in it to start researching.'}</p>`;
        if (cur) html += this.bar(`${cur.icon} ${cur.name}: ${Math.floor(Math.min(r.points, cur.cost))} / ${cur.cost}`, r.points / cur.cost, '#20c997');
        else if (r.points > 0) html += `<p class="sub">${Math.floor(r.points)} points banked for the next project.</p>`;
        html += '<div class="grid" style="margin-top:10px">';
        for (const def of availableResearch(s)) {
          const on = r.current === def.id;
          html += `<button class="card${on ? ' on' : ''}" data-research="${def.id}" aria-pressed="${on}"><div class="icon" aria-hidden="true">${def.icon}</div><div class="name">${def.name}</div>
            <div class="meta"><span class="tag">${def.cost} points</span>${on ? '<span class="tag role">in progress</span>' : ''}</div><div class="desc">${def.desc}</div></button>`;
        }
        html += '</div>';
        const done = RESEARCH.filter((d) => r.done.includes(d.id));
        if (done.length) html += `<p class="sub" style="margin-top:12px">Done: ${done.map((d) => `${d.icon} ${d.name}`).join(', ')}</p>`;
        break;
      }
      case 'hospital': {
        const m = s.monthStats, a = s.stats;
        html = `<h2>Hospital</h2><p class="sub">Cheaper treatment brings more patients and builds reputation faster. Pricier treatment earns more per cure.</p>
          <div class="cols"><div>
            <label style="font-weight:800">Treatment prices: <span data-k="priceOut">${Math.round(s.priceMult * 100)}%</span></label>
            <input type="range" min="50" max="200" step="5" value="${Math.round(s.priceMult * 100)}" data-price aria-label="Treatment price">
            <dl class="kv" style="margin-top:14px">
              <dt>Reputation</dt><dd>${Math.round(s.reputation)} / 100</dd>
              <dt>Monthly salaries</dt><dd>${money(s.staff.reduce((x, st) => x + st.salary, 0))}</dd>
              <dt>Patients inside now</dt><dd>${patientCount(s)}</dd>
            </dl></div>
            <div><dl class="kv">
              <dt>Earned this month</dt><dd>${money(m.earned)}</dd>
              <dt>Cured this month</dt><dd>${m.cured}</dd>
              <dt>Cured all time</dt><dd>${a.cured}</dd>
              <dt>Treatments failed</dt><dd>${a.failed}</dd>
              <dt>Walked out</dt><dd>${a.left}</dd>
              <dt>Earned all time</dt><dd>${money(a.earned)}</dd>
            </dl></div></div>`;
        break;
      }
      case 'settings': {
        const e = this.d.engine;
        html = `<h2>Settings</h2><p class="sub">Running on ${esc(e.gpuName.replace(/^ANGLE \(|\)$/g, '') || 'your GPU')}. Ultra assumes a dedicated graphics card.</p>
          <div class="cols"><div>
            <div style="font-weight:800;margin-bottom:6px">Graphics</div>
            <div class="tabs">${(['ultra', 'high', 'medium', 'low'] as Quality[]).map((q) => `<button data-q="${q}" aria-pressed="${e.quality === q}">${QUALITY_NAMES[q]}</button>`).join('')}</div>
            <div class="row"><button class="btn quiet" data-act="autores">${e.autoRes ? 'Auto resolution: on' : 'Auto resolution: off'}</button><button class="btn quiet" data-act="fps">${this.showFps ? 'Hide FPS' : 'Show FPS'}</button></div>
            <div style="font-weight:800;margin:14px 0 6px">Weather</div>
            <div class="tabs"><button data-weather="auto">Seasonal</button><button data-weather="clear">Sunny</button><button data-weather="rain">Rain</button><button data-weather="snow">Snow</button></div>
          </div><div>
            <label style="font-weight:800">Sound volume</label>
            <input type="range" min="0" max="100" value="${Math.round(this.d.sfx.volume * 100)}" data-vol aria-label="Sound volume">
            <p class="sub" style="margin-top:12px">Press P to hide the interface for screenshots.</p>
            <button class="btn pink" data-act="newgame">Start a new hospital</button>
          </div></div>
          <div class="about"><b>Quackwell General</b>, licensed under the Common Public Attribution License 1.0.${creditHtml()}</div>`;
        break;
      }
    }
    if (force || html !== this.trayHtml) {
      if (html !== this.trayHtml) {
        this.trayHtml = html;
        this.el.tray.innerHTML = html;
      }
    }
  }

  private patientStatus(p: Patient): string {
    const room = p.target >= 0 ? this.world.room(p.target) : undefined;
    const rn = room ? ROOMS[room.type].name : '';
    switch (p.state) {
      case 'arriving': return p.vip ? 'Arriving to inspect the hospital.' : p.emergency ? 'Rushed in by ambulance!' : 'Heading in through the front doors.';
      case 'queueReception': return p.desk === -1 ? 'Looking for somewhere to check in.' : 'Queuing at the Front Desk.';
      case 'atReception': return 'Checking in.';
      case 'seekRoom': return 'Working out where to go next.';
      case 'waiting': return room ? `Waiting for the ${rn}.` : p.need ? `Waiting for someone to build a ${ROOMS[p.need].name}.` : 'Waiting.';
      case 'toRoom': return `Walking into the ${rn}.`;
      case 'inRoom': return `Being seen in the ${rn}.`;
      case 'toVending': case 'atVending': return 'Grabbing a drink.';
      case 'leaving': return p.cured ? 'Going home cured!' : p.leaveReason === 'impatient' ? 'Storming out after waiting too long.' : 'Going home, still unwell.';
      default: return '';
    }
  }

  private staffStatus(st: Staff): string {
    if (st.state === 'leaving') return 'Leaving for good';
    if (st.state === 'toBreak') return 'Heading for a break';
    if (st.state === 'onBreak') return 'On a break in the Staff Room';
    if (st.state === 'toTraining') return 'Heading to training';
    if (st.state === 'training') return `Training (${Math.ceil(st.trainLeft)}s left)`;
    if (st.role === 'janitor') {
      if (st.state === 'toJob' || st.state === 'doingJob') return st.job?.kind === 'repair' ? 'Fixing a machine' : 'Sweeping up';
      return 'Looking for mess';
    }
    if (st.state === 'toPost') return 'Heading to work';
    if (st.state === 'atPost') {
      if (st.post < 0) return 'At the Front Desk';
      const r = this.world.room(st.post);
      return r ? (st.busy ? `Treating in the ${ROOMS[r.type].name}` : `Waiting in the ${ROOMS[r.type].name}`) : 'At work';
    }
    return 'Looking for a room to run';
  }

  private bar(label: string, v: number, color: string) {
    const pct = Math.max(0, Math.min(100, v * 100));
    return `<div class="bar">${label}<div class="track"><div class="fill" style="width:${pct.toFixed(0)}%;background:${color}"></div></div></div>`;
  }

  private renderInspector() {
    const sel: Selection = this.d.input.selection;
    const box = this.el.inspector;
    if (!sel) { box.hidden = true; this.inspectorHtml = ''; return; }
    let html = '<button class="close" data-act="closeInspector" aria-label="Close">✕</button>';
    if (sel.kind === 'patient') {
      const p = this.world.patient(sel.id);
      if (!p) { box.hidden = true; return; }
      const ill = ILLNESSES[p.illness];
      if (p.vip) {
        html += `<div class="who"><div class="avatar" aria-hidden="true">🎩</div><div><b>${esc(p.name)}</b><span>Health inspector</span></div></div><div class="status">Taking notes on cleanliness, comfort, queues and broken machines.</div>`;
        if (html !== this.inspectorHtml) { this.inspectorHtml = html; box.innerHTML = html; }
        box.hidden = false;
        return;
      }
      html += `<div class="who"><div class="avatar" aria-hidden="true">${p.emergency ? '🚑' : '🤒'}</div><div><b>${esc(p.name)}</b><span>${p.diagnosed ? ill.name : 'Not diagnosed yet'}</span></div></div>`;
      if (p.diagnosed) html += `<div class="desc" style="font-size:13px;font-weight:600;color:var(--ink-soft)">${ill.desc} Cured in a ${ROOMS[ill.room].name}.</div>`;
      html += this.bar('Diagnosis', p.certainty, '#7c8cff');
      html += this.bar('Patience', p.patience / 100, p.patience < 30 ? '#ff4d6d' : '#24c08a');
      html += this.bar('Thirst', p.thirst / 100, '#3fb6ff');
      html += `<div class="status">${this.patientStatus(p)}</div>`;
    } else if (sel.kind === 'staff') {
      const st = this.world.staffById(sel.id);
      if (!st) { box.hidden = true; return; }
      html += `<div class="who"><div class="avatar" aria-hidden="true">${ROLE_ICON[st.role]}</div><div><b>${esc(st.name)}</b><span>${ROLES[st.role].name}</span></div></div>`;
      html += `<div class="meta">${stars(st.skill)} <span class="tag">${esc(st.trait)}</span></div>`;
      html += `<dl class="kv" style="margin-top:8px"><dt>Salary</dt><dd>${money(st.salary)}/mo</dd></dl>`;
      html += this.bar('Energy', st.energy / 100, st.energy < 22 ? '#ff4d6d' : '#ffc93c');
      html += this.bar('Mood', st.mood / 100, st.mood < 25 ? '#ff4d6d' : '#24c08a');
      if (st.skill < 5) html += this.bar(`Experience toward ${'★'.repeat(st.skill + 1)}`, st.xp / XP_PER_STAR, '#7c8cff');
      html += `<div class="status">${this.staffStatus(st)}.</div><div class="row">`;
      if (st.skill < 5) html += `<button class="btn" data-train="${st.id}">Train for ${money(TRAIN_COST_PER_STAR * st.skill)}</button>`;
      html += `<button class="btn pink" data-fire="${st.id}">Fire</button></div>`;
    } else if (sel.kind === 'room') {
      const r = this.world.room(sel.id);
      if (!r) { box.hidden = true; return; }
      const def = ROOMS[r.type];
      const st = r.staffId !== -1 ? this.world.staffById(r.staffId) : undefined;
      html += `<div class="who"><div class="avatar" aria-hidden="true">${def.icon}</div><div><b>${def.name}</b><span>${r.rect.w}×${r.rect.h}</span></div></div>`;
      const broken = this.world.state.items.filter((it) => r.items.includes(it.id) && it.broken);
      if (broken.length) html += `<div class="status bad">${broken.map((b) => ITEMS[b.type].name).join(', ')} broken. A janitor will fix it.</div>`;
      const wearItems = this.world.state.items.filter((it) => r.items.includes(it.id) && ITEMS[it.type].machine);
      for (const m of wearItems) html += this.bar(`${ITEMS[m.type].name} wear`, m.wear / 100, m.wear > 70 ? '#ff4d6d' : '#9fb0c4');
      if (r.type === 'research') {
        const cur = this.world.state.research.current ? researchDef(this.world.state.research.current) : undefined;
        html += `<div class="status">${cur ? `Researching ${cur.name}.` : 'No project picked. Open Research (L) to choose one.'}</div>`;
      }
      if (def.staff) {
        html += `<dl class="kv"><dt>${ROLES[def.staff].name}</dt><dd>${st ? esc(st.name) : 'Nobody'}</dd><dt>Queue</dt><dd>${r.queue.length}</dd><dt>Inside</dt><dd>${r.occupants.length}</dd></dl>`;
        html += `<div class="status">${st ? def.desc : `Hire a ${ROLES[def.staff].name} to open this room.`}</div>`;
      } else {
        html += `<div class="status">${def.desc}</div>`;
      }
      html += `<button class="btn quiet" data-act="sell" data-kind="room" data-id="${r.id}">Sell for ${money(r.cost / 2)}</button>`;
    } else {
      const it = this.world.item(sel.id);
      if (!it) { box.hidden = true; return; }
      const def = ITEMS[it.type];
      html += `<div class="who"><div class="avatar" aria-hidden="true">${ITEM_ICON[it.type] ?? '📦'}</div><div><b>${def.name}</b><span>${it.roomId === -1 ? 'Corridor' : 'Room'}</span></div></div>`;
      html += `<div class="status">${def.desc}</div>`;
      if (it.type === 'reception') html += `<dl class="kv"><dt>In line</dt><dd>${it.queue.length}</dd></dl>`;
      html += `<button class="btn quiet" data-act="sell" data-kind="item" data-id="${it.id}">Sell for ${money(it.cost / 2)}</button>`;
    }
    if (html !== this.inspectorHtml) {
      this.inspectorHtml = html;
      box.innerHTML = html;
    }
    box.hidden = false;
  }

  private renderGoals() {
    const s = this.world.state;
    const sc = scenarioById(s.scenario);
    let html = `<button class="collapse" data-act="goals" aria-label="Collapse goals">–</button>`;
    if (s.sandbox) {
      html += `<h3>Sandbox</h3><p class="desc" style="font-size:13px;font-weight:600;color:var(--ink-soft)">No goals here. Build whatever you like.</p>`;
    } else {
      const next = Math.min(s.stars, 2);
      html += `<h3>${sc.name}</h3><div class="starline stars" aria-label="${s.stars} of 3 stars">${'★'.repeat(s.stars)}<span class="off">${'★'.repeat(3 - s.stars)}</span></div>`;
      if (s.stars < 3) {
        html += `<h4>For ${'★'.repeat(next + 1)}</h4>`;
        sc.stars[next].forEach((g, i) => {
          const met = s.goals[goalId(sc.id, next, i)] !== undefined;
          const v = goalValue(s, g);
          const pct = met ? 100 : Math.max(0, Math.min(100, (v / g.target) * 100));
          const shown = g.kind === 'money' ? `$${Math.round(Math.min(v, g.target)).toLocaleString()}` : String(Math.floor(Math.min(v, g.target)));
          const target = g.kind === 'money' ? `$${g.target.toLocaleString()}` : String(g.target);
          const count = g.target > 1 && g.kind !== 'room' ? ` <small>${shown} / ${target}</small>` : '';
          html += `<span class="goal ${met ? 'met' : ''}">${met ? '✓ ' : ''}${g.text}${count}<span class="gbar"><i style="width:${pct.toFixed(0)}%"></i></span></span>`;
        });
      } else html += `<p class="desc" style="font-size:13px;font-weight:700">Three stars! This town is in excellent hands.</p>`;
    }
    if (starterGoalsActive(s)) {
      const open = GOALS.map((g, i) => ({ g, i, done: !!s.hints[`goal:${i}`] })).filter((x) => !x.done);
      if (open.length && open.length > GOALS.length - 9) {
        html += `<h4>Getting started</h4><ul>`;
        for (const x of open.slice(0, 4)) html += `<li><span class="box" aria-hidden="true"></span>${x.g.text}</li>`;
        html += '</ul>';
      }
    }
    if (this.el.goals.innerHTML !== html) this.el.goals.innerHTML = html;
  }

  showStar(stars: number, next: { id: string; name: string } | null) {
    this.d.sfx.play('fanfare');
    this.resumeSpeed = this.d.getSpeed() || 1;
    this.d.setSpeed(0);
    const sc = scenarioById(this.world.state.scenario);
    const el = document.createElement('div');
    el.className = 'welcome modal star-modal';
    const title = stars === 3 ? 'Three stars!' : stars === 2 ? 'Two stars!' : 'A star!';
    const line = stars === 3 ? 'is the best hospital in the land.' : 'is going from strength to strength.';
    const opened = next && stars === 1 ? ` ${next.name} is now open in the campaign.` : '';
    el.innerHTML = `<div class="card" role="dialog" aria-labelledby="st"><h1 id="st">${title}</h1>
      <div class="bigstars" aria-hidden="true">${'★'.repeat(stars)}<span style="color:#dde6ef">${'★'.repeat(3 - stars)}</span></div>
      <p>${sc.name} ${line}${opened}</p>
      <div class="row">
        <button class="btn" data-act="closeAwards">Keep playing</button>
        ${next ? `<button class="btn quiet" data-next="${next.id}">Go to ${next.name}</button>` : ''}
        <button class="btn quiet" data-act="menu">Main menu</button>
      </div></div>`;
    this.root.appendChild(el);
    el.querySelector<HTMLButtonElement>('button')!.focus();
  }

  private checkGoals() {
    const s = this.world.state;
    if (!starterGoalsActive(s)) { this.renderGoals(); return; }
    GOALS.forEach((g, i) => {
      if (s.hints[`goal:${i}`]) return;
      if (g.done(this.world)) {
        s.hints[`goal:${i}`] = s.t || 1;
        this.toast(`Goal complete: ${g.text}`, 'good');
        this.d.sfx.play('goal');
      }
    });
    this.renderGoals();
  }

  toast(text: string, tone: 'info' | 'warn' | 'good' | 'bad' = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${tone}`;
    t.innerHTML = `<span class="dot" aria-hidden="true"></span><span>${esc(text)}</span>`;
    t.setAttribute('role', 'status');
    this.el.toasts.appendChild(t);
    while (this.el.toasts.children.length > 5) this.el.toasts.firstElementChild!.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 5200);
  }

  handle(events: SimEvent[]) {
    for (const e of events) {
      if (e.type === 'awards') this.showAwards(e);
      if (e.type === 'eventStart') this.d.sfx.play(e.kind === 'emergency' ? 'siren' : 'hire');
      if (e.type === 'broke') this.d.sfx.play('clank');
      if (e.type === 'promoted' || e.type === 'trained') this.d.sfx.play('goal');
      if (e.type === 'researched') { this.d.sfx.play('goal'); if (this.tray === 'research') this.renderTray(true); }
      if (e.type === 'toast') this.toast(e.text, e.tone);
      if (e.type === 'month') this.toast(`Payday: ${money(e.salaries)} in salaries went out. Welcome to ${e.label}.`, 'info');
    }
  }

  update(dt: number) {
    const s = this.world.state;
    const k = 1 - Math.exp(-7 * dt);
    this.shownMoney += (s.money - this.shownMoney) * k;
    if (Math.abs(s.money - this.shownMoney) < 1) this.shownMoney = s.money;
    this.el.money.textContent = money(this.shownMoney);
    this.el.money.parentElement!.classList.toggle('neg', s.money < 0);
    (this.el.rep as HTMLElement).style.width = `${s.reputation.toFixed(0)}%`;
    this.el.repn.textContent = String(Math.round(s.reputation));
    const cal = calendar(s.t);
    const tod = timeOfDay(s.t);
    const hour = Math.floor(tod * 24), min = Math.floor((tod * 24 * 60) % 60 / 15) * 15;
    this.el.sky.textContent = isNight(s.t) ? '🌙' : tod < 0.3 || tod > 0.78 ? '🌅' : '☀️';
    this.el.day.textContent = `Day ${cal.day}`;
    this.el.month.textContent = `${MONTH_NAMES[cal.month]} Y${cal.year}, ${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    this.el.pats.textContent = String(patientCount(s));
    this.el.cured.textContent = String(s.stats.cured);
    const sp = this.d.getSpeed();
    this.el.speed.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === sp)));
    const input = this.d.input;
    this.el.hint.hidden = !input.hintText || !!this.tray;
    if (input.hintText && this.el.hint.dataset.html !== input.hintText) {
      this.el.hint.dataset.html = input.hintText;
      this.el.hint.innerHTML = input.hintText;
    }
    this.el.hint.classList.toggle('bad', input.hintBad);
    this.acc += dt;
    if (this.acc > 0.25) {
      this.acc = 0;
      this.renderInspector();
      this.renderBanner();
      this.checkGoals();
      if (this.tray) this.renderTray();
      if (this.showFps) this.el.fps.textContent = `${this.d.engine.fps.toFixed(0)} fps, ${QUALITY_NAMES[this.d.engine.quality]}, ${Math.round(this.d.engine.renderScale * 100)}% resolution`;
    }
  }
}
