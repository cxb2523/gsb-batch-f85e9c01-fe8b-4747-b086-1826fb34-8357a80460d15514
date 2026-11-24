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
// Measures steady-state FPS for a URL at a given size (auto-res off) over a few seconds.
import { chromium } from 'playwright';
const [url, size = '1920x1080', secs = '6'] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);
const browser = await chromium.launch({ args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width, height } });
await page.goto(url);
await page.waitForFunction(() => window.__ready === true);
await page.waitForTimeout(1500);
const r = await page.evaluate(async (secs) => {
  const eng = window.__engine;
  eng.autoRes = false; eng.renderScale = 1; eng.resize();
  await new Promise((r) => setTimeout(r, 800));
  let n = 0; const t0 = performance.now();
  await new Promise((res) => { const f = () => { n++; if (performance.now() - t0 < secs * 1000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
  const ms = (performance.now() - t0) / n;
  const info = eng.renderer.info.render;
  return { fps: (1000 / ms).toFixed(1), ms: ms.toFixed(2), q: eng.quality, calls: info.calls, tris: info.triangles };
}, Number(secs));
console.log(size, JSON.stringify(r));
await browser.close();
