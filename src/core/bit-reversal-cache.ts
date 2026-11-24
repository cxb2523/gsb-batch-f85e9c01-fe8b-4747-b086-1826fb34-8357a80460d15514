// Bounded LRU cache for FFT bit-reversal tables.
//
// A bit-reversal table for an N-point FFT costs N Uint32 entries, so caching
// every size ever requested without a limit grows without bound when a user
// repeatedly switches FFT sizes in the workbench. This module keeps at most
// BIT_REVERSAL_CACHE_LIMIT tables and evicts the least-recently-used entry
// once the limit is reached. An evicted size is simply rebuilt on its next
// use, so correctness never depends on a table staying resident.
//
// The cache is an internal implementation detail of the FFT routines: it is
// not re-exported from the package barrels. The introspection helpers exist
// for tests that need deterministic cache state.

export const BIT_REVERSAL_CACHE_LIMIT = 8;

interface CachedTable {
  table: Uint32Array;
  /** Monotonic recency stamp; larger means used more recently. */
  stamp: number;
}

export class BitReversalCache {
  private readonly entries = new Map<number, CachedTable>();
  private nextStamp = 0;
  constructor(private readonly limit: number = BIT_REVERSAL_CACHE_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError(`cache limit must be a positive safe integer, got ${limit}`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get capacity(): number {
    return this.limit;
  }

  has(n: number): boolean {
    return this.entries.has(n);
  }

  /** Return the cached table, marking it as most-recently-used. */
  get(n: number): Uint32Array | undefined {
    const entry = this.entries.get(n);
    if (!entry) return undefined;
    entry.stamp = this.nextStamp++;
    return entry.table;
  }

  /**
   * Insert a freshly built table. When the cache is full the entry with the
   * oldest recency stamp is evicted before the new one is stored.
   */
  set(n: number, table: Uint32Array): void {
    const existing = this.entries.get(n);
    if (existing) {
      existing.table = table;
      existing.stamp = this.nextStamp++;
      return;
    }
    if (this.entries.size >= this.limit) {
      let oldestKey: number | undefined;
      let oldestStamp = Number.POSITIVE_INFINITY;
      for (const [key, entry] of this.entries) {
        if (entry.stamp < oldestStamp) {
          oldestStamp = entry.stamp;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(n, { table, stamp: this.nextStamp++ });
  }

  clear(): void {
    this.entries.clear();
    this.nextStamp = 0;
  }
}

export function buildBitReversalTable(n: number): Uint32Array {
  const bits = Math.log2(n);
  const table = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let j = 0; j < bits; j++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    table[i] = r;
  }
  return table;
}

/** Process-wide shared cache used by the FFT entry points. */
export const bitReversalCache = new BitReversalCache();

/** Drop every cached table (test helper). */
export function clearBitReversalCache(): void {
  bitReversalCache.clear();
}

/** Number of tables currently resident in the shared cache (test helper). */
export function bitReversalCacheSize(): number {
  return bitReversalCache.size;
}
