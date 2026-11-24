// iter-21 regression coverage — Evolved Frost Nova ("Glacial Cascade")
// delayed pulse lifecycle + SpatialHash consistency.
//
// Acceptance map:
//   A1 moved alive enemies are hit by the delayed pulse using the CURRENT
//      roster/index (no fire-time reference capture).
//   A2 dead / roster-removed enemies take no damage and emit no hit particles.
//   A3 player death during the 0.4s window cancels the pulse.
//   A4 the pulse rides the EffectLayer dt scheduler: wall-clock while paused
//      does nothing; accumulated dt after resume fires it exactly once.
//   A5 SpatialHash remove/update/prune keep queryRect/findNearest aligned
//      with the live enemy list, and the other weapon query paths reject
//      stale references too.
//
// Pure Node tests; scaffolds mirror test/weapons.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Weapon, queryActiveEnemies, isActiveEnemy } from '../src/weapons.js';
import { WEAPONS, ENEMIES } from '../src/data.js';
import { EffectLayer } from '../src/effects.js';
import { SpatialHash } from '../src/spatial-hash.js';
import { Enemy } from '../src/entities.js';
import { Game } from '../src/main.js';

const DELAY = 0.4;

function makePlayer() {
    return {
        x: 0,
        y: 0,
        dead: false,
        passives: {},
        getDamageMult: () => 1,
        getCooldownMult: () => 1,
        getAreaMult: () => 1,
        getCritChance: () => 0,
        weapons: []
    };
}

function makeEnemy(x = 50, y = 0, hp = 100000) {
    return {
        x,
        y,
        hp,
        calls: [],
        slowTimer: 0,
        slowPct: 0,
        takeDamage(d) {
            this.calls.push(d);
            this.hp -= d;
        }
    };
}

// Game scaffold with a REAL EffectLayer + REAL SpatialHash and particle spy.
function makeGame(player, { spatial = true } = {}) {
    const particleCalls = [];
    const g = {
        player,
        enemies: [],
        projectiles: [],
        mines: [],
        effects: new EffectLayer(),
        texts: [],
        particleCalls,
        createParticles(x, y, color, n) {
            particleCalls.push({ x, y, color, n });
        },
        createFloatingText(text, x, y, color, opts) {
            g.texts.push({ text, x, y, color, opts });
        },
        audio: { shoot() {}, explosion() {} }
    };
    if (spatial) g.spatial = new SpatialHash(64);
    return g;
}

function evolvedNova() {
    const w = new Weapon(WEAPONS.FROST_NOVA);
    w.level = WEAPONS.FROST_NOVA.evolveLevel; // 5
    assert.equal(w.isEvolved(), true);
    return w;
}

function seedHash(g) {
    g.spatial.insertAll(g.enemies);
}

// Expected raw damages for a level-5 nova with all multipliers 1.
function expectedDamages(w, p) {
    const main = w.getDamage(p);
    return { main, second: main * 0.6 };
}

// ---------------------------------------------------------------------------
// A1 — movement after the main pulse; delayed pulse uses current positions.
// ---------------------------------------------------------------------------

test('A1 nova delayed pulse hits an enemy that moved INTO range after firing (stale hash, no manual resync)', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const e = makeEnemy(900, 0); // out of main-pulse range
    g.enemies.push(e);
    seedHash(g);

    w.fire(p, g);
    assert.equal(e.calls.length, 0, 'main pulse cannot hit at 900');

    // Move after the main pulse WITHOUT updating the hash. The pulse itself
    // must reconcile the index from the current roster at trigger time.
    e.x = 40;
    e.y = 0;

    g.effects.update(DELAY);
    assert.equal(e.calls.length, 1, 'delayed pulse hits the moved enemy exactly once');
    const { second } = expectedDamages(w, p);
    assert.ok(Math.abs(e.calls[0] - second) < 1e-9, 'second hit is 60% strength');
});

