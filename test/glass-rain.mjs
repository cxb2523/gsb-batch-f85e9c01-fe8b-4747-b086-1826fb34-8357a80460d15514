// Executable acceptance sample for the persistent glass lifecycle.
//
//   node test/glass-rain.mjs
//
// It drives the real GlassState (and the real GlassRain uniform layer, with
// three.js headless) through every acceptance beat:
//   1. rain lays water on the glass and speed makes it run;
//   2. when the rain stops, airflow dries it to ~zero;
//   3. the existing Systems module builds airframe ice in freezing cloud and
//      that output freezes the glass water into static frost;
//   4. warm air (the same Systems output decaying, plus OAT) clears the frost;
//   5. dt 0 ticks (pause) leave every value and uniform exactly unchanged;
//   6. reset() (Restart / new airport) makes the glass clean;
//   7. the cockpit/exterior opacity mapping in js/main.js is still there.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as THREE from '../vendor/three.module.js';
import { GlassState, TIMING } from '../js/glass-state.js';
import { GlassRain } from '../js/glass-rain.js';
import { FlightModel, Autopilot, KT, stillAir } from '../js/fdm.js';
import { Systems } from '../js/systems.js';

const DT = 1 / 60;
const rows = [];
function check(name, pass, note = '') { rows.push({ name, ok: !!pass, note: String(note) }); }
function step(g, seconds, input = {}, dt = DT) { for (let t = 0; t < seconds - 1e-9; t += dt) g.update(dt, input); }
const nearZero = (x, e = 0.02) => x <= e;

// ---------------------------------------------------------------- 1. rain + flow
{
  const g = new GlassState();
  step(g, 8, { rain: 1, ias: 0 });
  check('Rain soaks the glass: water appears', g.water > 0.8, `water ${g.water.toFixed(2)} after 8 s heavy rain`);
  check('At zero airspeed the drops mostly sit (no airflow push)', g.push < 0.05, `push ${g.push.toFixed(2)}`);

  const before = g.travelY[0];
  step(g, 2, { rain: 1, ias: 42 });
  check('At speed the airflow push engages', g.push > 0.95, `push ${g.push.toFixed(2)} at 42 m/s`);
  check('Windscreen water runs up the glass as speed builds', g.travelY[0] - before > 0.5,
    `${(g.travelY[0] - before).toFixed(2)} m of layer-1 travel in 2 s`);
  const sideBefore = g.travelX[3];
  step(g, 1, { rain: 1, ias: 42 });
  check('Side-window streams run aft/across their pane', Math.abs(g.travelX[3] - sideBefore) > 0.2,
    `${Math.abs(g.travelX[3] - sideBefore).toFixed(2)} m side travel in 1 s`);
}

// ---------------------------------------------------------------- 2. drying
{
  const cruise = new GlassState(); cruise.water = 1;
  const still = new GlassState(); still.water = 1;
  let tClean = null, tMost = null;
  for (let t = DT; t <= 60; t += DT) {
    cruise.update(DT, { rain: 0, ias: 50 });
    still.update(DT, { rain: 0, ias: 0 });
    if (tMost === null && cruise.water <= 0.05) tMost = t;
    if (tClean === null && cruise.water <= 0.02) tClean = t;
  }
  check('Rain stop at cruise: most water gone within ~12 s', tMost !== null && tMost <= 12, `water <= 0.05 after ${tMost === null ? '>60' : tMost.toFixed(1)} s`);
  check('After rain stops at cruise speed the glass dries to ~zero within ~20 s', tClean !== null && tClean <= 20,
    `water <= 0.02 after ${tClean === null ? '>60' : tClean.toFixed(1)} s`);
  check('Drying is driven by airspeed: cruise glass is drier than still glass', cruise.water < still.water * 0.5,
    `cruise ${cruise.water.toFixed(3)} vs still ${still.water.toFixed(3)} after 60 s`);
  check('Eventually the dried state is exactly clean', cruise.water === 0 && !cruise.visible, `water ${cruise.water}`);
}

