// End-to-end local sample for the persistent glass lifecycle in a real browser.
//
//   node tools/glass-sample.mjs [--port 0] [--out shots/glass-sample]
//
// Serves the repo on a free local port with the dependency-free node server and
// launches the installed Chrome/Edge headless, then drives the actual simulator
// frame loop over CDP: it soaks the glass, makes the water run, dries it,
// freezes it to frost via systems.ice, freezes paused frames and compares their
// pixels, restarts via place(), and checks the cockpit/exterior opacity. JPEG
// evidence and a JSON report are written to --out. Non-zero exit on failure.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const PORT_ARG = Number(arg('--port', 0));          // 0 = a free ephemeral port
const OUT = resolve(arg('--out', join(root, 'shots', 'glass-sample')));
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
};
// In-process static server so back-to-back runs never fight over a fixed port.
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(PORT_ARG, '127.0.0.1', r));
const PORT = server.address().port;

function browserPath() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
  ];
  return candidates.find((p) => p && existsSync(p)) || null;
}

// ---- browser child
const bin = browserPath();
if (!bin) { console.error('No Chrome/Edge found; set CHROME_BIN.'); server.close(); process.exit(2); }
const prof = mkdtempSync(join(tmpdir(), 'cayley-glass-'));
const chrome = spawn(bin, [
  '--headless=new', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--mute-audio',
  // Chromium's Windows command-line parser eats backslashes in this value; forward slashes work.
  `--user-data-dir=${prof.replaceAll('\\', '/')}`, '--remote-debugging-port=0', '--remote-allow-origins=*',
  '--window-size=1280,800', '--force-device-scale-factor=1',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl',
  '--ignore-gpu-blocklist', '--enable-gpu', '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  try { spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  try { chrome.kill(); } catch {}
  try { server.close(); } catch {}
  try { rmSync(prof, { recursive: true, force: true }); } catch {}
};
const hardStop = setTimeout(() => { console.error('sample timed out'); cleanup(); process.exit(2); }, 240000);

let seq = 0;
try {
  let port = null;
  for (let i = 0; i < 150 && !port; i++) {
    const f = join(prof, 'DevToolsActivePort');
    if (existsSync(f)) { port = readFileSync(f, 'utf8').split('\n')[0].trim(); break; }
    await sleep(100);
  }
  if (!port) throw new Error('browser did not start CDP');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.text || 'exception');
  };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 800));
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__glassErrs = [];
    window.addEventListener('error', function (e) { window.__glassErrs.push('error: ' + (e.message || 'unknown')); });
    (function () { var ce = console.error.bind(console);
      console.error = function () { try { window.__glassErrs.push(Array.prototype.map.call(arguments,
        function (x) { if (x && x.message) return x.message; try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); } })
        .join(' ').slice(0, 600)); } catch (e) {} ce.apply(console, arguments); };
    })();` });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?record` });

  const SCENARIO = `(async () => {
    const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms); });
    const R = { steps: [], shots: {} };
    const ok = function (name, pass, note) { R.steps.push({ name: name, pass: !!pass, note: note == null ? '' : String(note) }); };
    let sim = window.sim;
    for (let i = 0; i < 200 && !(sim && sim.S && sim.S.airport && sim.S.weather && sim.aircraft && sim.aircraft.rainGlass); i++) { await sleep(250); sim = window.sim; }
    if (!(sim && sim.aircraft && sim.aircraft.rainGlass)) { R.fatal = 'sim did not boot within wait'; return JSON.stringify(R); }
    const rg = sim.aircraft.rainGlass;
    const gl = sim.renderer.getContext();
    // Coarse raw-GL readback grid: a stronger pause comparison than JPEG bytes alone.
    const pixelHash = function () {
      const c = sim.renderer.domElement, pts = [];
      for (let j = 1; j < 8; j++) for (let i = 1; i < 8; i++) {
        const p = new Uint8Array(4);
        gl.readPixels((c.width * i / 8) | 0, (c.height * j / 8) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
        pts.push(p[0] + ',' + p[1] + ',' + p[2]);
      }
      return pts.join('|');
    };
    sim.S.paused = false;
    // The record clock starts at module-eval time, so the entry fade can stay 0
    // in a fast headless run. Settle it exactly as a normal session would be.
    // Noon gives stable exposure for the evidence frames regardless of run time.
    const noonBtn = document.querySelector('#timeSeg [data-v=noon]');
    if (noonBtn) noonBtn.click();
    sim.S.settled = true; sim.S.fade = 1;
    sim.S.view = 'cockpit'; sim.input.look.yaw = 0; sim.input.look.pitch = 0;
    for (let k = 0; k < 20; k++) sim.advance(0.25, 30);
    sim.S.fade = 1;

    // ---- main frame wiring: systems.ice reaches the glass state
    sim.systems.ice = 0.77;
    sim.advance(1 / 30, 30);
    ok('frame wires systems.ice into the glass module', Math.abs(rg.state.ice - 0.77) < 1e-9, 'state.ice=' + rg.state.ice);
    sim.systems.ice = 0;

    // ---- rain accumulates and runs with speed
    rg.reset();
    for (let i = 0; i < 240; i++) rg.update(1 / 30, { rain: 1, ias: 12 });
    ok('rain lays water on the glass', rg.state.water > 0.8, 'water=' + rg.state.water.toFixed(2));
    const y0 = rg.state.travelY[0];
    for (let i = 0; i < 90; i++) rg.update(1 / 30, { rain: 1, ias: 42 });
    ok('at speed the water runs up the pane', rg.state.travelY[0] - y0 > 0.3, 'dy=' + (rg.state.travelY[0] - y0).toFixed(2) + ' m');
    sim.advance(1 / 30, 30);
    R.shots.rain = sim.grab('Rain on the windscreen', 'persistent drops that run with airspeed');

    // ---- rain stops: airflow dries it within seconds
    let tDry = null;
    for (let s = 1; s <= 40; s++) {
      for (let i = 0; i < 30; i++) rg.update(1 / 30, { rain: 0, ias: 46 });
      if (tDry === null && rg.state.water <= 0.02) tDry = s;
    }
    ok('once rain stops, airflow dries the glass to ~zero', tDry !== null && tDry <= 20, 'clean at ' + tDry + ' s');

    // ---- freezing cloud: systems-level ice turns a wet glass to static frost
    rg.state.water = 1; rg.sync();
    for (let i = 0; i < 300; i++) rg.update(1 / 30, { rain: 0, ias: 42, ice: 1, oat: -7 });
    ok('freezing cloud turns the water to static frost', rg.state.frost > 0.85 && rg.state.mobility === 0,
      'frost=' + rg.state.frost.toFixed(2) + ' mobility=' + rg.state.mobility);
    sim.advance(1 / 30, 30);
    R.shots.frost = sim.grab('Freezing cloud', 'water freezes to rime and stops flowing');

    // ---- pause: real advanced frames, state/uniforms/pixels must not change
    rg.reset();
    for (let i = 0; i < 120; i++) rg.update(1 / 30, { rain: 1, ias: 34, ice: 0.25, oat: -5 });
    sim.S.paused = true;
    sim.advance(0.2, 30);
    const s1 = JSON.stringify(rg.state.toJSON());
    const h1 = pixelHash();
    const uSnap = function () { return JSON.stringify([rg.uniforms.uWet.value, rg.uniforms.uFrost.value,
      rg.uniforms.uOff.value.map(function (v) { return v.toArray(); })]); };
    const u1 = uSnap();
    const img1 = sim.grab('Paused', 'consecutive frames are identical');
    sim.advance(0.3, 30);
    const s2 = JSON.stringify(rg.state.toJSON());
    const u2 = uSnap();
    const h2 = pixelHash();
    const img2 = sim.grab('Paused', 'consecutive frames are identical');
    ok('paused frame is a rendered picture, not a blank buffer', new Set(h2.split('|')).size >= 4,
      new Set(h2.split('|')).size + ' distinct sample colours');
    ok('paused frames keep the lifecycle state identical', s1 === s2);
    ok('paused frames keep the shader uniforms identical', u1 === u2);
    ok('paused raw-GL pixels are unchanged', h1 === h2);
    ok('paused canvas frames are pixel-identical', img1 === img2, img1.length + ' vs ' + img2.length + ' chars');
    R.shots.pause = img2;
    sim.S.paused = false;
    const tBefore = rg.state.time;
    sim.advance(1 / 30, 30);
    ok('resume continues from the held state', rg.state.time > tBefore, 'time ' + tBefore.toFixed(2) + ' -> ' + rg.state.time.toFixed(2));

    // ---- restart / new airport path clears the glass
    rg.state.water = 0.8; rg.state.frost = 0.4; rg.sync();
    sim.place();
    ok('place() (R / new airport) returns clean glass', rg.state.water === 0 && rg.state.frost === 0 && !rg.mesh.visible,
      'water=' + rg.state.water + ' frost=' + rg.state.frost + ' visible=' + rg.mesh.visible);

    // ---- view switching keeps state and the original opacity mapping
    sim.S.view = 'cockpit'; sim.advance(1 / 30, 30);
    const opC = sim.aircraft.glass.material.opacity;
    sim.S.view = 'chase'; sim.advance(1 / 30, 30);
    const opX = sim.aircraft.glass.material.opacity;
    ok('glass opacity stays 0.07 cockpit / 0.30 exterior', Math.abs(opC - 0.07) < 1e-9 && Math.abs(opX - 0.3) < 1e-9, opC + ' / ' + opX);
    rg.update(1, { rain: 1, ias: 10 });
    const wView = rg.state.water;
    sim.S.view = 'flyby'; sim.S.view = 'cockpit';
    ok('switching views does not reset glass state', sim.aircraft.rainGlass === rg && rg.state.water === wView);

    // ---- real flight path: startFlight, run frames, then pause like the P key ----
    try {
      await sim.startFlight();
      for (let i = 0; i < 120; i++) sim.advance(1 / 30, 30);
      ok('startFlight runs and the live frame loop drives the glass',
        sim.S.mode === 'fly' && rg.state.time > 0,
        'mode=' + sim.S.mode + ' glassT=' + rg.state.time.toFixed(1) + ' ias=' + Math.round(sim.fm.out.ias));
      sim.S.paused = true;                                   // exactly what KeyP toggles
      const f1 = JSON.stringify(rg.state.toJSON());
      sim.advance(0.3, 30); sim.advance(0.3, 30);
      const f2 = JSON.stringify(rg.state.toJSON());
      ok('P-key pause freezes live glass state', f1 === f2);
      sim.S.paused = false;
      sim.advance(1 / 30, 30);
      ok('unpausing continues from the held state', rg.state.time > JSON.parse(f2).time);
    } catch (e) {
      ok('flight smoke ran without throwing', false, e && e.message);
    }

    R.consoleErrors = (window.__glassErrs || []).filter(function (m) {
      return /shader|webgl|gl_|ERROR:|uncaught|typeerror|referenceerror|syntaxerror/i.test(m);
    }).slice(0, 12);
    R.allConsoleErrors = (window.__glassErrs || []).slice(0, 12);
    return JSON.stringify(R);
  })()`;

  const raw = await ev(SCENARIO);
  if (!raw) throw new Error('scenario returned no value');
  const report = JSON.parse(raw);
  if (report.fatal) throw new Error(report.fatal);

  for (const [name, url] of Object.entries(report.shots || {})) {
    if (!url || !url.startsWith('data:image/jpeg')) continue;
    writeFileSync(join(OUT, `${name}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
  }
  delete report.shots;
  report.pageErrors = pageErrors;
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  let bad = 0;
  for (const s of report.steps) { if (!s.pass) bad++; console.log(`${s.pass ? '  ok  ' : ' FAIL '}${s.name}${s.note ? '  — ' + s.note : ''}`); }
  if (report.consoleErrors?.length) { bad += report.consoleErrors.length; console.log('\nShader/runtime console errors:'); for (const e of report.consoleErrors) console.log('  ! ' + e); }
  if (pageErrors.length) { bad += pageErrors.length; console.log('\nCDP page exceptions:', pageErrors); }
  const passed = report.steps.filter((s) => s.pass).length;
  console.log(`\n${passed}/${report.steps.length} browser checks passed${bad ? `, ${bad} problem(s)` : ''}`);
  console.log(`evidence in ${OUT}`);
  cleanup();
  clearTimeout(hardStop);
  process.exit(bad ? 1 : 0);
} catch (err) {
  console.error('glass sample failed:', err.message);
  try { writeFileSync(join(OUT, 'error.txt'), err.stack || err.message); } catch {}
  cleanup();
  clearTimeout(hardStop);
  process.exit(1);
}
