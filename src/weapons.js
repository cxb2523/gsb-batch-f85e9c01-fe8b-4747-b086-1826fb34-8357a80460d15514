/**
 * @module weapons
 * @description Single `Weapon` class that consumes a definition from
 * `data.js` and dispatches to the appropriate `_fire*` strategy each tick.
 * Level scaling formulas:
 *   damage   = base * (1 + (lvl-1) * 0.2) * player.damageMult * critMult
 *   cooldown = base * 0.92^(lvl-1) * player.cooldownMult
 *   range    = base * (1 + (lvl-1) * 0.1) * player.areaMult
 * At `lvl === def.evolveLevel` (5) the weapon enters its shape-changing
 * evolution — see `isEvolved()` and per-type handling below.
 *
 * Dependencies: `./entities.js` (Mine, OrbitShard, Projectile).
 *
 * Exports:
 *   - class Weapon
 */

import { Mine, OrbitShard, Projectile } from './entities.js';

/**
 * iter-21: decide whether a spatial-hash candidate is still a valid target.
 * The broad-phase index is a performance structure, not the authoritative
 * roster: after an enemy dies / is spliced from `game.enemies` (or simply
 * flagged dead pending removal) its reference can linger in a bucket for a
 * frame or in hand-built test indexes. Every weapon damage path funnels
 * through this guard so stale references can never absorb damage or emit
 * hit particles.
 *
 * @param {object} e candidate enemy-like object.
 * @param {Set<object>|null} [roster] set built from the CURRENT
 *     `game.enemies`; when present, reference membership is required.
 * @returns {boolean}
 */
export function isActiveEnemy(e, roster = null) {
    if (!e || typeof e !== 'object') return false;
    // Explicit lifecycle flags used across the codebase / test doubles.
    if (e.dead === true || e.removed === true || e.shouldRemove === true || e._removed === true) {
        return false;
    }
    if (e.alive === false || e.active === false) return false;
    if (typeof e.isDead === 'function' && e.isDead()) return false;
    if (typeof e.isAlive === 'function' && e.isAlive() === false) return false;
    // Enemy.takeDamage leaves dead foes at hp <= 0 until the main loop
    // splices them; never damage the corpse a second time.
    if (Number.isFinite(e.hp) && e.hp <= 0) return false;
    if (roster && !roster.has(e)) return false;
    return true;
}

/**
 * Build a Set of the current enemy roster, or `null` when the game exposes
 * no array (defensive — unit scaffolds sometimes provide only a hash).
 */
function buildRoster(game) {
    return game && Array.isArray(game.enemies) ? new Set(game.enemies) : null;
}

/**
 * Resolve the validated broad-phase candidates around `(x, y)`: queries
 * `game.spatial` when available, otherwise scans `game.enemies`. Every result
 * is filtered through {@link isActiveEnemy} against the CURRENT roster and
 * de-duplicated (a reference can occur twice if a caller double-indexed).
 *
 * The exact range check is still the caller's responsibility — queryRect is
 * a broad phase and may return neighbours outside the requested radius.
 *
 * @returns {object[]} fresh array of valid enemy references.
 */
export function queryActiveEnemies(game, x, y, radius) {
    const roster = buildRoster(game);
    const hasRoster = Array.isArray(game?.enemies);
    let candidates;
    const hash = game?.spatial;
    // A present-but-completely-empty index paired with a non-empty roster
    // means the broad phase was never populated (minimal unit scaffolds).
    // Fall back to the authoritative roster instead of hiding every target.
    const indexUnpopulated =
        hash &&
        typeof hash.queryRect === 'function' &&
        typeof hash.size === 'number' &&
        hash.size === 0 &&
        hasRoster &&
        game.enemies.length > 0;
    if (hash && typeof hash.queryRect === 'function' && !indexUnpopulated) {
        candidates = hash.queryRect(x, y, radius);
    } else {
        candidates = hasRoster ? game.enemies : [];
    }
    const out = [];
    const seen = new Set();
    for (const e of candidates) {
        if (!isActiveEnemy(e, roster)) continue;
        if (seen.has(e)) continue;
        seen.add(e);
        out.push(e);
    }
    return out;
}

