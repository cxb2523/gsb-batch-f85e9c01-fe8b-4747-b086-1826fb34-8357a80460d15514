// A test of the game's side of the shared sea (source/src/net.js), with no browser and no GPU: the real net.js runs in
// a VM over stubs of what it shares with the rest of the page (the creatures, the bots it adds, the health and claws of
// the player's creature) and a stub WebSocket the test drives by hand.
//   node test/client.test.mjs        (or npm test in server/, with the protocol test)
// It covers the connection's lifetime - a lost or replaced socket taking its sea with it at once, the player's own id
// ignored, a late message dropped - and the rules of a fight between players, which must only land from a sender still
// among this connection's near players.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = (f) => readFileSync(fileURLToPath(new URL('../../source/src/' + f, import.meta.url)), 'utf8');
let failed = 0; const ok = (what, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failed++; };

// ---------------------------------------------------------------- the page as net.js finds it
// Every socket net.js opens, in order. The test plays the server through the last one.
const sockets = [];
class StubSocket {
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; sockets.push(this); }
  send(m) { this.sent.push(m); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose && this.onclose(); }
  open() { this.readyState = 1; this.onopen && this.onopen(); }
  hear(m) { this.onmessage && this.onmessage({ data: m }); }
  fail() { if (this.readyState === 3) return; this.readyState = 3; this.onerror && this.onerror(); this.onclose && this.onclose(); }
  json() { return this.sent.filter((m) => typeof m === 'string').map((m) => JSON.parse(m)); }
}
const ctx = vm.createContext({
  console, WebSocket: StubSocket, URLSearchParams, localStorage: {}, location: { search: '', protocol: 'https:', host: 'sea.test' },
  performance: { now: () => Date.now() }, queueMicrotask,
});
// everything net.js reads or writes of the rest of the page, in the same top-level scope as net.js will be
vm.runInContext(`
  const { sin, cos, sqrt, min, max, abs, floor, PI, pow, atan2, hypot, exp, round, ceil } = Math;
  const TAU = PI * 2, clamp = (x, a, b) => (x < a ? a : x > b ? b : x), wrapA = (a) => a - TAU * Math.round(a / TAU);
  const CRIT = ${JSON.stringify(Array.from({ length: 10 }, (_, s) => ({ id: 's' + s, real: 0.2 + s, len: 1.6 + s, spd: 1 + s * 0.5, freq: 3, turn: 1.5, high: 0.15, near: 4 })))};
  const CRAB = 0, PEERMAX = 40, F = new Float64Array(4), CX = 0, CY = 1, CZ = 2;
  const bots = [];
  const botAdd = (s, p, yaw) => { const c = CRIT[s], b = { s, x: p[0], y: p[1], z: p[2], yaw, pit: 0, v: c.spd * 0.7, ph: 0, turn: 0, age: 0, gone: false, mode: 0, n: bots.length }; bots.push(b); return b; };
  // the player's own creature, and the bits of its survival a fight touches
  let me = { s: CRAB, x: 0, y: 0, z: 0 }, meAway = false, meHP = 1, meLost = 0, meDown = 0, meKX = 0, meKZ = 0, meCause = '', meHurtT = -9, MSG = '';
  const sfx = [], fx = (k, s) => sfx.push([k, s]);
  const meSay = (t) => { MSG = t; }, meHurt = (d) => { meHP -= d; meHurtT = 0; }, meFeed = (k) => { meHP = min(1, meHP + k); };
  const meBeaten = (by) => { meHP = 0.02; meDown = 8; meCause = 'Beaten by ' + by; MSG = by; };
  const shove = (b, x, z) => { const dx = b.x - x, dz = b.z - z, d = hypot(dx, dz) || 1; return [dx / d * 1.5, dz / d * 1.5]; };
  const loseClaw = (l) => l | (l & 1 ? 2 : l & 2 ? 1 : 1), CLAWP = 0.1;
`, ctx);
vm.runInContext(src('net.js'), ctx);
// helpers inside that same scope: the state as the test sees it, a neighbor packet built here, the player's creature set
vm.runInContext(`
  const P = () => ({ id: netId, on: netOn, full: netFull, peers: [...netPeers.entries()].map(([id, b]) => [id, b.name, b.s, !!b.gone]), names: [...netNames], scene: bots.filter((b) => b.net).map((b) => b.id) });
  const PKT = (rows) => { const buf = new ArrayBuffer(4 + rows.length * 30), v = new DataView(buf); v.setUint8(0, 2); v.setUint16(2, rows.length, true); rows.forEach((r, i) => { const o = 4 + i * 30; v.setUint16(o, r[0], true); v.setUint8(o + 2, r[1]); v.setUint8(o + 3, r[2] | 0); v.setFloat32(o + 6, r[3], true); v.setFloat32(o + 10, r[4], true); v.setFloat32(o + 14, r[5], true); v.setFloat32(o + 18, r[6] || 0, true); v.setFloat32(o + 22, r[7] || 0, true); v.setFloat32(o + 26, r[8] === undefined ? 1 : r[8], true); }); return buf; };
  const ME = (o) => { if (o.s !== undefined) me.s = o.s; if (o.hp !== undefined) meHP = o.hp; if (o.down !== undefined) meDown = o.down; if (o.lost !== undefined) meLost = o.lost; if (o.kx !== undefined) meKX = o.kx; if (o.kz !== undefined) meKZ = o.kz; if (o.away !== undefined) meAway = o.away; };
  const HP = () => ({ hp: meHP, lost: meLost, down: meDown, kx: meKX, kz: meKZ, msg: MSG, cause: meCause });
`, ctx);
const run = (code) => vm.runInContext(code, ctx);
const P = () => run('P()'), PKT = (rows) => run('PKT(' + JSON.stringify(rows) + ')'), ME = (o) => run('ME(' + JSON.stringify(o || {}) + ')'), HP = () => run('HP()');
const live = () => sockets[sockets.length - 1];

