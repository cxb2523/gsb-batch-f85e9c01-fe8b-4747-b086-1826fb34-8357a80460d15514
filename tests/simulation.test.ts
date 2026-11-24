import assert from 'node:assert/strict';
import test from 'node:test';
import { RaceSimulation } from '../src/simulation';
import { sampleTrack, TRACK_LENGTH } from '../src/track';
import { createBoxVolume, type StaticCollider } from '../src/collision';
import { DIFFICULTIES } from '../src/difficulty';
import { EMPTY_INPUT, type InputState, type Projectile } from '../src/types';

const input = (changes: Partial<InputState> = {}): InputState => ({ ...EMPTY_INPUT, ...changes });
const running = (seed = 42) => { const sim = new RaceSimulation(seed); sim.start(); sim.update(3, input()); return sim; };
const advance = (sim: RaceSimulation, seconds: number, changes: Partial<InputState> = {}) => {
  for (let frame = 0; frame < Math.round(seconds * 60); frame++) sim.update(1 / 60, input(changes));
};
const clearTraffic = (sim: RaceSimulation) => {
  sim.state.racers.slice(1).forEach((racer, i) => { racer.distance = 400 + i * 100; racer.lateral = -5; });
  sim.state.pickups.forEach(pickup => { pickup.cooldown = 100; });
};

test('start resets a seeded six-car, three-lap race and countdown does not advance cars', () => {
  const sim = new RaceSimulation(11);
  assert.equal(sim.state.phase, 'menu');
  sim.start();
  assert.equal(sim.state.phase, 'countdown');
  assert.equal(sim.state.racers.length, 6);
  assert.equal(sim.state.totalLaps, 3);
  assert.equal(sim.state.racers[0].distance, 0);
  assert.equal(sim.state.racers[0].name, '沙暴');
  assert.equal(sim.state.racers[0].color, 0xf16235);
  assert.ok(sim.state.racers.every(racer => racer.lap === 1));
  sim.update(2, input({ throttle: true }));
  assert.equal(sim.state.countdown, 1);
  assert.equal(sim.state.time, 0);
  assert.equal(sim.state.racers[0].speed, 0);
  sim.update(1, input({ throttle: true }));
  assert.equal(sim.state.phase, 'racing');
  assert.ok(sim.state.events.some(event => event.type === 'countdown' && event.text === 'GO!'));
  advance(sim, 1, { throttle: true });
  assert.ok(sim.state.racers[0].distance > 8);
  sim.start();
  assert.equal(sim.state.racers[0].distance, 0);
  assert.equal(sim.state.time, 0);
});

test('throttle accelerates, releasing coasts, brake stops then allows limited reverse', () => {
  const sim = running();
  clearTraffic(sim);
  advance(sim, 2, { throttle: true });
  const car = sim.state.racers[0];
  assert.ok(car.speed > 40);
  const beforeCoast = car.speed;
  advance(sim, 0.2);
  assert.ok(car.speed < beforeCoast && car.speed > beforeCoast - 3);
  advance(sim, 2, { brake: true });
  assert.ok(car.speed < 0 && car.speed >= -8);
  advance(sim, 1, { throttle: true });
  assert.ok(car.speed > 5);
});

test('right steering increases road lateral; left decreases it', () => {
  const right = running(), left = running();
  clearTraffic(right); clearTraffic(left);
  right.state.racers[0].speed = 35;
  left.state.racers[0].speed = 35;
  advance(right, 0.3, { steer: 1, throttle: true });
  advance(left, 0.3, { steer: -1, throttle: true });
  assert.ok(right.state.racers[0].lateral > left.state.racers[0].lateral + 0.7);
  assert.ok(right.state.racers[0].heading < left.state.racers[0].heading);
});

