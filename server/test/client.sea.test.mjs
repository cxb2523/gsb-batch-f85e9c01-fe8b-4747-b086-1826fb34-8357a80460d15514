// The game's side of the shared sea (source/src/net.js) against the real sea (server/src/sea.js), in one Node process:
// a plain HTTP server and WebSockets, the sea joined to them, the real net.js run in a VM with a WebSocket that is a
// real client socket. No browser, no GPU, no public server.
//   node test/client.sea.test.mjs       (or npm test in server/)
// It covers what only an end-to-end run can: after connecting, the other player is seen and a strike between crabs is
// settled; after an active disconnect and a reconnect, the old player is gone from the scene, the new connection has a
// new id of its own, and the players near are back under it; a message of the closed connection changes nothing.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { WebSocketServer, WebSocket as ClientWS } from 'ws';
import { Sea } from '../src/sea.js';

let failed = 0; const ok = (what, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const src = (f) => readFileSync(fileURLToPath(new URL('../../source/src/' + f, import.meta.url)), 'utf8');

// ---------------------------------------------------------------- the sea, on a spare port of its own
const sea = new Sea();
const http = createServer((req, res) => { res.writeHead(404); res.end(); });
const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => { wss.handleUpgrade(req, socket, head, (ws) => { ws.binaryType = 'arraybuffer'; sea.join(ws); }); });
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const port = http.address().port;

// a raw player, as server/test/sea.test.mjs drives one: a WebSocket speaking the protocol by hand
function remote(name, s, x, y, z, yaw) {
  const ws = new ClientWS(`ws://127.0.0.1:${port}/ws`), p = { ws, id: 0, json: [], yaw };
  ws.on('message', (d, bin) => { if (!bin) { const m = JSON.parse(d.toString()); p.json.push(m); if (m.t === 'hi') p.id = m.id; } });
  p.send = (m) => ws.send(JSON.stringify(m));
  p.state = (flags = 0) => { const b = new ArrayBuffer(28), v = new DataView(b); v.setUint8(0, 1); v.setUint8(1, s); v.setUint8(2, flags); [x, y, z, yaw, 0, 1].forEach((f, i) => v.setFloat32(4 + i * 4, f, true)); ws.send(b); };
  ws.on('open', () => { p.send({ t: 'hi', name }); p.state(); p.timer = setInterval(() => p.state(), 100); });
  p.done = () => { clearInterval(p.timer); try { ws.close(); } catch {} };
  return p;
}

// ---------------------------------------------------------------- the game, as net.js finds it
// A WebSocket for the VM that is a real client socket; messages reach net.js as the page would get them.
const vmSockets = [];
class PageSocket {
  constructor(url) {
    this.ws = new ClientWS(url); this.binaryType = 'arraybuffer'; this.sent = []; vmSockets.push(this);
    this.ws.on('open', () => this.onopen && this.onopen());
    this.ws.on('message', (d, bin) => { const data = bin ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.toString(); this.onmessage && this.onmessage({ data }); });
    this.ws.on('close', () => this.onclose && this.onclose());
    this.ws.on('error', () => this.onerror && this.onerror());
  }
  // (the page's ArrayBuffer is another realm's: tell it by its tag, not instanceof)
  send(m) { const b = typeof m === 'string' ? m : Buffer.from(Object.prototype.toString.call(m) === '[object ArrayBuffer]' ? m : m.buffer); try { this.ws.send(b); } catch {} }
  close() { try { this.ws.close(); } catch {} }
}
const ctx = vm.createContext({
  console, WebSocket: PageSocket, URLSearchParams, localStorage: {}, location: { search: '', protocol: 'http:', host: '127.0.0.1:' + port },
  performance: { now: () => Date.now() }, queueMicrotask,
});
vm.runInContext(`
  const { sin, cos, sqrt, min, max, abs, floor, PI, pow, atan2, hypot, exp, round, ceil } = Math;
  const TAU = PI * 2, clamp = (x, a, b) => (x < a ? a : x > b ? b : x), wrapA = (a) => a - TAU * Math.round(a / TAU);
  const CRIT = ${JSON.stringify(Array.from({ length: 10 }, (_, s) => ({ id: 's' + s, real: 0.2 + s, len: 1.6 + s, spd: 1 + s * 0.5, freq: 3, turn: 1.5, high: 0.15, near: 4 })))};
  const CRAB = 0, PEERMAX = 40, F = new Float64Array(4), CX = 0, CY = 1, CZ = 2;
  const bots = [];
  const botAdd = (s, p, yaw) => { const c = CRIT[s], b = { s, x: p[0], y: p[1], z: p[2], yaw, pit: 0, v: c.spd * 0.7, ph: 0, turn: 0, age: 0, gone: false, mode: 0, n: bots.length }; bots.push(b); return b; };
  let me = { s: CRAB, x: 0, y: -20, z: 0, yaw: 0, pit: 0, v: 0 }, meAway = false, meHP = 1, meLost = 0, meDown = 0, meKX = 0, meKZ = 0, meCause = '', meHurtT = -9, MSG = '';
  const sfx = [], fx = (k, s) => sfx.push([k, s]);
  const meSay = (t) => { MSG = t; }, meHurt = (d) => { meHP -= d; meHurtT = 0; }, meFeed = (k) => { meHP = min(1, meHP + k); };
  const meBeaten = (by) => { meHP = 0.02; meDown = 8; meCause = 'Beaten by ' + by; MSG = by; };
  const shove = (b, x, z) => { const dx = b.x - x, dz = b.z - z, d = hypot(dx, dz) || 1; return [dx / d * 1.5, dz / d * 1.5]; };
  const loseClaw = (l) => l | (l & 1 ? 2 : l & 2 ? 1 : 1), CLAWP = 0.1;
`, ctx);
vm.runInContext(src('net.js'), ctx);
vm.runInContext(`
  const P = () => ({ id: netId, on: netOn, peers: [...netPeers.entries()].map(([id, b]) => [id, b.name, b.s]), names: [...netNames], scene: bots.filter((b) => b.net).map((b) => b.id) });
  const HP = () => ({ hp: meHP, lost: meLost, down: meDown, kx: meKX, kz: meKZ, msg: MSG, cause: meCause });
  const ME = (o) => { if (o.hp !== undefined) meHP = o.hp; if (o.kx !== undefined) meKX = o.kx; if (o.kz !== undefined) meKZ = o.kz; if (o.away !== undefined) meAway = o.away; };
`, ctx);
const run = (code) => vm.runInContext(code, ctx);
const P = () => run('P()'), HP = () => run('HP()'), ME = (o) => run('ME(' + JSON.stringify(o || {}) + ')');
// a few frames of the game: net.js sends its state and ages out the silent
function frames(n) { for (let i = 0; i < n; i++) run('netFrame(0.125)'); }
async function until(fn, ms = 2500) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(25); } return false; }

