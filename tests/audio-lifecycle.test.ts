import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSound } from '../src/audio/index.ts';
import { AudioEngine } from '../src/audio/engine.ts';
import { fakeContext } from './audio-fake.ts';

/** Context-lifecycle coverage: dispose/restart, per-context buffer caches, the voice budget across
 * rebuilds, and making sure pausing / autoplay-suspension never turns into a burst on resume. */

/** Two fake contexts handed out in order, so tests can prove a rebuild really made a new one. */
function contextQueue() {
  const fakes = [fakeContext(), fakeContext({ sampleRate: 16000 })];
  let handed = 0;
  return {
    fakes,
    create: () => fakes[Math.min(handed++, fakes.length - 1)].ctx,
    get handed() { return handed; },
  };
}

const FRAME = { dt: 0.016, moving: 0, grounded: true, sprinting: false, water: false, verticalSpeed: 0, active: true, life: 0.5 };

test('after dispose(), start() builds a new context that sounds again', () => {
  const queue = contextQueue();
  const sound = new GameSound({ createContext: queue.create, strict: true });
  sound.start();
  assert.equal(sound.live, true);
  sound.ui('click');
  assert.ok(queue.fakes[0].count('osc') > 0, 'the first context made sound');

  sound.dispose();
  assert.equal(sound.live, false, 'disposed: silent');
  const before = queue.fakes[1].count('osc');
  sound.ui('click'); sound.threadStep(0, 'power');
  assert.equal(queue.fakes[1].count('osc'), before, 'no sound while disposed');
  assert.equal(queue.handed, 1, 'a disposed engine does not lazily create a context');

  sound.start();
  assert.equal(sound.live, true, 'a new start() brings audio back');
  assert.equal(queue.handed, 2, 'a brand-new context was created');
  assert.equal(queue.fakes[0].raw.state, 'closed', 'the old context was closed');
  const after = queue.fakes[1].count('osc');
  sound.ui('click');
  assert.ok(queue.fakes[1].count('osc') > after, 'and it plays on the new context');
});

test('after dispose(), update() reconnects ambience and footsteps on the new context', () => {
  const queue = contextQueue();
  const sound = new GameSound({ createContext: queue.create, strict: true });
  sound.start();
  sound.update(FRAME);
  assert.equal(queue.fakes[0].count('source'), 3, 'three noise beds on the first context');
  sound.dispose();
  sound.start();
  sound.update({ ...FRAME, moving: 1 });
  assert.equal(queue.fakes[1].count('source') >= 3, true, 'the beds were rebuilt on the new context');
});

test('a rebuilt context gets its own master chain, buses and voice budget', () => {
  const queue = contextQueue();
  const engine = new AudioEngine({ createContext: queue.create });
  engine.start();
  const first = engine.ensure();
  assert.ok(first);
  assert.equal(queue.fakes[0].count('convolver'), 1);
  assert.equal(engine.claim(10, 1), true);
  assert.equal(engine.budget.active(0), 1);

  engine.dispose();
  assert.equal(engine.budget.active(engine.time), 0, 'old voice end times were cleared on dispose');
  assert.equal(engine.ensure(), null, 'ensure() cannot resurrect a disposed engine');

  engine.start();
  const second = engine.ensure();
  assert.ok(second && second !== first, 'a fresh graph, not the old one');
  assert.notEqual(second.ctx, first.ctx);
  assert.equal(queue.fakes[1].count('convolver'), 1, 'the reverb was regenerated on the new context');
  assert.equal(queue.fakes[0].count('convolver'), 1, 'and not again on the old one');
  assert.notEqual(second.master, first.master);
  assert.equal(engine.claim(10, 1), true, 'the budget starts empty again');
});

test('noise and pluck buffers are re-generated for a new context, never reused', () => {
  const fake = fakeContext();
  const engine = new AudioEngine({ createContext: () => fake.ctx });
  engine.start();
  const firstNoise = engine.noise('pink');
  const firstPluck = engine.pluck(165);
  assert.ok(firstNoise && firstPluck);
  assert.equal(engine.noise('pink'), firstNoise, 'cached within one context');
  assert.equal(engine.pluck(165), firstPluck);

  engine.dispose();
  engine.start();
  const secondNoise = engine.noise('pink');
  const secondPluck = engine.pluck(165);
  assert.ok(secondNoise && secondPluck);
  assert.notEqual(secondNoise, firstNoise, 'noise is regenerated, not the dead buffer');
  assert.notEqual(secondPluck, firstPluck, 'plucks are regenerated, not the dead buffer');
});

