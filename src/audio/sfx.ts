/*
 * The contents of this file are subject to the Common Public Attribution License
 * Version 1.0 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * https://github.com/WebWalker3D/Quackwell-General/blob/main/LICENSE. The License is
 * based on the Mozilla Public License Version 1.1 but Sections 14 and 15 have been
 * added to cover use of software over a computer network and provide for limited
 * attribution for the Original Developer. In addition, Exhibit A has been modified
 * to be consistent with Exhibit B.
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License for the
 * specific language governing rights and limitations under the License.
 *
 * The Original Code is Quackwell General.
 * The Initial Developer of the Original Code is Blaine Bouvier. All portions of the
 * code written by Blaine Bouvier are Copyright (c) 2026. All Rights Reserved.
 */
import type { SimEvent } from '../sim/events';

type Name = 'click' | 'build' | 'drop' | 'coin' | 'cure' | 'fail' | 'hire' | 'error' | 'whoosh' | 'goal' | 'siren' | 'clank' | 'fanfare';

const PENTA = [0, 2, 4, 7, 9];
const CHORDS = [[0, 4, 7], [-3, 0, 4], [5, 9, 12], [7, 11, 14]]; // I vi IV V in C
const hz = (semi: number, base = 261.63) => base * Math.pow(2, semi / 12);