test('pause freezes race time, countdown, racers, pickups, and projectile lifetimes', () => {
  const sim = running();
  advance(sim, 1, { throttle: true });
  sim.state.projectiles.push({ id: 99, type: 'mine', owner: 0, distance: 500, lateral: 4, lifetime: 10, powered: false, target: null });
  sim.pause();
  const snapshot = JSON.stringify({ ...sim.state, events: [] });
  sim.update(4, input({ throttle: true, useItem: true }));
  assert.equal(JSON.stringify(sim.state), snapshot);
  sim.resume();
  assert.equal(sim.state.phase, 'racing');
  sim.update(0.1, input());
  assert.ok(sim.state.time > 1);
  sim.start(); sim.update(0.4, input()); sim.pause(); sim.update(2, input());
  assert.equal(sim.state.countdown, 2.6);
  sim.resume();
  assert.equal(sim.state.phase, 'countdown');
});

test('pickups are collected by proximity, respect inventory, and respawn after cooldown', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0], pickup = sim.state.pickups[1];
  assert.equal(sim.state.pickups.length, 18);
  player.distance = pickup.distance;
  player.lateral = pickup.lateral;
  pickup.cooldown = 0;
  sim.update(1 / 60, input());
  assert.equal(player.item, pickup.type);
  assert.ok(pickup.cooldown > 7);
  assert.ok(sim.state.events.some(event => event.type === 'pickup' && event.racer === 0));
  pickup.cooldown = 0.1;
  advance(sim, 0.3);
  assert.equal(pickup.cooldown, 0);
  assert.equal(player.item, pickup.type);
});

test('rocket hits an opponent and gives temporary protection against chain hits', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0], opponent = sim.state.racers[1];
  player.distance = 40; player.lateral = 0; player.item = 'rocket';
  opponent.distance = 63; opponent.lateral = 0; opponent.speed = 30;
  sim.update(0.2, input({ useItem: true }));
  assert.equal(player.item, null);
  assert.equal(sim.state.hits, 1);
  assert.ok(opponent.hitTime > 0 && opponent.invulnerable > 0);
  assert.ok(sim.state.events.some(event => event.type === 'hit' && event.racer === 1));
  sim.state.projectiles.push({ id: 99, type: 'mine', owner: 0, distance: opponent.distance,
    lateral: opponent.lateral, lifetime: 10, powered: true, target: null });
  sim.update(1 / 90, input());
  assert.equal(sim.state.hits, 1);
});

test('shield consumes an incoming rocket without damage, and item activation is edge-triggered', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0];
  player.distance = 200; player.speed = 35; player.item = 'shield';
  sim.update(1 / 90, input({ useItem: true }));
  assert.ok(player.shield > 5);
  const beforeHit = player.speed;
  sim.state.projectiles.push({ id: 77, type: 'rocket', owner: 1, distance: player.distance - 1.5,
    lateral: player.lateral, lifetime: 10, powered: false, target: 0 });
  sim.update(1 / 90, input({ useItem: true }));
  assert.equal(player.shield, 0);
  assert.equal(player.hitTime, 0);
  assert.ok(player.speed > beforeHit - 1);
  assert.ok(sim.state.events.some(event => event.type === 'shield' && event.text === 'BLOCKED!'));
  player.item = 'nitro';
  sim.update(1 / 90, input({ useItem: true }));
  assert.equal(player.item, 'nitro');
  sim.update(1 / 90, input());
  sim.update(1 / 90, input({ useItem: true }));
  assert.equal(player.item, null);
  assert.ok(player.boostTime > 1.7);
});

test('drift builds item charge and energy, powered nitro lasts longer', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0];
  player.item = 'nitro'; player.speed = 35; player.energy = 20;
  advance(sim, 0.8, { throttle: true, steer: 0.2, drift: true });
  assert.ok(player.charge > 0.3);
  assert.ok(player.energy > 25);
  sim.update(1 / 60, input({ throttle: true }));
  assert.equal(sim.state.drifts, 1);
  player.charge = 1;
  sim.update(1 / 90, input({ useItem: true }));
  assert.ok(player.boostTime > 3.1);
  assert.equal(player.charge, 0);
});

test('energy boost consumes a finite resource and cannot permanently accelerate', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0]; player.speed = 40; player.energy = 30;
  advance(sim, 0.3, { throttle: true, boost: true });
  assert.ok(player.energy < 22);
  assert.ok(player.speed > 49);
  player.energy = 0;
  advance(sim, 0.2, { throttle: true, boost: true });
  assert.ok(player.energy >= 0 && player.energy <= 1);
});