test('A1 nova delayed pulse tracks an enemy that crossed to the opposite side of the player', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const e = makeEnemy(60, 0);
    g.enemies.push(e);
    seedHash(g);

    w.fire(p, g);
    assert.equal(e.calls.length, 1, 'main pulse connects');

    e.x = -120; // still well inside the 200px range, different cells
    g.effects.update(DELAY);

    assert.equal(e.calls.length, 2, 'delayed pulse connects at the new position');
});

test('A1 nova delayed pulse hits moved enemies when the caller re-indexes via spatial.update', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const e = makeEnemy(900, 0);
    g.enemies.push(e);
    seedHash(g);

    w.fire(p, g);
    e.x = 80;
    g.spatial.update(e); // explicit lifecycle API
    g.effects.update(DELAY);

    assert.equal(e.calls.length, 1);
});

test('A1 nova delayed pulse centered on the player’s CURRENT position if the hero moved', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const e = makeEnemy(30, 0);
    g.enemies.push(e);
    seedHash(g);

    w.fire(p, g);
    assert.equal(e.calls.length, 1);

    // Hero walks far away; enemy stays put. Re-index roster positions and
    // move the hero beyond nova range: second pulse must not hit.
    p.x = 500;
    g.effects.update(DELAY);
    assert.equal(e.calls.length, 1, 'enemy is outside the pulse centred on the moved hero');
});

test('A1 nova works without a spatial hash (linear roster fallback)', () => {
    const p = makePlayer();
    const g = makeGame(p, { spatial: false });
    const w = evolvedNova();
    const e = makeEnemy(10, 0);
    g.enemies.push(e);

    w.fire(p, g);
    e.x = 20;
    g.effects.update(DELAY);

    assert.equal(e.calls.length, 2);
});

// ---------------------------------------------------------------------------
// A2 — dead / removed enemies: no damage, no hit particles.
// ---------------------------------------------------------------------------

test('A2 roster-removed enemy referenced by a stale spatial bucket takes no second damage and no particles', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const removed = makeEnemy(50, 0);
    g.enemies.push(removed);
    seedHash(g); // hash now owns a stale reference after removal below

    w.fire(p, g);
    assert.equal(removed.calls.length, 1, 'main pulse hit');

    // Simulate the main loop: kill + splice from the roster, but deliberately
    // leave the stale reference in the hash (worst case the fix must cover).
    g.enemies.splice(g.enemies.indexOf(removed), 1);
    assert.ok(g.spatial.queryRect(0, 0, 200).includes(removed), 'precondition: hash is stale');

    // Reset the spy-equivalent particle log boundary by remembering length.
    const particlesAfterMain = g.particleCalls.length;
    g.effects.update(DELAY);

    assert.equal(removed.calls.length, 1, 'removed enemy is never damaged by the delayed pulse');
    const delayedParticles = g.particleCalls.slice(particlesAfterMain);
    assert.equal(delayedParticles.length, 0, 'pulse with zero valid targets emits no particles');
    const atRemoved = g.particleCalls.filter((c) => c.x === removed.x && c.y === removed.y);
    assert.equal(atRemoved.length, 0, 'no hit particles at the removed enemy position');
    assert.equal(g.effects.delays.length, 0, 'scheduled entry was drained');
});

test('A2 enemy flagged dead (hp <= 0) but still in the roster is not hit twice', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const corpse = makeEnemy(40, 0, 10);
    g.enemies.push(corpse);
    seedHash(g);

    w.fire(p, g); // level-5 damage brings hp well below zero
    assert.equal(corpse.calls.length, 1);
    assert.ok(corpse.hp <= 0);
    corpse.dead = true;

    const before = g.particleCalls.length;
    g.effects.update(DELAY);

    assert.equal(corpse.calls.length, 1, 'corpse takes no second hit');
    assert.equal(g.particleCalls.slice(before).length, 0);
});