// ---------------------------------------------------------------- 3. freezing into static frost
{
  const g = new GlassState(); g.water = 1;
  step(g, 8, { rain: 0, ias: 42, ice: 1, oat: -7 });
  check('Full airframe-ice output freezes most glass water into frost', g.frost > 0.85,
    `frost ${g.frost.toFixed(2)}, water ${g.water.toFixed(3)}`);
  check('Frozen glass keeps almost no liquid water', g.water < 0.1, `water ${g.water.toFixed(3)}`);
  check('The streams are locked solid by the frost', g.mobility === 0, `mobility ${g.mobility}`);
  const tx = Float64Array.from(g.travelX), ty = Float64Array.from(g.travelY);
  step(g, 2, { rain: 0, ias: 42, ice: 1, oat: -7 });
  let moved = 0; for (let i = 0; i < 9; i++) moved += Math.abs(g.travelX[i] - tx[i]) + Math.abs(g.travelY[i] - ty[i]);
  check('Frost does not flow: offsets stay exactly put', moved === 0, `total offset move ${moved.toExponential(1)}`);
}

// A small systems.ice value only partially locks the glass; the mapping must be gradual.
{
  const g = new GlassState(); g.water = 1;
  step(g, 5, { rain: 0, ias: 42, ice: 0.08, oat: -5 });
  check('Light airframe ice gives partial freezing, not an all-or-nothing jump',
    g.frost > 0.08 && g.frost < 0.6 && g.mobility > 0.2 && g.mobility < 1,
    `frost ${g.frost.toFixed(2)}, mobility ${g.mobility.toFixed(2)}`);
}

// ---------------------------------------------------------------- 4. thaw in warm air
{
  const g = new GlassState(); g.water = 1;
  step(g, 8, { rain: 0, ias: 42, ice: 1, oat: -7 });
  step(g, 16, { rain: 0, ias: 42, ice: 0, oat: 10 });
  check('Back in warm air the frost recedes to ~zero', g.frost <= 0.02, `frost ${g.frost.toFixed(3)} after 16 s at +10 C`);
  step(g, 30, { rain: 0, ias: 42, ice: 0, oat: 10 });
  check('Meltwater then dries: the glass ends fully clean', g.frost === 0 && g.water <= 0.02,
    `frost ${g.frost}, water ${g.water.toFixed(3)}`);
}

// Without an OAT feed the state still thaws once systems reports the airframe clean.
{
  const g = new GlassState(); g.frost = 0.8;
  step(g, 30, { rain: 0, ias: 30, ice: 0 });
  check('With no OAT input, clean systems ice output still clears frost', g.frost < 0.05, `frost ${g.frost.toFixed(3)}`);
}

// ---------------------------------------------------------------- 5. pause invariance
{
  const g = new GlassState();
  step(g, 5, { rain: 1, ias: 30, ice: 0.2, oat: -4 });
  const before = JSON.stringify(g.toJSON());
  for (let i = 0; i < 30; i++) g.update(0, { rain: 1, ias: 30, ice: 0.9, oat: -20 });  // repeated paused frames
  check('Thirty dt=0 ticks leave the whole state identical', JSON.stringify(g.toJSON()) === before);

  // And through the real three.js uniform layer.
  const rg = new GlassRain(new THREE.BufferGeometry());
  rg.update(1 / 30, { rain: 1, ias: 36, ice: 0.4, oat: -6 });
  rg.update(1 / 30, { rain: 0, ias: 36, ice: 0.8, oat: -9 });
  const uniformSnapshot = () => [
    rg.uniforms.uWet.value, rg.uniforms.uFrost.value, rg.uniforms.uDens.value.toArray(),
    rg.uniforms.uOff.value.map((v) => v.toArray()), rg.uniforms.uDir.value.map((v) => v.toArray()),
    rg.uniforms.uTail.value.map((v) => v.toArray()), rg.mesh.visible,
  ];
  const u0 = JSON.stringify(uniformSnapshot());
  for (let i = 0; i < 12; i++) rg.update(0, { rain: 0.9, ias: 80, ice: 1, oat: -40 });
  check('Paused frames leave every shader uniform identical', JSON.stringify(uniformSnapshot()) === u0);
}

// ---------------------------------------------------------------- 6. reset
{
  const rg = new GlassRain(new THREE.BufferGeometry());
  rg.update(2, { rain: 1, ias: 40, ice: 1, oat: -8 });
  check('Sample is dirty before reset', rg.state.water + rg.state.frost > 0.5);
  rg.reset();
  const s = rg.state;
  check('reset() clears water and frost', s.water === 0 && s.frost === 0);
  check('reset() zeroes offsets and hides the mesh',
    !rg.mesh.visible && rg.uniforms.uWet.value === 0 && rg.uniforms.uFrost.value === 0 &&
    s.offX.every((v) => v === 0) && s.offY.every((v) => v === 0) && s.travelX.every((v) => v === 0));
  // A reset followed by a normal tick starts accumulating again from zero (continuity).
  rg.update(1, { rain: 1, ias: 0 });
  check('Life resumes normally after reset', rg.state.water > 0.2 && rg.mesh.visible);
}