test('the slower tune cruises near 207 km/h, preserves a useful boost, and enforces its hard cap', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0];
  // A fixed, empty piece of road isolates motor tuning from curvature and weapons.
  for (let frame = 0; frame < 240; frame++) {
    player.distance = 25; player.lateral = 0; player.heading = 0;
    sim.update(1 / 60, input({ throttle: true }));
  }
  assert.ok(player.speed > 57 && player.speed < 58);
  player.energy = 100;
  for (let frame = 0; frame < 120; frame++) {
    player.distance = 25; player.lateral = 0; player.heading = 0;
    sim.update(1 / 60, input({ throttle: true, boost: true }));
    assert.ok(player.speed <= 84);
  }
  assert.ok(player.speed > 78);
  assert.ok(player.energy < 41);
  player.speed = 100;
  sim.update(1 / 90, input({ throttle: true }));
  assert.equal(player.speed, 84);
});

test('the charge threshold consistently activates powered items at 99 percent', () => {
  for (const charge of [0.989, 0.99, 0.995, 1]) {
    const sim = running(); clearTraffic(sim);
    const player = sim.state.racers[0];
    player.item = 'shield'; player.charge = charge;
    sim.update(1 / 90, input({ useItem: true }));
    assert.ok(Math.abs(player.shield - ((charge >= 0.99 ? 8.5 : 5.3) - 1 / 90)) < 1e-8);
  }
});

test('multiple seeded races remain controllable at the slower pace with nearby AI competitors', () => {
  for (const seed of [11, 42, 7431]) {
    const sim = running(seed);
    let resets = 0;
    for (let frame = 0; frame < 60 * 110 && sim.state.phase === 'racing'; frame++) {
      const player = sim.state.racers[0];
      const curve = sampleTrack(player.distance + 3).curvature;
      const steer = Math.max(-1, Math.min(1,
        -curve * player.speed * 0.88 / 1.45 - player.lateral * 0.075 + player.heading * 1.3));
      sim.update(1 / 60, input({ throttle: true, steer }));
      resets += sim.state.events.filter(event => event.type === 'reset').length;
    }
    assert.equal(sim.state.phase, 'finished');
    assert.ok(sim.state.time > 76 && sim.state.time < 100);
    assert.equal(resets, 0);
    assert.ok(sim.state.racers[0].rank <= 3);
    const closestOpponent = Math.max(...sim.state.racers.slice(1).map(racer => racer.distance));
    assert.ok(TRACK_LENGTH * 3 - closestOpponent < 400);
  }
});

test('laps, timing, finish order, and the completed result remain stable', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0];
  player.distance = TRACK_LENGTH - 0.1; player.speed = 40;
  sim.state.time = 25;
  sim.update(1 / 60, input({ throttle: true }));
  assert.equal(player.lap, 2);
  assert.ok(sim.state.bestLap > 25);
  assert.ok(sim.state.lastLapTime > 25);
  player.distance = TRACK_LENGTH * 2 - 0.1; player.speed = 40;
  sim.state.time = 50;
  sim.update(1 / 60, input({ throttle: true }));
  assert.equal(player.lap, 3);
  player.distance = TRACK_LENGTH * 3 - 0.1; player.speed = 40;
  sim.state.time = 75;
  sim.update(1 / 60, input({ throttle: true }));
  assert.equal(sim.state.phase, 'finished');
  assert.ok(player.finished);
  assert.equal(player.rank, 1);
  assert.equal(player.lap, 3);
  assert.equal(player.distance, TRACK_LENGTH * 3);
  assert.ok(sim.state.events.some(event => event.type === 'finish'));
  const finishTime = player.finishTime;
  const ranks = sim.state.racers.map(racer => racer.rank);
  sim.update(2, input({ throttle: true }));
  assert.equal(player.finishTime, finishTime);
  assert.deepEqual(sim.state.racers.map(racer => racer.rank), ranks);
});