/**
 * Roster/liveness-safe equivalent of `spatial.findNearestEnemy(...)`.
 * Returns the closest valid enemy strictly within `maxRange`, or `null`.
 */
function findActiveNearestEnemy(game, x, y, maxRange) {
    let best = null;
    let bestD = maxRange;
    for (const e of queryActiveEnemies(game, x, y, maxRange)) {
        const d = Math.hypot(e.x - x, e.y - y);
        if (d < bestD) {
            bestD = d;
            best = e;
        }
    }
    return best;
}

export class Weapon {
    constructor(def) {
        this.def = def;
        this.id = def.id;
        this.name = def.name;
        this.icon = def.icon;
        this.level = 1;
        this.cooldown = 0;
        this._shards = null; // orbit-only
    }

    levelUp() {
        this.level++;
    }

    isEvolved() {
        return !!this.def.evolveLevel && this.level >= this.def.evolveLevel;
    }

    update(dt, player, game) {
        // Orbit weapon ticks every frame (maintains shards), but re-fires on cooldown
        // to refresh damage state. Everything else fires on its cooldown.
        if (this.def.type === 'orbit') {
            this._ensureShards(player);
            for (const s of this._shards) s.update(dt, player, game);
            return;
        }
        this.cooldown -= dt;
        if (this.cooldown <= 0) {
            this.fire(player, game);
            this.cooldown = this.getCooldown(player);
        }
    }

    getDamage(player) {
        let base = this.def.baseDamage * (1 + (this.level - 1) * 0.2) * player.getDamageMult();
        // iter-14 evolution micro-tweak: a per-weapon evolved damage scalar.
        if (this.isEvolved() && this.def.evolveDamageMult) {
            base *= this.def.evolveDamageMult;
        }
        return base;
    }

    _rollCrit(player, game, baseDamage, x, y, color) {
        // iter-14: evolved weapons may add a flat crit-chance bonus on top
        // of the player's passive-derived crit chance. Stacks additively
        // because the player's crit chance is already a sum of LUCK stacks.
        let chance = player.getCritChance();
        if (this.isEvolved() && this.def.evolveBonusCrit) {
            chance += this.def.evolveBonusCrit;
        }
        if (chance > 0 && Math.random() < chance) {
            const dmg = baseDamage * 2;
            game.createFloatingText(Math.round(dmg), x, y, '#ffee44', { crit: true });
            return dmg;
        }
        game.createFloatingText(Math.round(baseDamage), x, y, color);
        return baseDamage;
    }

    getCooldown(player) {
        let cd = this.def.baseCooldown * Math.pow(0.92, this.level - 1) * player.getCooldownMult();
        // iter-14: evolution can shave additional cooldown (Twin Arc).
        if (this.isEvolved() && this.def.evolveCooldownMult) {
            cd *= this.def.evolveCooldownMult;
        }
        return cd;
    }

    getRange(player) {
        return this.def.baseRange * (1 + (this.level - 1) * 0.1) * player.getAreaMult();
    }

    getOrbitShardCount(player) {
        // Each 2 weapon levels adds a shard; evolved doubles and mirrors.
        let n = this.def.projectileCount + Math.floor((this.level - 1) / 2);
        if (this.isEvolved()) n = n * 2;
        // Extra shard for every 2 cooldown passives (just a fun passive synergy).
        const extra = Math.floor((player.passives?.cooldown?.count || 0) / 2);
        return Math.min(12, n + extra);
    }

    _ensureShards(player) {
        const count = this.getOrbitShardCount(player);
        const radius = this.getRange(player);
        const dmg = this.getDamage(player);
        if (!this._shards || this._shards.length !== count) {
            this._shards = [];
            for (let i = 0; i < count; i++) {
                this._shards.push(new OrbitShard(this, i, count, radius, dmg));
            }
        } else {
            // Update params in place.
            for (const s of this._shards) {
                s.radius = radius;
                s.damage = dmg;
                s.total = count;
            }
        }
    }