// ---------------------------------------------------------------- 1. a connection and its sea
console.log('--- the sea a connection describes ---');
ME({ s: 0, hp: 1, lost: 0, down: 0, kx: 0, kz: 0 });
run('netConnect()');
const s0 = live();
s0.open();
ok('connecting reports the player to the server', s0.json().some((m) => m.t === 'hi'));
s0.hear(JSON.stringify({ t: 'hi', id: 5, tick: 100, near: 170 }));
s0.hear(JSON.stringify({ t: 'who', list: [[7, 'Tuna'], [9, 'Shark']] }));
s0.hear(JSON.stringify({ t: 'in', id: 11, name: 'Perch' }));
s0.hear(PKT([[7, 6, 0, 10, -20, 0], [9, 8, 0, 20, -20, 0], [11, 3, 0, 30, -20, 0], [5, 6, 0, 0, -20, 0]]));
let st = P();
ok('the player knows its own id', st.id === 5);
ok('the near players are creatures in the scene', st.peers.length === 3 && st.scene.length === 3);
ok('their names are kept', st.peers.every((p) => p[1] === ({ 7: 'Tuna', 9: 'Shark', 11: 'Perch' })[p[0]]));
ok('the player is not told of itself', !st.peers.some((p) => p[0] === 5));

// 2. a player that leaves: gone at once, out of the scene, its name gone
s0.hear(JSON.stringify({ t: 'out', id: 9 }));
st = P();
ok('a player that leaves is gone, and its creature with it', !st.peers.some((p) => p[0] === 9) && !st.scene.includes(9) && !st.names.includes(9));

// ---------------------------------------------------------------- 3. the connection is lost
console.log('--- a lost connection ---');
s0.fail();
st = P();
ok('a lost connection clears the near players, their names and the player\'s id', st.peers.length === 0 && st.names.length === 0 && st.id === 0 && st.on === false);
ok('and every creature it brought is out of the scene', st.scene.length === 0);
// messages of the dead socket that arrive late change nothing
s0.hear(JSON.stringify({ t: 'who', list: [[7, 'Ghost']] }));
s0.hear(PKT([[7, 6, 0, 10, -20, 0]]));
s0.hear(JSON.stringify({ t: 'bit', from: 7, s: 8, dmg: 0.5 }));
st = P();
ok('a late message of the closed connection is dropped', st.peers.length === 0 && st.names.length === 0 && st.scene.length === 0 && HP().hp === 1);

// ---------------------------------------------------------------- 4. reconnecting
console.log('--- reconnecting ---');
run('netConnect()');
const s1 = live();
s1.open();
ok('the new connection reports the player again', s1.json().some((m) => m.t === 'hi'));
s1.hear(JSON.stringify({ t: 'hi', id: 12, tick: 100, near: 170 }));
s1.hear(JSON.stringify({ t: 'who', list: [[3, 'Crab']] }));
s1.hear(JSON.stringify({ t: 'in', id: 4, name: 'Shark' }));
s1.hear(PKT([[3, 0, 0, 10, -20, 0], [4, 8, 0, 20, -20, 0], [12, 6, 0, 0, -20, 0]]));
st = P();
ok('the new connection has its own id', st.id === 12);
ok('its near players are back, with this connection\'s ids', st.peers.length === 2 && st.peers.some((p) => p[0] === 4 && p[1] === 'Shark'));
ok('the old connection\'s creatures are not back', !st.scene.includes(7) && !st.scene.includes(9) && !st.scene.includes(11));
ok('the player\'s own id in a packet is ignored', !st.peers.some((p) => p[0] === 12));

// 5. a crowd: no more than PEERMAX are added
const rows = []; for (let i = 0; i < 60; i++) rows.push([100 + i, 6, 0, i, -20, 0]);
s1.hear(PKT(rows));
ok('the near players stay within PEERMAX', P().peers.length === 40);

// 6. a socket that a successor replaced: the old one's close must not touch the new connection's sea
console.log('--- a replaced connection ---');
run('netWS.close(); netWS = null; netConnect()');
const s2 = live();
s2.open(); s2.hear(JSON.stringify({ t: 'hi', id: 20 })); s2.hear(JSON.stringify({ t: 'in', id: 4, name: 'Shark' })); s2.hear(PKT([[4, 8, 0, 20, -20, 0]]));
s1.close();
st = P();
ok('the old socket\'s close does not clear the new connection', st.on === true && st.id === 20 && st.peers.length === 1);