test('manual and automatic resets preserve progress; menu resets all race statistics', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0];
  player.distance = 340; player.lateral = 21; player.heading = 0.7; player.speed = 60;
  sim.resetPlayer();
  assert.equal(player.distance, 340);
  assert.equal(player.lateral, 0);
  assert.equal(player.heading, 0);
  assert.equal(player.speed, 16);
  assert.ok(player.invulnerable > 0);
  player.lateral = 26;
  sim.update(1 / 90, input());
  assert.equal(player.lateral, 0);
  assert.ok(sim.state.events.some(event => event.type === 'reset'));
  sim.returnToMenu();
  assert.equal(sim.state.phase, 'menu');
  assert.equal(sim.state.racers[0].distance, 0);
  assert.equal(sim.state.time, 0);
});

test('AI advances, uses the track lanes, and seeded long runs retain finite bounds', () => {
  const sim = running(123);
  advance(sim, 8);
  assert.ok(sim.state.racers.slice(1).every(racer => racer.distance > 200));
  assert.ok(sim.state.racers.slice(1).some(racer => racer.item !== null || racer.boostTime > 0));
  let usedWeapons = false;
  for (let frame = 0; frame < 60 * 160; frame++) {
    sim.update(1 / 60, input({ throttle: true, steer: Math.sin(frame * 0.003) * 0.25,
      drift: frame % 180 < 60, boost: frame % 400 < 60, useItem: frame % 90 === 0 }));
    usedWeapons ||= sim.state.events.some(event => ![0].includes(event.racer) && ['fire', 'shield', 'boost'].includes(event.type));
    for (const racer of sim.state.racers) {
      assert.ok([racer.distance, racer.lateral, racer.heading, racer.speed, racer.energy, racer.charge].every(Number.isFinite));
      assert.ok(racer.speed >= -8 && racer.speed <= 84);
      assert.ok(Math.abs(racer.lateral) <= 27);
      assert.ok(racer.energy >= 0 && racer.energy <= 100);
      assert.ok(racer.charge >= 0 && racer.charge <= 1);
      assert.ok(racer.lap >= 1 && racer.lap <= 3);
    }
    assert.equal(new Set(sim.state.racers.map(racer => racer.rank)).size, 6);
  }
  assert.ok(usedWeapons);
  assert.ok(sim.state.racers.slice(1).every(racer => racer.finished));
});

test('invalid time does not poison state and separate simulations reproduce the same race', () => {
  const first = running(99), second = running(99);
  advance(first, 5, { throttle: true }); advance(second, 5, { throttle: true });
  assert.deepEqual(first.state, second.state);
  const distance = first.state.racers[0].distance;
  first.update(Number.NaN, input({ throttle: true }));
  first.update(Number.POSITIVE_INFINITY, input({ throttle: true }));
  assert.equal(first.state.racers[0].distance, distance);
});

// --- Mutual exclusion of shield absorption, invulnerability windows and damage ---

const mineAt = (owner: number, at: { distance: number; lateral: number }, id: number,
  powered = false): Projectile => ({
  id, type: 'mine', owner, distance: at.distance, lateral: at.lateral,
  lifetime: 10, powered, target: null,
});

const weaponWall = (id: string, distance: number, lateral = 0): StaticCollider => {
  const point = sampleTrack(distance);
  return { id, kind: 'barrier', ...createBoxVolume(
    point.x + point.nx * lateral, point.y + 1.5, point.z + point.nz * lateral,
    20, 1.5, 0.08, point.heading) };
};

const finishTraffic = (sim: RaceSimulation) => {
  sim.state.racers.slice(1).forEach(racer => { racer.finished = true; });
};

test('a shield absorbs one hit and its grace window ignores the second same-step weapon', () => {
  const sim = running(); clearTraffic(sim); finishTraffic(sim);
  const car = sim.state.racers[0];
  Object.assign(car, { distance: 200, lateral: 0, heading: 0, speed: 40,
    shield: 5, invulnerable: 0, hitTime: 0 });
  const speedBefore = car.speed;
  // Two weapons at the exact same spot, both resolved inside the single 1/90 step.
  sim.state.projectiles.push(mineAt(1, car, 101), mineAt(2, car, 102));
  sim.update(1 / 90, input());

  assert.equal(car.shield, 0, 'the shield is consumed by the first contact only');
  assert.equal(car.invulnerable, 0.9, 'the spent shield opens the brief block window');
  assert.equal(car.hitTime, 0, 'a blocked contact never starts hit recovery');
  assert.equal(sim.state.hits, 0);
  assert.ok(car.speed > speedBefore - 1, 'the block applies no hit slowdown');
  assert.equal(sim.state.projectiles.length, 0, 'both same-step weapons contacted and were resolved');
  const blocks = sim.state.events.filter(event => event.type === 'shield' && event.text === 'BLOCKED!');
  assert.equal(blocks.length, 1, 'exactly one shield-absorb event');
  assert.ok(!sim.state.events.some(event => event.type === 'hit'), 'absorption and damage never stack');
});

