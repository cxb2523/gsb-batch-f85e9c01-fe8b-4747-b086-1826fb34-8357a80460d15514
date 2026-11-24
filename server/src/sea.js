// The shared sea: who is in it, where each one is, and what they do to one another. Bots are not here - every
// browser keeps its own around its player - so the server knows nothing of the terrain and only relays players:
//   * each player sends its state eight times a second (28 bytes, binary);
//   * ten times a second the server sends every player one packet with the states of the players near it;
//   * a bite, a death and who has come or gone travel as small JSON messages, the bite checked here first.
// This file has no Cloudflare in it: worker.js wraps it in a Durable Object, test/local.mjs in a Node server.

// species as in the game (source/src/creatures.js): 0 crab, 1 fry, 2 chromis, 3 perch, 4 barracuda, 5 grouper, 6 tuna,
// 7 dolphin, 8 shark, 9 whale; their real lengths in metres, drawn GSCALE times life size
const REAL = [0.2, 0.06, 0.09, 0.45, 1.3, 1.8, 2.0, 2.8, 4.6, 16.5], GSCALE = 8.4 / 4.5, CRAB = 0, WHALE = 9;
const len = (s) => REAL[s] * GSCALE;
const eats = (a, b) => a !== b && a !== WHALE && REAL[b] <= REAL[a] * 0.6;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export const TICK = 100;      // ms between the packets of neighbours
export const NEAR = 170;      // metres: how far a player is told of another (the fog hides everything past 135)
export const MAXP = 100;      // players in the sea at once: one more is told the sea is full and is not let in
export const SHOWN = 40;      // of those near, a player is told of this many at most, the nearest (the game draws
                              // no more: PEERMAX in source/src/bots.js, keep the two equal)
const IDLE = 30000;           // ms without a word: the connection is dropped
// A fight of crabs (the same numbers as in the game, source/src/bots.js): what a strike takes of the other's health,
// with both claws and with one; what part of it gets through claws held up; how much a beaten crab is to eat.
// Flags of a state: 1 gurgling (a crab: claws up, blocking), 2 snapping, 4 and 8 the claws a crab has lost, 16 beaten.
// REACH: how far apart two crabs may be for a strike (0.53 m in the game, and what a crab walks while the network
// is behind). FRONT: the struck one has to be ahead of the striker, where the claws are (the cosine of how far off
// its heading; 0.64 in the game, looser here for the same reason).
const STRIKE = 0.14, STRIKE1 = 0.085, BLOCK = 0.3, MEAL = 0.45, REACH = 1, FRONT = 0.3;
const STATE = 28, ENTRY = 30; // bytes of a state as sent, and as relayed (with the sender's id)

export class Sea {
  constructor() { this.players = new Map(); this.nextId = 1; this.timer = null; }

