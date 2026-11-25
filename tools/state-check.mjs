// State-leak / cache-consistency check. Proves that a render depends only on the current effect, its current
// parameters, the shared knobs and the current camera — never on what was rendered before on the same view.
// Each case renders a target frame two ways and compares pixels:
//   REUSE   run some unrelated frames first on one View, then the target, vs. a cold View rendering the target
//   HIT/MISS the same frame drawn twice (cache warm) vs. a fresh View (cache cold) — a correct cache must agree
//   PARAM   the target after a different parameter value, vs. the target from a cold View with that value
//   MODE/NIGHT/SIZE/HUE/CAMERA  the target after the toggle was on and off again, vs. the toggle never touched
// Multiple flush() calls inside one frame (post / grade / domain) are exercised too, so the reset at frame
// start cannot be mistaken for a per-flush reset.
// usage: node tools/state-check.mjs [--ids a,b] [--quiet] [--fuzz N] [--png out.png]   (exit code 1 on any mismatch)
//   --png writes a side-by-side contact sheet: each row is one scenario (warm render / cold render / diff mask),
//   so the same evidence is visible as pixels, not just as a pass/fail count.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const has = n => args.includes('--' + n);
const quiet = has('quiet'), fuzz = +(opt('fuzz', 6));

// Two independent engines (fresh module instances) so a global cache warmed in one cannot mask a bad key in
// the other: the "cold" side builds its caches from the target inputs only.
const pxfx = fs.readFileSync(path.join(root, 'engine/pxfx.js'), 'utf8');
const kit = fs.readFileSync(path.join(root, 'engine/kit.js'), 'utf8');
function newEngine() {
  const ctx = vm.createContext({ console, performance, Math, Float32Array, Uint8Array, Uint16Array, Uint32Array, Int32Array });
  vm.runInContext(pxfx, ctx, { filename: 'engine/pxfx.js' });
  vm.runInContext(kit, ctx, { filename: 'engine/kit.js' });
  return ctx;
}
const engineA = newEngine();                               // reused views render here (caches get warmed / poisoned)
const SIZE = { '3d': [240, 150], '25d': [240, 150], '2d': [160, 100] };
const allIds = fs.readdirSync(path.join(root, 'fx')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3));
const only = opt('ids', null);
const ids = (only ? only.split(',') : allIds).filter(id => fs.existsSync(path.join(root, 'fx', id + '.js')));

// load every requested effect into engine A and into a per-effect cache of engines for cold renders
const synthetic = new Map();   // id -> draw source, for probe effects defined inline below (no fx/<id>.js on disk)
const defA = {};
for (const id of ids) {
  try { vm.runInContext(fs.readFileSync(path.join(root, 'fx', id + '.js'), 'utf8'), engineA, { filename: 'fx/' + id + '.js' }); defA[id] = engineA.PXFX.get(id); }
  catch (e) { console.log('LOAD ERROR', id, e.message); process.exitCode = 1; }
}

const snapshot = v => Uint32Array.from(v.pix);
function countDiff(a, b) { let n = 0; const len = Math.min(a.length, b.length); for (let i = 0; i < len; i++) if (a[i] !== b[i]) n++; return n + Math.abs(a.length - b.length); }
// render counts as a failure if the effect's draw threw: a cache that returns a null projection, or a key that
// reads an undefined field, shows up here even when the pixels happen to look plausible.
let drawErrors = 0;
const realErr = console.error;
console.error = (...a) => { if (String(a[0]).includes('[pxfx]')) drawErrors++; };
function applyCfg(v, c) {
  v.night = !!c.night; v.transparent = !!c.transparent; v.noProps = !!c.noProps; v.hue = c.hue || 0;
  v.tune = c.tune || {}; v.params = c.params || {}; v.guide = c.guide || 0;
  v.yaw = c.yaw === undefined ? null : c.yaw; v.pitch = c.pitch === undefined ? null : c.pitch;
  v.shakeX = c.shakeX || 0; v.shakeY = c.shakeY || 0; v.gainNow = c.gainNow == null ? 1 : c.gainNow;
}
// render target on engine ctx at mode/cfg/t; returns Uint32Array copy
function render(ctx, id, mode, cfg, t, canvasHooks) {
  const [w, h] = SIZE[mode];
  const v = new ctx.PXFX.View(null, w, h);
  v.mode = mode; applyCfg(v, cfg);
  v.render(ctx.PXFX.get(id), t);
  return { v, pix: snapshot(v) };
}

