// UI 重开接线测试：用最小 DOM/Canvas 桩加载真实 js/ui.js，
// 验证 window.__game.restart 会清掉交互选中态、悬停态和 HUD 差量缓存。
import test from "node:test";
import assert from "node:assert/strict";

import { update } from "../js/game.js";

function installBrowserStub() {
  const elements = new Map();
  const win = {
    devicePixelRatio: 1,
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    },
    removeEventListener() {},
  };

  const ctxStub = new Proxy({}, {
    get(target, prop) {
      if (prop === "createLinearGradient" || prop === "createRadialGradient") {
        return () => ({ addColorStop() {} });
      }
      if (prop in target) return target[prop];
      return () => {};
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });

  class ClassList {
    constructor() { this.classes = new Set(); }
    add(...names) { names.forEach((name) => this.classes.add(name)); }
    remove(...names) { names.forEach((name) => this.classes.delete(name)); }
    contains(name) { return this.classes.has(name); }
    toggle(name, force) {
      const shouldAdd = force === undefined ? !this.classes.has(name) : Boolean(force);
      if (shouldAdd) this.classes.add(name);
      else this.classes.delete(name);
      return shouldAdd;
    }
  }

  class StubElement {
    constructor(idOrTag = "element") {
      this.id = idOrTag;
      this.style = {};
      this.dataset = {};
      this.attrs = {};
      this.children = [];
      this.listeners = {};
      this.classList = new ClassList();
      this.hidden = false;
      this.disabled = false;
      this.width = 300;
      this.height = 150;
      this._text = "";
      this._html = "";
      this.textWriteCount = 0;
      this.htmlWriteCount = 0;
    }

    get textContent() { return this._text; }
    set textContent(value) {
      this._text = String(value);
      this.textWriteCount += 1;
    }

    get innerHTML() { return this._html; }
    set innerHTML(value) {
      this._html = String(value);
      this.htmlWriteCount += 1;
    }

    addEventListener(type, handler) {
      (this.listeners[type] ||= []).push(handler);
    }

    removeEventListener() {}
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    }
    remove() {}
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null; }

    querySelector(selector) {
      if (selector === "canvas") {
        this._iconCanvas ||= new StubElement(`${this.id}-icon-canvas`);
        return this._iconCanvas;
      }
      return null;
    }

    querySelectorAll() { return []; }
    getContext() { return ctxStub; }

    getBoundingClientRect() {
      return { left: 0, top: 0, x: 0, y: 0, width: 960, height: 600, right: 960, bottom: 600 };
    }
  }

  let domReady = null;
  const documentStub = {
    readyState: "loading",
    addEventListener(type, handler) {
      if (type === "DOMContentLoaded") domReady = handler;
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new StubElement(id));
      return elements.get(id);
    },
    createElement(tag) { return new StubElement(tag); },
    querySelector(selector) {
      const match = selector.match(/data-type="([^"]+)"/);
      if (!match) return null;
      const shop = elements.get("shop");
      return shop?.children.find((card) => card.dataset.type === match[1]) || null;
    },
    querySelectorAll(selector) {
      if (selector === ".card") {
        const shop = elements.get("shop");
        return shop ? shop.children.filter((card) => card.dataset.type) : [];
      }
      return [];
    },
  };

  globalThis.window = win;
  globalThis.document = documentStub;
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};

  return {
    win,
    elements,
    flushDomReady() {
      if (!domReady) throw new Error("ui.js 未注册 DOMContentLoaded");
      domReady();
    },
    dispatch(element, type, event = {}) {
      for (const handler of element.listeners[type] || []) {
        handler({ preventDefault() {}, stopPropagation() {}, ...event });
      }
    },
  };
}

