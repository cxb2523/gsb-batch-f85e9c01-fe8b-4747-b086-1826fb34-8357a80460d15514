/**
 * @module spatial-hash
 * @description Uniform-grid spatial hash for 2D broad-phase collision queries.
 * Insertion is O(1) per item (bucket push) and range queries are O(k) in the
 * number of items in the overlapping cells — a dramatic improvement over the
 * O(n²) pairwise scan that the game used in v1.x. Cell size is tuned to be
 * ~2× the largest common entity diameter so a single-cell probe usually
 * suffices. The module is decoupled from game types: buckets just store
 * whatever object you hand them, as long as each has numeric `.x` and `.y`.
 *
 * Layered on top of this class, `src/systems.js` re-exports a thin wrapper
 * tuned for enemies. This file is the authoritative implementation and is
 * the one exercised by the unit tests.
 *
 * Dependencies: none.
 *
 * Exports:
 *   - class SpatialHash
 */

export class SpatialHash {
    /**
     * @param {number} cell - cell edge length in world units (px). 64 is a
     *     good default for this game: matches the biggest non-boss enemy
     *     bounding box so most queries hit a single cell.
     */
    constructor(cell = 64) {
        this.cell = cell;
        /** @type {Map<string, Array<object>>} */
        this.map = new Map();
        this._size = 0;
        // iter-21: remembers which bucket an item was inserted into so
        // `remove(item)` can drop the stale reference in O(bucket) even after
        // the item's `.x/.y` have moved (the tracked key still points at the
        // bucket that physically owns the reference).
        /** @type {WeakMap<object, string>} */
        this._keys = new WeakMap();
    }

    /** Empty every bucket. Cheap and allocation-free. */
    clear() {
        this.map.clear();
        this._keys = new WeakMap();
        this._size = 0;
    }

    get size() {
        return this._size;
    }

    _key(x, y) {
        return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
    }

    /**
     * Insert a single item. The caller owns the item reference; the hash just
     * indexes it for fast neighbour lookup. Items are NOT de-duplicated.
     */
    insert(item) {
        const k = this._key(item.x, item.y);
        let bucket = this.map.get(k);
        if (!bucket) {
            bucket = [];
            this.map.set(k, bucket);
        }
        bucket.push(item);
        this._keys.set(item, k);
        this._size++;
    }

    /** Bulk-insert after a `clear()`. */
    insertAll(items) {
        this.clear();
        if (!items || typeof items[Symbol.iterator] !== 'function') return;
        for (const it of items) this.insert(it);
    }

    /**
     * iter-21: remove one item reference from the index. Safe to call after
     * the item has already moved — the insertion key tracked in `_keys`
     * identifies the bucket that physically contains the reference. Also
     * scrubs the bucket at the item's *current* coordinates as a fallback
     * for indexes built/mutated by older code paths.
     *
     * Accepts either `remove(item)` or the coordinate-first
     * `remove(x, y, item)` form for compatibility with other grid-hash APIs.
     *
     * @returns {boolean} true when at least one reference was removed.
     */
    remove(itemOrX, maybeY, maybeItem) {
        let item = itemOrX;
        if (
            (itemOrX === null || typeof itemOrX !== 'object') &&
            maybeItem &&
            typeof maybeItem === 'object'
        ) {
            // remove(x, y, item) calling convention.
            item = maybeItem;
        }
        if (!item || typeof item !== 'object') return false;

        const keys = new Set();
        const tracked = this._keys.get(item);
        if (tracked !== undefined) keys.add(tracked);
        keys.add(this._key(item.x, item.y));
        if (typeof itemOrX === 'number' && typeof maybeY === 'number') {
            keys.add(this._key(itemOrX, maybeY));
        }

        let removed = 0;
        for (const k of keys) removed += this._removeFromBucket(item, k);
        this._keys.delete(item);
        return removed > 0;
    }

    /** Remove every strict-equal occurrence of `item` from one bucket. */
    _removeFromBucket(item, k) {
        const bucket = this.map.get(k);
        if (!bucket) return 0;
        let removed = 0;
        for (let i = bucket.length - 1; i >= 0; i--) {
            if (bucket[i] === item) {
                bucket.splice(i, 1);
                removed++;
                this._size--;
            }
        }
        if (bucket.length === 0) this.map.delete(k);
        return removed;
    }

    /**
     * iter-21: re-index an item after its `.x/.y` changed. Equivalent to
     * `remove(item); insert(item)`. Items not currently indexed are inserted.
     * Numeric extra arguments are treated as new coordinates:
     * `update(item, x, y)` assigns them before re-indexing.
     */
    update(item, x, y) {
        if (!item || typeof item !== 'object') return;
        if (Number.isFinite(x)) item.x = x;
        if (Number.isFinite(y)) item.y = y;
        this.remove(item);
        this.insert(item);
    }

