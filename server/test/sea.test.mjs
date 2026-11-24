// A test of the sea with three players over real WebSockets (npm test). It starts test/local.mjs on a spare port.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
// SEA_PORT=8080 npm test: against a server that is already running there (the OpenResty one, see ../openresty)
// SEA_URL=https://sea.example.workers.dev npm test: against a server anywhere (a deployed Worker)
const url = (process.env.SEA_URL || '').replace(/\/+$/, ''), ext = +process.env.SEA_PORT, port = ext || 8799, base = url || 'http://localhost:' + port, srv = ext || url ? { kill() {} } : spawn(process.execPath, [fileURLToPath(new URL('./local.mjs', import.meta.url))], { env: { ...process.env, PORT: port }, stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0; const ok = (what, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + what); if (!cond) failed++; };
function player(name, s, x, y, z) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws'); ws.binaryType = 'arraybuffer';
  const p = { ws, json: [], near: new Map(), s, x, y, z, yaw: 0 };
  ws.on('message', (d, bin) => {
    if (!bin) { p.json.push(JSON.parse(d.toString())); return; }
    const v = new DataView(d), n = v.getUint16(2, true); p.near = new Map();
    for (let i = 0; i < n; i++) { const o = 4 + i * 30; p.near.set(v.getUint16(o, true), { s: v.getUint8(o + 2), flags: v.getUint8(o + 3), x: v.getFloat32(o + 6, true) }); }
  });
  p.state = (flags = 0) => { const b = new ArrayBuffer(28), v = new DataView(b); v.setUint8(0, 1); v.setUint8(1, p.s); v.setUint8(2, flags); [p.x, p.y, p.z, p.yaw, 0, 1].forEach((f, i) => v.setFloat32(4 + i * 4, f, true)); ws.send(b); };
  p.say = (m) => ws.send(JSON.stringify(m));
  p.got = (t) => p.json.filter((m) => m.t === t);
  ws.on('open', () => { p.say({ t: 'hi', name }); p.state(); });
  return p;
}
try {
  await wait(700);
  const a = player('Shark <b>', 8, 0, -20, 0); await wait(200);
  const b = player('Tuna', 6, 5, -20, 0), c = player('', 1, 1000, -20, 0); await wait(500);
  const ida = a.got('hi')[0].id, idb = b.got('hi')[0].id, idc = c.got('hi')[0].id;
  ok('each gets an id', ida && idb && idc && new Set([ida, idb, idc]).size === 3);
  ok('the later ones are told who is in, with the name cleaned', b.got('who')[0].list.some((e) => e[0] === ida && e[1] === 'Shark b'));
  ok('the earlier one hears of the arrivals', a.got('in').some((m) => m.id === idb && m.name === 'Tuna') && a.got('in').some((m) => m.id === idc && m.name.startsWith('Diver')));
  ok('near players are relayed, far ones are not', a.near.has(idb) && !a.near.has(idc) && b.near.has(ida) && c.near.size === 0 && b.near.get(ida).s === 8);
  b.state(1); await wait(250); ok('flags travel (gurgling)', a.near.get(idb).flags === 1);
  b.say({ t: 'bite', to: ida }); c.say({ t: 'bite', to: idb }); await wait(200);
  ok('a tuna cannot bite a shark, nor a fry from a kilometre away', a.got('bit').length === 0 && b.got('bit').length === 0);
  a.say({ t: 'bite', to: idb }); a.say({ t: 'bite', to: idb }); await wait(200);
  ok('a shark bites the tuna beside it, once per 0.4 s', b.got('bit').length === 1 && b.got('bit')[0].from === ida && b.got('bit')[0].dmg > 0.2);
  b.say({ t: 'ate' }); await wait(200);
  ok('the eaten one feeds the biter', a.got('fed').length === 1 && a.got('fed')[0].gain > 0.1);
  b.say({ t: 'ate' }); await wait(200); ok('but only once', a.got('fed').length === 1);
  const st = await (await fetch(base + '/status')).json(); ok('status counts three', st.players === 3);
  b.ws.close(); await wait(300);
  ok('leaving is announced and the player is gone from the packets', a.got('out').some((m) => m.id === idb) && !a.near.has(idb));
  a.ws.close(); c.ws.close();
  // a fight of crabs: flags 1 claws up (blocking), 4 and 8 claws lost, 16 beaten and on its back
  const k1 = player('Crab one', 0, 3000, -20, 0), k2 = player('Crab two', 0, 3000.6, -20, 0); await wait(500);
  const id1 = k1.got('hi')[0].id, id2 = k2.got('hi')[0].id, strike = async (p, to, flags) => { if (flags !== undefined) { p.state(flags); await wait(150); } p.say({ t: 'bite', to }); await wait(450); };
  await strike(k1, id2); ok('a crab strikes a crab for 0.14', k2.got('bit').length === 1 && k2.got('bit')[0].dmg === 0.14 && !k2.got('bit')[0].blk);
  await strike(k1, id2, 4); ok('with one claw for 0.085', k2.got('bit').length === 2 && k2.got('bit')[1].dmg === 0.085);
  await strike(k1, id2, 12); ok('with no claws not at all', k2.got('bit').length === 2);
  await strike(k1, id2, 1); ok('nor with its claws up', k2.got('bit').length === 2);
  k2.state(1); await wait(150); await strike(k1, id2, 0); ok('claws held up block most of a strike', k2.got('bit').length === 3 && k2.got('bit')[2].dmg === 0.042 && k2.got('bit')[2].blk === 1);
  k2.state(13); await wait(150); await strike(k1, id2); ok('but not without claws', k2.got('bit').length === 4 && k2.got('bit')[3].dmg === 0.14 && !k2.got('bit')[3].blk);
  k2.state(16); await wait(150); await strike(k1, id2); ok('a beaten crab is eaten, and the eater fed', k2.got('eaten').length === 1 && k2.got('eaten')[0].from === id1 && k1.got('fed').length === 1 && k1.got('fed')[0].gain === 0.45 && k2.got('bit').length === 4);
  await strike(k1, id2); ok('once', k2.got('eaten').length === 1 && k1.got('fed').length === 1);
  await strike(k2, id1); ok('and a beaten crab does not strike', k1.got('bit').length === 0);
  k1.yaw = Math.PI; k2.state(0); await wait(150); await strike(k1, id2, 0); ok('a crab with its back to the other does not strike', k2.got('bit').length === 4); k1.yaw = 0;
  k1.x = 2998.6; k1.state(0); k2.state(0); await wait(200); await strike(k1, id2); ok('a crab two metres away does not reach', k2.got('bit').length === 4);
  k1.ws.close(); k2.ws.close();
  // a crowd in one place: each is told of the 40 nearest only; the sea takes 100 and turns the next away
  const crowd = []; for (let i = 0; i < 100; i++) crowd.push(player('C' + i, 6, 5000 + i, -20, 0));
  await wait(1500);
  ok('of a crowd only the nearest 40 are relayed', crowd[0].near.size === 40 && crowd[50].near.size === 40 && [...crowd[0].near.values()].every((q) => q.x <= 5040.5));
  const late = player('Late', 6, 0, -20, 0); await wait(500);
  ok('the sea is full at 100', late.got('full').length === 1 && late.got('hi').length === 0);
  for (const p of crowd) p.ws.close();
} finally { srv.kill(); }
console.log(failed ? failed + ' failed' : 'all passed'); process.exit(failed ? 1 : 0);