test('A2 mixed roster: only current live enemies are hit; stale refs ignored', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const live = makeEnemy(30, 0);
    const gone = makeEnemy(60, 0);
    g.enemies.push(live, gone);
    seedHash(g);

    w.fire(p, g);
    assert.equal(live.calls.length, 1);
    assert.equal(gone.calls.length, 1);

    g.enemies.splice(g.enemies.indexOf(gone), 1); // gone removed, stale hash ref

    g.effects.update(DELAY);

    assert.equal(live.calls.length, 2, 'live enemy receives the second pulse');
    assert.equal(gone.calls.length, 1, 'removed enemy does not');
    // Hit sparks at the live enemy, never at the removed one.
    assert.ok(g.particleCalls.some((c) => c.x === live.x && c.y === live.y));
    assert.ok(!g.particleCalls.some((c) => c.x === gone.x && c.y === gone.y && c.n <= 6));
});

test('A2 effects-layer HitBursts never fire for a removed enemy, but do for live hits', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const live = makeEnemy(35, 0);
    const gone = makeEnemy(55, 0);
    g.enemies.push(live, gone);
    seedHash(g);

    w.fire(p, g);
    g.enemies.splice(g.enemies.indexOf(gone), 1);
    g.effects.update(DELAY);

    const bursts = g.effects.hits.bursts;
    assert.ok(
        bursts.some((b) => b.x === live.x && b.y === live.y),
        'live target emits a hit burst'
    );
    assert.ok(!bursts.some((b) => b.x === gone.x && b.y === gone.y), 'removed target emits none');
});

test('A2 a sole removed enemy yields zero delayed particle/hit feedback of any channel', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const gone = makeEnemy(0, 0); // origin: coincides with the pulse centre
    g.enemies.push(gone);
    seedHash(g);

    w.fire(p, g);
    g.enemies.length = 0;
    g.effects.update(DELAY);

    // Even though the pulse ring is centred on (0,0), it must not be emitted
    // when there are no valid targets, so no feedback can be attributed to
    // the removed enemy at the same coordinates.
    const delayed = g.particleCalls.filter((c) => c.color === '#88ccff' || c.color === '#88ddff');
    assert.equal(delayed.length, 0);
    assert.equal(g.effects.hits.bursts.length, 0);
    assert.equal(gone.calls.length, 1);
});

test('A1/A2 real Enemy instances: moved survivor takes second hit; lethal corpse is a no-op', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const tankDef = { ...ENEMIES.BAT, hp: 100000 };
    const survivor = new Enemy(40, 0, tankDef, 1, 1);
    const victim = new Enemy(50, 0, { ...ENEMIES.BAT, hp: 20 }, 1, 1);
    g.enemies.push(survivor, victim);
    seedHash(g);

    w.fire(p, g); // level-5 main hit ~50 — victim (20 hp) dies, tank survives
    assert.equal(victim.dead, true, 'lethal main-pulse damage flips dead');
    assert.equal(victim.hp, 0);
    const survivorHpAfterMain = survivor.hp;
    assert.ok(survivorHpAfterMain > 0);

    // The engine splices the victim; deliberately leave its stale bucket ref
    // in place to prove the trigger-time roster rebuild/filter handles it.
    g.enemies.splice(g.enemies.indexOf(victim), 1);

    survivor.x = 70; // move after the main pulse
    const victimHp = victim.hp;
    assert.doesNotThrow(() => victim.takeDamage(999), 'dead Enemy ignores further damage');
    assert.equal(victim.hp, victimHp);

    g.effects.update(DELAY);

    const { second } = expectedDamages(w, p);
    assert.ok(
        Math.abs(survivor.hp - (survivorHpAfterMain - second)) < 1e-6,
        'moved live survivor receives exactly the 60% delayed hit'
    );
});

