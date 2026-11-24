/**
 * The sound driver's queue and voice lifecycle: what happens when more sounds are asked for than the
 * eight-slot effects queue or the nine OPL channels can hold, how an engine comes back after a louder
 * sound took its voice, and that a stop request really stops.
 *
 * These do not need the game's files. The driver reads its bank, its instrument records and its silence
 * list out of the image it is handed, so this file builds a small one with the layout DRIVER1.BIN has
 * (engines at 0x0008, bank at 0x0200, instrument records at 0x0680, silence list at 0x104a), with 32
 * identical one-note effects. test/engine/sound.test.ts keeps the checks against the real DRIVER1.BIN and
 * skips without it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SoundDriver } from '../../src/engine/sound/driver';
import { SoundOutput } from '../../src/hal/audio/SoundOutput';
import { OPL2, OPL_RATE } from '../../src/engine/sound/opl2';

// ---------------------------------------------------------------- a driver image with the real layout
const SONG_BANK = 0x1800, BANK = 0x0200, SEQ = 0x0300, INSTR = 0x0600;
const SOUNDS = 0x20;
const PIT_DIVISOR = 0x4287;               // what fn 321c passes: PIT ticks per game tick
const IMG_LEN = 0x2000;
const EFFECT_QUEUE = 0x13D1;

/** One OPL channel's operator offsets, as the driver's table at 0x1038 has them. */
const CHANNEL_OPS = [0x0003, 0x0104, 0x0205, 0x080B, 0x090C, 0x0A0D, 0x1013, 0x1114, 0x1215];

function buildImage(): Uint8Array {
  const img = new Uint8Array(IMG_LEN);
  const w = (at: number, v: number): void => { img[at] = v & 0xFF; img[at + 1] = (v >> 8) & 0xFF; };
  // where the driver looks for its data (driver.ts's constants)
  w(0x13F0, SONG_BANK);                   // no songs: the bank's count byte stays 0
  w(0x13F2, BANK);
  w(0x13F4, INSTR);
  w(0x1254, PIT_DIVISOR);
  img[0x125E] = 1; img[0x125F] = 1;       // tempo bytes, so the sequencer rates are non-zero
  w(0x1256, 0x7F);                        // global volume

  // the operator pairs the sequencer gives each OPL channel (0x1038)
  for (let chan = 0; chan < 9; chan++) w(0x1038 + chan * 2, CHANNEL_OPS[chan]!);

  // a frequency table that makes every note audible: 0x300 words at 0x0a38, then 12 block bytes
  for (let i = 0; i < 0x300; i++) w(0x0A38 + i * 2, 0x300);
  for (let i = 0; i < 12; i++) img[0x09D3 + i] = 0x10;    // block 4
  // the loudness table at 0x10cc: zero attenuation all the way (the driver indexes it by a 0..255 volume)
  img.fill(0x00, 0x10CC, 0x114D);

  // the silence list at 0x104a: the eighteens operator registers, as the real one has them (it has to end
  // before the loudness table at 0x10cc)
  let p = 0x104A;
  for (const op of [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15]) {
    w(p, (0xFF << 8) | (0x60 + op)); p += 2;              // 0x60+op = 0xff
    w(p, (0xFF << 8) | (0x80 + op)); p += 2;              // 0x80+op = 0xff
  }
  // the register shadow at 0x114d ships full of 0xff, as the real driver's does
  img.fill(0xFF, 0x114D, 0x124D);

  // 32 one-note effects, identical: instrument 0, a note held for 0x20 sequencer ticks, then the end
  const sequence = [0x00, 0x92, 0x00, 0x00, 0x1C, 0x7F, 0x20, 0x91];
  img[BANK] = SOUNDS;
  for (let n = 0; n < SOUNDS; n++) {
    const at = SEQ + n * 0x10;
    w(BANK + 1 + n * 2, at - BANK);
    img.set(sequence, at);
  }

  // instrument 0: fast attack, shallow decay, a 0xff release (so a stop is audible at once)
  const ins = INSTR + 0x80;
  img[ins + 0x00] = 0xF1;                 // AR = 15, DR = 1 (0x60), modulator
  img[ins + 0x01] = 0xF1;                 // the same for the carrier
  img[ins + 0x02] = 0x0F;                 // SL = 0, RR = 15 (0x80), modulator
  img[ins + 0x03] = 0x0F;                 // the same for the carrier
  img[ins + 0x04] = 0x21; img[ins + 0x05] = 0x21;   // EG + MULT 1 (0x20)
  img[ins + 0x08] = 0x00;                 // the note offset
  img[ins + 0x09] = 0xC0;                 // feedback 6 on 0xc0
  img[ins + 0x0A] = 0x00; img[ins + 0x0B] = 0x00;   // modulator and carrier levels: full
  img[ins + 0x0C] = 0x00;                 // no key scaling
  img[ins + 0x0F] = 0x02;                 // two semitones of bend

  // the four engine records: instrument 0, a loop point, a note, the pitch bend and the loop/end command
  for (let car = 0; car < 4; car++) {
    img.set([0x00, 0x92, 0x00, 0x00, 0x9C, 0x00, 0x1C, 0x7F, 0x01, 0x95, 0x30, 0x00, 0x98],
      0x0008 + car * 16);
  }
  return img;
}