  // a new connection (a WebSocket, or anything with send, close and addEventListener)
  join(ws) {
    if (this.players.size >= MAXP) { try { ws.send(JSON.stringify({ t: 'full' })); ws.close(1013, 'full'); } catch {} return; }
    let id = this.nextId; while (this.players.has(id)) id = id % 65000 + 1; this.nextId = id % 65000 + 1;
    const p = { id, ws, name: '', s: -1, st: null, flags: 0, talk: 0, seen: Date.now(), bit: 0, by: 0, byAt: 0, eaten: 0 };
    this.players.set(id, p);
    ws.addEventListener('message', (e) => { try { this.message(p, e.data); } catch {} });
    const gone = () => this.leave(p);
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK);
  }

  leave(p) {
    if (this.players.get(p.id) !== p) return;
    this.players.delete(p.id);
    try { p.ws.close(); } catch {}
    if (p.name) this.all({ t: 'out', id: p.id });
    if (!this.players.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  send(p, m) { try { p.ws.send(typeof m === 'string' || m instanceof ArrayBuffer || ArrayBuffer.isView(m) ? m : JSON.stringify(m)); } catch { this.leave(p); } }
  all(m, but) { const s = JSON.stringify(m); for (const p of this.players.values()) if (p !== but && p.name) this.send(p, s); }

  message(p, data) {
    p.seen = Date.now();
    if (typeof data !== 'string') return this.state(p, data);
    if (data.length > 300) return;
    const m = JSON.parse(data);
    if (m.t === 'hi') {
      // a name: what can be seen of it, at most 16 characters
      const name = String(m.name || '').replace(/[\u0000-\u001f\u007f<>&"']/g, '').trim().slice(0, 16) || 'Diver ' + p.id, first = !p.name;
      p.name = name;
      if (first) {
        this.send(p, { t: 'hi', id: p.id, tick: TICK, near: NEAR, max: MAXP, shown: SHOWN });
        this.send(p, { t: 'who', list: [...this.players.values()].filter((q) => q.name && q !== p).map((q) => [q.id, q.name]) });
      }
      this.all({ t: 'in', id: p.id, name }, p);
    } else if (m.t === 'bite') this.bite(p, this.players.get(m.to | 0));
    else if (m.t === 'ate') this.ate(p);
  }

  // a state: [1, species (255: only watching), flags, talk, x, y, z, yaw, pitch, speed]
  state(p, data) {
    const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (buf.byteLength !== STATE) return;
    const v = new DataView(buf); if (v.getUint8(0) !== 1) return;
    const s = v.getUint8(1); if (s > 9 && s !== 255) return;
    const f = new Float32Array(6); for (let i = 0; i < 6; i++) { f[i] = v.getFloat32(4 + i * 4, true); if (!Number.isFinite(f[i])) return; }
    p.s = s; p.flags = v.getUint8(2); p.talk = v.getUint8(3); p.st = f;
  }

  // a wants to bite b: only what it could eat (or crab against crab), only within reach, and not too often
  bite(a, b) {
    const now = Date.now();
    if (!b || b === a || !a.st || !b.st || a.s > 9 || b.s > 9 || now - a.bit < 400) return;
    const crabs = a.s === CRAB && b.s === CRAB; if (!crabs && !eats(a.s, b.s)) return;
    const d = Math.hypot(a.st[0] - b.st[0], a.st[1] - b.st[1], a.st[2] - b.st[2]);
    if (d > (crabs ? REACH : len(a.s) * 0.6 + len(b.s) * 0.5 + 3)) return; // (three metres for what the network is behind by)
    if (crabs) {
      // crab against crab. A beaten one, on its back, is eaten (once); otherwise a strike: none from a crab that is
      // beaten itself, has its claws up or has no claws; weaker with one claw; mostly stopped by claws held up
      const down = b.flags & 16, claws = (f) => (f & 12) !== 12;
      if (a.flags & 16 || (!down && (a.flags & 1 || !claws(a.flags)))) return;
      if (!down && d > 0.05 && (Math.cos(a.st[3]) * (b.st[0] - a.st[0]) + Math.sin(a.st[3]) * (b.st[2] - a.st[2])) / d < FRONT) return;
      a.bit = now;
      if (down) { if (now - b.eaten < 3000) return; b.eaten = now; this.send(b, { t: 'eaten', from: a.id }); this.send(a, { t: 'fed', id: b.id, gain: MEAL }); return; }
      const blk = b.flags & 1 && claws(b.flags) ? 1 : 0;
      this.send(b, { t: 'bit', from: a.id, s: a.s, dmg: +((a.flags & 12 ? STRIKE1 : STRIKE) * (blk ? BLOCK : 1)).toFixed(3), blk });
      return;
    }
    a.bit = now; b.by = a.id; b.byAt = now;
    this.send(b, { t: 'bit', from: a.id, s: a.s, dmg: +clamp(0.16 + 0.07 * len(a.s) / len(b.s), 0.2, 0.55).toFixed(3) });
  }

  // p says the last bite killed it: the one who bit is fed
  ate(p) {
    const a = this.players.get(p.by);
    if (!a || Date.now() - p.byAt > 4000 || a.s > 9 || p.s > 9) return;
    p.by = 0;
    this.send(a, { t: 'fed', id: p.id, gain: a.s === CRAB ? MEAL : +clamp(0.1 + 0.6 * len(p.s) / len(a.s), 0.1, 0.5).toFixed(3) });
  }

  // to every player: the others near it. [2, 0, count (u16)] then for each [id (u16), species, flags, talk, 0, six floats]
  tick() {
    const now = Date.now(), live = [];
    for (const p of this.players.values()) { if (now - p.seen > IDLE) { this.leave(p); continue; } if (p.name && p.st) live.push(p); }
    const buf = new ArrayBuffer(4 + SHOWN * ENTRY), v = new DataView(buf), near = [];
    for (const p of live) {
      near.length = 0;
      for (const q of live) {
        if (q === p || q.s > 9) continue;
        const dx = q.st[0] - p.st[0], dy = q.st[1] - p.st[1], dz = q.st[2] - p.st[2], d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= NEAR * NEAR) near.push([d2, q]);
      }
      // a crowd: only the nearest
      if (near.length > SHOWN) { near.sort((a, b) => a[0] - b[0]); near.length = SHOWN; }
      let n = 0;
      for (const [, q] of near) {
        const o = 4 + n++ * ENTRY;
        v.setUint16(o, q.id, true); v.setUint8(o + 2, q.s); v.setUint8(o + 3, q.flags); v.setUint8(o + 4, q.talk); v.setUint8(o + 5, 0);
        for (let i = 0; i < 6; i++) v.setFloat32(o + 6 + i * 4, q.st[i], true);
      }
      v.setUint8(0, 2); v.setUint8(1, 0); v.setUint16(2, n, true);
      this.send(p, buf.slice(0, 4 + n * ENTRY));
    }
  }

  status() { return { players: [...this.players.values()].filter((p) => p.name).length, max: MAXP }; }
}