    renderExtras(ctx) {
        if (this.def.type === 'orbit' && this._shards) {
            for (const s of this._shards) s.render(ctx);
        }
    }

    fire(player, game) {
        switch (this.def.type) {
            case 'melee':
                return this._fireMelee(player, game);
            case 'projectile':
                return this._fireProjectile(player, game);
            case 'instant':
                return this._fireInstant(player, game);
            case 'aura':
                return this._fireAura(player, game);
            case 'mine':
                return this._fireMine(player, game);
            case 'nova':
                return this._fireNova(player, game);
            case 'drain':
                return this._fireDrain(player, game);
        }
    }

    _fireMelee(player, game) {
        const range = this.getRange(player);
        const baseDmg = this.getDamage(player);
        const hit = new Set();
        const evolved = this.isEvolved();
        // iter-16 perf: query the spatial hash for the bounding-box of the
        // sweep instead of walking every enemy. With 200 enemies on screen
        // the linear scan was ~200 hypot calls per fire — the hash trims it
        // to whatever lives in the overlapping cells (typically <30 in a
        // forest spawn cluster). iter-21: results are roster/liveness
        // validated so stale hash references cannot be hit after death.
        const candidates = queryActiveEnemies(game, player.x, player.y, Math.max(range, 40));
        for (const enemy of candidates) {
            const dx = enemy.x - player.x;
            const dy = enemy.y - player.y;
            if (evolved) {
                // Full circular sweep
                if (Math.hypot(dx, dy) > range) continue;
            } else {
                if (Math.abs(dx) > range) continue;
                if (Math.abs(dy) > 40) continue;
            }
            if (hit.has(enemy)) continue;
            hit.add(enemy);
            const dmg = this._rollCrit(player, game, baseDmg, enemy.x, enemy.y - 20, '#ffaa00');
            enemy.takeDamage(dmg);
        }
        if (evolved) {
            game.createParticles(player.x, player.y, '#ff6644', 12);
        } else {
            game.createParticles(player.x - range / 2, player.y, '#ffaa00', 5);
            game.createParticles(player.x + range / 2, player.y, '#ffaa00', 5);
        }
        game.audio.shoot();
    }

    _fireProjectile(player, game) {
        let count = this.def.projectileCount + Math.floor((this.level - 1) / 2);
        if (this.isEvolved() && this.id === 'knife') count = Math.max(count, 5);
        if (this.isEvolved() && this.id === 'magic_wand') count += 2;
        const spreadDeg = count > 1 ? (this.isEvolved() ? 24 : 14) : 0;
        // iter-21: never seed a projectile from a stale spatial reference.
        const target = findActiveNearestEnemy(game, player.x, player.y, this.getRange(player));
        if (!target) return;
        const base = Math.atan2(target.y - player.y, target.x - player.x);
        for (let i = 0; i < count; i++) {
            const offset = ((i - (count - 1) / 2) * spreadDeg * Math.PI) / 180;
            game.projectiles.push(
                new Projectile(
                    player.x,
                    player.y,
                    base + offset,
                    this.def,
                    this.getDamage(player),
                    this.level,
                    player
                )
            );
        }
        game.audio.shoot();
    }

