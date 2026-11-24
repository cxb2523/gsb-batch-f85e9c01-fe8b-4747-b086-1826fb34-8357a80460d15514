// 重开必须是一次完整的世界重置，而不是只把 phase/wave 改回初始值。
// 这里专门守住所有跨帧集合、特效计时器、未交付事件以及暂停/结束状态。
import test from "node:test";
import assert from "node:assert/strict";

import { BUILD_TIME, CARROT_HP, ECONOMY, TOWERS, TOWER_ORDER, WAVE_COUNT } from "../js/data.js";
import {
  createGame, update, resetGame, restartGame, PHASE,
} from "../js/game.js";
import { hudViewModel, applyHudViewModel, resetHudCache } from "../js/hudvm.js";

function makeDirtyState(phase = PHASE.WAVE, paused = false) {
  const state = createGame(42);

  // 真实对局中会累积或变化的标量。
  state.phase = phase;
  state.paused = paused;
  state.speed = 3;
  state.time = 123.45;
  state.waveStartTime = 120;
  state.coins = 1;
  state.hp = 2;
  state.wave = 9;
  state.buildTimer = 0.25;
  state.nextId = 999;

  state.stats.kills = 8;
  state.stats.leaks = 6;
  state.stats.built = 5;
  state.stats.spent = 900;
  state.stats.earned = 432;

  // 所有不能穿越到新一局的集合。
  state.towers.push({ id: 101, type: "cannon" });
  state.enemies.push({ id: 102, type: "slime", hp: 1 });
  state.projectiles.push({ id: 103, x: 10, y: 20, targetId: 102 });
  state.pending.push({ at: 0.5, type: "slime", scale: 1, lane: 0 });
  state.floats.push({ x: 30, y: 40, text: "+7", life: 0.4, kind: "coin" });
  state.particles.push({ x: 50, y: 60, life: 0.1, kind: "pop" });

  // 故意不调用 update：这些事件就是“尚未交付”的旧局事件。
  state.events.push({ type: "leak", marker: "old-leak" });
  state.events.push({ type: "lost", marker: "old-lost" });

  state.shake = { t: 0.32, dur: 0.36, mag: 12 };
  state.carrotFlinch = 0.5;

  return state;
}

function assertFreshWorld(state, seed = 42) {
  assert.deepEqual(state, createGame(seed), "重置后的完整状态应与同种子的新对局一致");
  assert.equal(state.seed, seed);
  assert.equal(state.phase, PHASE.BUILD);
  assert.equal(state.paused, false);
  assert.equal(state.speed, 1);
  assert.equal(state.time, 0);
  assert.equal(state.wave, 0);
  assert.equal(state.coins, ECONOMY.startCoins);
  assert.equal(state.hp, CARROT_HP);
  assert.equal(state.maxHp, CARROT_HP);
  assert.equal(state.buildTimer, BUILD_TIME);
  assert.equal(state.nextId, 1);

  assert.deepEqual(state.towers, []);
  assert.deepEqual(state.enemies, []);
  assert.deepEqual(state.projectiles, []);
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.floats, []);
  assert.deepEqual(state.particles, []);
  assert.deepEqual(state.events, []);

  assert.deepEqual(state.stats, {
    kills: 0, leaks: 0, built: 0, spent: 0, earned: 0,
  });
  assert.deepEqual(state.shake, { t: 0, dur: 0.3, mag: 0 });
  assert.equal(state.carrotFlinch, 0);

  // waveStartTime 只在开波后存在；重开后这个阶段字段也不能残留。
  assert.equal(state.waveStartTime, undefined);
}