test('A2 queryActiveEnemies rejects every stale/lifecycle shape', () => {
    const roster = [{ x: 1, y: 1 }];
    const rosterSet = new Set(roster);
    assert.equal(isActiveEnemy(roster[0], rosterSet), true);
    assert.equal(isActiveEnemy({ x: 0, y: 0, dead: true }), false);
    assert.equal(isActiveEnemy({ x: 0, y: 0, shouldRemove: true }), false);
    assert.equal(isActiveEnemy({ x: 0, y: 0, hp: 0 }), false);
    assert.equal(isActiveEnemy({ x: 0, y: 0, hp: -5 }), false);
    assert.equal(isActiveEnemy({ x: 0, y: 0, alive: false }), false);
    assert.equal(isActiveEnemy(null), false);
    assert.equal(isActiveEnemy({ x: 0, y: 0 }, rosterSet), false, 'not a roster member');

    const sh = new SpatialHash(64);
    const stale = { x: 0, y: 0 };
    sh.insert(stale);
    sh.insert(roster[0]);
    const g = { enemies: roster, spatial: sh };
    const got = queryActiveEnemies(g, 0, 0, 10000);
    assert.ok(!got.includes(stale));
    assert.ok(got.includes(roster[0]));
});

// ---------------------------------------------------------------------------
// A3 — player death during the delay window.
// ---------------------------------------------------------------------------

test('A3 player.dead set during the window cancels damage and particles', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const e = makeEnemy(40, 0);
    g.enemies.push(e);
    seedHash(g);

    w.fire(p, g);
    assert.equal(e.calls.length, 1);

    p.dead = true;
    const before = g.particleCalls.length;
    g.effects.update(1.0); // enough dt to cross 0.4s

    assert.equal(e.calls.length, 1, 'no second damage after player death');
    assert.equal(g.particleCalls.slice(before).length, 0, 'no particles after player death');
});

test('A3 missing player reference also cancels the pulse safely', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const e = makeEnemy(40, 0);
    g.enemies.push(e);
    seedHash(g);

    w.fire(p, g);
    g.player = null;
    assert.doesNotThrow(() => g.effects.update(DELAY));
    assert.equal(e.calls.length, 1);
});

test('A3 player at hp <= 0 without an explicit dead flag also cancels', () => {
    const p = makePlayer();
    p.hp = 100;
    const g = makeGame(p);
    const w = evolvedNova();
    const e = makeEnemy(40, 0);
    g.enemies.push(e);
    seedHash(g);

    w.fire(p, g);
    p.hp = 0; // lethal damage simulated without flipping `dead`
    g.effects.update(DELAY);
    assert.equal(e.calls.length, 1);
});

// ---------------------------------------------------------------------------
// A4 — scheduler timing / pause semantics through the REAL EffectLayer.
// ---------------------------------------------------------------------------

test('A4 paused time (no update calls, real wall clock) does not fire; residual dt fires once', async () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const e = makeEnemy(40, 0);
    g.enemies.push(e);
    seedHash(g);

    w.fire(p, g);
    assert.equal(g.effects.delays.length, 1, 'follow-up is queued on the effects scheduler');

    // "Paused": the game loop does not call effects.update. Real time passes.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(e.calls.length, 1, 'wall-clock time while paused must not trigger the pulse');

    g.effects.update(0.3);
    assert.equal(e.calls.length, 1, '0.3s < 0.4s remaining threshold');
    g.effects.update(0.09);
    assert.equal(e.calls.length, 1, '0.39s accumulated — still waiting');
    g.effects.update(0.02); // crosses 0.41
    assert.equal(e.calls.length, 2, 'residual dt triggers the pulse');

    g.effects.update(1.0);
    assert.equal(e.calls.length, 2, 'the pulse fires exactly once');
});

test('A4 a single oversized dt after resume still fires exactly once', () => {
    const fx = new EffectLayer();
    let n = 0;
    fx.schedule(DELAY, () => n++);
    fx.update(2);
    assert.equal(n, 1);
    fx.update(2);
    assert.equal(n, 1);
});

// ---------------------------------------------------------------------------
// A5 — SpatialHash lifecycle consistency + other weapon paths.
// ---------------------------------------------------------------------------