// Legacy positional call shape kept working.
{
  const rg = new GlassRain(new THREE.BufferGeometry());
  const sky = new THREE.Color(0.2, 0.3, 0.4);
  rg.update(1, 1, 20, sky, new THREE.Color(1, 1, 1));
  check('Legacy update(dt, rain, ias, sky, glint) call still wets', rg.wet > 0.2 && rg.uniforms.uSky.value.g === 0.3);
  rg.update(1, 1, 20, 0.5, -6, sky, new THREE.Color(1, 1, 1));
  check('Extended positional update feeds systems ice', rg.state.ice === 0.5 && rg.state.oat === -6);
}

// ---------------------------------------------------------------- 7. real Systems provenance
// Fly the real flight model + systems through freezing cloud, exactly like
// test/systems.mjs, and feed sys.ice / o.oat straight into the glass.
{
  const fm = new FlightModel(stillAir);
  fm.reset({ alt: 1500, heading: 0, speed: 100 * KT, pitch: 0.03, throttle: 0.65 });
  const sys = new Systems(fm), ap = new Autopilot(fm); ap.engage('alt');
  const glass = new GlassState();
  const clear = { oat: 15, lwc: 0, precip: 0, humidity: 0.5, lat: 46, variation: 0 };
  const run = (sec, wx, rain) => {
    const n = Math.round(sec / (1 / 240));
    for (let i = 0; i < n; i++) {
      const h = 1 / 240;
      ap.update(h); fm.step(h); sys.update(h, wx);
      glass.update(h, { rain, ias: fm.out.ias, ice: sys.ice, oat: wx.oat });
    }
  };

  run(8, clear, 1);
  const wetBeforeCloud = glass.water;
  check('Integrated: rain coats the glass before cloud entry', wetBeforeCloud > 0.8, `water ${wetBeforeCloud.toFixed(2)}`);

  run(420, { ...clear, oat: -7, lwc: 1 }, 0);
  check('Systems builds genuine airframe ice in freezing cloud', sys.ice > 0.7,
    `systems.ice ${sys.ice.toFixed(2)} after 7 min`);
  check('That system output frosts the glass and freezes its water', glass.frost > 0.7,
    `frost ${glass.frost.toFixed(2)} from systems.ice ${sys.ice.toFixed(2)}`);
  check('Integrated frost is static', glass.mobility === 0, `mobility ${glass.mobility}`);

  run(60, { ...clear, oat: 12, lwc: 0 }, 0);
  check('Systems ice decays in warm air', sys.ice < 0.05, `systems.ice ${sys.ice.toFixed(3)}`);
  check('Glass frost melts as the system clears in warm air', glass.frost < 0.02, `frost ${glass.frost.toFixed(3)}`);
  run(30, { ...clear, oat: 12, lwc: 0 }, 0);
  check('Glass is left essentially clean after drying', glass.frost === 0 && glass.water < 0.05,
    `frost ${glass.frost}, water ${glass.water.toFixed(3)}`);
}

// ---------------------------------------------------------------- 8. main.js wiring / transparency guard
{
  const here = dirname(fileURLToPath(import.meta.url));
  const main = readFileSync(join(here, '..', 'js', 'main.js'), 'utf8');
  check('main.js passes systems.ice into the glass module', /rainGlass\.update\([\s\S]*?ice:\s*systems\.ice/.test(main));
  check('main.js passes outside air temperature for thawing', /rainGlass\.update\([\s\S]*?oat:\s*o\.oat/.test(main));
  check('place() resets the glass on restart / airport change', /systems\.reset\(\);\s*\n\s*aircraft\?\.rainGlass\?\.reset\(\)/.test(main));
  check('Cockpit/exterior glass opacity mapping is unchanged',
    main.includes("aircraft.glass.material.opacity = S.view === 'cockpit' ? 0.07 : 0.3;"));
  check('Pause feeds a zero motion dt to the glass update', /rainGlass\.update\(motionDt/.test(main) && /const motionDt = S\.paused \? 0 : dt;/.test(main));
}

// ---------------------------------------------------------------- report
let bad = 0;
for (const r of rows) { if (!r.ok) bad++; console.log(`${r.ok ? '  ok  ' : ' FAIL '}${r.name}${r.note ? `  — ${r.note}` : ''}`); }
console.log(`\n${rows.length - bad}/${rows.length} glass lifecycle checks passed\n`);
process.exitCode = bad ? 1 : 0;