test("resetGame 清空战斗残留、未交付事件、特效、时间、波次与统计", () => {
  const state = makeDirtyState(PHASE.WAVE);
  const originalRef = state;
  const arrayRefs = ["projectiles", "pending", "floats", "particles", "events"].map((key) => state[key]);
  const statsRef = state.stats;
  const shakeRef = state.shake;

  assert.equal(state.projectiles.length, 1);
  assert.equal(state.pending.length, 1);
  assert.equal(state.floats.length, 1);
  assert.equal(state.particles.length, 1);
  assert.equal(state.events.length, 2);
  assert.ok(state.shake.t > 0);
  assert.ok(state.carrotFlinch > 0);

  const returned = resetGame(state);

  assert.equal(returned, originalRef, "重置应原地作用于同一个状态容器");
  for (const ref of arrayRefs) assert.equal(ref.length, 0, "重开前捕获的集合引用也必须被清空");
  assert.equal(state.stats, statsRef, "统计对象应原地归零");
  assert.equal(state.shake, shakeRef, "震屏对象应原地归零");
  assertFreshWorld(state);

  const firstFrameEvents = update(state, 1 / 60);
  assert.deepEqual(firstFrameEvents, [], "干净新局首帧不应结算出任何事件");
  assert.deepEqual(state.events, [], "首帧后事件队列应为空");
  assert.equal(
    firstFrameEvents.some((event) => String(event.marker || "").startsWith("old-")),
    false,
    "旧局未交付事件不能在新局首帧补放",
  );
  assert.equal(state.phase, PHASE.BUILD);
  assert.equal(state.wave, 0);
});

test("暂停中重开也回到未暂停的干净布防局", () => {
  const state = makeDirtyState(PHASE.WAVE, true);
  assert.equal(state.paused, true);

  resetGame(state);

  assertFreshWorld(state);
  const events = update(state, 1 / 60);
  assert.deepEqual(events, []);
  assert.equal(state.paused, false);
  assert.equal(state.time, 1 / 60, "新局 update 应正常推进，而不是仍处于暂停冻结");
});

for (const phase of [PHASE.WON, PHASE.LOST]) {
  test(`${phase} 结算状态下重开同样干净，且旧事件不会补放`, () => {
    const state = makeDirtyState(phase);

    resetGame(state, 7);

    assertFreshWorld(state, 7);
    const events = update(state, 1 / 60);
    assert.deepEqual(events, []);
    assert.equal(state.phase, PHASE.BUILD);
    assert.equal(state.paused, false);
  });
}

test("布防阶段重开也会清掉所有跨帧视觉数据", () => {
  const state = makeDirtyState(PHASE.BUILD);

  resetGame(state);

  assertFreshWorld(state);
  assert.deepEqual(update(state, 1 / 60), []);
});

test("restartGame 是 resetGame 的兼容别名", () => {
  assert.equal(restartGame, resetGame);
  const state = makeDirtyState();
  restartGame(state, 99);
  assertFreshWorld(state, 99);
});

test("resetHudCache 清掉标量字段与塔卡差量键，下一帧全部重算", () => {
  const prev = {
    coins: 320,
    wave: "9/15",
    hpText: 2,
    cards: { cannon: "true:true", ice: "false:false" },
  };

  resetHudCache(prev);
  assert.deepEqual(prev, {});

  const state = createGame(1);
  const vm = hudViewModel(state, {
    WAVE_COUNT,
    CARROT_HP,
    nextWave: "",
    banner: "",
    cardIds: TOWER_ORDER,
    cardCost: (id) => TOWERS[id].cost,
  });

  const writes = [];
  const writer = new Proxy({}, {
    get(_target, key) {
      return (...args) => writes.push([key, ...args]);
    },
  });

  const writeCount = applyHudViewModel(vm, prev, writer);
  assert.ok(writeCount > 0, "缓存清空后应重新写入 HUD 字段");
  assert.ok(writes.some(([key]) => key === "coins"));
  assert.ok(writes.some(([key]) => key === "card"));
  assert.equal(prev.coins, ECONOMY.startCoins);
  assert.equal(Object.keys(prev.cards).length, TOWER_ORDER.length);
});
