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
// Usage: node scripts/shot.mjs <url> <out.png> [waitMs] [WxH]
// Waits for window.__ready (set by the app once the first frames rendered), then screenshots.
import { chromium } from 'playwright';

const [url, out, waitMs = '1500', size = '1600x900'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [waitMs] [WxH]');
  process.exit(2);
}
const [width, height] = size.split('x').map(Number);
const gpu = process.env.SHOT_GPU !== '0';
const browser = await chromium.launch({
  args: gpu
    ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-unsafe-swiftshader']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width, height } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url);
try {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
} catch {
  logs.push('[shot] timed out waiting for window.__ready');
}
await page.waitForTimeout(Number(waitMs));
const info = await page.evaluate(() => window.__info?.() ?? null).catch(() => null);
await page.screenshot({ path: out });
await browser.close();
if (info) console.log('info:', JSON.stringify(info));
for (const l of logs.slice(-30)) console.log(l);
console.log('saved', out);