class Log {
  readonly writes: [number, number][] = [];
  write(reg: number, value: number): void { this.writes.push([reg, value]); }
}

function boot(): { d: SoundDriver; log: Log } {
  const log = new Log();
  const d = new SoundDriver(buildImage(), log);
  d.init();
  log.writes.length = 0;
  return { d, log };
}

/** The effects queue as the driver would save it (the eight bytes at 0x13d1). */
function effectsQueue(d: SoundDriver): number[] {
  return Array.from(d.saveState(EFFECT_QUEUE, 8));
}

// ---------------------------------------------------------------- the queue
describe('effects queue', () => {
  it('makes room for a more valuable sound instead of dropping it', () => {
    const d = boot().d;
    for (let i = 0; i < 8; i++) expect(d.play(5)).toBe(true);      // eight skids fill the queue
    expect(effectsQueue(d).every(s => s === 5)).toBe(true);
    expect(d.play(1)).toBe(true);                                  // a crash outranks a skid
    let q = effectsQueue(d);
    expect(q.filter(s => s === 5).length).toBe(7);
    expect(q.includes(1)).toBe(true);
    expect(d.play(5)).toBe(false);                                 // another skid is worth no more than the queue
    expect(effectsQueue(d).includes(5)).toBe(true);
    expect(d.play(1)).toBe(true);                                  // a second crash still beats a skid
    q = effectsQueue(d);
    expect(q.filter(s => s === 1).length).toBe(2);
    expect(q.filter(s => s === 5).length).toBe(6);
  });

  it('keeps one engine request per car and lets engines in ahead of chatter', () => {
    const d = boot().d;
    for (let i = 0; i < 8; i++) d.play(0x12);                      // bumped surface: repeating, lowest rank
    expect(d.play(0x40)).toBe(true);                               // car 0's engine takes a slot
    expect(d.play(0x40)).toBe(true);                               // the same engine again is already queued
    expect(d.play(0x41)).toBe(true);                               // and a second car gets its own
    const q = effectsQueue(d);
    expect(q.filter(s => s >= 0x40).sort()).toEqual([0x40, 0x41]);
    expect(q.filter(s => s === 0x12).length).toBe(6);
  });

  it('plays the queue in request order once there is room', () => {
    const { d } = boot();
    for (const s of [1, 2, 3, 4]) expect(d.play(s)).toBe(true);
    expect(effectsQueue(d)).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
    d.tick();
    expect([1, 2, 3, 4].every(n => d.isPlaying(n))).toBe(true);
    expect(effectsQueue(d).every(s => s === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------- engines and voices
describe('engine voices', () => {
  it('re-queues a car engine after a louder effect took its voice, and starts it when one frees', () => {
    const { d } = boot();
    for (const n of [1, 2, 3, 4, 6, 7, 8, 9]) d.play(n);           // eight one-shots
    d.tick();
    d.engine(0, 0x30, true);
    d.tick();
    expect(d.isPlaying(0x40)).toBe(true);                          // the engine has the ninth channel

    d.play(2);                                                     // a crash: the only voice it may take is the engine's
    d.tick();
    expect(d.isPlaying(0x40)).toBe(false);
    expect(d.isPlaying(2)).toBe(true);

    d.engine(0, 0x40, true);                                       // fn 7b46 asks again: back into the queue
    expect(effectsQueue(d).includes(0x40)).toBe(true);
    d.tick();
    // every other channel is a one-shot the engine may not interrupt, so it waits
    expect(d.isPlaying(0x40)).toBe(false);
    expect(effectsQueue(d).includes(0x40)).toBe(true);

    // ...and starts by itself once one of the one-shots runs out
    let started = false;
    for (let tick = 0; tick < 80 && !started; tick++) { d.tick(); started = d.isPlaying(0x40); }
    expect(started).toBe(true);
  });

  it('an engine may take a repeating skid voice but never a one-shot', () => {
    const { d } = boot();
    for (const n of [5, 1, 2, 3, 4, 6, 7, 8]) d.play(n);           // a skid and seven one-shots: all eight slots
    d.tick();                                                      // eight voices, the skid among them
    d.play(9); d.tick();                                           // the ninth channel: a one-shot too
    expect(d.isPlaying(5)).toBe(true);
    expect(d.isPlaying(9)).toBe(true);

    d.play(0x40);                                                  // the queue holds it...
    d.tick();
    expect(d.isPlaying(0x40)).toBe(true);                          // ...and the skid is the voice it takes
    expect(d.isPlaying(5)).toBe(false);
    expect(d.isPlaying(1)).toBe(true);                             // a one-shot is never interrupted
  });

  it('running false takes a queued request back out and ends the playing voice', () => {
    const { d } = boot();
    d.engine(0, 0x30, true);
    d.engine(0, 0, false);                                         // stopped between frames, before a tick gave it a channel
    d.tick();
    expect(d.isPlaying(0x40)).toBe(false);
    expect(effectsQueue(d).every(s => s !== 0x40)).toBe(true);

    d.engine(1, 0x30, true);
    d.tick();
    expect(d.isPlaying(0x41)).toBe(true);
    d.engine(1, 0, false);                                         // the sequence reaches its 0x91 and ends
    for (let tick = 0; tick < 20; tick++) d.tick();
    expect(d.isPlaying(0x41)).toBe(false);
  });
});

// ---------------------------------------------------------------- stopping
describe('stopping', () => {
  it('stopVoices silences an effect that is already on a channel', () => {
    const opl = new OPL2();
    const live = new SoundDriver(buildImage(), opl);
    live.init();
    live.play(1);
    live.tick();
    expect(live.isPlaying(1)).toBe(true);

    const before = new Float32Array(Math.round(OPL_RATE / 70.086) * 2);
    opl.render(before);
    expect(peak(before)).toBeGreaterThan(0.01);                    // it really was sounding

    live.stopVoices();
    live.tick();
    expect(live.isPlaying(1)).toBe(false);
    const after = new Float32Array(Math.round(OPL_RATE / 20));      // 50 ms
    opl.render(after);
    expect(peak(after.subarray(256))).toBe(0);                      // the release is over within a few ms
  });

  it('stopVoices drops a queued engine request instead of starting it next tick', () => {
    const { d } = boot();
    d.engine(0, 0x30, true);                                       // queued, not yet on a channel
    d.stopVoices();
    d.tick();
    for (let tick = 0; tick < 30; tick++) { d.tick(); expect(d.isPlaying(0x40)).toBe(false); }
  });

  it('stopAll clears both queues and leaves every voice silent', () => {
    const { d } = boot();
    d.play(1); d.play(2, true);
    d.tick();
    expect(d.isPlaying(1)).toBe(true);
    d.stopAll();
    d.tick();
    expect(d.isPlaying(1)).toBe(false);
    expect(effectsQueue(d).every(s => s === 0)).toBe(true);
  });

  it('a stop requested between two samples takes effect on the next sample, not the next tick', () => {
    const out = new SoundOutput(buildImage());
    out.driver.play(1);
    out.driver.tick();
    expect(out.driver.isPlaying(1)).toBe(true);

    const internal = out as unknown as { sample(): number; tickCarry: number };
    internal.tickCarry = 500;                                      // no tick would run on this sample
    const writes: [number, number][] = [];
    const opl = out.opl as unknown as { write(r: number, v: number): void };
    const write = opl.write.bind(opl);
    opl.write = (r: number, v: number): void => { writes.push([r, v]); write(r, v); };

    out.driver.stopVoices();                                       // deferred to a tick, as the driver has it
    internal.sample();
    expect(out.driver.isPlaying(1)).toBe(false);                   // the slot is gone...
    expect(writes.some(([r, v]) => r >= 0xB0 && r < 0xB9 && (v & 0x20) === 0)).toBe(true);   // ...and the gate is off
  });

  it('SoundOutput applies a stop at once even when no audio is being pumped', () => {
    const out = new SoundOutput(buildImage());
    out.driver.play(1);
    out.driver.tick();
    out.stopVoices();                                              // no pump, no sample: the call itself must land
    expect(out.driver.isPlaying(1)).toBe(false);
  });
});

describe('sound output', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders buffers after a stop that do not carry the stopped voice', () => {
    const ctx = new FakeContext();
    vi.stubGlobal('AudioContext', function (this: unknown) { return ctx; });
    const out = new SoundOutput(buildImage());
    out.start();
    out.driver.play(1);
    out.pump();
    const first = ctx.scheduled.flatMap(s => Array.from(s.buffer.data));
    expect(peak(first)).toBeGreaterThan(0.01);

    ctx.currentTime += 0.5;                                        // force new buffers
    out.stopVoices();
    const before = ctx.scheduled.length;
    out.pump();
    expect(ctx.scheduled.length).toBeGreaterThan(before);
    const fresh = ctx.scheduled.slice(before).flatMap(s => Array.from(s.buffer.data));
    expect(peak(fresh.slice(1024))).toBe(0);                       // past the release, and no re-key
    expect(out.driver.isPlaying(1)).toBe(false);
  });
});

// ---------------------------------------------------------------- helpers
function peak(data: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]!));
  return p;
}

class FakeBuffer {
  readonly data: Float32Array;
  constructor(length: number) { this.data = new Float32Array(length); }
  getChannelData(): Float32Array { return this.data; }
}

class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  readonly scheduled: { at: number; buffer: FakeBuffer }[] = [];
  createGain(): unknown { return { gain: { value: 0 }, connect: () => undefined }; }
  createBuffer(_channels: number, length: number): FakeBuffer { return new FakeBuffer(length); }
  createBufferSource(): unknown {
    const ctx = this;
    let buffer: FakeBuffer | undefined;
    return {
      set buffer(b: FakeBuffer) { buffer = b; },
      get buffer(): FakeBuffer | undefined { return buffer; },
      connect: () => undefined,
      start: (at: number) => ctx.scheduled.push({ at, buffer: buffer! }),
    };
  }
  resume(): Promise<void> { return Promise.resolve(); }
  get destination(): unknown { return {}; }
}