// ---------------------------------------------------------------- 7. a fight between players
console.log('--- a fight between players ---');
ME({ s: 0, hp: 1, lost: 1, down: 0, kx: 0, kz: 0 });
s2.hear(JSON.stringify({ t: 'in', id: 30, name: 'Rival' }));
s2.hear(PKT([[30, 0, 0, 0.6, -20, 0]]));
ok('a crab beside the player is in the scene', P().peers.some((p) => p[0] === 30));
// a strike from a crab that is there: health down, shoved away from it (the player is at the origin, the crab at x 0.6)
s2.hear(JSON.stringify({ t: 'bit', from: 30, s: 0, dmg: 0.14, blk: 0 }));
let hp = HP();
ok('a strike from a crab that is there takes health', Math.abs(hp.hp - 0.86) < 1e-9);
ok('and shoves the player away from it', Math.abs(hp.kx + 1.5) < 1e-9 && Math.abs(hp.kz) < 1e-9);
ok('the blow is not blocked', /Struck by Rival|Lost a claw to Rival/.test(hp.msg));
// a message from someone not among the near players: no health, no claw, no footing
let before = HP();
s2.hear(JSON.stringify({ t: 'bit', from: 999, s: 0, dmg: 0.5, blk: 0 }));
let after = HP();
ok('a strike from an unknown sender changes nothing', after.hp === before.hp && after.lost === before.lost && after.down === before.down && after.kx === before.kx && after.kz === before.kz);
// a sender that was there but has left: its late strike must not land either
s2.hear(JSON.stringify({ t: 'out', id: 30 }));
s2.hear(JSON.stringify({ t: 'bit', from: 30, s: 0, dmg: 0.5, blk: 0 }));
after = HP();
ok('a strike from someone who has just left changes nothing', after.hp === before.hp && after.lost === before.lost && after.kx === before.kx);
// a crab that is there but whose place is not known: no shove at the origin, no NaN
s2.hear(JSON.stringify({ t: 'in', id: 31, name: 'Rival2' }));
s2.hear(PKT([[31, 0, 0, 0.6, -20, 0]]));
run('netPeers.get(31).x = NaN; netPeers.get(31).z = NaN;');
ME({ hp: 1, lost: 1, down: 0, kx: 0.7, kz: -0.2 });
s2.hear(JSON.stringify({ t: 'bit', from: 31, s: 0, dmg: 0.1, blk: 0 }));
after = HP();
ok('a strike whose sender has no place leaves the player where it was (no NaN, no shove to the origin)', Number.isFinite(after.kx) && Number.isFinite(after.kz) && after.kx === 0.7 && after.kz === -0.2 && Math.abs(after.hp - 0.9) < 1e-9);

// a hunter's bite on a fish: only from a sender that is there
ME({ s: 1, hp: 1, lost: 0, down: 0 });
s2.hear(JSON.stringify({ t: 'in', id: 32, name: 'Sharky' })); s2.hear(PKT([[32, 8, 0, 0.5, -20, 0]]));
s2.hear(JSON.stringify({ t: 'bit', from: 33, s: 8, dmg: 0.3 }));
ok('a bite from an unknown hunter changes nothing', HP().hp === 1);
s2.hear(JSON.stringify({ t: 'bit', from: 32, s: 8, dmg: 0.3 }));
ok('a bite from a hunter that is there takes health', Math.abs(HP().hp - 0.7) < 1e-9);

// eaten and fed: only for players still in this connection's near set
ME({ s: 0, hp: 0.02, down: 8 });
s2.hear(JSON.stringify({ t: 'eaten', from: 444 }));
ok('eaten by an unknown crab changes nothing', HP().down === 8 && Math.abs(HP().hp - 0.02) < 1e-9);
ME({ s: 0, hp: 0.02, down: 8 });
s2.hear(JSON.stringify({ t: 'eaten', from: 32 }));
ok('eaten by a crab that is there ends the player', HP().hp === 0 && HP().down === 8 && /Eaten by Sharky/.test(HP().cause));
ME({ s: 0, hp: 0.4, down: 0 });
s2.hear(JSON.stringify({ t: 'fed', id: 888, gain: 0.4 }));
ok('a meal from an unknown player feeds nothing', Math.abs(HP().hp - 0.4) < 1e-9);
s2.hear(JSON.stringify({ t: 'fed', id: 32, gain: 0.4 }));
ok('a meal from a player that is there feeds the player', Math.abs(HP().hp - 0.8) < 1e-9);

// 8. the connection ends and the whole sea goes, at once
console.log('--- the connection ends ---');
s2.fail();
st = P();
ok('closing clears the sea and the scene at once', st.peers.length === 0 && st.scene.length === 0 && st.names.length === 0 && st.id === 0);
ME({ hp: 1, down: 0 });
s2.hear(JSON.stringify({ t: 'bit', from: 32, s: 8, dmg: 0.3 }));
ok('a bite arriving after the close changes nothing', HP().hp === 1);

console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