    _fireInstant(player, game) {
        const range = this.getRange(player);
        const baseDmg = this.getDamage(player);
        // iter-16 perf: spatial probe + materialise into an array (we still
        // need indexed access for the random-pick loop and the chain hops).
        // iter-21: validated against the current roster/liveness.
        const candIter = queryActiveEnemies(game, player.x, player.y, range);
        const targets = [];
        for (const e of candIter) {
            if (Math.hypot(e.x - player.x, e.y - player.y) < range) targets.push(e);
        }
        if (!targets.length) return;
        const evolved = this.isEvolved();
        const strikes = evolved ? Math.min(3, targets.length) : 1;
        const picked = new Set();
        for (let i = 0; i < strikes; i++) {
            let target = null;
            while (picked.size < targets.length) {
                const cand = targets[Math.floor(Math.random() * targets.length)];
                if (!picked.has(cand)) {
                    target = cand;
                    picked.add(cand);
                    break;
                }
            }
            if (!target) break;
            const dmg = this._rollCrit(player, game, baseDmg, target.x, target.y - 20, '#ffff66');
            target.takeDamage(dmg);
            game.createParticles(target.x, target.y, '#ffff66', 14);

            if (this.def.chain && this.level >= 3) {
                let current = target;
                const chained = new Set([current]);
                const chainCount = evolved ? this.def.chainCount + 2 : this.def.chainCount;
                for (let c = 0; c < chainCount; c++) {
                    let nearest = null,
                        minD = Infinity;
                    // iter-16 perf: Lightning chain hops within 180 px, so
                    // a per-hop spatial probe of the same radius is the
                    // exact set we want. Drops chain cost from O(C × N) to
                    // O(C × cells_in_180px) which is small-constant on
                    // even the densest waves. iter-21: stale references are
                    // filtered before they can absorb chain damage.
                    const hopCands = queryActiveEnemies(game, current.x, current.y, 180);
                    for (const e of hopCands) {
                        if (chained.has(e)) continue;
                        const d = Math.hypot(e.x - current.x, e.y - current.y);
                        if (d < 180 && d < minD) {
                            minD = d;
                            nearest = e;
                        }
                    }
                    if (!nearest) break;
                    nearest.takeDamage(dmg * 0.7);
                    game.createParticles(nearest.x, nearest.y, '#ffff66', 8);
                    chained.add(nearest);
                    current = nearest;
                }
            }
        }
        game.audio.shoot();
    }