// a frame that forces several flush() calls (post / grade / domain) — used to prove multi-flush still works.
// Registered like a normal effect file so both define() (id/draw validation) and the registry path are exercised.
const MULTI_ID = '_multiflush';
const MULTI_SRC = `PXFX.define({ id: ${JSON.stringify(MULTI_ID)}, draw(p, t) {
  p.ball(0, 0, .5, .4, ['#334455', '#778899', '#ffffff']);
  p.glow(.3, 0, .5, .7, ['#ff8800', '#ffcc44', '#ffffff'], 1);
  p.flush();                                  // resolve, then draw more on top
  p.ball(.6, 0, .4, .3, ['#552233', '#bb5577', '#ffddee']);
  p.grade({ dark: .2 });                       // flushes again
  p.glow(-.4, 0, .5, .6, ['#2266ff', '#88bbff', '#ffffff'], .8);
  p.flush();                                   // and again
} });`;
synthetic.set(MULTI_ID, MULTI_SRC);
vm.runInContext(MULTI_SRC, engineA, { filename: 'fx/' + MULTI_ID + '.js' });
defA[MULTI_ID] = engineA.PXFX.get(MULTI_ID);
const HUE_ID = '_hueprobe';
const HUE_SRC = `PXFX.define({ id: ${JSON.stringify(HUE_ID)}, draw(p) { p.ball(0, 0, .7, .7, ['#ff2200', '#ffcc00', '#fff6e0']); } });`;
synthetic.set(HUE_ID, HUE_SRC);
vm.runInContext(HUE_SRC, engineA, { filename: 'fx/' + HUE_ID + '.js' });

let checks = 0, fails = 0;
const failRows = [];
function check(name, ref, got) {
  checks++;
  const d = countDiff(ref, got);
  if (d) { fails++; failRows.push(`${name}: ${d} px differ`); if (!quiet) console.log('  MISMATCH', name, d); }
  return d === 0;
}
// a cold reference must come from a *separate* engine so the shared caches are not already warm for the target.
// Memoised: identical (id, mode, cfg, t) references are reused, otherwise a full sweep builds thousands of
// engines and takes minutes. Synthetic defs (no fx/<id>.js on disk) are re-registered from their draw source.
const coldMemo = new Map();
const cfgHash = cfg => JSON.stringify(cfg, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v));
function coldRef(id, mode, cfg, t) {
  const key = id + '|' + mode + '|' + t + '|' + cfgHash(cfg);
  if (coldMemo.has(key)) return coldMemo.get(key);
  const c = newEngine();
  const file = path.join(root, 'fx', id + '.js');
  if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), c, { filename: 'fx/' + id + '.js' });
  else vm.runInContext(synthetic.get(id), c, { filename: 'fx/' + id + '.js' });
  const pix = render(c, id, mode, cfg, t).pix;
  coldMemo.set(key, pix);
  return pix;
}

const cfgPool = [
  {}, { night: true }, { transparent: true, noProps: true }, { hue: 33 }, { hue: 33.5 },
  { tune: { size: 1.45 } }, { tune: { density: 1.9 } }, { tune: { dither: .15, outline: true } }, { tune: { gain: 1.6 } },
];
const modes = ['25d', '3d', '2d'];
const tOf = def => def.loop * (0.31 + (def.id.length % 7) * 0.05);   // a deterministic per-effect time

// ---------- 1. effect-to-effect / frame-to-frame reuse ----------
for (const id of ids) {
  const def = defA[id];
  if (!def) continue;
  const other = ids[(ids.indexOf(id) + 5) % ids.length];
  for (const mode of modes) {
    const t = tOf(def);
    const ref = coldRef(id, mode, {}, t);
    // (a) unrelated effect rendered first on the same view
    const v = new engineA.PXFX.View(null, ...SIZE[mode]); v.mode = mode; applyCfg(v, {});
    v.render(engineA.PXFX.get(other) || def, 0.4);
    applyCfg(v, {}); v.render(def, t);
    check(`REUSE other->${id} ${mode}`, ref, snapshot(v));
    // (b) night + transparent + max params + hue + orbit first, then straight target
    const v2 = new engineA.PXFX.View(null, ...SIZE[mode]); v2.mode = mode;
    const pmax = Object.fromEntries(Object.entries(def.params || {}).map(([k, d]) => [k, d.max]));
    applyCfg(v2, { night: true, transparent: true, noProps: true, hue: 120, tune: { size: 1.5, density: 2 }, params: pmax, yaw: 1.7, pitch: .1 });
    v2.render(def, def.loop * 0.2);
    applyCfg(v2, {}); v2.render(def, t);
    check(`REUSE poisoned->${id} ${mode}`, ref, snapshot(v2));
  }
}