test('a mine inside the protection window does not spend the shield, slow the car or fire a hit', () => {
  const setup = () => {
    const sim = running(); clearTraffic(sim); finishTraffic(sim);
    const car = sim.state.racers[0];
    Object.assign(car, { distance: 205, lateral: 0, heading: 0, speed: 40,
      shield: 4, invulnerable: 1.2, hitTime: 0 });
    return sim;
  };
  const sim = setup();
  const control = setup();
  const car = sim.state.racers[0];
  sim.state.projectiles.push(mineAt(1, car, 201));

  sim.update(1 / 90, input());
  control.update(1 / 90, input());

  assert.ok(Math.abs(car.shield - (4 - 1 / 90)) < 1e-9, 'shield only undergoes normal timer decay');
  assert.ok(car.shield > 3.9, 'the protected contact must not consume the active shield');
  assert.ok(Math.abs(car.invulnerable - (1.2 - 1 / 90)) < 1e-9);
  assert.equal(car.hitTime, 0);
  assert.equal(sim.state.hits, 0);
  assert.equal(sim.state.projectiles.length, 0, 'the mine still makes contact and is removed');
  assert.ok(!sim.state.events.some(event => event.type === 'hit'), 'protection raises no hit event');
  assert.ok(!sim.state.events.some(event => event.type === 'shield' && event.text === 'BLOCKED!'),
    'protection must not look like a shield absorption');
  assert.ok(Math.abs(car.speed - control.state.racers[0].speed) < 1e-9,
    'the protected contact adds no speed loss beyond the identical ambient step');
});

test('after the shield fully expires a weapon deals damage and grants difficulty protection', () => {
  for (const difficulty of ['easy', 'hard', 'hell'] as const) {
    const sim = new RaceSimulation(7, difficulty);
    sim.start(); sim.update(3, input());
    sim.state.pickups.forEach(pickup => { pickup.cooldown = 1000; });
    finishTraffic(sim);
    const car = sim.state.racers[0];
    Object.assign(car, { distance: 180, lateral: 0, heading: 0, speed: 40,
      shield: 1 / 90, invulnerable: 0, hitTime: 0 });
    sim.update(1 / 90, input());
    assert.equal(car.shield, 0, 'the shield timer naturally expires before the hit');

    sim.state.projectiles.push(mineAt(1, car, 301));
    sim.update(1 / 90, input());

    assert.ok(car.hitTime > 0, `${difficulty}: damaging hit starts recovery`);
    assert.equal(car.invulnerable, DIFFICULTIES[difficulty].playerHitProtection,
      `${difficulty}: player protection duration stays sourced from DIFFICULTIES`);
    assert.ok(sim.state.events.some(event => event.type === 'hit' && event.racer === 0));
    assert.equal(sim.state.hits, 0, 'an AI attacker never advances the player hits statistic');
  }
});

test('hits increments only for a damaging player-owned weapon, never for shield or protection blocks', () => {
  const sim = running(); clearTraffic(sim);
  const target = sim.state.racers[1];
  Object.assign(target, { finished: false, distance: 230, lateral: 0, heading: 0, speed: 0,
    shield: 5, invulnerable: 0, hitTime: 0 });

  // Player mine vs an active shield: absorbed, no hit count.
  sim.state.projectiles.push(mineAt(0, target, 401));
  sim.update(1 / 90, input());
  assert.equal(sim.state.hits, 0);
  assert.equal(target.shield, 0);
  assert.equal(target.invulnerable, 0.9);

  // A recharged shield while the grace window is active is preserved by protection.
  target.shield = 5;
  sim.state.projectiles.push(mineAt(0, target, 402));
  sim.update(1 / 90, input());
  assert.equal(sim.state.hits, 0);
  assert.ok(target.shield > 4.9, 'the grace window ignores the mine before the shield is touched');

  // Once both shield and protection are gone the next player mine counts as a real hit.
  target.shield = 0;
  target.invulnerable = 0;
  sim.state.projectiles.push(mineAt(0, target, 403));
  sim.update(1 / 90, input());
  assert.equal(sim.state.hits, 1);
  assert.ok(target.hitTime > 0);
  assert.ok(sim.state.events.some(event => event.type === 'hit' && event.racer === 1
    && event.text === 'DIRECT HIT!'));
});

