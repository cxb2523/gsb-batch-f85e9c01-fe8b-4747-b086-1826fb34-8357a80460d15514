// A smoke test of the real page in real Chrome: dev.html#offscreen and the net hooks of window.abyssal (source/src/dev.js)
// against the real sea. It is not part of npm test (it needs a Chrome with WebGPU and is slower); run it by hand:
//   node test/browser.test.mjs          (CHROME=... to point at another Chrome)
// What it checks, over the Chrome DevTools Protocol (a pipe, so no debugging port): the page connects and gets an id;
// it sees the other player, with its name; a strike from that player takes health; a closed connection clears the near
// players and the page's id at once; and a reconnect gets a new id and sees the player again.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket as ClientWS } from 'ws';
import { Sea } from '../src/sea.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0; const ok = (what, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failed++; };

// ---------------------------------------------------------------- the sea, and the page it serves
const page = readFileSync(fileURLToPath(new URL('../../dev.html', import.meta.url)));
const sea = new Sea();
const http = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); });
const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => { wss.handleUpgrade(req, socket, head, (ws) => { ws.binaryType = 'arraybuffer'; sea.join(ws); }); });
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const port = http.address().port;
// another player, a crab that stands 0.6 m east of the page's crab and faces it, so it is near and can strike it. Its
// place follows the page's crab (which the page keeps moving), so the distance the server checks stays within reach.
function remote(name, at) {
  const ws = new ClientWS(`ws://127.0.0.1:${port}/ws`), p = { ws, id: 0, json: [], pos: { x: at[0] + 0.6, y: at[1], z: at[2] } };
  ws.on('message', (d, bin) => { if (!bin) { const m = JSON.parse(d.toString()); p.json.push(m); if (m.t === 'hi') p.id = m.id; } });
  p.state = (flags = 0) => { const { x, y, z } = p.pos, b = new ArrayBuffer(28), v = new DataView(b); v.setUint8(0, 1); v.setUint8(1, 0); v.setUint8(2, flags); [x, y, z, Math.PI, 0, 0].forEach((f, i) => v.setFloat32(4 + i * 4, f, true)); ws.send(b); };
  p.send = (m) => ws.send(JSON.stringify(m));
  ws.on('open', () => { p.send({ t: 'hi', name }); p.state(); p.timer = setInterval(() => p.state(), 100); });
  p.done = () => { clearInterval(p.timer); try { ws.close(); } catch {} };
  return p;
}
const rival = { id: 0, done() {} };
await wait(300);

// ---------------------------------------------------------------- Chrome, over a debugging pipe
const chromePath = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = mkdtempSync(join(tmpdir(), 'abyssal-browser-'));
const child = spawn(chromePath, ['--headless=new', '--remote-debugging-pipe', '--user-data-dir=' + profile, '--enable-unsafe-webgpu', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let chromeErr = ''; child.stderr.on('data', (d) => { chromeErr += d.toString(); });
const to = child.stdio[3], from = child.stdio[4];
let n = 0; const pend = new Map(); let buf = '';
from.on('data', (d) => {
  buf += d.toString();
  let k; while ((k = buf.indexOf('\0')) >= 0) { const s = buf.slice(0, k); buf = buf.slice(k + 1); let m; try { m = JSON.parse(s); } catch { continue; } if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } }
});
const cmd = (method, params = {}, sessionId) => new Promise((r, j) => { const id = ++n; pend.set(id, (m) => (m.error ? j(new Error(method + ': ' + m.error.message)) : r(m.result))); to.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + '\0'); });
// a page target of its own, with the sea at the server
const { targetId } = await cmd('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cmd('Target.attachToTarget', { targetId, flatten: true });
const url = `http://127.0.0.1:${port}/dev.html#offscreen?server=127.0.0.1:${port}`;
await cmd('Page.navigate', { url }, sessionId);
await cmd('Runtime.enable', {}, sessionId);
const ev = async (expr) => {
  const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};
const until = async (expr, ms = 30000, step = 250) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return true; } catch {} await wait(step); } return false; };
// #offscreen draws no frames of its own (dev.js steps them): pump a few, so net.js sends its state and takes packets
const pump = (frames = 4) => ev(`(async () => { for (let i = 0; i < ${frames}; i++) await abyssal.step(33); })()`);
const untilPumped = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(expr)) return true; } catch {} await pump(2); await wait(150); } return false; };

try {
  ok('the page starts and exposes its net hooks', await until('!!(window.abyssal && window.abyssal.net)', 90000));
  // a crab in play, and the menu down: behind the menu a player is away, and the server tells nobody of it
  await ev('abyssal.play(0)');
  await ev('abyssal.dive()');
  const at = await ev('abyssal.meAt()'); // where the page's crab is, to put the rival beside it
  const rv = remote('Rival', at);
  for (let i = 0; i < 40 && !rv.id; i++) await wait(100); // (its id comes with the server's answer)
  rival.id = rv.id; rival.done = rv.done; rival.send = rv.send;
  // the rival keeps station off the page's crab's shoulder, which the page (left to the sea) keeps drifting from
  const follow = async () => { const m = await ev('abyssal.meAt()'); if (m) { rv.pos.x = m[0] + 0.6; rv.pos.y = m[1]; rv.pos.z = m[2]; } };
  await wait(300);
  await ev('abyssal.net(true)');
  ok('the page connects and is given an id', await untilPumped('abyssal.net().id > 0'));
  const s1 = await ev('abyssal.net()');
  ok('it sees the other player, with its name', await untilPumped(`abyssal.net().peers.some((p) => p[0] === ${rival.id} && p[1] === 'Rival')`));
  // the rival strikes the page: the server settles it, and the page takes the health
  await ev('abyssal.life(1)');
  for (let i = 0; i < 40; i++) { await follow(); rival.send({ t: 'bite', to: s1.id }); if (await ev('abyssal.fight().hp < 0.99')) break; await pump(2); await wait(150); }
  ok('a strike from the other player takes health', await ev('abyssal.fight().hp < 0.99'));
  // an active disconnect: the near players and the page's id go at once
  await ev('abyssal.netClose()');
  ok('a closed connection clears the near players and the id', await until('abyssal.net().id === 0 && abyssal.net().peers.length === 0', 8000));
  // and a reconnect: a new id of its own, the other player seen again
  await ev('abyssal.net(true)');
  ok('the reconnected page is given a new id', await untilPumped(`abyssal.net().id > 0 && abyssal.net().id !== ${s1.id}`));
  ok('and sees the other player again', await untilPumped(`abyssal.net().peers.some((p) => p[0] === ${rival.id})`));
} catch (e) { console.error('browser test: ' + e.message); failed++; if (chromeErr) console.error(chromeErr.slice(-2000)); }
finally {
  rival.done();
  try { await cmd('Browser.close'); } catch {}
  try { child.kill(); } catch {}
  try { wss.close(); http.close(); } catch {}
  // its own Chrome profile goes (once Chrome has let go of it; a locked file is left to the OS)
  await wait(1500);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
}
console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