/** Everything synthesized: UI blips, cash chimes, cure fanfares and a generative music box. */
export class Sfx {
  volume = 0.6;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noise!: AudioBuffer;
  private last = new Map<string, number>();
  private musicTimer: number | null = null;
  private beat = 0;

  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const c = this.ctx;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = c.createGain();
    this.master.gain.value = this.volume;
    this.sfxBus = c.createGain();
    this.musicBus = c.createGain();
    this.musicBus.gain.value = 0.32;
    // cheap reverb: feedback delay network
    const verbIn = c.createGain();
    verbIn.gain.value = 0.25;
    const d1 = c.createDelay(), d2 = c.createDelay();
    d1.delayTime.value = 0.113; d2.delayTime.value = 0.171;
    const fb = c.createGain();
    fb.gain.value = 0.42;
    const lp = c.createBiquadFilter();
    lp.frequency.value = 3200;
    verbIn.connect(d1); d1.connect(d2); d2.connect(lp); lp.connect(fb); fb.connect(d1); lp.connect(comp);
    this.sfxBus.connect(comp);
    this.sfxBus.connect(verbIn);
    this.musicBus.connect(comp);
    this.musicBus.connect(verbIn);
    comp.connect(this.master);
    this.master.connect(c.destination);
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.startMusic();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, when = 0, slideTo?: number, bus?: GainNode) {
    const c = this.ctx!;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(bus ?? this.sfxBus);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private bell(freq: number, vol: number, when = 0, bus?: GainNode, dur = 1.2) {
    this.tone(freq, dur, 'sine', vol, when, undefined, bus);
    this.tone(freq * 2.01, dur * 0.6, 'sine', vol * 0.35, when, undefined, bus);
    this.tone(freq * 3.98, dur * 0.3, 'sine', vol * 0.12, when, undefined, bus);
  }

  private hiss(dur: number, vol: number, from: number, to: number, when = 0, q = 1.2) {
    const c = this.ctx!;
    const t = c.currentTime + when;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.sfxBus);
    s.start(t);
    s.stop(t + dur + 0.05);
  }

  play(name: Name | string) {
    if (!this.ctx || this.volume <= 0) return;
    const now = performance.now();
    const cool = name === 'coin' ? 70 : 40;
    if (now - (this.last.get(name) ?? 0) < cool) return;
    this.last.set(name, now);
    switch (name as Name) {
      case 'click': this.tone(900, 0.06, 'sine', 0.18, 0, 1300); break;
      case 'error': this.tone(150, 0.16, 'square', 0.08); this.tone(110, 0.16, 'square', 0.07, 0.08); break;
      case 'drop':
        this.tone(260, 0.14, 'triangle', 0.35, 0, 90);
        this.hiss(0.18, 0.18, 2000, 400);
        break;
      case 'build':
        this.tone(140, 0.3, 'sine', 0.5, 0, 50);
        this.hiss(0.5, 0.25, 600, 120, 0, 0.8);
        [0, 4, 7, 12].forEach((s, i) => this.bell(hz(s + 12), 0.12, 0.12 + i * 0.07));
        break;
      case 'coin':
        this.tone(1318, 0.08, 'square', 0.06);
        this.tone(1760, 0.32, 'square', 0.06, 0.07);
        this.bell(2637, 0.05, 0.07, undefined, 0.4);
        break;
      case 'cure':
        [0, 4, 7, 12, 16].forEach((s, i) => this.bell(hz(s + 12), 0.16, i * 0.075, undefined, 1.4));
        this.tone(hz(0), 0.9, 'triangle', 0.12, 0.3);
        this.hiss(0.6, 0.06, 6000, 9000, 0.2, 2);
        break;
      case 'goal':
        [0, 7, 12, 16, 19, 24].forEach((s, i) => this.bell(hz(s + 7), 0.13, i * 0.06, undefined, 1.6));
        break;
      case 'fail':
        this.tone(330, 0.35, 'sawtooth', 0.07, 0, 250);
        this.tone(250, 0.6, 'sawtooth', 0.07, 0.32, 160);
        break;
      case 'hire':
        this.bell(hz(19), 0.14);
        this.bell(hz(24), 0.14, 0.12);
        break;
      case 'siren':
        for (let i = 0; i < 4; i++) {
          this.tone(740, 0.32, 'triangle', 0.1, i * 0.62, 980);
          this.tone(980, 0.3, 'triangle', 0.1, i * 0.62 + 0.31, 740);
        }
        break;
      case 'clank':
        this.tone(180, 0.25, 'square', 0.1, 0, 70);
        this.hiss(0.35, 0.25, 3000, 600, 0.02, 3);
        this.tone(1200, 0.12, 'square', 0.05, 0.08, 400);
        break;
      case 'fanfare':
        [[0, 0], [4, 0.12], [7, 0.24], [12, 0.36], [7, 0.6], [12, 0.72], [16, 0.84]].forEach(([n, t]) => this.bell(hz(n + 12), 0.15, t, undefined, 1.4));
        this.tone(hz(-12), 1.6, 'triangle', 0.1, 0.36);
        break;
      case 'whoosh':
        this.hiss(0.45, 0.3, 300, 3000, 0, 0.9);
        this.tone(200, 0.3, 'sine', 0.2, 0.1, 80);
        break;
    }
  }

  /** Generative music box over a slow chord pad (I vi IV V). */
  private startMusic() {
    if (this.musicTimer !== null) return;
    const step = () => {
      const c = this.ctx;
      if (!c || c.state !== 'running') return;
      const bar = Math.floor(this.beat / 8);
      const chord = CHORDS[bar % CHORDS.length];
      if (this.beat % 8 === 0) {
        for (const s of chord) {
          this.tone(hz(s - 12), 4.2, 'triangle', 0.045, 0, undefined, this.musicBus);
          this.tone(hz(s - 12) * 1.004, 4.2, 'sine', 0.04, 0, undefined, this.musicBus);
        }
        this.tone(hz(chord[0] - 24), 4.2, 'sine', 0.08, 0, undefined, this.musicBus);
      }
      const p = this.beat % 2 === 0 ? 0.6 : 0.28;
      if (Math.random() < p) {
        const note = Math.random() < 0.5 ? chord[(Math.random() * 3) | 0] + 12 : PENTA[(Math.random() * 5) | 0] + 12 + (Math.random() < 0.3 ? 12 : 0);
        this.bell(hz(note), 0.07 + Math.random() * 0.04, 0, this.musicBus, 1.6);
      }
      this.beat++;
    };
    this.musicTimer = window.setInterval(step, 280);
  }

  handle(events: SimEvent[]) {
    for (const e of events) {
      switch (e.type) {
        case 'cured': this.play('cure'); setTimeout(() => this.play('coin'), 180); break;
        case 'failed': this.play('fail'); break;
        case 'paid': if (e.amount >= 100) this.play('coin'); break;
        case 'built': if (e.kind === 'room') this.play('build'); break;
        case 'hired': this.play('hire'); break;
        case 'sold': this.play('whoosh'); break;
        case 'month': this.play('coin'); break;
      }
    }
  }
}