test('a rocket intercepted by a static obstacle produces only the structure collision event', () => {
  const sim = running(); clearTraffic(sim); finishTraffic(sim);
  const player = sim.state.racers[0];
  Object.assign(player, { distance: 46, lateral: 0, heading: 0, speed: 0 });
  sim.setStaticColliders([weaponWall('weapon-wall', 40)]);
  sim.state.projectiles.push({ id: 501, type: 'rocket', owner: 1, distance: 38,
    lateral: 0, lifetime: 10, powered: false, target: null });

  sim.update(1 / 90, input());

  assert.equal(sim.state.projectiles.length, 0);
  const structures = sim.state.events.filter(event =>
    event.type === 'collision' && event.collisionKind === 'structure');
  assert.equal(structures.length, 1);
  assert.equal(structures[0].text, 'PROJECTILE_BLOCKED');
  assert.ok(!sim.state.events.some(event => event.type === 'hit' || event.type === 'shield'),
    'the blocked rocket never enters the vehicle-hit branch');
  assert.equal(player.hitTime, 0);
  assert.equal(player.invulnerable, 0);
  assert.equal(player.speed, 0, 'traffic behind the obstacle is untouched');
  assert.equal(sim.state.events.length, 1, 'the obstacle contact is the only event in the step');
});

test('pause followed by restart, and return to menu, leave no hit, shield or protection residue', () => {
  const sim = running(); clearTraffic(sim);
  const player = sim.state.racers[0];
  const opponent = sim.state.racers[1];
  Object.assign(player, { distance: 150, lateral: 0, shield: 0, invulnerable: 0, hitTime: 0 });
  Object.assign(opponent, { distance: 172, lateral: 0, shield: 0, invulnerable: 0, hitTime: 0 });
  // One AI-owned mine damages the player; one player-owned mine damages the opponent.
  sim.state.projectiles.push(mineAt(1, player, 601), mineAt(0, opponent, 602));
  sim.update(1 / 90, input());
  assert.ok(player.hitTime > 0 && player.invulnerable > 0);
  assert.ok(opponent.hitTime > 0);
  assert.equal(sim.state.hits, 1);
  player.shield = 2.5; // an active shield value present at pause time

  sim.pause();
  assert.equal(sim.state.phase, 'paused');
  assert.ok(player.hitTime > 0, 'pause freezes rather than clears the live race state');
  sim.start();
  assert.equal(sim.state.phase, 'countdown');
  assert.equal(sim.state.hits, 0);
  assert.deepEqual(sim.state.projectiles, []);
  for (const racer of sim.state.racers) {
    assert.equal(racer.hitTime, 0, `racer ${racer.id} hitTime resets on restart`);
    assert.equal(racer.invulnerable, 0, `racer ${racer.id} invulnerable resets on restart`);
    assert.equal(racer.shield, 0, `racer ${racer.id} shield resets on restart`);
  }

  // Dirty the fresh run again, then abandon it through the menu.
  sim.state.hits = 3;
  sim.state.racers[0].hitTime = 0.7;
  sim.state.racers[0].invulnerable = 1.1;
  sim.state.racers[0].shield = 4;
  sim.returnToMenu();
  assert.equal(sim.state.phase, 'menu');
  assert.equal(sim.state.hits, 0);
  for (const racer of sim.state.racers) {
    assert.equal(racer.hitTime, 0);
    assert.equal(racer.invulnerable, 0);
    assert.equal(racer.shield, 0);
  }
});