// ---------- 2. cache hit vs miss (same frame twice, warm vs cold) ----------
for (const id of ids) {
  const def = defA[id];
  if (!def) continue;
  for (const mode of modes) {
    const t = tOf(def);
    const ref = coldRef(id, mode, {}, t);
    const v = new engineA.PXFX.View(null, ...SIZE[mode]); v.mode = mode; applyCfg(v, {});
    v.render(def, t); const first = snapshot(v);
    v.render(def, t); const second = snapshot(v);
    check(`HIT self-repeat->${id} ${mode}`, ref, second);
    check(`HIT first-vs-second->${id} ${mode}`, first, second);
  }
}

// ---------- 3. parameter change: after another value, vs. cold at the target value ----------
for (const id of ids) {
  const def = defA[id];
  const keys = Object.keys(def && def.params || {});
  if (!keys.length) continue;
  const mode = '25d', t = tOf(def);
  for (const key of keys) {
    const d = def.params[key], vals = [d.min, d.max, (d.min + d.max) / 2];
    for (let i = 0; i < vals.length; i++) {
      const target = { [key]: vals[i] }, other = { [key]: vals[(i + 1) % vals.length] };
      const ref = coldRef(id, mode, { params: target }, t);
      const v = new engineA.PXFX.View(null, ...SIZE[mode]); v.mode = mode;
      applyCfg(v, { params: other }); v.render(def, t * 0.8);
      applyCfg(v, { params: target }); v.render(def, t);
      check(`PARAM ${id}.${key}=${target[key]} after ${other[key]} ${mode}`, ref, snapshot(v));
    }
  }
}

// ---------- 4. shared knobs toggled on then off, and camera moved then restored ----------
for (const id of ids) {
  const def = defA[id];
  if (!def) continue;
  for (const mode of modes) {
    const t = tOf(def);
    const ref = coldRef(id, mode, {}, t);
    for (const cfg of cfgPool) {
      const v = new engineA.PXFX.View(null, ...SIZE[mode]); v.mode = mode;
      applyCfg(v, cfg); v.render(def, t * 0.9);
      applyCfg(v, {}); v.render(def, t);
      check(`TOGGLE ${id} ${mode} <- ${JSON.stringify(cfg)}`, ref, snapshot(v));
    }
    if (mode === '3d') {                                   // orbit the camera, then back to the default yaw
      const v = new engineA.PXFX.View(null, ...SIZE[mode]); v.mode = mode;
      applyCfg(v, { yaw: 1.2345 }); v.render(def, t);
      applyCfg(v, { yaw: -0.7, pitch: .2 }); v.render(def, t);
      applyCfg(v, {}); v.render(def, t);
      check(`CAMERA orbit->restore ${id} ${mode}`, ref, snapshot(v));
      // a sub-pixel camera nudge whose projection rounds to the same 3 decimals: a per-effect cache keyed on
      // rounded projections would wrongly reuse the first camera's rays here.
      const refB = coldRef(id, mode, { yaw: 0.5000004 }, t);
      const vb = new engineA.PXFX.View(null, ...SIZE[mode]); vb.mode = mode;
      applyCfg(vb, { yaw: 0.5 }); vb.render(def, t);
      applyCfg(vb, { yaw: 0.5000004 }); vb.render(def, t);
      check(`CAMERA fine-move ${id} ${mode}`, refB, snapshot(vb));
    }
  }
}

// ---------- 4b. exact hue: two hues that truncate to the same integer must not share a ramp ----------
{
  const hueDef = engineA.PXFX.get(HUE_ID);
  for (const [a, b] of [[30.4, 30.6], [120.1, 120.9], [-45.3, -44.7]]) {
    const refHue = coldRef(HUE_ID, '25d', { hue: b }, 0);
    const v = new engineA.PXFX.View(null, ...SIZE['25d']); v.mode = '25d';
    applyCfg(v, { hue: a }); v.render(hueDef, 0);
    applyCfg(v, { hue: b }); v.render(hueDef, 0);
    check(`HUE ${a}->${b}`, refHue, snapshot(v));
  }
}