test('the voice budget resets on rebuild so old voice ends cannot crowd out new ones', () => {
  const fake = fakeContext();
  const engine = new AudioEngine({ createContext: () => fake.ctx });
  engine.start();
  const capacity = engine.budget.capacity;
  for (let i = 0; i < capacity; i++) assert.equal(engine.claim(60, 1), true);
  assert.equal(engine.claim(0.1, 1), false, 'the first context is saturated');

  engine.dispose();
  engine.start();
  for (let i = 0; i < capacity; i++) assert.equal(engine.claim(0.1, 1), true, 'all slots are free again');
});

test('a resumed context does not burst out sounds queued while suspended', async () => {
  const fake = fakeContext();
  fake.raw.state = 'suspended';
  fake.raw.resume = () => new Promise(() => {}); // pending until a gesture, like Chrome
  const sound = new GameSound({ createContext: () => fake.ctx, strict: true });
  sound.start();
  assert.equal(sound.live, true, 'live() is optimistic while the resume is pending');
  const before = fake.count('osc');
  for (let i = 0; i < 20; i++) { sound.ui('click'); sound.threadStep(i, 'power'); sound.threadPickup(); }
  assert.equal(fake.count('osc'), before, 'nothing is scheduled onto a frozen clock');
  await new Promise(resolve => setTimeout(resolve, 520));
  assert.equal(sound.live, false, 'locked after the grace period');

  fake.raw.state = 'running';
  (fake.raw.onstatechange as () => void)();
  assert.equal(sound.live, true);
  assert.equal(fake.count('osc'), before, 'the queue did not burst out on resume');
  sound.ui('click');
  assert.ok(fake.count('osc') > before, 'new events play normally after resume');
});

test('pause/resume cycles queue nothing, and pause flags survive a rebuild', () => {
  const queue = contextQueue();
  const sound = new GameSound({ createContext: queue.create, strict: true });
  const fake = queue.fakes[0];
  sound.start();
  sound.setPaused(true);
  const before = fake.count('osc');
  for (let i = 0; i < 10; i++) sound.ui('click');
  assert.equal(fake.count('osc'), before, 'paused: nothing queued');
  sound.setPaused(false);
  assert.equal(fake.count('osc'), before, 'resuming alone does not replay anything');

  sound.dispose();
  sound.setPaused(true);
  sound.setPaused(false);
  sound.start();
  assert.equal(sound.live, true, 'pause toggles across dispose do not break restart');
  const after = queue.fakes[1].count('osc');
  sound.update(FRAME);
  sound.ui('click');
  assert.ok(queue.fakes[1].count('osc') > after, 'ambience and one-shots come back on the new context');
});

test('a context the browser closed by itself is rebuilt on the next ensure()', () => {
  const queue = contextQueue();
  const engine = new AudioEngine({ createContext: queue.create });
  engine.start();
  const first = engine.ensure();
  assert.ok(first);
  queue.fakes[0].raw.state = 'closed'; // tab discard / audio device removal
  const second = engine.ensure();
  assert.ok(second && second.ctx !== first.ctx, 'ensure() recovers from a context closed outside the engine');
  assert.equal(queue.handed, 2);
});

test('recorded samples are not replayed from a dead context, and registrations survive', () => {
  const fake = fakeContext();
  const engine = new AudioEngine({ createContext: () => fake.ctx });
  engine.start();
  engine.samples.register('ui.click', '/x.ogg');
  engine.dispose();
  assert.equal(engine.ensure(), null, 'samples alone cannot resurrect a disposed engine');
  engine.start();
  const live = engine.ensure()!;
  assert.equal(engine.samples.play(live.ctx, live.sfx.input, 'ui.click'), null, 'no stale decoded buffer is used');
  assert.equal(engine.samples.has('ui.click'), true, 'the registration survives the swap');
});

test('a browser without WebAudio stays a safe no-op through the whole lifecycle', async () => {
  const sound = new GameSound({ strict: true });
  sound.start();
  assert.equal(sound.live, false);
  sound.dispose();
  sound.start();
  assert.equal(sound.live, false);
  sound.ui('click');
  sound.update(FRAME);
  await sound.preloadSamples();
  assert.equal(sound.started, true);
});
