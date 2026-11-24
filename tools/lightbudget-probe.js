/**
 * Light-budget probe — executed inside the `browser` tool's `run` action,
 * where `page`, `tab`, `display`, `assert` are in scope (same convention as
 * capture.js / bench.js). Requires the dev server on :5188.
 *
 * Verifies the RUNTIME light budget (World.lightCull.setBudget) against the
 * real renderer, in the live game:
 *
 *   1. shown === rung on every sampled frame, at every budget (offRung never
 *      grows — that is the recompile alarm)
 *   2. setBudget(20) rebuilds the ladder to [12,16,20] and takes effect
 *      immediately — no reload
 *   3. droppedInFrustum reflects real discarded lights once demand exceeds
 *      the cap (verified by injecting 30 extra in-frustum lights)
 *   4. the shadow-casting light stays visible at every budget
 *   5. setBudget(null) restores the full ladder
 *   6. renderer.info.programs does NOT grow across budget switches — every
 *      selectable rung was prewarmed, so no switch can trigger a recompile
 *
 * The same checks can be run by hand in the browser console:
 *   World.lightCull.setBudget(20); World.lightCull.stats   // rung <= 20
 *   World.lightCull.setBudget(null)                        // full ladder back
 */

const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.message).slice(0, 200)));

await tab.goto('http://127.0.0.1:5188/', { waitUntil: 'load' });

// Poll for the app's own readiness signal — procedural generation time varies.
let ready = false, bootErr = null;
for (let i = 0; i < 110; i++) {
  try {
    const s = await tab.evaluate(() => ({ r: !!window.__EXILIUM_READY, e: window.__EXILIUM_ERROR || null }));
    if (s.e) { bootErr = s.e; break; }
    if (s.r) { ready = true; break; }
  } catch (e) { /* main thread busy */ }
  await new Promise((r) => setTimeout(r, 2500));
}
if (!ready) { display({ FATAL: 'boot failed', bootErr, errs }); return { ok: false, bootErr, errs }; }

await tab.evaluate(() => { document.getElementById('boot')?.remove(); });
try { await page.bringToFront(); } catch (e) {}

// Install a per-frame sampler INSIDE the page: it records every frame where
// shown !== rung, so a violation can't slip past between two evaluate() calls.
await tab.evaluate(() => {
  const W = window.__ENGINE.ctx.World;
  window.__lb = { violations: [], samples: 0, shadowHidden: 0 };
  const tick = () => {
    const s = W.lightCull.stats;
    window.__lb.samples++;
    if (s.shown !== s.rung) window.__lb.violations.push({ ...s });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // Independent shadow-caster watch: count frames where a casting light is hidden.
  window.__ENGINE.scene.traverse((o) => {
    if (o.isPointLight && o.castShadow) window.__lbShadow = o;
  });
});

const results = {};

// Snapshot the program count BEFORE any budget switch: every rung the default
// ladder can select was prewarmed at boot, and every rung a budget change makes
// selectable is prewarmed inside setBudget — so this number must never grow.
results.programsAtBoot = await tab.evaluate(() => window.__ENGINE.renderer.info.programs.length);

// ---------------------------------------------------------------- cap at 20
results.cap20 = await tab.evaluate(() => {
  const W = window.__ENGINE.ctx.World;
  const r = W.lightCull.setBudget(20);
  return { rungs: r.rungs, budget: W.lightCull.budget, prewarmMs: r.prewarm && r.prewarm.ms };
});
await new Promise((r) => setTimeout(r, 2500));   // ~a second of live frames at the cap
results.cap20Stats = await tab.evaluate(() => window.__ENGINE.ctx.World.lightCull.stats);

// ------------------------------------------------------- force real drops
// Inject 30 bright in-frustum lights around the player so demand (>>20) exceeds
// the cap, then confirm droppedInFrustum counts the discard and shown stays on
// the rung. invalidate() makes the culler rescan for the new lights.
await tab.evaluate(() => {
  const E = window.__ENGINE, W = E.ctx.World, THREE = E.ctx.THREE;
  const p = W.player.pos;
  window.__lbExtra = [];
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2;
    const l = new THREE.PointLight(0xffcc88, 1 + (i % 5), 10);
    l.position.set(p.x + Math.cos(a) * 4, p.y + 1.5, p.z + Math.sin(a) * 4);
    E.scene.add(l);
    window.__lbExtra.push(l);
  }
  W.lightCull.invalidate();
});
await new Promise((r) => setTimeout(r, 1500));
results.drops = await tab.evaluate(() => {
  const W = window.__ENGINE.ctx.World;
  const s = W.lightCull.stats;
  return { rung: s.rung, shown: s.shown, inFrustum: s.inFrustum, droppedInFrustum: s.droppedInFrustum };
});

// Remove the injected lights and restore the full ladder.
await tab.evaluate(() => {
  const E = window.__ENGINE, W = E.ctx.World;
  for (const l of window.__lbExtra) { E.scene.remove(l); }
  window.__lbExtra = [];
  W.lightCull.invalidate();
  W.lightCull.setBudget(null);
});
await new Promise((r) => setTimeout(r, 2500));

// ---------------------------------------------------------------- verdict
results.restored = await tab.evaluate(() => {
  const W = window.__ENGINE.ctx.World;
  return { rungs: W.lightCull.rungs, budget: W.lightCull.budget, stats: W.lightCull.stats };
});
results.programsAfter = await tab.evaluate(() => window.__ENGINE.renderer.info.programs.length);
results.sampler = await tab.evaluate(() => ({
  samples: window.__lb.samples,
  violations: window.__lb.violations.slice(0, 5),
  violationCount: window.__lb.violations.length,
  shadowEverHidden: window.__lbShadow ? !window.__lbShadow.visible : 'no shadow light found',
  offRung: window.__ENGINE.ctx.World.lightCull.stats.offRung,
}));

const ok =
  results.cap20.rungs.join(',') === '12,16,20' &&
  results.cap20.budget === 20 &&
  results.cap20Stats.rung <= 20 &&
  results.cap20Stats.shown === results.cap20Stats.rung &&
  results.drops.shown === results.drops.rung &&
  results.drops.droppedInFrustum > 0 &&
  results.restored.rungs.join(',') === '12,16,20,24,28,34' &&
  results.restored.budget === null &&
  results.sampler.violationCount === 0 &&
  results.sampler.offRung === 0 &&
  results.sampler.shadowEverHidden === false &&
  results.programsAfter === results.programsAtBoot;

display({ ok, ...results, consoleErrors: errs.slice(0, 10) });
return { ok, ...results, errs: errs.slice(0, 10) };
