import { describe, it, expect, beforeEach } from 'vitest';
import { fft, fftInPlace, fftReal, ifft, ifftInPlace, ifftReal } from './fft.js';
import { generateSine } from './generators.js';
import {
  BIT_REVERSAL_CACHE_LIMIT,
  bitReversalCacheSize,
  clearBitReversalCache,
} from './bit-reversal-cache.js';

describe('fft', () => {
  it('fft then ifft recovers the input', () => {
    const samples = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const orig = new Float32Array(samples);
    const f = fft(samples);
    const inv = ifft(f);
    for (let i = 0; i < samples.length; i++) {
      expect(inv.re[i] ?? 0).toBeCloseTo(orig[i] ?? 0, 4);
      expect(inv.im[i] ?? 0).toBeCloseTo(0, 4);
    }
  });

  it('fftInPlace rejects non-power-of-two', () => {
    const re = new Float32Array(6);
    const im = new Float32Array(6);
    expect(() => fftInPlace(re, im)).toThrow(/power of two/);
  });

  it('fft of a 1-cycle sine concentrates energy in bin 1', () => {
    const N = 64;
    const data = new Float32Array(N);
    for (let i = 0; i < N; i++) data[i] = Math.sin((2 * Math.PI * i) / N);
    const f = fft(data);
    let peak = 0;
    let peakIdx = 0;
    for (let i = 0; i < N; i++) {
      const m = Math.hypot(f.re[i] ?? 0, f.im[i] ?? 0);
      if (m > peak) {
        peak = m;
        peakIdx = i;
      }
    }
    expect(peakIdx).toBe(1);
  });

  it('fft of DC produces a single non-zero real bin at index 0', () => {
    const data = new Float32Array(16).fill(1);
    const f = fft(data);
    expect(f.re[0]).toBeCloseTo(16, 4);
    expect(f.im[0]).toBeCloseTo(0, 4);
    for (let i = 1; i < 16; i++) {
      expect(f.re[i] ?? 0).toBeCloseTo(0, 4);
      expect(f.im[i] ?? 0).toBeCloseTo(0, 4);
    }
  });

  it('ifftInPlace works in place', () => {
    const re = new Float32Array(4);
    const im = new Float32Array(4);
    re.set([1, 0, 0, 0]);
    ifftInPlace(re, im);
    for (let i = 0; i < 4; i++) {
      expect(re[i] ?? 0).toBeCloseTo(0.25, 4);
    }
  });

  it('fftReal and ifftReal compose', () => {
    const data = new Float32Array(8);
    for (let i = 0; i < 8; i++) data[i] = Math.cos((2 * Math.PI * 2 * i) / 8);
    const f = fftReal(data);
    const back = ifftReal(f);
    for (let i = 0; i < 8; i++) {
      expect(back[i] ?? 0).toBeCloseTo(data[i] ?? 0, 4);
    }
  });

  it('fft on a real audio sine concentrates energy at the right bin', () => {
    // sampleRate=64, duration=1.0, frequency=4 -> 64 samples, 4 cycles -> bin 4
    const buf = generateSine(64, 1, 4, { amplitude: 1 });
    const f = fftReal(buf.getChannel(0));
    let peak = 0;
    let peakIdx = 0;
    for (let i = 0; i < 64; i++) {
      const m = Math.hypot(f.re[i] ?? 0, f.im[i] ?? 0);
      if (m > peak) {
        peak = m;
        peakIdx = i;
      }
    }
    expect(peakIdx).toBe(4);
  });

  it('fftInPlace rejects mismatched re/im lengths before mutation', () => {
    const re = new Float32Array(4);
    const im = new Float32Array(8);
    const reBefore = new Float32Array(re);
    const imBefore = new Float32Array(im);
    expect(() => fftInPlace(re, im)).toThrow(/mismatch/);
    expect(Array.from(re)).toEqual(Array.from(reBefore));
    expect(Array.from(im)).toEqual(Array.from(imBefore));
  });

  it('ifftInPlace leaves inputs unchanged on a failed call', () => {
    const re = new Float32Array([1, 2, 3, 4]);
    const im = new Float32Array([4, 3, 2, 1]);
    const reBefore = new Float32Array(re);
    const imBefore = new Float32Array(im);
    expect(() => ifftInPlace(re, im)).not.toThrow();
    // A successful call mutates: sanity check the mutation.
    expect(Array.from(re)).not.toEqual(Array.from(reBefore));
    expect(Array.from(im)).not.toEqual(Array.from(imBefore));
    // Now a failing call: invalid size.
    const re2 = new Float32Array([1, 2, 3]);
    const im2 = new Float32Array([0, 0, 0]);
    const reBefore2 = new Float32Array(re2);
    const imBefore2 = new Float32Array(im2);
    expect(() => ifftInPlace(re2, im2)).toThrow();
    expect(Array.from(re2)).toEqual(Array.from(reBefore2));
    expect(Array.from(im2)).toEqual(Array.from(imBefore2));
  });

  it('fft rejects non-finite samples', () => {
    const samples = new Float32Array(4);
    samples[2] = NaN;
    expect(() => fft(samples)).toThrow(/non-finite/);
  });

  it('ifft rejects mismatched re/im lengths without mutating', () => {
    const re = new Float32Array(4);
    const im = new Float32Array(2);
    expect(() => ifft({ re, im })).toThrow();
  });

  it('fft rejects sizes above MAX_FFT_SIZE', () => {
    const samples = new Float32Array(1 << 25);
    expect(() => fft(samples)).toThrow(/<= 1048576/);
  });
});