// ---------- 4c. camera caches at an early frame (t = 0.5): a sub-pixel nudge that rounds the same, and an
// orbit that sends a probe point off a perspective camera's screen (both used to leak / crash in per-effect
// per-camera caches). Run on every effect; the draw-error counter and the pixel diff both catch problems. ----------
for (const id of ids) {
  const def = defA[id];
  if (!def) continue;
  const mode = '3d', t = 0.5;
  const refFine = coldRef(id, mode, { yaw: 0.5000004 }, t);
  const v = new engineA.PXFX.View(null, ...SIZE[mode]); v.mode = mode;
  applyCfg(v, { yaw: 0.5 }); v.render(def, t);
  applyCfg(v, { yaw: 0.5000004 }); v.render(def, t);
  check(`CAMERA fine-move t=.5 ${id}`, refFine, snapshot(v));
  const refOrbit = coldRef(id, mode, { yaw: 1.2345 }, t);
  const vo = new engineA.PXFX.View(null, ...SIZE[mode]); vo.mode = mode;
  applyCfg(vo, { yaw: -0.7 }); vo.render(def, t);
  applyCfg(vo, { yaw: 1.2345 }); vo.render(def, t);
  check(`CAMERA orbit t=.5 ${id}`, refOrbit, snapshot(vo));
}

// ---------- 5. multi-flush frame: still deterministic, still clears between frames ----------
{
  const mode = '25d', t = .5;
  const mk = () => { const v = new engineA.PXFX.View(null, ...SIZE[mode]); v.mode = mode; return v; };
  const a = mk(); a.render(defA[MULTI_ID], t); const ref = snapshot(a);
  const b = mk(); b.render(defA[MULTI_ID], t); const again = snapshot(b);
  check('MULTIFLUSH deterministic', ref, again);
  // a plain frame between two multi-flush frames must not change the second one
  const c = mk(); c.render(engineA.PXFX.get('fireball') || defA[MULTI_ID], .5); c.render(defA[MULTI_ID], t);
  check('MULTIFLUSH after plain frame', ref, snapshot(c));
  // no light / shadow / ground-light residue left behind after a clean frame
  const d = mk(); d.render(defA[MULTI_ID], t);
  const left = k => { let n = 0; for (let i = 0; i < d[k].length; i++) if (d[k][i]) n++; return n; };
  const residue = left('L') + left('LM') + left('GL') + left('shadow');
  check('MULTIFLUSH buffers drained', new Uint32Array([0]), new Uint32Array([residue]));
}

// ---------- 6. random fuzz over ids/modes/configs ----------
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
for (let k = 0; k < fuzz; k++) {
  const id = pick(ids), def = defA[id];
  if (!def) continue;
  const mode = pick(modes), t = def.loop * (0.1 + rnd() * 0.8);
  const cfg = {};
  if (rnd() < .4) cfg.night = true;
  if (rnd() < .3) { cfg.transparent = true; cfg.noProps = true; }
  if (rnd() < .4) cfg.hue = Math.round(rnd() * 360);
  if (rnd() < .4) cfg.tune = { size: .6 + rnd(), density: .3 + rnd() * 1.6, gain: .6 + rnd() };
  if (rnd() < .3) { cfg.yaw = rnd() * 6.28; cfg.pitch = -.3 + rnd() * .9; }
  const keys = Object.keys(def.params || {});
  if (keys.length && rnd() < .5) { const key = pick(keys), d = def.params[key]; cfg.params = { [key]: d.min + rnd() * (d.max - d.min) }; }
  const ref = coldRef(id, mode, cfg, t);
  const v = new engineA.PXFX.View(null, ...SIZE[mode]); v.mode = mode;
  const warm = rnd() < .5 ? pick(cfgPool) : {};
  applyCfg(v, warm); v.render(engineA.PXFX.get(pick(ids)) || def, rnd() * def.loop);
  applyCfg(v, cfg); v.render(def, t);
  check(`FUZZ#${k} ${id} ${mode} ${JSON.stringify(cfg)}`, ref, snapshot(v));
}

