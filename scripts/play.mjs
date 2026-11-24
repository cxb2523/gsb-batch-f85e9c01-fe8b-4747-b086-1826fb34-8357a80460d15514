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
// Drives a real new game through the UI: desk, consult room, dispensary, hires, then runs and screenshots.
import { chromium } from 'playwright';
const base = process.argv[2] ?? 'http://127.0.0.1:5199/';
const out = process.argv[3] ?? 'shots/play';
const browser = await chromium.launch({ args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(base + '?q=high');
await page.waitForFunction(() => window.__ready === true);
await page.click('text=Open the doors');
await page.waitForTimeout(300);
// screen position of a world tile centre
const at = async (x, z) => page.evaluate(([x, z]) => window.__screenOf(x, z), [x, z]);
const click = async (x, z) => { const p = await at(x, z); await page.mouse.move(p.x, p.y); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(120); };
const drag = async (x0, z0, x1, z1) => {
  const a = await at(x0, z0), b = await at(x1, z1);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + (b.x - a.x) * i / 8, a.y + (b.y - a.y) * i / 8);
  await page.mouse.up(); await page.waitForTimeout(150);
};
const state = () => page.evaluate(() => ({ money: window.__world.state.money, rooms: window.__world.state.rooms.map((r) => r.type), items: window.__world.state.items.map((i) => i.type), staff: window.__world.state.staff.map((s) => s.role + ':' + s.state), patients: window.__world.state.patients.length, cured: window.__world.state.stats.cured }));

// Front desk
await page.keyboard.press('n');
await page.click('button.card[data-item="reception"]');
await click(21.5, 21.5);
await page.keyboard.press('Escape');
// Benches
await page.keyboard.press('n');
await page.click('button.card[data-item="bench"]');
await click(16.5, 14.5);
await click(26.5, 14.5);
await page.keyboard.press('Escape');
// Consult room
await page.keyboard.press('b');
await page.click('button.card[data-room="gp"]');
await drag(12.5, 8.5, 15.5, 11.5);
const doorPos = await at(14.5, 12.4);
await page.mouse.move(doorPos.x, doorPos.y); await page.waitForTimeout(120);
await page.screenshot({ path: `${out}_door.png` });
await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(400);
// Dispensary
await page.keyboard.press('b');
await page.click('button.card[data-room="pharmacy"]');
await drag(27.5, 8.5, 30.5, 11.5);
const d2 = await at(28.5, 12.4);
await page.mouse.move(d2.x, d2.y); await page.waitForTimeout(120);
await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(400);
// Hire
await page.keyboard.press('h');
for (const tab of ['assistant', 'doctor', 'nurse']) {
  await page.click(`[data-tab="${tab}"]`);
  await page.click('[data-hire]');
  await page.waitForTimeout(150);
}
await page.keyboard.press('Escape');
console.log('after build', JSON.stringify(await state()));
await page.keyboard.press('3');
await page.waitForTimeout(25000);
console.log('after run', JSON.stringify(await state()));
await page.screenshot({ path: `${out}_run.png` });
// select a patient
const pat = await page.evaluate(() => { const p = window.__world.state.patients[0]; return p ? window.__screenOf(p.x - 0.5, p.z - 0.5, 0.7) : null; });
if (pat) { await page.mouse.click(pat.x, pat.y); await page.waitForTimeout(400); }
await page.screenshot({ path: `${out}_inspect.png` });
const info = await page.evaluate(() => window.__info());
console.log('info', JSON.stringify(info));
for (const l of logs.slice(0, 20)) console.log(l);
await browser.close();