test('A5 SpatialHash.remove: queryRect and findNearest drop the removed reference', () => {
    const sh = new SpatialHash(64);
    const a = { x: 10, y: 0, id: 'a' };
    const b = { x: 20, y: 0, id: 'b' };
    sh.insertAll([a, b]);

    assert.equal(sh.remove(a), true);
    assert.equal(sh.size, 1);
    const ids = sh.queryRect(0, 0, 200).map((x) => x.id);
    assert.deepEqual(ids, ['b']);
    assert.equal(sh.findNearest(0, 0, 200), b);
    assert.equal(sh.remove({ x: 999, y: 999 }), false);
});

test('A5 SpatialHash.remove works AFTER the item moved (tracked insertion bucket)', () => {
    const sh = new SpatialHash(64);
    const e = { x: 0, y: 0 };
    sh.insert(e);
    e.x = 500;
    e.y = 500; // moved far, ref still lives in the old bucket
    assert.equal(sh.remove(e), true);
    assert.equal(sh.size, 0);
    assert.equal(sh.queryRect(0, 0, 10000).length, 0);
    assert.equal(sh.queryRect(500, 500, 100).length, 0);
});

test('A5 SpatialHash.update/move re-indexes movement across cells (no miss, no stale hit)', () => {
    const sh = new SpatialHash(64);
    const e = { x: 0, y: 0, id: 'mover' };
    sh.insert(e);

    e.x = 300;
    sh.update(e);

    // New position is discoverable...
    assert.ok(sh.queryRect(300, 0, 40).includes(e));
    assert.equal(sh.findNearest(300, 0, 40), e);
    // ...and the old cell no longer owns it.
    assert.equal(sh.queryRect(0, 0, 40).length, 0);
    assert.equal(sh.size, 1, 'move must not duplicate the entry');

    // Alias coverage.
    e.x = -300;
    sh.move(e);
    assert.ok(sh.queryRect(-300, 0, 40).includes(e));
    assert.equal(sh.queryRect(300, 0, 40).length, 0);
});

test('A5 SpatialHash.prune/retain evict stale entries and report counts', () => {
    const sh = new SpatialHash(64);
    sh.insertAll([
        { x: 0, y: 0, dead: true },
        { x: 10, y: 0, hp: 0 },
        { x: 20, y: 0, hp: 100 }
    ]);
    const removed = sh.prune((e) => e.dead === true || e.hp <= 0);
    assert.equal(removed, 2);
    assert.equal(sh.size, 1);

    const sh2 = new SpatialHash(64);
    sh2.insertAll([
        { x: 0, y: 0, alive: false },
        { x: 5, y: 5, alive: true }
    ]);
    assert.equal(
        sh2.retain((e) => e.alive !== false),
        1
    );
    assert.equal(sh2.size, 1);
});

test('A5 queryActiveEnemies stays correct after insertAll rebuild from the current roster', () => {
    const sh = new SpatialHash(64);
    const enemies = [
        { x: 0, y: 0 },
        { x: 500, y: 0 }
    ];
    sh.insertAll(enemies);
    // Move both, then rebuild exactly like the game loop / nova pulse does.
    enemies[0].x = 40;
    enemies[1].x = -400;
    sh.insertAll(enemies);
    const g = { enemies, spatial: sh };
    const near = queryActiveEnemies(g, 0, 0, 100);
    assert.equal(near.length, 1);
    assert.equal(near[0], enemies[0]);
});

test('A5 melee does not damage a roster-removed enemy left in a stale hash bucket', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = new Weapon(WEAPONS.WHIP);
    const e = makeEnemy(20, 0);
    g.enemies.push(e);
    seedHash(g);

    w.fire(p, g);
    const callsAfterFirst = e.calls.length;
    assert.ok(callsAfterFirst >= 1);

    g.enemies.length = 0; // removed from roster, stale hash ref remains
    w.fire(p, g);
    assert.equal(e.calls.length, callsAfterFirst, 'stale reference is not hit');
});

