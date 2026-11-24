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
import { SCENARIOS, isScenarioUnlocked, parseProgress, type Progress, type ScenarioDef } from '../sim/scenarios';
import { saveMeta } from './storage';
import { ATTRIBUTION } from './hud';

const PROGRESS_KEY = 'qg:campaign';

export function loadProgress(): Progress {
  try {
    return parseProgress(localStorage.getItem(PROGRESS_KEY));
  } catch {
    return parseProgress(null);
  }
}

export function saveProgress(p: Progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: progress lives for this session only */
  }
}

const money = (n: number) => `$${n.toLocaleString()}`;
const starRow = (n: number) => `<span class="stars big" aria-label="${n} of 3 stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(3 - n)}</span></span>`;

/** Title screen, campaign select, level intro and sandbox picker. Navigation reloads with URL params. */
export class Menu {
  private root: HTMLDivElement;
  private progress = loadProgress();

  constructor(private onSound: (n: string) => void) {
    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.root.id = 'menu';
    document.body.appendChild(this.root);
    this.root.addEventListener('click', (e) => this.click(e));
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.home(); });
    this.home();
  }

  private go(url: string) {
    this.onSound('click');
    location.href = url;
  }

  private click(e: MouseEvent) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    const d = t.dataset;
    if (d.act === 'continue') this.go(`${location.pathname}?load=auto&nowelcome`);
    if (d.act === 'campaign') { this.onSound('click'); this.campaign(); }
    if (d.act === 'sandbox') { this.onSound('click'); this.sandbox(); }
    if (d.act === 'home') { this.onSound('click'); this.home(); }
    if (d.level) { this.onSound('click'); this.intro(SCENARIOS.find((s) => s.id === d.level)!); }
    if (d.play) this.go(`${location.pathname}?play=${d.play}`);
    if (d.sand) this.go(`${location.pathname}?play=${d.sand}&sandbox`);
  }

  private credit() {
    return `<p class="credit"><span>${ATTRIBUTION.copyright}</span><span>${ATTRIBUTION.phrase}</span><a href="${ATTRIBUTION.url}" target="_blank" rel="noopener">${ATTRIBUTION.url.replace('https://', '')}</a></p>`;
  }

  home() {
    const auto = saveMeta('auto');
    const total = SCENARIOS.reduce((a, s) => a + (this.progress.stars[s.id] ?? 0), 0);
    this.root.innerHTML = `<div class="menu-title">
        <h1>Quackwell<br>General</h1>
        <p>Build a hospital. Cure the incurable. Mind the ducks.</p>
      </div>
      <div class="menu-card main">
        ${auto ? `<button class="menu-btn primary" data-act="continue"><b>Continue</b><span>${auto.label}</span></button>` : ''}
        <button class="menu-btn ${auto ? '' : 'primary'}" data-act="campaign"><b>Campaign</b><span>${total} of ${SCENARIOS.length * 3} stars earned</span></button>
        <button class="menu-btn" data-act="sandbox"><b>Sandbox</b><span>A million dollars and everything unlocked</span></button>
        ${this.credit()}
      </div>`;
    this.root.querySelector<HTMLButtonElement>('.menu-btn')?.focus();
  }

  private campaign() {
    const cards = SCENARIOS.map((s, i) => {
      const open = isScenarioUnlocked(this.progress, s.id);
      const stars = this.progress.stars[s.id] ?? 0;
      return `<button class="level ${s.theme}" data-level="${s.id}" ${open ? '' : 'disabled'}>
        <span class="lv-icon" aria-hidden="true">${open ? s.icon : '🔒'}</span>
        <b>${i + 1}. ${s.name}</b>
        ${starRow(stars)}
        <span class="lv-tag">${open ? s.tagline : `Earn a star at ${SCENARIOS[i - 1].name} to unlock.`}</span>
      </button>`;
    }).join('');
    this.root.innerHTML = `<div class="menu-card wide"><h2>Campaign</h2><p class="sub">Five hospitals, three stars each. One star opens the next town.</p>
      <div class="levels">${cards}</div><div class="row"><button class="btn quiet" data-act="home">Back</button></div></div>`;
  }

  private intro(s: ScenarioDef) {
    const stars = this.progress.stars[s.id] ?? 0;
    const goals = s.stars.map((list, k) => `<li class="${stars > k ? 'done' : ''}"><span class="stars" aria-hidden="true">${'★'.repeat(k + 1)}</span><span>${list.map((g) => g.text).join(', ')}</span></li>`).join('');
    this.root.innerHTML = `<div class="menu-card intro ${s.theme}"><div class="intro-head"><span class="lv-icon big" aria-hidden="true">${s.icon}</span><div><h2>${s.name}</h2><p class="sub">${s.tagline}</p></div></div>
      <dl class="kv"><dt>Starting money</dt><dd>${money(s.money)}</dd><dt>Best so far</dt><dd>${starRow(stars)}</dd></dl>
      <ul class="goal-list">${goals}</ul>
      <div class="row"><button class="btn" data-play="${s.id}">Open the hospital</button><button class="btn quiet" data-act="campaign">Back</button></div></div>`;
    this.root.querySelector<HTMLButtonElement>('[data-play]')?.focus();
  }

  private sandbox() {
    const cards = SCENARIOS.map((s) => {
      const open = isScenarioUnlocked(this.progress, s.id);
      return `<button class="level ${s.theme}" data-sand="${s.id}" ${open ? '' : 'disabled'}><span class="lv-icon" aria-hidden="true">${open ? s.icon : '🔒'}</span><b>${s.name}</b><span class="lv-tag">${open ? `${s.building.w}×${s.building.h} building` : 'Unlock it in the campaign first.'}</span></button>`;
    }).join('');
    this.root.innerHTML = `<div class="menu-card wide"><h2>Sandbox</h2><p class="sub">No goals and no research needed. Pick a town you've unlocked.</p>
      <div class="levels">${cards}</div><div class="row"><button class="btn quiet" data-act="home">Back</button></div></div>`;
  }
}