    /** Alias for {@link SpatialHash.update} used by movement code. */
    move(item, x, y) {
        this.update(item, x, y);
    }

    /**
     * Drop every entry for which `shouldRemove(item)` is truthy. Returns the
     * number of removed references. `retain(isLive)` is the inverse filter.
     */
    prune(shouldRemove) {
        if (typeof shouldRemove !== 'function') return 0;
        let removed = 0;
        for (const [k, bucket] of this.map) {
            for (let i = bucket.length - 1; i >= 0; i--) {
                const item = bucket[i];
                let stale = false;
                try {
                    stale = !!shouldRemove(item);
                } catch {
                    stale = true;
                }
                if (stale) {
                    bucket.splice(i, 1);
                    this._size--;
                    this._keys.delete(item);
                    removed++;
                }
            }
            if (bucket.length === 0) this.map.delete(k);
        }
        return removed;
    }

    /** Keep only entries for which `isLive(item)` is truthy. */
    retain(isLive) {
        if (typeof isLive !== 'function') return 0;
        return this.prune((item) => !isLive(item));
    }

    /**
     * Rebuild the index from `items` (alias of `insertAll`) and return `this`
     * for fluent call sites that want `hash.sync(enemies).queryRect(...)`.
     */
    sync(items) {
        this.insertAll(items || []);
        return this;
    }

    /** Alias of {@link SpatialHash.sync}. */
    rebuild(items) {
        this.insertAll(items || []);
        return this;
    }

    /** @alias remove */
    delete(itemOrX, maybeY, maybeItem) {
        return this.remove(itemOrX, maybeY, maybeItem);
    }

    /** @alias remove */
    removeItem(item) {
        return this.remove(item);
    }

    /** @alias remove (enemy-lifecycle naming used by the game loop) */
    removeEnemy(item) {
        return this.remove(item);
    }

    /** Insert a single enemy-shaped item. @alias insert */
    insertEnemy(item) {
        return this.insert(item);
    }

    /** @alias update */
    updateItem(item, x, y) {
        this.update(item, x, y);
    }

    /** @alias update (enemy-lifecycle naming used by the game loop) */
    updateEnemy(item, x, y) {
        this.update(item, x, y);
    }

    /** @alias update */
    moveItem(item, x, y) {
        this.update(item, x, y);
    }

    /** @alias update */
    relocate(item, x, y) {
        this.update(item, x, y);
    }

    /** @alias update */
    reindex(item, x, y) {
        this.update(item, x, y);
    }

    /**
     * Polymorphic refresh: `refresh(itemsArray)` rebuilds from a roster,
     * while `refresh(item)` re-indexes a single moved item.
     */
    refresh(target, x, y) {
        if (Array.isArray(target)) return this.sync(target);
        this.update(target, x, y);
        return undefined;
    }

    /** @deprecated alias kept for backwards compatibility with v2.x callers. */
    insertEnemies(enemies) {
        this.insertAll(enemies);
    }

    /**
     * Iterate every item whose cell overlaps the square `(x±r, y±r)`. Results
     * may include items further than `r` from the query centre — callers must
     * do the exact distance check. The generator yields each item at most
     * once (cells don't overlap by construction).
     *
     * iter-16 perf: returns a plain array instead of a generator. V8 inlines
     * tight `for (const e of arr)` loops aggressively, and avoiding the
     * generator suspend/resume bookkeeping is measurably faster on hot
     * weapon-fire paths (Lightning's chain hops alone can call this dozens
     * of times per fire). Callers that destructure to `[...sh.queryRect()]`
     * still work because Array is iterable.
     */
    queryRect(x, y, r) {
        const c = this.cell;
        const x0 = Math.floor((x - r) / c);
        const x1 = Math.floor((x + r) / c);
        const y0 = Math.floor((y - r) / c);
        const y1 = Math.floor((y + r) / c);
        const out = [];
        for (let gx = x0; gx <= x1; gx++) {
            for (let gy = y0; gy <= y1; gy++) {
                const b = this.map.get(`${gx},${gy}`);
                if (b) {
                    for (let i = 0; i < b.length; i++) out.push(b[i]);
                }
            }
        }
        return out;
    }

    /**
     * Return the single closest item within `maxRange` (Euclidean distance),
     * or `null` if no bucket is populated within the search square.
     */
    findNearest(x, y, maxRange) {
        let best = null;
        let bestD = maxRange;
        for (const e of this.queryRect(x, y, maxRange)) {
            const d = Math.hypot(e.x - x, e.y - y);
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        return best;
    }

    /** Alias used throughout `weapons.js`/`entities.js`. */
    findNearestEnemy(x, y, maxRange) {
        return this.findNearest(x, y, maxRange);
    }

    /** Count cells currently holding at least one item (for diagnostics). */
    occupiedCellCount() {
        return this.map.size;
    }
}