const rival = remote('Rival', 0, 0.6, -20, 0, Math.PI);
await wait(150);

console.log('--- connecting and seeing the other player ---');
run('netConnect()');
ok('the player is given an id', await until(() => P().id > 0));
frames(4);
ok('the other player is seen, with its name', await until(() => P().peers.some((p) => p[0] === rival.id && p[1] === 'Rival')));
ok('and it is a creature in the scene', P().scene.includes(rival.id));

console.log('--- a strike between crabs ---');
const myId = P().id;
ME({ hp: 1, kx: 0, kz: 0 });
rival.send({ t: 'bite', to: myId });
ok('a strike from the other crab takes health', await until(() => Math.abs(HP().hp - 0.86) < 1e-9));
ok('and the player is shoved away from it', HP().kx < 0 && Math.abs(HP().kz) < 1e-9);
ok('and the blow is named', /Struck by Rival|Lost a claw to Rival/.test(HP().msg));

console.log('--- disconnecting and reconnecting ---');
const oldId = P().id;
run('netWS.close()');
ok('a closed connection clears its sea at once', await until(() => P().id === 0 && P().peers.length === 0 && P().scene.length === 0));
const old = vmSockets[vmSockets.length - 1];
ok('the server announced the player gone', await until(() => rival.json.some((m) => m.t === 'out' && m.id === oldId)));
run('netConnect()');
ok('the new connection is given a new id of its own', await until(() => P().id > 0 && P().id !== oldId));
const newId = P().id;
frames(4);
ok('the near players are back under the new connection', await until(() => P().peers.some((p) => p[0] === rival.id)));
ok('and the player is in the sea again', await until(() => rival.json.some((m) => m.t === 'in' && m.id === newId)));
// a message of the closed socket, arriving late, changes nothing
const before = P();
old.onmessage && old.onmessage({ data: JSON.stringify({ t: 'who', list: [[4242, 'Ghost']] }) });
ok('a late message of the closed connection is dropped', P().names.length === before.names.length && !P().peers.some((p) => p[0] === 4242));

// the new connection settles a fight too, under its own id (after the server's 0.4 s between bites)
await wait(450);
ME({ hp: 1, kx: 0, kz: 0 });
rival.send({ t: 'bite', to: newId });
ok('a strike on the new connection takes health', await until(() => Math.abs(HP().hp - 0.86) < 1e-9));

// clean up
rival.done();
run('netWS && netWS.close()');
await wait(200);
wss.close(); http.close();
console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
