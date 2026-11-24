/**
 * Light-budget invariant test — runnable locally with no browser:
 *
 *     node tools/lightbudget-test.mjs        (or: npm run test:lightbudget)
 *
 * Drives the REAL src/render/lightcull.js against a real THREE.Scene with a
 * deterministic light layout and a mock renderer, and asserts the invariants
 * the runtime light budget must keep:
 *
 *   1. shown === rung on EVERY frame, at every budget (offRung never grows)
 *   2. setBudget(n) rebuilds the ladder to rungs <= n, syncs CFG, and prewarms
 *      any newly reachable rung SYNCHRONOUSLY (no selectable rung is ever
 *      uncompiled — that is the 4,295 ms recompile stall)
 *   3. already-warmed rungs are not recompiled (budget changes only pay the delta)
 *   4. droppedInFrustum reflects the true number of discarded in-frustum lights
 *   5. the shadow-casting light stays visible at EVERY budget (a shadow-map
 *      count change would recompile every material even at a fixed light count)
 *   6. setBudget(null) restores the full ladder
 *
 * The scene: 1 shadow caster + 25 in-frustum lights + 8 out-of-frustum lights
 * + 3 parked pool slots (intensity 0). In-frustum demand is therefore 26, so
 * the full ladder lands on rung 28, a budget of 20 drops 6, a budget of 12
 * drops 14 — all deterministic.
 */

import * as THREE from 'three';
import { World } from '../src/core/world.js';
import { CFG } from '../src/core/config.js';
import lightcull from '../src/render/lightcull.js';

const ALL_RUNGS = [12, 16, 20, 24, 28, 34];   // mirror of the module constant

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  — ' + detail}`);
  if (!ok) failures++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- scene
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 16 / 9, 1, 260);
camera.position.set(0, 30, 30);
camera.lookAt(0, 0, 0);
camera.updateProjectionMatrix();
camera.updateMatrixWorld(true);

// Mock renderer: records the visible-light count of every compile() so the
// test can prove WHICH rungs were compiled and WHEN. render() is a no-op —
// cull() never touches the renderer, only prewarm() does.
const renderer = {
  compileCounts: [],
  compile() {
    let n = 0;
    scene.traverse((o) => { if (o.isPointLight && o.visible) n++; });
    this.compileCounts.push(n);
  },
  render() {},
  info: { programs: [] },
};

// Deterministic light layout.
const shadowLight = new THREE.PointLight(0xffaa55, 5, 30);
shadowLight.castShadow = true;                // the one shadow caster (props.js: 1)
scene.add(shadowLight);

const inLights = [];
for (let i = 0; i < 25; i++) {
  const a = (i / 25) * Math.PI * 2;
  const l = new THREE.PointLight(0xffcc88, 1 + i * 0.1, 12);   // distinct intensities
  l.position.set(Math.cos(a) * 6, 1, Math.sin(a) * 6);         // ring around origin
  scene.add(l);
  inLights.push(l);
}
for (let i = 0; i < 8; i++) {                                   // far outside the frustum
  const l = new THREE.PointLight(0x88ccff, 2, 10);
  l.position.set(150 + i * 5, 0, -150);
  scene.add(l);
}
for (let i = 0; i < 3; i++) {                                   // parked pool slots
  const l = new THREE.PointLight(0xffffff, 0, 8);
  l.position.set(2 + i, 1, 2);
  scene.add(l);
}

// ---------------------------------------------------------------- boot
lightcull.init({ scene, camera, renderer });
const api = World.lightCull;
const frame = () => { lightcull.frame(); return api.stats; };

check('api exposed on World.lightCull', !!api);
check('default budget is uncapped', api.budget === null);
check('default ladder is the full ladder', eq(api.rungs, ALL_RUNGS), JSON.stringify(api.rungs));

// Boot prewarm (what main.js does): every rung compiled exactly once, in order.
const pw0 = api.prewarm();
check('boot prewarm compiled every rung once',
  eq(renderer.compileCounts, ALL_RUNGS), JSON.stringify(renderer.compileCounts));
check('boot prewarm reports the ladder', eq(pw0.rungs, ALL_RUNGS));

// ---------------------------------------------------------------- full ladder
let s = frame();
check('full ladder: rung 28 at 26 in-frustum demand', s.rung === 28, `rung=${s.rung}`);
check('full ladder: shown === rung', s.shown === s.rung, `shown=${s.shown} rung=${s.rung}`);
check('full ladder: nothing dropped', s.droppedInFrustum === 0, `dropped=${s.droppedInFrustum}`);
check('full ladder: padding holds the count', s.padded === s.rung - 26, `padded=${s.padded}`);
check('shadow caster visible at full ladder', shadowLight.visible === true);

// ---------------------------------------------------------------- budget 20
const r20 = api.setBudget(20);
check('setBudget(20): ladder is [12,16,20]', eq(r20.rungs, [12, 16, 20]), JSON.stringify(r20.rungs));
check('setBudget(20): api.budget reports 20', api.budget === 20);
check('setBudget(20): CFG.graphics.lightBudget synced', CFG.graphics.lightBudget === 20);
check('setBudget(20): no recompiles (all rungs already warm)',
  renderer.compileCounts.length === 6, `compiles=${renderer.compileCounts.length}`);

s = frame();
check('budget 20: rung clamps to 20', s.rung === 20, `rung=${s.rung}`);
check('budget 20: shown === rung', s.shown === s.rung, `shown=${s.shown} rung=${s.rung}`);
check('budget 20: droppedInFrustum counts the 6 real drops',
  s.droppedInFrustum === 6, `dropped=${s.droppedInFrustum}`);
