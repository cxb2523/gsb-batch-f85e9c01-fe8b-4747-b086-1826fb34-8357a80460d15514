import { describe, it, expect, beforeEach } from 'vitest';
import {
  BitReversalCache,
  BIT_REVERSAL_CACHE_LIMIT,
  bitReversalCache,
  bitReversalCacheSize,
  buildBitReversalTable,
  clearBitReversalCache,
} from './bit-reversal-cache.js';

describe('BitReversalCache', () => {
  it('retains up to its capacity and evicts the least-recently-used entry', () => {
    const cache = new BitReversalCache(3);
    cache.set(2, buildBitReversalTable(2));
    cache.set(4, buildBitReversalTable(4));
    cache.set(8, buildBitReversalTable(8));
    expect(cache.size).toBe(3);
    // Touch size 2 so size 4 becomes the least recently used.
    expect(cache.get(2)).toBeDefined();
    cache.set(16, buildBitReversalTable(16));
    expect(cache.size).toBe(3);
    expect(cache.has(4)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.has(8)).toBe(true);
    expect(cache.has(16)).toBe(true);
  });

  it('refreshes recency on get so a read entry survives eviction', () => {
    const cache = new BitReversalCache(2);
    cache.set(2, buildBitReversalTable(2));
    cache.set(4, buildBitReversalTable(4));
    expect(cache.get(2)).toBeDefined();
    cache.set(8, buildBitReversalTable(8));
    expect(cache.has(4)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.has(8)).toBe(true);
  });

  it('overwrites an existing entry without growing past the capacity', () => {
    const cache = new BitReversalCache(2);
    const first = buildBitReversalTable(4);
    const replacement = buildBitReversalTable(4);
    cache.set(4, first);
    cache.set(4, replacement);
    expect(cache.size).toBe(1);
    expect(cache.get(4)).toBe(replacement);
  });

  it('works with a capacity of one', () => {
    const cache = new BitReversalCache(1);
    cache.set(2, buildBitReversalTable(2));
    cache.set(4, buildBitReversalTable(4));
    expect(cache.size).toBe(1);
    expect(cache.has(2)).toBe(false);
    expect(cache.has(4)).toBe(true);
  });

  it('rejects non-positive capacities', () => {
    expect(() => new BitReversalCache(0)).toThrow(/positive/);
    expect(() => new BitReversalCache(-1)).toThrow(/positive/);
    expect(() => new BitReversalCache(1.5)).toThrow(/positive/);
  });

  it('clears all entries and recency state', () => {
    const cache = new BitReversalCache(2);
    cache.set(2, buildBitReversalTable(2));
    cache.clear();
    expect(cache.size).toBe(0);
    cache.set(4, buildBitReversalTable(4));
    expect(cache.has(4)).toBe(true);
  });
});

describe('shared FFT bit-reversal cache', () => {
  beforeEach(() => clearBitReversalCache());

  it('exposes the documented capacity and introspection helpers', () => {
    expect(BIT_REVERSAL_CACHE_LIMIT).toBeGreaterThan(0);
    expect(bitReversalCacheSize()).toBe(0);
    bitReversalCache.set(64, buildBitReversalTable(64));
    expect(bitReversalCacheSize()).toBe(1);
    clearBitReversalCache();
    expect(bitReversalCacheSize()).toBe(0);
  });

  it('never holds more than BIT_REVERSAL_CACHE_LIMIT entries across many sizes', () => {
    const sizes = [];
    for (let shift = 1; shift <= 14; shift++) sizes.push(1 << shift);
    for (let round = 0; round < 3; round++) {
      for (const size of sizes) {
        bitReversalCache.set(size, buildBitReversalTable(size));
        expect(bitReversalCacheSize()).toBeLessThanOrEqual(BIT_REVERSAL_CACHE_LIMIT);
      }
    }
    expect(bitReversalCacheSize()).toBe(BIT_REVERSAL_CACHE_LIMIT);
  });

  it('rebuilds an evicted table with identical contents', () => {
    const cache = new BitReversalCache(2);
    cache.set(4, buildBitReversalTable(4));
    cache.set(8, buildBitReversalTable(8));
    cache.set(16, buildBitReversalTable(16)); // evicts size 4
    expect(cache.has(4)).toBe(false);
    const rebuilt = buildBitReversalTable(4);
    cache.set(4, rebuilt);
    expect(Array.from(cache.get(4)!)).toEqual(Array.from(buildBitReversalTable(4)));
  });
});