    _fireAura(player, game) {
        const range = this.getRange(player);
        const dmg = this.getDamage(player);
        // iter-16 perf: cells overlapping the aura radius only. Aura is
        // called every cooldown tick (~1s default) so the savings stack up.
        // iter-21: roster/liveness validated like every other query path.
        const candidates = queryActiveEnemies(game, player.x, player.y, range);
        for (const enemy of candidates) {
            const d = Math.hypot(enemy.x - player.x, enemy.y - player.y);
            if (d < range) enemy.takeDamage(dmg);
        }
        if (Math.random() < 0.4) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.random() * range;
            game.createParticles(
                player.x + Math.cos(a) * r,
                player.y + Math.sin(a) * r,
                '#88ff88',
                1
            );
        }
    }

    _fireMine(player, game) {
        const radius = this.getRange(player);
        const dmg = this.getDamage(player);
        const fuse = this.def.fuse || 1.2;
        game.mines = game.mines || [];
        game.mines.push(new Mine(player.x, player.y, radius, dmg, fuse));
        if (this.isEvolved()) {
            // Cluster: second mine offset slightly
            const a = Math.random() * Math.PI * 2;
            game.mines.push(
                new Mine(
                    player.x + Math.cos(a) * 60,
                    player.y + Math.sin(a) * 60,
                    radius * 0.8,
                    dmg,
                    fuse
                )
            );
        }
        game.audio?.shoot?.();
    }

    /**
     * Frost Nova: radial burst centred on the hero that damages every foe
     * within `range` and applies a timed slow. Evolved variant fires a
     * second delayed ring at 60% strength for a staggered AOE.
     */
    _fireNova(player, game) {
        const range = this.getRange(player);
        const baseDmg = this.getDamage(player);
        const slowPct = this.def.slowPct ?? 0.5;
        const slowDur = this.def.slowDuration ?? 1.2;
        // iter-16 perf: spatial probe instead of a full enemy walk. Nova has
        // a fairly wide range (~range+nova default), so several cells are
        // visited each fire — but in dense waves this still shaves >70%
        // of the per-enemy hypot() calls. iter-21: candidates are validated
        // against the current roster/liveness so stale buckets cannot hit
        // dead/removed enemies.
        const candidates = queryActiveEnemies(game, player.x, player.y, range);
        for (const enemy of candidates) {
            const d = Math.hypot(enemy.x - player.x, enemy.y - player.y);
            if (d < range) {
                const dmg = this._rollCrit(player, game, baseDmg, enemy.x, enemy.y - 20, '#88ddff');
                enemy.takeDamage(dmg);
                // Slow is cooperative: entities.js reads `slowTimer` / `slowPct`.
                if (!enemy.slowTimer || enemy.slowTimer < slowDur) {
                    enemy.slowTimer = slowDur;
                    enemy.slowPct = slowPct;
                }
            }
        }
        game.createParticles(player.x, player.y, '#aaeeff', 24);
        if (this.isEvolved()) {
            // Queue a follow-up pulse ~0.4s later, at 60% damage. Goes through
            // the effects layer so it pauses with the game / tab visibility,
            // unlike a wall-clock setTimeout. Captures `range`/`baseDmg` at
            // fire-time so a stat change between pulses doesn't retro-buff.
            const r = range;
            const d2 = baseDmg * 0.6;
            game.effects?.schedule?.(0.4, () => {
                // Requirement: if the hero died during the delay window the
                // follow-up never executes (no damage, no particles). Check
                // both the authoritative `dead` flag and hp <= 0 for scaffolds
                // that simulate lethal damage without flipping the flag.
                if (!game || !game.player || game.player.dead === true || game.player.hp <= 0) {
                    return;
                }

                // Re-resolve candidates AT TRIGGER TIME from the current
                // enemy set. Rebuild the broad-phase index from the live
                // roster first so movement across cells and deaths/removals
                // since the main pulse cannot leave stale buckets behind.
                // Full rebuild is O(n) and runs at most once per 0.4s pulse.
                if (game.spatial && typeof game.spatial.insertAll === 'function') {
                    if (Array.isArray(game.enemies)) game.spatial.insertAll(game.enemies);
                }

                const hits = [];
                for (const e of queryActiveEnemies(game, player.x, player.y, r)) {
                    const d = Math.hypot(e.x - player.x, e.y - player.y);
                    if (d < r) hits.push(e);
                }
                if (hits.length === 0) return;

                for (const e of hits) {
                    e.takeDamage(d2);
                    // Hit feedback is emitted only for validated, current
                    // targets — a dead/removed reference never reaches here.
                    // `createParticles` is the weapon-layer spark pool and
                    // `effects.hit` feeds the effects-layer HitBursts; both are
                    // optional so minimal unit scaffolds stay silent.
                    game.createParticles?.(e.x, e.y, '#88ddff', 6);
                    game.effects?.hit?.(e.x, e.y, '170,221,255');
                }
                game.createParticles?.(player.x, player.y, '#88ccff', 16);
            });
        }
        game.audio?.shoot?.();
    }

    /**
     * Soul Drain: short-range tether to the nearest foe. Ticks damage each
     * fire, and heals the hero for `lifestealPct × damageDealt`. Evolved
     * variant drains two foes simultaneously.
     */
    _fireDrain(player, game) {
        const range = this.getRange(player);
        const baseDmg = this.getDamage(player);
        const steal = this.def.lifestealPct ?? 0.25;
        const targetCount = this.isEvolved() ? 2 : 1;
        const targets = [];
        // Pick nearest N enemies within range. iter-21: skip dead/removed.
        const nearby = (Array.isArray(game.enemies) ? game.enemies : [])
            .filter((e) => isActiveEnemy(e) && Math.hypot(e.x - player.x, e.y - player.y) < range)
            .sort(
                (a, b) =>
                    Math.hypot(a.x - player.x, a.y - player.y) -
                    Math.hypot(b.x - player.x, b.y - player.y)
            );
        for (let i = 0; i < targetCount && i < nearby.length; i++) targets.push(nearby[i]);
        if (!targets.length) return;
        let totalDmg = 0;
        for (const e of targets) {
            const dmg = this._rollCrit(player, game, baseDmg, e.x, e.y - 16, '#ff66aa');
            e.takeDamage(dmg);
            totalDmg += dmg;
            // Cheap "tether" visual = particle streak.
            game.createParticles((player.x + e.x) / 2, (player.y + e.y) / 2, '#ff88cc', 2);
        }
        if (player.heal) player.heal(totalDmg * steal);
    }
}
