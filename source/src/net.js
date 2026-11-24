// Multiplayer: the client's side of the shared sea (the server is in ../../server, its protocol in server/src/sea.js).
// Only players are shared - every browser keeps its own bots. Another player is one more entry in `bots` (net: true)
// that is moved by what the server relays instead of by a bot's mind, so it is drawn, shown on the sonar, heard
// gurgling, counted against the population and can be bitten like anything else there.
// The server is where the page came from (wss://<host>/ws), or what ?server=... or localStorage.abyssalServer names;
// a page opened from a file has none and plays alone.
// A connection is a lifetime: everything the sea holds - the players near, their names, the player's own id - belongs
// to the socket that told it. A socket that closes, fails or is replaced takes all of it with it, at once, so that
// nothing it said late can move a new connection's sea, and the creatures it brought are gone from the scene.
let netFull = false, netWS = null, netOn = false, netId = 0, netTries = 0, netNext = 0, netSendT = 0, netEver = false;
const netPeers = new Map(), netNames = new Map();
let netName = ''; try { netName = localStorage.abyssalName || ''; } catch {}
function netURL() {
  let u = null; try { u = new URLSearchParams(location.search).get('server') || localStorage.abyssalServer; } catch {}
  if (u) return /^wss?:\/\//.test(u) ? u : (/^https?:\/\//.test(u) ? u.replace(/^http/, 'ws') : 'wss://' + u).replace(/\/+$/, '') + '/ws';
  return /^https?:$/.test(location.protocol) ? location.protocol.replace('http', 'ws') + '//' + location.host + '/ws' : null;
}
const netSend = (m) => { if (netOn && netWS) try { netWS.send(typeof m === 'string' || m instanceof ArrayBuffer ? m : JSON.stringify(m)); } catch {} };
const netWho = (id) => netNames.get(id) || 'a diver';
// a player that is no longer there: gone at once, and out of the creatures drawn around this frame - not merely at the
// next repopulation - so its body, its name and its fight state stop at the moment it left
function netDrop(id) {
  const b = netPeers.get(id); if (!b) return;
  b.gone = true; netPeers.delete(id);
  // take it out of the scene now, keeping every remaining creature's place in the array (b.n, which the minds use)
  const i = bots.indexOf(b); if (i >= 0) { const last = bots[bots.length - 1]; bots[i] = last; bots.pop(); if (last !== b) last.n = i; }
}
// the connection is over (closed, failed, or was replaced): the sea it described goes with it. Peers, names and the
// player's own id are cleared, and no late message of that socket may bring any of them back (see netConnect).
function netClear() {
  for (const id of [...netPeers.keys()]) netDrop(id);
  netNames.clear(); netId = 0; netOn = false; netSendT = 0;
}
function netConnect() {
  const url = netURL(); if (netWS || !url) return;
  // a new socket starts from an empty sea: nothing an earlier connection left behind may show through it
  netClear();
  let ws; try { ws = new WebSocket(url); } catch { return; }
  netWS = ws; ws.binaryType = 'arraybuffer';
  // Every callback checks that it still belongs to the socket that is current: an old socket's late open, message,
  // close or error must not touch the sea its successor is building.
  ws.onopen = () => {
    if (netWS !== ws) return;
    netOn = netEver = true; netTries = 0;
    netSend({ t: 'hi', name: netName }); // (again on every connection: the server keeps no memory of the old one)
  };
  ws.onclose = ws.onerror = () => {
    if (netWS !== ws) return;
    netWS = null; netClear();
    // again later, each time after longer; a host that never answered (a page not served by the game's server) is left alone
    netTries++; netNext = netEver || netTries < 3 ? performance.now() + min(30000, 2000 * 2 ** netTries) : Infinity;
  };
  ws.onmessage = (e) => {
    if (netWS !== ws || !netOn) return; // (a message that outlived its connection: dropped with the rest of it)
    try { if (typeof e.data === 'string') netHear(JSON.parse(e.data)); else netPacket(e.data); } catch (err) { console.error(err); }
  };
}
// the small messages: who is in, who bit whom
function netHear(m) {
  if (!m || typeof m !== 'object') return;
  const t = m.t;
  if (t === 'hi') {
    const id = m.id | 0;
    // (a neighbour heard of before the answer cannot be the player itself: the id is the connection's own)
    if (id > 0) { netId = id; netNames.delete(id); netDrop(id); }
    if (netFull) meSay('A place has come free · in the shared sea'); netFull = false;
  } else if (t === 'who') {
    // the whole list as it is on this connection: it replaces whatever an older one left behind, and never the player itself
    netNames.clear();
    if (Array.isArray(m.list)) for (const e of m.list) {
      const id = Array.isArray(e) ? e[0] | 0 : 0; if (!id || id === netId) continue;
      netNames.set(id, String(e[1] == null ? '' : e[1]));
    }
    for (const [id, b] of netPeers) b.name = netNames.get(id) || '';
  } else if (t === 'in') {
    const id = m.id | 0; if (!id || id === netId) return;
    const name = String(m.name == null ? '' : m.name);
    netNames.set(id, name); const b = netPeers.get(id); if (b) b.name = name;
  } else if (t === 'out') {
    const id = m.id | 0; if (!id || id === netId) return;
    netNames.delete(id); netDrop(id);
  }
  // (the connection is closed and tried again every few seconds: said once, and again when a place has come free)
  else if (t === 'full') { if (!netFull) meSay('The sea is full · playing alone'); netFull = true; }
  else if (t === 'bit') netBit(m);
  else if (t === 'eaten') netEaten(m);
  else if (t === 'fed') netFed(m);
}
// bitten by another player (the server has checked that it could): as a hunter's bite. A crab's strike (see the
// fight of crabs, bots.js) shoves, may cost a claw unless it was blocked (m.blk), and at nothing leaves the crab
// on its back for the other to eat; any other bite at nothing is the end, and feeds the biter.
// Only a sender that is in this connection's near players is heeded: a late message from someone already gone must not
// take health, a claw or the crab's footing.
function netBit(m) {
  if (!me || meAway) return;
  const a = netPeers.get(m.from | 0); if (!a) return;
  const s = m.s | 0, dmg = +m.dmg;
  if (s < 0 || s >= CRIT.length || !(dmg > 0) || !Number.isFinite(dmg)) return;
  const crab = s === CRAB && me.s === CRAB, who = netWho(a.id), down = meDown > 0;
  fx('bite', s); meHurt(dmg, s);
  meCause = (crab ? 'Beaten by ' : 'Eaten by ') + who; meSay((crab ? m.blk ? 'Blocked ' : 'Struck by ' : 'Bitten by ') + who);
  if (crab && !down) {
    // the shove points away from the striker, and only where the striker's place is known (never at the origin)
    if (Number.isFinite(a.x) && Number.isFinite(a.z)) [meKX, meKZ] = shove(me, a.x, a.z);
    if (!m.blk && Math.random() < CLAWP && meLost !== 3) { meLost = loseClaw(meLost); meSay('Lost a claw to ' + who); }
    if (meHP <= 0) meBeaten(who);
  } else if (meHP <= 0) netSend({ t: 'ate' });
}
// beaten and on its back, and the other crab has eaten it; only a crab still near this connection can do that
function netEaten(m) {
  if (!me || meAway || !(meDown > 0)) return;
  const from = m.from | 0; if (!netPeers.has(from)) return;
  meHP = 0; meHurtT = 0; meCause = 'Eaten by ' + netWho(from); fx('hurt');
}
// fed by a bite that killed: the eaten player must still be one of this connection's near players
function netFed(m) {
  if (!me) return;
  const id = m.id | 0, gain = +m.gain;
  if (!id || !netPeers.has(id) || !(gain > 0) || !Number.isFinite(gain)) return;
  meFeed(gain); meSay('Ate ' + netWho(id)); fx('eat');
}
// the players near, ten times a second: [2, 0, count] then for each [id, species, flags, talk, 0, x, y, z, yaw, pitch, speed]
function netPacket(buf) {
  if (!buf || buf.byteLength < 4) return;
  const v = new DataView(buf); if (v.getUint8(0) !== 2) return;
  const n = v.getUint16(2, true), now = performance.now();
  if (v.byteLength < 4 + n * 30) return; // (a packet cut short: none of it is taken)
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 30, id = v.getUint16(o, true), s = v.getUint8(o + 2), fl = v.getUint8(o + 3), x = v.getFloat32(o + 6, true), y = v.getFloat32(o + 10, true), z = v.getFloat32(o + 14, true), yaw = v.getFloat32(o + 18, true), pit = v.getFloat32(o + 22, true), spd = v.getFloat32(o + 26, true);
    if (s >= CRIT.length || !id || id === netId) continue; // (the player's own id: the server may tell it of itself)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(yaw) || !Number.isFinite(pit) || !Number.isFinite(spd)) continue;
    let b = netPeers.get(id);
    if (!b || b.s !== s) { netDrop(id); if (netPeers.size >= PEERMAX) continue; b = botAdd(s, [x, y, z], yaw); b.net = true; b.id = id; b.name = netNames.get(id) || ''; b.pf = fl; netPeers.set(id, b); }
    b.nx = x; b.ny = y; b.nz = z; b.nyaw = yaw; b.npit = pit; b.v = spd; b.stamp = now;
    // flags: 1 gurgling (a crab: claws up, blocking), 2 its mouth or claws have just snapped, 4 and 8 the claws a crab
    // has lost, 16 a beaten crab on its back
    b.gur = (fl & 1) > 0; if (fl & 2 && !(b.pf & 2)) b.snap = 0.28; b.lost = fl >> 2 & 3; b.dead = fl & 16 ? 1 : 0; b.pf = fl;
  }
}
// a remote player between two packets: eased to where it was last said to be
function netMove(b, dt) {
  const c = CRIT[b.s], k = min(1, dt * 12);
  b.x += (b.nx - b.x) * k; b.y += (b.ny - b.y) * k; b.z += (b.nz - b.z) * k; b.yaw += wrapA(b.nyaw - b.yaw) * k; b.pit += (b.npit - b.pit) * k;
  b.ph += dt * c.freq * clamp(abs(b.v) / c.spd, 0.15, 2.5); b.turn = 0; b.mode = 0;
}
// every frame: the own state out eight times a second (who only watches says where its camera is, to be told who is
// near), the silent dropped, a lost connection tried again
function netFrame(dt) {
  const now = performance.now();
  if (!netWS) { if (netEver || netTries) { if (now > netNext) netConnect(); } return; }
  if (!netOn) return;
  for (const [id, b] of netPeers) if (now - b.stamp > 1500) netDrop(id);
  if ((netSendT += dt) < 0.125) return;
  netSendT = 0;
  const buf = new ArrayBuffer(28), v = new DataView(buf), b = me, away = !b || meAway;
  v.setUint8(0, 1); v.setUint8(1, away ? 255 : b.s); v.setUint8(2, away ? 0 : (b.gur ? 1 : 0) | (b.snap > 0 ? 2 : 0) | meLost << 2 | (meDown > 0 ? 16 : 0)); v.setUint8(3, 0);
  [b ? b.x : F[CX], b ? b.y : F[CY], b ? b.z : F[CZ], b ? b.yaw : 0, b && b.s !== CRAB ? b.pit : 0, b ? b.v : 0].forEach((f, i) => v.setFloat32(4 + i * 4, f, true));
  netSend(buf);
}
