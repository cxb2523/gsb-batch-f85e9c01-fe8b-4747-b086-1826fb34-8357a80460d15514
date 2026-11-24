// 소리: 효과음과 배경음을 Web Audio로 직접 합성한다 (음원 파일 없음 → 저작권 걱정 없음)
'use strict';

const Sound = (() => {
  let ac = null, master, sfxBus, bgmBus, loopBus = null, musicGain, duck;
  let unlocked = false, want = null, theme = null, timer = 0, step = 0, nextT = 0;
  // 배경음 상태 사슬: want(무엇을 틀어야 하는가) → resolve(어떤 음원인가) → stage(지금 나는 소리)
  // stage 는 'none' | 'synth'(합성 루프) | 'file'(파일 플레이어) 중 하나만 된다.
  let stage = 'none', reqSeq = 0, pending = false, bgmEnabled = null;
  const loopNodes = new Set();   // 합성 루프가 예약한 소리들 (끌 때 함께 멈춘다)
  const lastPlay = {};
  const set = () => (typeof Game !== 'undefined' && Game.save && Game.save.settings) || {};
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  function ctx() {
    if (!ac) {
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
      master = ac.createGain(); master.connect(ac.destination);
      sfxBus = ac.createGain(); sfxBus.connect(master);
      duck = ac.createGain(); duck.connect(master);   // 짧은 곡(팡파르)이 나오는 동안 배경음을 줄인다
      bgmBus = ac.createGain(); bgmBus.connect(duck);
      loopBus = ac.createGain(); loopBus.gain.value = 1; loopBus.connect(bgmBus);   // 합성 루프 전용 (끌 때 한 번에 0으로)
      musicGain = ac.createGain(); musicGain.connect(duck);
      // 지금 설정을 '이미 반영된 상태'로 먼저 맞춘다 — refresh()가 만들자마자 request()를 다시 걸지 않게
      bgmEnabled = set().bgm !== false;
      refresh();
    }
    if (ac.state === 'suspended' && !document.hidden) ac.resume();
    return ac;
  }
  // 다른 앱이나 홈 화면으로 가서 창이 가려지면 소리를 멈추고, 돌아오면 다시 튼다 (휴대폰 브라우저)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (ac && ac.state === 'running') ac.suspend().catch(() => {});
      if (stage === 'file' && player && player.el && !player.el.paused) player.el.pause();
    } else {
      if (ac && ac.state === 'suspended') ac.resume().catch(() => {});
      if (stage === 'file' && player && player.el && player.el.paused && unlocked && bgmOn()) player.el.play().catch(() => {});
      else if (unlocked && want && stage === 'none' && !pending) request(want);   // 합성 루프가 비어 있으면 되살린다
    }
  });
  // 설정의 켜기/끄기와 음량을 반영 (음원을 새로 만들지 않고, 지금 나는 소리의 음량만 맞춘다)
  function refresh() {
    const s = set();
    const on = s.bgm !== false;
    const mv = on ? (s.bgmVol ?? 40) / 100 * 0.8 * trackVol(fileKey) : 0;
    if (musicGain) musicGain.gain.value = mv;
    if (stage === 'file' && player && player.el) { player.el.volume = Math.min(1, mv); if (!on) player.el.pause(); else if (unlocked && player.el.paused && !document.hidden) player.el.play().catch(() => {}); }
    if (ac) {
      sfxBus.gain.value = s.sfx === false ? 0 : (s.sfxVol ?? 60) / 100 * 0.5;
      bgmBus.gain.value = on ? (s.bgmVol ?? 40) / 100 * 0.22 : 0;
    }
    // 켜짐 → 꺼짐: 두 음원 모두 즉시 정지·해제. 꺼짐 → 켜짐: 지금 장소의 곡을 다시 푼다.
    // (음량만 바뀐 경우에는 여기서 아무것도 하지 않는다)
    if (on !== bgmEnabled) {
      bgmEnabled = on;
      if (!on) { previewing = false; silence(); }   // 미리 듣기도 함께 끝낸다
      else if (unlocked && want) request(want);     // 다시 켜면 현재 장소의 곡으로 복귀
    }
  }
  // 지금 배경음이 나야 하는 상태인지 (설정을 껐으면 refresh()가 bgmEnabled 를 false 로 바꾼다)
  const bgmOn = () => (bgmEnabled === null ? set().bgm !== false : bgmEnabled);

  // ── 합성 도구 ──
  // 합성 루프가 예약한 소리를 담는다. 그 소리가 끝나면(onended) 딸린 노드들을 함께 버퍼에서 지운다.
  // loopNodes 는 배경음을 끌 때 "지금 살아 있는 합성 소리"를 한 번에 멈추는 목록이다.
  function trackLoop(src, nodes) {
    if (!src) return;
    for (const n of nodes) loopNodes.add(n);
    src.onended = () => { for (const n of nodes) loopNodes.delete(n); };
  }
  function tone(freq, dur, o = {}) {
    const t = ac.currentTime + (o.at || 0);
    const osc = ac.createOscillator(), g = ac.createGain();
    osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(freq, t);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * o.slide), t + dur);
    const v = o.vol ?? 0.3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + Math.min(0.01, dur / 4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(o.dest || sfxBus);
    osc.start(t); osc.stop(t + dur + 0.02);
    if (o.loop) trackLoop(osc, [osc, g]);
  }
  let noiseBuf = null;
  function noise(dur, o = {}) {
    if (!noiseBuf) {
      noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let x = 12345;   // Math.random을 쓰지 않는다 (오늘의 도전 난수를 흐트러뜨리지 않게)
      for (let i = 0; i < d.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; d[i] = x / 2147483648 - 1; }
    }
    const t = ac.currentTime + (o.at || 0);
    const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = noiseBuf;
    f.type = o.filter || 'lowpass'; f.frequency.setValueAtTime(o.freq || 2000, t);
    if (o.sweep) f.frequency.exponentialRampToValueAtTime(o.sweep, t + dur);
    g.gain.setValueAtTime(o.vol ?? 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(o.dest || sfxBus);
    src.start(t); src.stop(t + dur + 0.02);
    if (o.loop) trackLoop(src, [src, f, g]);
  }
  const arp = (notes, gap, o = {}) => notes.forEach((m, i) => tone(mtof(m), o.len || gap * 1.4, { ...o, at: (o.at || 0) + i * gap }));

  const SFX = {
    hit()   { noise(0.09, { freq: 1800, vol: 0.35 }); tone(180, 0.08, { type: 'square', slide: 0.5, vol: 0.18 }); },
    weak()  { noise(0.07, { freq: 900, vol: 0.25 }); },
    super() { noise(0.14, { freq: 3000, vol: 0.4 }); tone(320, 0.14, { type: 'sawtooth', slide: 0.4, vol: 0.2 }); tone(640, 0.08, { vol: 0.12, at: 0.03 }); },
    crit()  { noise(0.16, { freq: 4000, vol: 0.4 }); tone(900, 0.1, { type: 'square', slide: 0.6, vol: 0.18 }); tone(1200, 0.12, { vol: 0.15, at: 0.06 }); },
    hurt()  { noise(0.12, { freq: 1200, vol: 0.35 }); tone(140, 0.14, { type: 'sawtooth', slide: 0.6, vol: 0.2 }); },
    miss()  { noise(0.15, { filter: 'highpass', freq: 3000, sweep: 800, vol: 0.12 }); },
    faint() { tone(440, 0.35, { type: 'triangle', slide: 0.25, vol: 0.25 }); },
    down()  { arp([67, 63, 60, 55], 0.16, { type: 'triangle', vol: 0.25, len: 0.3 }); },
    levelup() { arp([72, 76, 79, 84], 0.07, { type: 'square', vol: 0.14 }); tone(mtof(84), 0.35, { type: 'triangle', vol: 0.2, at: 0.28 }); },
    stairs() { arp([79, 76, 72, 67, 64], 0.06, { type: 'triangle', vol: 0.2 }); },
    pickup() { arp([84, 91], 0.05, { type: 'square', vol: 0.1 }); },
    money()  { tone(mtof(88), 0.06, { type: 'square', vol: 0.1 }); tone(mtof(95), 0.2, { type: 'square', vol: 0.1, at: 0.06 }); },
    heal()   { arp([72, 76, 79, 83, 88], 0.045, { type: 'sine', vol: 0.2 }); },
    item()   { tone(mtof(76), 0.08, { type: 'triangle', vol: 0.18 }); tone(mtof(81), 0.12, { type: 'triangle', vol: 0.18, at: 0.07 }); },
    up()     { tone(400, 0.18, { type: 'triangle', slide: 2, vol: 0.15 }); },
    down2()  { tone(500, 0.18, { type: 'triangle', slide: 0.5, vol: 0.15 }); },
    status() { tone(300, 0.08, { type: 'square', vol: 0.1 }); tone(250, 0.1, { type: 'square', vol: 0.1, at: 0.09 }); },
    trap()   { tone(220, 0.25, { type: 'sawtooth', slide: 0.5, vol: 0.18 }); noise(0.2, { freq: 900, vol: 0.2, at: 0.05 }); },
    shiny()  { arp([88, 91, 96, 100], 0.05, { type: 'sine', vol: 0.15 }); arp([96, 100], 0.08, { type: 'sine', vol: 0.1, at: 0.25 }); },
    boss()   { arp([45, 46, 45, 46], 0.12, { type: 'sawtooth', vol: 0.18, len: 0.12 }); tone(mtof(33), 0.6, { type: 'square', vol: 0.18, at: 0.5 }); },
    achieve() { arp([67, 72, 76, 79], 0.08, { type: 'square', vol: 0.13 }); arp([76, 79, 84], 0.0, { type: 'triangle', vol: 0.13, len: 0.5, at: 0.34 }); },
    menu()   { tone(mtof(84), 0.04, { type: 'square', vol: 0.06 }); },
    mission() { arp([76, 81, 85, 88], 0.07, { type: 'triangle', vol: 0.2 }); tone(mtof(93), 0.4, { type: 'sine', vol: 0.14, at: 0.3 }); },
    clear()  { arp([72, 72, 72, 76, 79, 84], 0.1, { type: 'square', vol: 0.13 }); tone(mtof(84), 0.6, { type: 'triangle', vol: 0.2, at: 0.6 }); },
    wind()   { noise(1.2, { filter: 'bandpass', freq: 400, sweep: 1500, vol: 0.3 }); },
  };

  // at: performance.now() 기준 시각 (던전 연출 타이밍에 맞춰 나중에 울림)
  function play(name, at) {
    if (set().sfx === false || !SFX[name]) return;
    const d = at ? at - performance.now() : 0;
    if (d > 20) { setTimeout(() => play(name), d); return; }
    if (!unlocked || !ctx()) return;
    const t = performance.now();
    if (t - (lastPlay[name] || 0) < 45) return;   // 같은 소리가 한꺼번에 겹치지 않게
    lastPlay[name] = t;
    SFX[name]();
  }

  // ── 배경음: 키(장소)마다 정해진 무작위 멜로디를 만들어 반복한다 ──
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { let a = seed || 1; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], lydian: [0, 2, 4, 6, 7, 9, 11], phryg: [0, 1, 3, 5, 7, 8, 10] };
  const PROGS = [[0, 5, 3, 4], [0, 3, 4, 0], [0, 4, 5, 3], [5, 3, 0, 4], [0, 3, 0, 4], [0, 6, 5, 4]];

  function makeTheme(key, o = {}) {
    const r = rng(hash(key));
    const scale = SCALES[o.mode || 'major'];
    const root = o.root ?? 50 + Math.floor(r() * 8);
    const prog = o.prog || PROGS[Math.floor(r() * PROGS.length)];
    const deg = (d, oct = 0) => root + scale[((d % 7) + 7) % 7] + 12 * (Math.floor(d / 7) + oct);
    // 멜로디: 음계 위를 걸어다니는 64칸 (4마디)
    const mel = [];
    let cur = 7 + Math.floor(r() * 3);
    for (let i = 0; i < 64; i++) {
      const strong = i % 4 === 0, bar = Math.floor(i / 16);
      if (!strong && r() < (o.sparse ?? 0.55)) { mel.push(null); continue; }
      if (strong && r() < 0.5) cur = prog[bar] + 7 + [0, 2, 4][Math.floor(r() * 3)];   // 박자 첫머리는 화음 음으로
      else cur += [-2, -1, -1, 1, 1, 2, 0][Math.floor(r() * 7)];
      cur = clamp(cur, 4, 14);
      mel.push(i % 16 === 15 ? null : deg(cur, 1));
    }
    return { key, bpm: o.bpm || 92 + Math.floor(r() * 30), prog, deg, mel, wave: o.wave || 'square', bass: o.bass || 'triangle', drums: o.drums ?? true };
  }

  function scheduleStep(th, i, t) {
    const bar = Math.floor(i / 16) % 4, beat = i % 16, ch = th.prog[bar];
    const len = 60 / th.bpm / 4;
    const at = t - ac.currentTime;
    const out = { dest: loopBus, loop: true };
    // 베이스
    if (beat % 4 === 0) tone(mtof(th.deg(ch, -1)), len * (beat % 8 === 0 ? 3.5 : 1.8), { ...out, type: th.bass, vol: 0.5, at });
    // 화음 아르페지오 (작게)
    if (beat % 2 === 0) tone(mtof(th.deg(ch + [0, 2, 4, 2][(beat / 2) % 4])), len * 1.6, { ...out, type: 'triangle', vol: 0.13, at });
    // 멜로디
    const m = th.mel[i % 64];
    if (m) tone(mtof(m), len * 1.8, { ...out, type: th.wave, vol: 0.14, at });
    // 리듬
    if (th.drums) {
      if (beat % 8 === 4) noise(0.07, { ...out, freq: 1500, vol: 0.18, at });
      if (beat % 2 === 0) noise(0.02, { ...out, filter: 'highpass', freq: 7000, vol: 0.05, at });
    }
  }
  function tick() {
    if (!theme || !ac) return;
    while (nextT < ac.currentTime + 0.2) {
      scheduleStep(theme, step, nextT);
      nextT += 60 / theme.bpm / 4; step = (step + 1) % 64;
    }
  }
  // 합성 루프가 예약해 둔 소리를 모두 멈추고 버퍼에서 떼어 낸다
  function killLoopNodes() {
    if (!loopNodes.size) return;
    for (const n of [...loopNodes]) {
      try { if (n.stop) n.stop(); } catch (e) { /* 이미 멈춤 */ }
      try { n.disconnect(); } catch (e) { /* 이미 끊김 */ }
    }
    loopNodes.clear();
  }
  function startLoop(th) {
    if (!ctx()) return;
    if (!th) return;
    theme = th; step = 0;
    nextT = ac.currentTime + 0.1;
    if (loopBus) loopBus.gain.value = 1;
    clearInterval(timer); timer = setInterval(tick, 40);
  }
  function stopLoop() {
    clearInterval(timer); timer = 0;
    theme = null; step = 0; nextT = 0;
    killLoopNodes();
  }

  // ── 음악 파일: music/ 폴더의 파일이나 정보 탭에서 불러온 파일이 있으면 합성 배경음 대신 그 파일을 반복 재생 ──
  // 파일 이름: town, boss, dungeon(던전 공통), 던전 ID (예: music/forest.ogg). 확장자 ogg / mp3 / m4a / wav
  const EXTS = ['mp3', 'ogg', 'm4a', 'wav'];
  const found = {};          // 파일 키 → URL 또는 null (한 번 찾으면 기억)
  let uploadedKeys = new Set();
  let fileUrl = null, fileKey = null, player = null, previewing = false;
  // 불러온 파일은 용량이 커서 IndexedDB에 저장한다
  const IDB = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise(res => {
        try {
          const r = indexedDB.open('pmdweb_music', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('music');
          r.onsuccess = () => { this.db = r.result; res(this.db); };
          r.onerror = () => res(null);
        } catch (e) { res(null); }
      });
    },
    async op(mode, fn) {
      const db = await this.open(); if (!db) return null;
      return new Promise(res => { try { const tx = db.transaction('music', mode), st = tx.objectStore('music'), r = fn(st); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch (e) { res(null); } });
    },
    get(k) { return this.op('readonly', st => st.get(k)); },
    put(k, v) { return this.op('readwrite', st => st.put(v, k)); },
    del(k) { return this.op('readwrite', st => st.delete(k)); },
    keys() { return this.op('readonly', st => st.getAllKeys()); },
  };
  // 업로드 목록은 비동기로 읽는다. 그 전에 "파일 없음"으로 기억해 둔 키가 있으면, 목록이 도착한 뒤 지운다
  // (업로드한 곡이 합성 배경음으로 나던 문제 방지). 지금 그 키로 소리가 나고 있으면 다시 푼다.
  IDB.keys().then(k => {
    uploadedKeys = new Set(k || []);
    for (const key of Object.keys(found)) {
      if (!uploadedKeys.has(key) || found[key]) continue;
      delete found[key];   // 목록을 읽기 전에 "없음"으로 기억했던 업로드 곡
      const w = want; if (w && !previewing && candidates(w).includes(key)) request(w);
    }
  });
  // 소리가 날 수 있는 파일인지 확인
  function tryAudio(src) {
    return new Promise(res => {
      const a = new Audio(); let done = false;
      const end = ok => { if (done) return; done = true; a.removeAttribute('src'); res(ok); };
      a.preload = 'metadata';
      a.oncanplay = a.onloadedmetadata = () => end(true);
      a.onerror = () => end(false);
      setTimeout(() => end(false), 4000);
      a.src = src;
    });
  }
  // ── 루프 구간: 정보 탭 설정 > music/loops.js > 파일 안의 루프 정보(OGG LOOPSTART 태그, WAV smpl) 순으로 쓴다 ──
  const LOOP_KEY = 'pmdweb_loops';
  function userLoops() { try { return JSON.parse(localStorage.getItem(LOOP_KEY) || '{}'); } catch (e) { return {}; } }
  function setUserLoop(key, v) { const u = userLoops(); if (v) u[key] = v; else delete u[key]; try { localStorage.setItem(LOOP_KEY, JSON.stringify(u)); } catch (e) { /* 무시 */ } }
  // 파일 바이트에서 루프 정보 읽기 → { start, end } (초) 또는 null
  function parseLoopTags(ab) {
    const u8 = new Uint8Array(ab), dv = new DataView(ab);
    const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
    let rate = 0, start = null, end = null;
    try {
      if (str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE') {
        for (let o = 12; o + 8 <= u8.length;) {
          const id = str(o, 4), len = dv.getUint32(o + 4, true), d = o + 8;
          if (id === 'fmt ') rate = dv.getUint32(d + 4, true);
          if (id === 'smpl' && dv.getUint32(d + 28, true) > 0) { start = dv.getUint32(d + 36 + 8, true); end = dv.getUint32(d + 36 + 12, true) + 1; }
          o = d + len + (len & 1);
        }
      } else {
        // OGG / MP3 등: 앞부분에서 태그 문자열을 찾는다
        const head = String.fromCharCode(...u8.subarray(0, Math.min(u8.length, 65536)).map(c => (c < 32 || c > 126 ? 32 : c)));
        const vi = head.indexOf('vorbis');
        if (str(0, 4) === 'OggS' && vi > 0) rate = dv.getUint32(vi + 6 + 5, true);
        const num = re => { const m = head.match(re); return m ? +m[1] : null; };
        start = num(/LOOPSTART[= ]+(\d+)/i);
        const len = num(/LOOPLENGTH[= ]+(\d+)/i), e = num(/LOOPEND[= ]+(\d+)/i);
        end = len != null && start != null ? start + len : e;
      }
    } catch (e) { return null; }
    if (start == null) return null;
    rate = rate || 44100;
    return { start: start / rate, end: end ? end / rate : 0 };
  }
  function loopFor(key, tags, dur) {
    const cfg = (window.MUSIC_LOOPS || {})[key];
    const u = userLoops()[key] || (cfg ? { start: cfg[0], end: cfg[1] } : null) || tags;
    if (!u) return null;
    const start = clamp(+u.start || 0, 0, dur), end = +u.end > start ? Math.min(+u.end, dur) : dur;
    return end - start > 0.2 ? { start, end } : null;
  }
  // 곡마다 음량 보정 (music/loops.js 의 MUSIC_VOLUME, 1 = 그대로)
  const trackVol = key => { const v = (window.MUSIC_VOLUME || {})[key]; return v > 0 ? Math.min(v, 2) : 1; };
  const canFetch = url => url.startsWith('blob:') || /^https?:/.test(location.protocol);
  const bufCache = new Map();   // url → { buf, tags } (용량이 커서 최근 2곡만)
  async function loadBuffer(url) {
    if (bufCache.has(url)) return bufCache.get(url);
    const ab = await (await fetch(url)).arrayBuffer();
    const tags = parseLoopTags(ab);
    const buf = await new Promise((res, rej) => ac.decodeAudioData(ab, res, rej));
    const entry = { buf, tags };
    bufCache.set(url, entry);
    while (bufCache.size > 2) bufCache.delete(bufCache.keys().next().value);
    return entry;
  }

  async function findFile(key) {
    if (key in found) return found[key];
    let url = null;
    if (uploadedKeys.has(key)) { const blob = await IDB.get(key); if (blob) url = URL.createObjectURL(blob); }
    for (const ext of EXTS) { if (url) break; if (await tryAudio(`${MUSIC_BASE}${key}.${ext}`)) url = `${MUSIC_BASE}${key}.${ext}`; }
    found[key] = url;
    if (url) urlKey[url] = key;
    return url;
  }
  // 업로드한 곡이 바뀌면(불러오기·삭제) 그 키의 기억을 지우고, 붙잡고 있던 blob URL도 놓아 준다
  function forgetFile(key) {
    delete found[key];
    for (const u of Object.keys(urlKey)) {
      if (urlKey[u] !== key) continue;
      delete urlKey[u]; bufCache.delete(u);
      if (u.startsWith('blob:')) URL.revokeObjectURL(u);
    }
  }
  const urlKey = {};
  const fileKeyOf = url => urlKey[url] || null;
  // 파일 소리를 멈추고 해제한다 (곡 정보도 함께 비운다). 요청 번호(reqSeq)는 건드리지 않는다.
  function stopFile() {
    if (player) {
      if (player.src) { try { player.src.stop(); } catch (e) { /* 이미 멈춤 */ } try { player.src.disconnect(); } catch (e) { /* 이미 끊김 */ } }
      if (player.el) { player.el.pause(); clearInterval(player.timer); try { player.el.removeAttribute('src'); player.el.load(); } catch (e) { /* 무시 */ } }
      player = null;
    }
    if (stage === 'file') stage = 'none';
    fileUrl = null; fileKey = null;
  }
  // 파일 하나를 끝까지 준비해서 소리를 낸다. tok(=요청 번호)이 바뀌었으면(새 요청·정지) 조용히 버린다.
  // Web Audio로 정확히 루프, 안 되면(file:// 로 연 경우) audio 요소로 현재 곡의 루프 지점에서 되감기
  async function playFile(url, key, tok, offset = 0) {
    if (!unlocked || !bgmOn() || !ctx()) return false;   // 나중에 unlock/refresh에서 다시 시작
    const stale = () => tok !== reqSeq;
    if (canFetch(url)) {
      try {
        const { buf, tags } = await loadBuffer(url);
        if (stale()) return false;
        stopLoop();   // 혹시 남아 있으면 합성 루프를 끈다 (파일과 동시에 나지 않게)
        stage = 'none';
        const L = loopFor(key, tags, buf.duration);
        const src = ac.createBufferSource();
        src.buffer = buf; src.loop = true;
        if (L) { src.loopStart = L.start; src.loopEnd = L.end; }
        src.connect(musicGain);
        player = { src, loop: L, dur: buf.duration, tags, key, url };
        const me = player;
        stage = 'file'; fileUrl = url; fileKey = key;
        refresh();
        // refresh() 가 그 사이에 음원을 껐을 수 있다 (배경음 끄기 등) → 그러면 이 소리는 내지 않는다
        if (player !== me || stale() || !bgmOn()) { stopFile(); return false; }
        src.start(0, Math.min(Math.max(0, offset), buf.duration - 0.05));
        return true;
      } catch (e) { /* 디코딩 실패 → audio 요소로 */ }
    }
    if (stale()) return false;
    stopLoop(); stage = 'none';
    const el = new Audio(url);
    const p = { el, loop: null, key, url };
    player = p;
    stage = 'file'; fileUrl = url; fileKey = key;
    el.addEventListener('loadedmetadata', () => {
      if (player !== p) return;
      const L = loopFor(key, null, el.duration);   // 항상 지금 곡의 루프 설정으로 (앞 곡의 구간을 물려받지 않는다)
      p.loop = L; p.dur = el.duration;
      el.loop = !L;
      if (offset) el.currentTime = offset;
    }, { once: true });
    el.addEventListener('ended', () => {
      if (player !== p) return;
      const L = p.loop;   // 되감기도 지금 곡의 loop 설정 기준
      if (L) { el.currentTime = L.start; el.play().catch(() => {}); }
    });
    p.timer = setInterval(() => {
      if (player !== p) { clearInterval(p.timer); return; }
      const L = p.loop;
      if (L && el.currentTime >= L.end - 0.015) el.currentTime -= L.end - L.start;
    }, 10);
    refresh();
    // refresh() 가 그 사이에 음원을 껐을 수 있다 → 그러면 재생하지 않는다
    if (player !== p || stale() || !bgmOn()) { stopFile(); return false; }
    el.play().catch(() => {});
    return true;
  }

  // ── 배경음 상태 사슬 ──
  // want: 지금 장소가 원하는 곡(후보 목록 포함). request(): 후보를 차례로 찾아 어떤 음원으로 낼지 정한다.
  // request()는 곧바로 지금 소리를 멈추고(silence) 새 요청 번호를 낸다. 그 뒤 모든 await 에서 자기 번호가
  // 아직 현재인지 확인하고, 아니면 조용히 버린다 — 빠른 전환에서 옛 곡이 새 곡 위에 올라가지 않는다.
  // stage 는 언제나 'none' | 'synth' | 'file' 중 하나이고, 두 음원이 동시에 살아 있는 상태는 없다.
  const candidates = w => (w && w.o && Array.isArray(w.o.files) && w.o.files.length ? w.o.files : [w.key]);
  async function resolve(w, tok) {
    pending = true;
    const cur = () => tok === reqSeq;
    const keys = [...new Set(candidates(w))];
    let url = null, key = null;
    for (const k of keys) { url = await findFile(k); if (!cur()) return; if (url) { key = k; break; } }
    if (!cur()) return;
    if (url) {
      await playFile(url, key, tok);   // 성공하면 playFile 이 stage 를 'file' 로 바꾼다
    } else {
      stopFile();
      if (unlocked && bgmOn() && ctx()) { stage = 'synth'; startLoop(makeTheme(w.key, w.o)); }
    }
    if (cur()) pending = false;
  }
  function request(w) {
    if (previewing) previewing = false;   // 새 장소로 가면 미리 듣기는 끝난다
    silence();               // 새 요청 번호를 내고 지금 나는 소리는 즉시 멈춘다
    resolve(w, reqSeq);
  }
  // 지금 나는 소리를 모두 멈추고 해제한다. 요청 번호도 함께 올려, 아직 불러오는 중인 옛 요청을 모두 무효로 만든다.
  function silence() {
    ++reqSeq;
    pending = false;
    stopLoop(); stopFile();
    stage = 'none';
    if (loopBus) loopBus.gain.value = 0;
  }
  // 같은 곡을 이어서 트는지 판단할 때 쓰는 지문 (후보 목록까지 비교)
  const sameWant = (a, b) => !!a && a.key === b.key && candidates(a).join('|') === candidates(b).join('|');

  // 장소별 배경음. 같은 곡이면 이어서 튼다. 음악 파일이 있으면 파일, 없으면 합성
  function bgm(key, o = {}) {
    const next = { key, o };
    if (sameWant(want, next)) {
      want = next;
      // 같은 곡인데 소리가 비었으면(아직 준비 중이거나 꺼져 있었다) 한 번 더 푼다
      if (unlocked && bgmOn() && stage === 'none' && !pending) request(want);
      return;
    }
    want = next;
    if (!unlocked || !bgmOn()) { previewing = false; silence(); return; }
    request(want);
  }
  async function importMusic(key, file) {
    if (!file || !/^audio\//.test(file.type) && !/\.(ogg|mp3|m4a|wav)$/i.test(file.name)) return false;
    const ok = await IDB.put(key, file);
    if (ok === null) return false;
    uploadedKeys.add(key); forgetFile(key);
    // 지금 장소가 이 곡을 후보로 쓰고 있으면 즉시 다시 푼다 (미리 듣기 중이면 끝난 뒤 반영)
    if (want && !previewing && candidates(want).includes(key)) request(want);
    return true;
  }
  async function removeMusic(key) {
    await IDB.del(key); uploadedKeys.delete(key); forgetFile(key);
    if (!want || previewing) return;
    // 지금 그 파일로 나고 있었거나 후보에 들어 있던 곡이면 다시 푼다 → 다음 후보 파일, 없으면 합성
    if (fileKey === key || candidates(want).includes(key)) request(want);
  }
  // 정보 탭의 루프 설정용: 파일 정보(길이, 파일 안의 루프, 지금 쓰는 루프)
  async function loopInfo(key) {
    const url = await findFile(key);
    if (!url) return null;
    let tags = null, dur = 0;
    if (canFetch(url) && ctx()) { try { const e = await loadBuffer(url); tags = e.tags; dur = e.buf.duration; } catch (e) { /* 무시 */ } }
    if (!dur) dur = await new Promise(res => { const a = new Audio(); a.preload = 'metadata'; a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(0); a.src = url; });
    const cfg = (window.MUSIC_LOOPS || {})[key];
    return { url, dur, tags, cfg: cfg ? { start: cfg[0], end: cfg[1] } : null, user: userLoops()[key] || null, use: loopFor(key, tags, dur), exact: canFetch(url) };
  }
  // 루프 연결 부분 미리 듣기 (끝나기 3초 전부터). 끝나면 endPreview()가 원래 곡으로 돌려놓는다.
  async function previewLoop(key) {
    const wantKey = want && want.key;
    const url = await findFile(key); if (!url) return false;
    const info = await loopInfo(key); if (!info || !info.use) return false;
    if ((want && want.key) !== wantKey) return false;   // 준비하는 사이에 장소가 바뀌었으면 미리 듣기는 시작하지 않는다
    previewing = true;
    silence();   // 새 요청 번호: 미리 듣는 동안 도착하는 옛 배경음 요청은 모두 버려진다
    const ok = await playFile(url, key, reqSeq, Math.max(info.use.start, info.use.end - 3));
    if (!ok && previewing) endPreview();   // 미리 들을 수 없으면 원래 곡으로
    return ok;
  }
  function endPreview() {
    if (!previewing) return;
    previewing = false;
    if (want && unlocked && bgmOn()) request(want);   // 미리 듣기 전의 곡으로 되돌린다
    else silence();
  }
  function setLoop(key, v) {
    setUserLoop(key, v);
    // 지금 이 곡이 나고 있으면 새 루프 구간으로 바로 다시 건다
    if (!previewing && fileKey === key && unlocked && bgmOn() && want) request(want);
  }

  const MOODS = { burned: 'phryg', whirl: 'dorian', seafloor: 'minor', ruins: 'phryg', shrine: 'minor', altar: 'lydian', coronet: 'dorian', spiral: 'minor', areazero: 'lydian', crystal: 'lydian', swamp: 'dorian', volcano: 'phryg', desert: 'phryg', frost: 'minor', storm: 'minor', dark: 'minor', mine: 'dorian',
    canyon: 'phryg', summit: 'lydian', trial: 'dorian', twilight: 'minor', mystery: 'dorian', eternal: 'phryg', daily: 'dorian' };
  const title = () => bgm('title', { mode: 'major', bpm: 96, root: 55, prog: [0, 3, 4, 0], wave: 'triangle', sparse: 0.6, files: ['title', 'town'] });
  // 마을 음악: 설정에서 고른 던전의 곡 (v0.102 보강, 파일이 없으면 마을 곡)
  const town = () => { const k = typeof Game !== 'undefined' && Game.save && Game.save.settings && Game.save.settings.townBgm;
    bgm(k ? 'town:' + k : 'town', { mode: 'major', bpm: 96, root: 55, prog: [0, 3, 4, 0], wave: 'triangle', sparse: 0.6, files: k ? [k, ...((window.MUSIC_ALIAS || {})[k] ? [window.MUSIC_ALIAS[k]] : []), 'town'] : ['town'] }); };
  // 오늘의 도전: 날짜로 정해지는 던전 하나의 곡 (날짜 순서대로 돌며 파일이 있는 첫 곡)
  const dailyFiles = seed => { const ids = DUNGEONS.filter(d => !d.daily && !d.endless).map(d => d.id), k = seed % ids.length; return [...ids.slice(k), ...ids.slice(0, k), 'dungeon']; };
  const dungeon = dg => bgm('dg:' + dg.id + (dg.daily ? dg.seed : ''), { mode: MOODS[dg.id] || 'major', files: dg.daily ? dailyFiles(dg.seed >>> 0) : [dg.id, ...((window.MUSIC_ALIAS || {})[dg.id] ? [window.MUSIC_ALIAS[dg.id]] : []), 'dungeon'] });
  // 특별한 순간의 곡 (수배범·도둑질·몬스터하우스·이야기): 파일이 있을 때만 틀고, 없으면 fallback (합성 배경음으로 바꾸지 않는다)
  async function special(key, fallback) {
    const wasKey = want && want.key;
    const url = await findFile(key);
    if ((want && want.key) !== wasKey) return;   // 찾는 사이에 장소가 바뀌었으면 옛 판단은 버린다
    if (url) bgm('sp:' + key, { files: [key] }); else if (fallback) fallback();
  }
  // 이야기 장면 동안만 잠깐 다른 곡: 끝나면 원래 곡으로 (그 사이에 다른 곡으로 바뀌었으면 그대로 둔다)
  async function scene(key) {
    const prev = want, prevKey = prev && prev.key;
    const url = key && await findFile(key);
    if (!url || (want && want.key) !== prevKey || (want && want.key === 'sp:' + key)) return () => {};
    bgm('sp:' + key, { files: [key] });
    return () => { if (want && want.key === 'sp:' + key && prev) bgm(prev.key, prev.o); };
  }
  // 팡파르: 짧은 곡을 한 번 (승급·보상 등). 그동안 배경음을 줄였다가 끝나면 다시. 파일이 없거나 배경음을 껐으면 합성 효과음(sfx)
  const fanCache = new Map();
  let fan = null;
  async function fanfare(key, sfx) {
    const url = await findFile(key);
    if (!url || !unlocked || !ctx() || !canFetch(url) || set().bgm === false) { if (sfx) play(sfx); return; }
    try {
      if (!fanCache.has(url)) fanCache.set(url, await new Promise(async (res, rej) => ac.decodeAudioData(await (await fetch(url)).arrayBuffer(), res, rej)));
      const buf = fanCache.get(url);
      if (fan) { try { fan.src.stop(); } catch (e) { /* 이미 끝남 */ } }
      const src = ac.createBufferSource(), g = ac.createGain();
      g.gain.value = (set().bgmVol ?? 40) / 100 * 0.8 * trackVol(key);
      src.buffer = buf; src.connect(g); g.connect(master);
      const t = ac.currentTime, my = fan = { src };
      duck.gain.cancelScheduledValues(t); duck.gain.setValueAtTime(duck.gain.value, t); duck.gain.linearRampToValueAtTime(0, t + 0.15);
      src.onended = () => { if (fan !== my) return; fan = null; const t2 = ac.currentTime; duck.gain.cancelScheduledValues(t2); duck.gain.setValueAtTime(duck.gain.value, t2); duck.gain.linearRampToValueAtTime(1, t2 + 0.8); };
      src.start(t + 0.1);
    } catch (e) { if (sfx) play(sfx); }
  }
  const boss = () => bgm('boss', { mode: 'minor', bpm: 150, root: 45, prog: [0, 5, 6, 4], wave: 'sawtooth', sparse: 0.3, files: ['boss'] });

  // 브라우저는 사용자가 한 번 누르기 전에는 소리를 막는다
  function unlock() {
    if (unlocked) return;
    if (!ctx()) return;
    unlocked = true;
    refresh();
    if (want && bgmOn() && stage === 'none' && !pending) request(want);   // 첫 곡은 잠금이 풀린 뒤 시작
  }
  ['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, unlock, { capture: true }));

  return { play, bgm, title, town, dungeon, boss, special, scene, fanfare, refresh, importMusic, removeMusic, loopInfo, previewLoop, endPreview, setLoop, get uploaded() { return uploadedKeys; }, get playingFile() { return fileUrl; }, get player() { return player; }, get state() { return { stage, previewing, want: want && want.key, fileKey, pending, enabled: bgmOn(), voices: loopNodes.size }; } };
})();
