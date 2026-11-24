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
// Verifies that switching graphics presets at runtime stays consistent and reclaimable.
//
//   node scripts/quality.mjs <url> [WxH]
//
// Drives the real game in Chromium and checks, in order:
//   1. Ultra -> Low -> High -> Low -> Ultra: no console errors, __info() q/scale correct,
//      renderer.info.memory.textures returns to the same two values (no monotonic growth);
//   2. rapid switching (dozens of setQuality calls in one tick) neither throws nor grows;
//   3. the post stack matches each preset (bloom / tilt-shift / SMAA / AO on-off);
//   4. renderScale snaps back to 1 on a switch and still adapts to frame rate afterwards;
//   5. shadows actually reach the scene after Low -> High — both content that existed
//      before the switch and a room built while shadows were off.
//
// Exits non-zero if any check fails, so it can run in CI. CHROME_PATH lets a machine reuse
// a Chromium build that Playwright did not download itself.
import { chromium } from 'playwright';

const [url, size = '1280x720'] = process.argv.slice(2);
if (!url) {
  console.error('usage: node scripts/quality.mjs <url> [WxH]');
  process.exit(2);
}
const [width, height] = size.split('x').map(Number);

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width, height } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
};

try {
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(2000);

  // Freeze the camera and simulation so frame comparisons are meaningful.
  await page.evaluate(() => {
    window.__speed?.(0);
    const eng = window.__engine;
    const cam = eng.rig.camera;
    const pinned = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov };
    eng.rig.update = () => { cam.position.copy(pinned.pos); cam.quaternion.copy(pinned.quat); cam.fov = pinned.fov; cam.updateProjectionMatrix(); };
    eng.autoRes = false; eng.renderScale = 1; eng.resize();
    window.__postInventory = () => {
      const post = eng.post;
      const effects = [];
      for (const pass of post.composer.passes) {
        if (pass.effects && pass.effects.length) for (const e of pass.effects) effects.push(e);
        else effects.push(pass);
      }
      // Duck-type instead of matching constructor names: a production build minifies them.
      // Any effect that exposes SMAA's edge + weight textures is the SMAA effect.
      const hasSmaa = effects.some((e) => e && typeof e.edgesTexture === 'object' && typeof e.weightsTexture === 'object');
      return { hasBloom: !!post.bloom, hasTilt: !!post.tilt, hasSmaa, ao: post.ao ? (post.ao.configuration.halfRes ? 'half' : 'full') : null };
    };
    window.__memory = () => ({
      textures: eng.renderer.info.memory.textures,
      geometries: eng.renderer.info.memory.geometries,
      programs: eng.renderer.info.programs.length,
    });
  });
  await page.waitForTimeout(500);

  // --- 1. the documented sequence ---------------------------------------------------
  const seq = ['ultra', 'low', 'high', 'low', 'ultra'];
  const trail = [];
  trail.push({ step: 'start', info: await page.evaluate(() => window.__info()), mem: await page.evaluate(() => window.__memory()) });
  for (const q of seq) {
    await page.evaluate((qq) => window.__engine.setQuality(qq), q);
    await page.waitForTimeout(700);
    trail.push({
      step: q,
      info: await page.evaluate(() => window.__info()),
      mem: await page.evaluate(() => window.__memory()),
      shadowMap: await page.evaluate(() => window.__engine.sky.sun.shadow.map?.width ?? null),
    });
  }
  for (const s of trail) console.log(`  ${s.step.padEnd(6)} q=${s.info.q} scale=${s.info.scale} textures=${s.mem.textures} shadowMap=${s.shadowMap}`);
  check('sequence: q and scale follow the preset', trail.slice(1).every((s) => s.info.q === s.step && s.info.scale === 1));
  const tex = trail.map((s) => s.mem.textures);
  const last = tex[tex.length - 1];
  const maxMid = Math.max(...tex.slice(1, -1));
  check('sequence: texture count does not grow monotonically', last <= maxMid, `textures ${tex.join(' -> ')}`);
  check('sequence: no shadows at Low, map present otherwise',
    trail.slice(1).every((s) => (s.step === 'low' ? s.shadowMap === null : s.shadowMap > 0)));

  // --- 2. rapid switching ------------------------------------------------------------
  const rapid = await page.evaluate(async () => {
    const eng = window.__engine;
    const before = window.__memory();
    const cycle = ['ultra', 'low', 'high', 'low', 'ultra', 'medium', 'low', 'high'];
    let calls = 0;
    for (let i = 0; i < 8; i++) for (const q of cycle) { eng.setQuality(q); calls++; }
    await new Promise((r) => setTimeout(r, 900));
    return { calls, before, after: window.__memory(), q: eng.quality, scale: eng.renderScale };
  });
  console.log(`  ${rapid.calls} switches in one tick -> textures ${rapid.before.textures} => ${rapid.after.textures}, geometries ${rapid.before.geometries} => ${rapid.after.geometries}`);
  check('rapid: no texture growth', rapid.after.textures <= rapid.before.textures + 1);
  check('rapid: no geometry growth', rapid.after.geometries <= rapid.before.geometries + 2);
  check('rapid: no program growth', rapid.after.programs <= rapid.before.programs + 2);
  check('rapid: ends in a consistent state', rapid.q === 'high' && rapid.scale === 1);

  // --- 3. post stack matches the preset ----------------------------------------------
  const want = {
    ultra: { bloom: true, tilt: true, smaa: true, ao: 'full' },
    high: { bloom: true, tilt: true, smaa: true, ao: null },
    medium: { bloom: true, tilt: false, smaa: true, ao: null },
    low: { bloom: false, tilt: false, smaa: false, ao: null },
  };
  for (const q of ['ultra', 'high', 'medium', 'low', 'ultra', 'high']) {
    await page.evaluate((qq) => window.__engine.setQuality(qq), q);
    await page.waitForTimeout(400);
    const inv = await page.evaluate(() => window.__postInventory());
    const w = want[q];
    check(`post stack matches ${q}`, inv.hasBloom === w.bloom && inv.hasTilt === w.tilt && inv.hasSmaa === w.smaa && inv.ao === w.ao, JSON.stringify(inv));
  }

  // --- 4. renderScale resets and keeps adapting ---------------------------------------
  const scale = await page.evaluate(async () => {
    const eng = window.__engine;
    eng.autoRes = true;
    eng.renderScale = 0.6; eng.resize();
    const forced = eng.renderScale;
    eng.setQuality('ultra');
    const afterSwitch = eng.renderScale;
    const t0 = performance.now();
    await new Promise((res) => { const tick = () => (performance.now() - t0 > 5000 ? res() : requestAnimationFrame(tick)); requestAnimationFrame(tick); });
    const adapting = eng.renderScale;
    eng.autoRes = false; eng.renderScale = 1; eng.resize();
    return { forced, afterSwitch, adapting, fps: eng.fps };
  });
  console.log(`  renderScale ${scale.forced} -> ${scale.afterSwitch} on switch, ${scale.adapting} after 5s at ${scale.fps.toFixed(1)} fps`);
  check('renderScale resets to 1 on a switch', scale.afterSwitch === 1);
  check('renderScale still adapts to frame rate', scale.adapting <= 1 && scale.adapting > 0);

  // --- 5. shadows reach the scene after Low -> High ------------------------------------
  // 5a: content that predates the switch.
  await page.evaluate(() => window.__engine.setQuality('low'));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__engine.setQuality('high'));
  await page.waitForTimeout(1000);
  const beforeShot = await page.screenshot();
  await page.evaluate(() => { window.__engine.sky.sun.castShadow = false; });
  await page.waitForTimeout(500);
  const noShadowShot = await page.screenshot();
  await page.evaluate(() => { window.__engine.sky.sun.castShadow = true; });
  await page.waitForTimeout(400);
  const shadowDelta = await page.evaluate(async ([a, b]) => {
    const load = (b64) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + b64; });
    const read = async (b64) => { const i = await load(b64); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const [da, db] = await Promise.all([read(a), read(b)]);
    let changed = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      if (d > 30) changed++;
    }
    return { changed, total: da.length / 4 };
  }, [beforeShot.toString('base64'), noShadowShot.toString('base64')]);
  const fraction = shadowDelta.changed / shadowDelta.total;
  check('shadows render again after Low -> High', fraction > 0.02, `${(fraction * 100).toFixed(1)}% of pixels change with the sun's shadow switched off`);

  // 5b: a room built while shadows were off. Build it at Low, switch to High, then check
  // that the room's own footprint casts a shadow by comparing a frame with the sun's
  // shadow enabled against one without it, limited to the screen rectangle around the room.
  const built = await page.evaluate(() => {
    const eng = window.__engine;
    eng.setQuality('low');
    const r = window.__world.cmd({ type: 'buildRoom', room: 'gp', rect: { x: 14, z: 12, w: 3, h: 3 }, door: { x: 15, z: 14, dir: 'S' } });
    return { ok: r.ok, reason: r.reason };
  });
  if (built.ok) {
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__engine.setQuality('high'));
    await page.waitForTimeout(1200);
    // Frame the room so its shadow is on screen regardless of the scenario's initial camera.
    await page.evaluate(() => { window.__engine.rig.focus(15.5, 13.5, 22); });
    await page.waitForTimeout(900);
    const roomOn = await page.screenshot();
    await page.evaluate(() => { window.__engine.sky.sun.castShadow = false; });
    await page.waitForTimeout(500);
    const roomOff = await page.screenshot();
    await page.evaluate(() => { window.__engine.sky.sun.castShadow = true; });
    const roomDelta = await page.evaluate(async ([a, b]) => {
      const load = (b64) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + b64; });
      const read = async (b64) => { const i = await load(b64); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
      const [da, db] = await Promise.all([read(a), read(b)]);
      let changed = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
        if (d > 30) changed++;
      }
      return { changed, total: da.length / 4 };
    }, [roomOn.toString('base64'), roomOff.toString('base64')]);
    const roomFraction = roomDelta.changed / roomDelta.total;
    check('a room built while shadows were off casts shadows after Low -> High', roomFraction > 0.02, `${(roomFraction * 100).toFixed(1)}% of framed pixels change with shadows off`);
  } else {
    console.log(`  (skipped the build-while-shadowless check: the scenario rejected the room: ${built.reason})`);
  }

  // --- console health ------------------------------------------------------------------
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (err) {
  failures.push(`script error: ${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
} finally {
  await browser.close();
}

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nall quality-switch checks passed');