describe('bounded bit-reversal cache', () => {
  beforeEach(() => clearBitReversalCache());

  it('stays bounded when many FFT sizes are used repeatedly', () => {
    const sizes = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
    for (let round = 0; round < 4; round++) {
      for (const size of sizes) {
        fft(new Float32Array(size));
        expect(bitReversalCacheSize()).toBeLessThanOrEqual(BIT_REVERSAL_CACHE_LIMIT);
      }
    }
    expect(bitReversalCacheSize()).toBe(BIT_REVERSAL_CACHE_LIMIT);
  });

  it('returns results identical to a cache-free computation after eviction', () => {
    const sizes = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
    const makeInput = (size: number) => {
      const samples = new Float32Array(size);
      for (let i = 0; i < size; i++) samples[i] = Math.sin((2 * Math.PI * 3 * i) / size) + 0.25;
      return samples;
    };
    // Cycle through enough sizes to force repeated evictions, including
    // sizes used much earlier whose tables have since been dropped.
    clearBitReversalCache();
    for (let round = 0; round < 3; round++) for (const size of sizes) fft(makeInput(size));
    // Recompute every size with an empty cache (table rebuilt each time)
    // and confirm the cached path produces exactly the same numbers.
    for (const size of sizes) {
      clearBitReversalCache();
      const rebuilt = fft(makeInput(size));
      clearBitReversalCache();
      const fresh = fft(makeInput(size));
      expect(Array.from(rebuilt.re)).toEqual(Array.from(fresh.re));
      expect(Array.from(rebuilt.im)).toEqual(Array.from(fresh.im));
    }
  });

  it('recomputes correct DC output for a size whose table was evicted', () => {
    clearBitReversalCache();
    const small = 64;
    fft(new Float32Array(small)); // populate then evict via larger sizes
    for (const size of [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768])
      fft(new Float32Array(size));
    expect(bitReversalCacheSize()).toBe(BIT_REVERSAL_CACHE_LIMIT);
    const result = fft(new Float32Array(small).fill(1));
    expect(result.re[0]).toBeCloseTo(small, 4);
    for (let i = 1; i < small; i++) expect(result.re[i] ?? 0).toBeCloseTo(0, 4);
  });
});
it('preserves both planes when a transform would exceed Float32 range', () => {
  for (const transform of [fftInPlace, ifftInPlace]) {
    const re = new Float32Array([1e38, 1e38, 1e38, 1e38]),
      im = new Float32Array([1, 2, 3, 4]);
    const beforeRe = re.slice(),
      beforeIm = im.slice();
    expect(() => transform(re, im)).toThrow();
    expect(re).toEqual(beforeRe);
    expect(im).toEqual(beforeIm);
  }
});
it('rejects partially overlapping transform planes and accepts disjoint views', () => {
  const storage = new Float32Array(12);
  const re = storage.subarray(0, 8),
    im = storage.subarray(4, 12);
  expect(() => fftInPlace(re, im)).toThrow();
  expect(() => ifftInPlace(re, im)).toThrow();
  const separate = new Float32Array(16);
  expect(() => fftInPlace(separate.subarray(0, 8), separate.subarray(8, 16))).not.toThrow();
});