check('budget 20: shadow caster still visible', shadowLight.visible === true);
check('budget 20: dimmest lights are the ones dropped',
  inLights[0].visible === false && inLights[24].visible === true,
  `weakest.visible=${inLights[0].visible} strongest.visible=${inLights[24].visible}`);

// ---------------------------------------------------------------- budget 12 (floor)
const r12 = api.setBudget(12);
check('setBudget(12): ladder is [12]', eq(r12.rungs, [12]), JSON.stringify(r12.rungs));
s = frame();
check('budget 12: shown === rung === 12', s.shown === 12 && s.rung === 12,
  `shown=${s.shown} rung=${s.rung}`);
check('budget 12: droppedInFrustum counts the 14 real drops',
  s.droppedInFrustum === 14, `dropped=${s.droppedInFrustum}`);
check('budget 12: shadow caster still visible', shadowLight.visible === true);

// Budget below the lowest rung clamps to it rather than emptying the ladder.
const r4 = api.setBudget(4);
check('setBudget(4): clamps to the lowest rung', eq(r4.rungs, [12]), JSON.stringify(r4.rungs));
s = frame();
check('budget 4: shown === rung, shadow caster visible',
  s.shown === s.rung && shadowLight.visible === true,
  `shown=${s.shown} rung=${s.rung} shadow=${shadowLight.visible}`);

// ---------------------------------------------------------------- restore
const rNull = api.setBudget(null);
check('setBudget(null): full ladder restored', eq(rNull.rungs, ALL_RUNGS), JSON.stringify(rNull.rungs));
check('setBudget(null): budget reports null', api.budget === null);
check('setBudget(null): CFG cleared', CFG.graphics.lightBudget === null);
check('setBudget(null): no recompiles (rungs were warmed at boot)',
  renderer.compileCounts.length === 6, `compiles=${renderer.compileCounts.length}`);
s = frame();
check('restored: rung 28 again, shown === rung, no drops',
  s.rung === 28 && s.shown === 28 && s.droppedInFrustum === 0,
  `rung=${s.rung} shown=${s.shown} dropped=${s.droppedInFrustum}`);

// Invalid values all mean "uncapped".
for (const bad of [0, -5, NaN, Infinity, undefined]) {
  api.setBudget(bad);
  if (api.budget !== null) { check(`setBudget(${bad}) means uncapped`, false, `budget=${api.budget}`); break; }
}
check('setBudget(0/-5/NaN/Infinity/undefined) all mean uncapped', api.budget === null);

// ------------------------------------------------- delta-prewarm on a cold ladder
// Prove that raising the cap compiles ONLY the newly reachable rungs, and that
// it happens synchronously inside setBudget — before any frame can select them.
renderer.compileCounts.length = 0;
api.setBudget(16);                                   // cold rungs: none new (12,16 warm)
check('setBudget(16) on warm ladder: zero compiles', renderer.compileCounts.length === 0,
  JSON.stringify(renderer.compileCounts));

// A boot that RAN with a cap: fresh module instance (query suffix), CFG capped
// before its init(). Its ladder is [12,16]; rungs 20+ have never been compiled.
// Uncapping must compile exactly the restored rungs, synchronously, inside
// setBudget — the one path where a cold rung could otherwise reach play.
CFG.graphics.lightBudget = 16;
const cold = (await import('../src/render/lightcull.js?cold-boot')).default;
cold.init({ scene, camera, renderer });
const coldApi = World.lightCull;
check('capped boot: ladder is [12,16]', eq(coldApi.rungs, [12, 16]), JSON.stringify(coldApi.rungs));
renderer.compileCounts.length = 0;
coldApi.prewarm();
check('capped boot: prewarm compiles only [12,16]',
  eq(renderer.compileCounts, [12, 16]), JSON.stringify(renderer.compileCounts));
renderer.compileCounts.length = 0;
const rCold = coldApi.setBudget(null);
check('uncap from cold ladder: full ladder restored', eq(rCold.rungs, ALL_RUNGS));
check('uncap from cold ladder: exactly the restored rungs compiled, synchronously',
  eq(renderer.compileCounts, [20, 24, 28, 34]), JSON.stringify(renderer.compileCounts));
let cs = (cold.frame(), coldApi.stats);
check('uncap from cold ladder: first frame lands on rung 28, shown === rung',
  cs.rung === 28 && cs.shown === 28, `rung=${cs.rung} shown=${cs.shown}`);
check('uncap from cold ladder: offRung still zero', coldApi.stats.offRung === 0);
// Hand World.lightCull back to the primary module for the sweep below.
World.lightCull = api;

// ------------------------------------------------- per-frame invariant sweep
// shown === rung on EVERY frame, across budgets and a moving camera. This is
// the invariant whose violation costs hundreds of milliseconds per frame.
let sweepOk = true, sweepDetail = '';
const budgets = [null, 20, 12, 28, null, 16];
for (const b of budgets) {
  api.setBudget(b);
  for (let f = 0; f < 10; f++) {
    camera.position.set(Math.sin(f * 0.3) * 10, 30, 30 + Math.cos(f * 0.2) * 5);
    camera.lookAt(0, 0, 0);
    const st = frame();
    if (st.shown !== st.rung) { sweepOk = false; sweepDetail = `budget=${b} frame=${f} shown=${st.shown} rung=${st.rung}`; break; }
    if (!shadowLight.visible) { sweepOk = false; sweepDetail = `budget=${b} frame=${f} shadow caster hidden`; break; }
  }
  if (!sweepOk) break;
}
check('shown === rung on every frame of a 60-frame budget/camera sweep', sweepOk, sweepDetail);
check('shadow caster visible on every frame of the sweep', sweepOk, sweepDetail);
check('offRung never grew across the entire test', api.stats.offRung === 0,
  `offRung=${api.stats.offRung}`);

// Restore module state for anything that runs after us in the same process.
api.setBudget(null);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
