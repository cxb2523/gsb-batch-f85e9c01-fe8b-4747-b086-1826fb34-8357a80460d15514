// VFX lifecycle regression test: battle effects vs scene effects around round restarts and
// quality switches. Drives the real game (bot directives make it deterministic). Needs the dev
// server (npm run dev). CHROME env var picks the browser binary.
//   node tools/vfxtest.mjs
import puppeteer from 'puppeteer-core';

const base = process.env.BASE || 'http://127.0.0.1:5183/';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// a fresh profile's first navigation can abort while chrome warms up — retry once
for (let i = 0; ; i++) {
  try { await page.goto(base + '?autostart=codex&level=hard&q=high', { waitUntil: 'load' }); break; }
  catch (e) { if (i >= 2) throw e; await new Promise((r) => setTimeout(r, 800)); }
}
await page.waitForFunction('window.__ready === true', { timeout: 60000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.waitForFunction('window.__game.G.state === "fight"', { timeout: 20000 });

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const snap = () => page.evaluate(() => {
  const v = window.__game.stage.vfx;
  return {
    puffs: v.puffs.n, sparks: v.sparks.n, glows: v.glows.n, shocks: v.shocks.n,
    bolts: v.bolts.bolts.filter((b) => !b.amb).length, trails: v.trails.list.length,
    ground: v.ground.items.length, decals: v.decals.items.length,
    rubble: v.rubble.items.length, cubes: v.cubes.items.length,
    orbsVis: v.orbs.pool.filter((o) => o.m.visible).length,
    beamsVis: v.beams.map((b) => !!(b && b.group.visible)),
    projFx: v.projFx.size, zoneFx: v.zoneFx.size,
    chargeOrb: v.chargeOrb.map((o) => !!o), clashOrbs: !!v.clashOrbs,
    flash: v.screen.flash, radial: v.screen.radial, trauma: v.trauma,
    barrier: window.__game.stage.arena.barrierUniforms.uHits.value.filter((h) => h.w >= 0).length,
    dyn: window.__game.stage.arena.dyn.filter((l) => l.intensity > 0.01).length,
    skyFlash: window.__game.stage.arena.flash,
    density: v.density,
  };
});
const combatLeft = (s) =>
  s.sparks + s.trails + s.bolts + s.ground + s.rubble + s.cubes + s.orbsVis + s.projFx + s.zoneFx + s.barrier + s.dyn +
  (s.beamsVis.some(Boolean) ? 1 : 0) + (s.chargeOrb.some(Boolean) ? 1 : 0) + (s.clashOrbs ? 1 : 0) +
  (s.flash > 0.001 ? 1 : 0) + (s.radial > 0.001 ? 1 : 0) + (s.trauma > 0.001 ? 1 : 0) + (s.skyFlash > 0.001 ? 1 : 0);
const restart = () => page.evaluate(() => { const w = window.__game.stage.newWorld({}); w.begin(); });
const directive = (d) => page.evaluate((d) => { window.__game.G.bot.directive = d; }, d);

// ---- 1. zone warning live at restart ------------------------------------------------------------
await directive({ do: 'tap', btn: 'S2', noDefense: true });
await page.waitForFunction('window.__game.stage.vfx.zoneFx.size > 0', { timeout: 15000, polling: 30 });
await directive(null);
let s = await snap();
check('zone warning is live before restart', s.zoneFx > 0 && s.ground > 0, `zoneFx=${s.zoneFx}`);
await restart();
s = await snap();
check('restart clears zone warnings', s.zoneFx === 0 && s.ground === 0 && combatLeft(s) === 0, JSON.stringify(s));

// ---- 2. ult charge orb live at restart ----------------------------------------------------------
await page.evaluate(() => { window.__game.stage.world.fighters[1].energy = 100; });
await directive({ do: 'tap', btn: 'ULT', noDefense: true });
await page.waitForFunction('window.__game.stage.vfx.chargeOrb.some(Boolean)', { timeout: 15000, polling: 30 });
s = await snap();
check('charge orb is held before restart', s.chargeOrb.some(Boolean) && s.orbsVis > 0, `orbs=${s.orbsVis}`);
await restart();
await directive(null);
s = await snap();
check('restart releases the charge orb', !s.chargeOrb.some(Boolean) && s.orbsVis === 0 && combatLeft(s) === 0, JSON.stringify(s));

// ---- 3. beam live at restart ---------------------------------------------------------------------
await page.evaluate(() => { window.__game.stage.world.fighters[1].energy = 100; });
await directive({ do: 'tap', btn: 'ULT', noDefense: true });
await page.waitForFunction('window.__game.stage.vfx.beams.some(b => b && b.group.visible)', { timeout: 15000, polling: 30 });
s = await snap();
check('beam is visible before restart', s.beamsVis.some(Boolean));
await restart();
await directive(null);
s = await snap();
check('restart removes the beam', !s.beamsVis.some(Boolean) && combatLeft(s) === 0, JSON.stringify(s));

// ---- 4. projectile trail + screen pulse + barrier ripple + dyn light live at restart --------------
await page.evaluate(() => {
  const g = window.__game, v = g.stage.vfx, w = g.stage.world;
  w.fighters[1].cdS1 = 0;
  v.screen.flash = 0.8; v.screen.radial = 1; v.trauma = 1.1;
  v.arena.barrierHit({ x: 6, y: 1, z: 0 }, { r: 1, g: 0.5, b: 0.2 });
  v.arena.light({ x: 0, y: 1, z: 0 }, { r: 1, g: 1, b: 1 }, 200, 5, 40);
  v.arena.skyFlash(1);
});
await directive({ do: 'tap', btn: 'S1', noDefense: true });
await page.waitForFunction('window.__game.stage.vfx.projFx.size > 0', { timeout: 15000, polling: 30 });
await directive(null);
s = await snap();
check('projectile + pulses live before restart', s.projFx > 0 && s.trails > 0 && s.barrier > 0 && s.dyn > 0 && s.skyFlash > 0, JSON.stringify(s));
await page.evaluate(() => { const v = window.__game.stage.vfx; v.decals.add(1, 1, 2, { mode: 0, life: 14, intensity: 1, seed: 0.5, r: 0.3, g: 0.3, b: 0.3 }); });
await restart();
s = await snap();
check('restart clears projectiles, pulses, barrier, lights, sky flash', combatLeft(s) === 0, JSON.stringify(s));
check('restart keeps scenery (ambient puffs/glows, scorch decals)', s.puffs > 0 && s.glows > 0 && s.decals >= 1, `puffs=${s.puffs} glows=${s.glows} decals=${s.decals}`);
await directive({ do: 'idle', noDefense: true, noTech: true }); // keep the new round quiet
await sleep(400);
s = await snap();
check('still clean 0.4 s after restart', combatLeft(s) === 0, JSON.stringify(s));

// ---- 5. re-entrancy ------------------------------------------------------------------------------
await page.evaluate(() => { const g = window.__game; g.stage.newWorld({}); g.stage.newWorld({}); });
await page.evaluate(() => { const g = window.__game; g.stage.newWorld({}); g.stage.R.setQuality('medium'); g.stage.vfx.density = 0.75; g.stage.newWorld({}); });
await sleep(400);
s = await snap();
check('double restart + restart/quality/restart is clean', combatLeft(s) === 0 && s.density === 0.75, JSON.stringify(s));

// ---- 6. quality switch mid-combat keeps in-flight effects, applies new density -------------------
await page.evaluate(() => { const g = window.__game; g.stage.R.setQuality('high'); g.stage.vfx.density = 1; });
await directive({ do: 'free' });
await sleep(4000);
await directive(null);
const before = await snap();
await page.evaluate(() => { const g = window.__game; g.stage.R.setQuality('low'); g.stage.vfx.density = 0.5; });
const after = await snap();
check('quality switch does not wipe in-flight effects', !(before.puffs > 0 && after.puffs === 0) && !(before.glows > 0 && after.glows === 0) && !(before.sparks > 0 && after.sparks === 0), `${before.puffs}/${before.glows}/${before.sparks} -> ${after.puffs}/${after.glows}/${after.sparks}`);
check('density follows the new step immediately', after.density === 0.5, `density=${after.density}`);
const emitted = await page.evaluate(() => {
  const v = window.__game.stage.vfx;
  const n = (k) => v.n(k);
  return { low: [n(10), n(3)], density: v.density };
});
check('new particles are counted at the new density', emitted.low[0] === 5 && emitted.low[1] === 2, JSON.stringify(emitted));

// ---- 7. pause menu quality switch keeps presenting -----------------------------------------------
await page.keyboard.press('Escape');
await sleep(300);
const frameBefore = await page.evaluate(() => window.__game.stage.R.frame);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.overlay button')].find((x) => x.textContent.startsWith('Graphics'));
  b.click();
});
await sleep(300);
const frameAfter = await page.evaluate(() => window.__game.stage.R.frame);
check('switching quality while paused still presents a frame', frameAfter > frameBefore, `frame ${frameBefore} -> ${frameAfter}`);
check('quality actually switched', (await page.evaluate(() => window.__game.stage.R.qualityName)) === 'medium');
await page.keyboard.press('Escape'); // resume
await sleep(400);
check('resume after paused quality switch', await page.evaluate(() => !window.__game.G.paused && window.__game.G.state === 'fight'));

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