// ---------- summary ----------
if (drawErrors) { fails++; failRows.push(`${drawErrors} draw exception(s) — a cache key or projection returned garbage`); }
if (failRows.length) { console.log('\nFAILURES:'); for (const r of failRows.slice(0, 40)) console.log('  ' + r); if (failRows.length > 40) console.log(`  … and ${failRows.length - 40} more`); }
console.log(`\n${fails ? 'FAIL' : 'OK'}  ${checks - fails}/${checks} checks passed${fails ? `, ${fails} mismatched` : ''}${drawErrors ? `, ${drawErrors} draw errors` : ''}`);

// ---------- optional pixel evidence ----------
const pngOut = opt('png', null);
if (pngOut) {
  const encode = (w, h, rgba) => {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    const crc = buf => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  };
  // rows: [label, effect id, mode, warm cfg, warm frames to run first, cold cfg, target cfg, t]
  const rows = [];
  const first = ids.find(id => defA[id] && Object.keys(defA[id].params || {}).length) || ids[0];
  const second = ids[(ids.indexOf(first) + 5) % ids.length];
  const tp = defA[first].params || {}, pk = Object.keys(tp)[0];
  // 1. two different effects rendered back to back on one view
  rows.push([`${second} -> ${first} (reuse)`, first, '25d', {}, [[second, 0.4]], {}, defA[first].loop * 0.5]);
  // 2. the same effect after a different parameter value
  if (pk) {
    const d = tp[pk], lo = d.min, hi = d.max;
    rows.push([`${first}.${pk}: ${hi} -> ${lo} (param)`, first, '25d', { params: { [pk]: hi } }, [[first, 0.3]], { params: { [pk]: lo } }, defA[first].loop * 0.6]);
  }
  // 3. camera orbit then back (3d only, when the effect renders in 3d)
  rows.push([`${first} orbit -> rest (camera)`, first, '3d', { yaw: 1.7, pitch: .1 }, [[first, 0.3]], {}, defA[first].loop * 0.55]);
  const cells = [];
  for (const [label, id, mode, warmCfg, warmFrames, cfg, t] of rows) {
    const def = defA[id]; if (!def || !mode) { cells.push(null); continue; }
    const v = new engineA.PXFX.View(null, ...SIZE[mode]); v.mode = mode;
    applyCfg(v, warmCfg);
    for (const [wid, wt] of warmFrames) { v.render(engineA.PXFX.get(wid) || def, wt); }
    applyCfg(v, cfg); v.render(def, t);
    const warm = snapshot(v);
    const cold = coldRef(id, mode, cfg, t);
    cells.push({ mode, warm, cold, label });
  }
  const [cw, ch] = [SIZE['25d'][0], SIZE['25d'][1]], gap = 4, scale = 1;
  const rowsN = cells.length, colsN = 3;
  const SW = colsN * (cw + gap) + gap, SH = rowsN * (ch + gap) + gap;
  const sheet = Buffer.alloc(SW * SH * 4, 255);
  // draw warm (col 0) / cold (col 1) / diff mask (col 2) for each row, upscaled nearest into a 240x150 cell
  for (let r = 0; r < rowsN; r++) {
    const c = cells[r]; if (!c) continue;
    const [w, h] = SIZE[c.mode];
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const sx = Math.min(w - 1, Math.floor(x * w / cw)), sy = Math.min(h - 1, Math.floor(y * h / ch)), si = sy * w + sx;
      const a = c.warm[si], b = c.cold[si];
      const oy = gap + r * (ch + gap) + y;
      const cell = (col, col32) => { const o = (oy * SW + gap + col * (cw + gap) + x) * 4; sheet[o] = col32 & 255; sheet[o + 1] = col32 >> 8 & 255; sheet[o + 2] = col32 >> 16 & 255; sheet[o + 3] = 255; };
      cell(0, a); cell(1, b); cell(2, a === b ? 0xff202020 : 0xffff3a3a);   // diff mask: red where they differ
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(pngOut)), { recursive: true });
  fs.writeFileSync(pngOut, encode(SW, SH, sheet));
  console.log(`wrote ${pngOut}  (columns: warm render | cold render | diff — red = mismatch)`);
}

process.exitCode = fails ? 1 : 0;