test("window.__game.restart 同步清空 UI 选中/悬停/HUD 缓存", async () => {
  const env = installBrowserStub();

  // 必须在 document/window 桩安装之后再加载 ui.js。
  await import("../js/ui.js");
  env.flushDomReady();

  const G = env.win.__game;
  assert.ok(G, "window.__game 应当挂载");

  const board = env.elements.get("board");
  const coins = env.elements.get("coins");
  const inspectBody = env.elements.get("inspectBody");

  // 选塔卡并在 (5,0) 放置一座塔；真实 pointerdown 会选中新塔并松开塔卡。
  G.selectType("cannon");
  env.dispatch(board, "pointermove", { clientX: 330, clientY: 30 });
  assert.deepEqual(G.hover, { col: 5, row: 0, type: "cannon" });

  env.dispatch(board, "pointerdown", { clientX: 330, clientY: 30 });
  const towerId = G.state.towers[0]?.id;
  assert.ok(towerId, "测试前置：应当已经放下塔");
  assert.equal(G.selectedTowerId, towerId);

  // 再选另一张卡，并通过测试 setter 保留一个选中塔，制造两类选中同时存在的 UI 脏状态。
  G.selectType("ice");
  G.setSelectedTower(towerId);
  // 放置成功会按交互规则清空 hover；重新移动一次，制造待重开清理的悬停态。
  env.dispatch(board, "pointermove", { clientX: 390, clientY: 30 });
  assert.equal(G.selectedType, "ice");
  assert.equal(G.selectedTowerId, towerId);
  assert.ok(G.hover, "重开前应存在悬停格");

  // 逻辑层也塞入旧局残留和未交付事件。
  Object.assign(G.state, { phase: "wave", paused: true, speed: 3, time: 88, wave: 7 });
  G.state.projectiles.push({ id: 1, old: true });
  G.state.particles.push({ id: 2, old: true });
  G.state.floats.push({ id: 3, old: true });
  G.state.pending.push({ id: 4, old: true });
  G.state.events.push({ type: "leak", marker: "undelivered" });
  G.state.shake = { t: 0.3, dur: 0.3, mag: 9 };
  G.state.carrotFlinch = 0.4;

  // Mount 时 HUD 已写入 320；若差量缓存未清，重开后的 320 会被跳过。
  coins.textWriteCount = 0;
  inspectBody.htmlWriteCount = 0;

  G.restart();

  assert.equal(G.selectedType, null);
  assert.equal(G.selectedTowerId, null);
  assert.equal(G.hover, null);
  assert.equal(G.state.phase, "build");
  assert.equal(G.state.paused, false);
  assert.equal(G.state.speed, 1);
  assert.equal(G.state.wave, 0);
  assert.equal(G.state.coins, 320);
  assert.equal(G.state.hp, 20);
  assert.deepEqual(G.state.projectiles, []);
  assert.deepEqual(G.state.particles, []);
  assert.deepEqual(G.state.floats, []);
  assert.deepEqual(G.state.pending, []);
  assert.deepEqual(G.state.events, []);
  assert.equal(G.state.carrotFlinch, 0);
  assert.equal(G.state.shake.t, 0);

  assert.ok(coins.textWriteCount >= 1, "HUD 差量缓存应被清空，金币字段必须重写");
  assert.ok(inspectBody.htmlWriteCount >= 1, "选中面板缓存键应重置并恢复提示");
  assert.match(inspectBody.innerHTML, /先点下方塔卡/);
  assert.equal(env.elements.get("overlay").hidden, true);

  const firstFrameEvents = update(G.state, 1 / 60);
  assert.deepEqual(firstFrameEvents, []);

  const iceCard = env.elements.get("shop").children.find((card) => card.dataset.type === "ice");
  assert.ok(iceCard);
  assert.equal(iceCard.classList.contains("active"), false);

  // 结算面板缓存键：先做出一个 lost 面板，再在重开后构造完全相同的键。
  const overlay = env.elements.get("overlay");
  Object.assign(G.state, { phase: "lost", hp: 0, wave: 3 });
  G.state.stats.kills = 4;
  G.refresh();
  assert.equal(overlay.hidden, false);
  const overlayTitle = env.elements.get("overlayTitle");
  const overlayText = env.elements.get("overlayText");
  assert.ok(overlayTitle);
  assert.ok(overlayText);
  overlayTitle.textWriteCount = 0;
  overlayText.htmlWriteCount = 0;

  G.restart();
  assert.equal(overlay.hidden, true);

  Object.assign(G.state, { phase: "lost", hp: 0, wave: 3 });
  G.state.stats.kills = 4;
  G.refresh();
  assert.equal(overlay.hidden, false);
  assert.ok(overlayTitle.textWriteCount >= 1, "结算面板缓存键应在重开时清空");
  assert.ok(overlayText.htmlWriteCount >= 1);
  assert.equal(overlayTitle.textContent, "萝卜被啃了");

  // 在已负结算面板上按 R，也必须走同一个完整重置。
  const keydown = env.win.listeners.keydown?.[0];
  assert.equal(typeof keydown, "function");
  keydown({ key: "r", preventDefault() {} });
  assert.equal(G.state.phase, "build");
  assert.equal(G.state.wave, 0);
  assert.equal(G.state.paused, false);
  assert.equal(overlay.hidden, true);
});