test('A5 aura does not damage dead/stale hash references', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const garlic = Object.values(WEAPONS).find((w) => w.type === 'aura');
    assert.ok(garlic, 'repo ships an aura weapon');
    const w = new Weapon(garlic);
    const live = makeEnemy(10, 0);
    const stale = makeEnemy(20, 0);
    g.enemies.push(live); // stale deliberately NOT in roster
    g.spatial.insert(live);
    g.spatial.insert(stale);

    w.fire(p, g);
    assert.ok(live.calls.length >= 1);
    assert.equal(stale.calls.length, 0);
});

test('A5 lightning initial targets and chain hops reject stale references', () => {
    const def = Object.values(WEAPONS).find((w) => w.type === 'instant' && w.chain);
    assert.ok(def, 'repo ships a chain instant weapon');
    const w = new Weapon(def);
    w.level = 3; // chain unlocked

    const p = makePlayer();
    // Force deterministic picks.
    let rand = 0;
    const realRandom = Math.random;
    Math.random = () => {
        rand = (rand + 0.37) % 1;
        return rand;
    };
    try {
        const g = makeGame(p);
        const a = makeEnemy(20, 0);
        const stale = makeEnemy(40, 0); // in hash but NOT roster
        const b = makeEnemy(60, 0);
        g.enemies.push(a, b);
        g.spatial.insertAll([a, stale, b]);

        assert.doesNotThrow(() => w.fire(p, g));
        assert.equal(stale.calls.length, 0, 'stale chain candidate never damaged');
        assert.ok(a.calls.length + b.calls.length >= 1);
    } finally {
        Math.random = realRandom;
    }
});

test('A5 Game#_updateEnemies incrementally re-indexes movement and drops deaths/despawns', () => {
    const spatial = new SpatialHash(64);
    const moving = {
        x: 0,
        y: 0,
        hp: 100,
        size: 12,
        damage: 5,
        update() {
            this.x += 300; // crosses several grid cells
        }
    };
    const dying = { x: 10, y: 0, hp: 0, size: 12, damage: 5, update() {} };
    const gone = { x: 99999, y: 99999, hp: 100, boss: false, size: 12, damage: 5, update() {} };
    const fakeGame = {
        spatial,
        enemies: [moving, dying, gone],
        player: { x: 0, y: 0, size: 12, invincible: true, takeDamage() {} },
        createFloatingText() {},
        _onEnemyKilled() {}
    };
    spatial.insertAll(fakeGame.enemies);

    Game.prototype._updateEnemies.call(fakeGame, 0.016, 1, 1);

    assert.deepEqual(fakeGame.enemies, [moving], 'dead and despawned enemies are spliced');
    assert.equal(spatial.size, 1, 'hash references removed with the enemies');
    assert.ok(spatial.queryRect(300, 0, 40).includes(moving), 'moved enemy found at new cell');
    assert.equal(spatial.queryRect(0, 0, 40).length, 0, 'old cell no longer owns the reference');
    assert.equal(spatial.findNearest(300, 0, 60), moving);
});

// ---------------------------------------------------------------------------
// A6 — main pulse values / slow / evolution formula unchanged.
// ---------------------------------------------------------------------------

test('A6 main pulse damage + slow use the existing level/evolution formulas', () => {
    const p = makePlayer();
    const g = makeGame(p);
    const w = evolvedNova();
    const e = makeEnemy(100, 0);
    g.enemies.push(e);

    const main = w.getDamage(p);
    const range = w.getRange(p);
    assert.ok(Math.abs(main - 28 * 1.8) < 1e-9, 'level-5 damage curve: +20%/level');
    assert.ok(Math.abs(range - WEAPONS.FROST_NOVA.baseRange * 1.4) < 1e-9);

    w.fire(p, g);
    assert.ok(Math.abs(e.calls[0] - main) < 1e-9);
    assert.equal(e.slowTimer, WEAPONS.FROST_NOVA.slowDuration);
    assert.equal(e.slowPct, WEAPONS.FROST_NOVA.slowPct);
});
