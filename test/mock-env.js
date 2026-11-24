'use strict'
/*
 * 零依赖的最小浏览器环境 mock：
 * - DOM：支持测试用到的 querySelector/getElementById/事件/appendChild/removeChild 等
 * - video：可控制 currentTime、play/pause、seek 流程与 timeupdate 推进
 * - canvas：记录 drawImage 调用
 * - rAF / setTimeout：时间由测试用 tick() 手动推进，不依赖真实时钟与外网资源
 */

class EventTarget {
  constructor() {
    this._listeners = Object.create(null)
    this._handlers = Object.create(null)
  }
  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = []
    this._listeners[type].push(fn)
  }
  removeEventListener(type, fn) {
    const arr = this._listeners[type]
    if (!arr) return
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }
  dispatchEvent(event) {
    const arr = this._listeners[event.type] || []
    for (const fn of arr.slice()) {
      try {
        fn.call(this, event)
      } catch (e) {
        // 与浏览器一致，单个监听器异常不影响其它监听器
        // eslint-disable-next-line no-console
        console.error(e)
      }
    }
    const handler = this._handlers[event.type]
    if (typeof handler === 'function') handler.call(this, event)
    return true
  }
  listenerCount(type) {
    return (this._listeners[type] || []).length
  }
}

// onxxx 事件处理器属性：赋值写入 _handlers，与 DOM 语义一致
function defineEventProps(target, types) {
  for (const type of types) {
    Object.defineProperty(target, 'on' + type, {
      configurable: true,
      enumerable: true,
      get() {
        return this._handlers[type] || null
      },
      set(fn) {
        this._handlers[type] = fn
      },
    })
  }
}

class MockElement extends EventTarget {
  constructor(tagName) {
    super()
    this.tagName = (tagName || 'div').toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = {}
    this.attrs = {}
    this._id = ''
    this.className = ''
    this.offsetWidth = 100
    this.offsetHeight = 100
    this.clientWidth = 100
    this.clientHeight = 100
    this.width = 0
    this.height = 0
    defineEventProps(this, ['click', 'mousedown', 'mouseup', 'mousemove', 'keydown'])
  }
  get id() {
    return this._id
  }
  set id(v) {
    if (this._id && this.parentNode && this.parentNode._byId) {
      delete this.parentNode._byId[this._id]
    }
    this._id = v
    if (this.parentNode && this.parentNode._byId) {
      this.parentNode._byId[v] = this
    }
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    if (!this._byId) this._byId = Object.create(null)
    if (child._id) this._byId[child._id] = child
    return child
  }
  removeChild(child) {
    const i = this.children.indexOf(child)
    if (i >= 0) {
      this.children.splice(i, 1)
      if (this._byId && child._id) delete this._byId[child._id]
      child.parentNode = null
    }
    return child
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }
  }
  getContext() {
    return mock2dContext
  }
  querySelector(sel) {
    return querySelectorIn(this, sel)
  }
  querySelectorAll(sel) {
    const r = querySelectorIn(this, sel)
    return r ? [r] : []
  }
}

const mock2dContext = {
  drawCalls: [],
  drawImage(...args) {
    this.drawCalls.push(args)
  },
  clear() {
    this.drawCalls.length = 0
  },
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchSelector(el, sel) {
  sel = sel.trim()
  if (sel.startsWith('#')) return el._id === sel.slice(1)
  if (sel.startsWith('.')) return (el.className || '').split(/\s+/).indexOf(sel.slice(1)) >= 0
  return el.tagName === sel.toUpperCase()
}

function querySelectorIn(root, sel) {
  const walk = (el) => {
    for (const c of el.children || []) {
      if (matchSelector(c, sel)) return c
      const r = walk(c)
      if (r) return r
    }
    return null
  }
  return walk(root)
}

class MockDocument extends MockElement {
  constructor() {
    super('#document')
    this.body = new MockElement('body')
    this.appendChild(this.body)
  }
  createElement(tag) {
    const t = (tag || 'div').toLowerCase()
    if (t === 'video') return new MockVideo()
    if (t === 'canvas') return new MockCanvas()
    return new MockElement(tag)
  }
  getElementById(id) {
    const walk = (el) => {
      if (el._id === id) return el
      for (const c of el.children || []) {
        const r = walk(c)
        if (r) return r
      }
      return null
    }
    return walk(this)
  }
  getElementsByTagName(tag) {
    const out = []
    const walk = (el) => {
      for (const c of el.children || []) {
        if (c.tagName === tag.toUpperCase()) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  querySelector(sel) {
    return querySelectorIn(this, sel)
  }
}

class MockCanvas extends MockElement {
  constructor() {
    super('canvas')
    this.drawImageCalls = mock2dContext.drawCalls
  }
}

class MockVideo extends MockElement {
  constructor() {
    super('video')
    defineEventProps(this, [
      'loadedmetadata',
      'durationchange',
      'seeked',
      'play',
      'pause',
      'timeupdate',
      'ended',
    ])
    this._currentTime = 0
    this.paused = true
    this.ended = false
    this.muted = false
    this.volume = 1
    this.preload = ''
    this.controls = false
    this.autoplay = false
    this.videoWidth = 640
    this.videoHeight = 360
    this.duration = NaN
    this._step = MockVideo.defaultStep
    this._timer = null
    this._seekTimer = null
  }
  static defaultStep = 0.25
  static updateInterval = 250
  get currentTime() {
    return this._currentTime
  }
  set currentTime(v) {
    // 模拟浏览器：赋值 currentTime 即触发 seek；即使值相同，显式 seek 也会派发 seeked
    this._currentTime = v
    this.ended = false
    this._scheduleSeeked()
  }
  _scheduleSeeked() {
    if (this._seekTimer) return
    this._seekTimer = setTimeout(() => {
      this._seekTimer = null
      if (this.destroyed) return
      this.dispatchEvent({ type: 'seeked' })
    }, 0)
  }
  set src(v) {
    this._src = v
    this._currentTime = 0
    this.paused = true
    this.ended = false
    // 设置新 src 会中断尚未完成的旧 seek
    if (this._seekTimer !== null) {
      clearTimeout(this._seekTimer)
      this._seekTimer = null
    }
    // 模拟媒体加载：下一宏任务派发 durationchange / loadedmetadata
    // 即使复用元素重复设置同一 src，浏览器同样会重新走加载流程
    setTimeout(() => {
      if (this.destroyed) return
      this.duration = 100
      this.dispatchEvent({ type: 'durationchange' })
      this.dispatchEvent({ type: 'loadedmetadata' })
    }, 0)
  }
  get src() {
    return this._src || ''
  }
  play() {
    this.paused = false
    this.ended = false
    this.dispatchEvent({ type: 'play' })
    this._startTicking()
    return Promise.resolve()
  }
  pause() {
    this.paused = true
    this._stopTicking()
  }
  _startTicking() {
    if (this._timer !== null) return
    // 与真实浏览器一致：timeupdate 约每 250ms 一次，跟随虚拟时钟推进
    const tick = () => {
      if (this.paused || this.destroyed) {
        this._timer = null
        return
      }
      this._timer = null
      this._currentTime += this._step
      this.dispatchEvent({ type: 'timeupdate' })
      if (!this.paused && !this.destroyed) {
        this._timer = setTimeout(tick, MockVideo.updateInterval)
      }
    }
    this._timer = setTimeout(tick, MockVideo.updateInterval)
  }
  _stopTicking() {
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }
  destroy() {
    this.destroyed = true
    this._stopTicking()
    if (this._seekTimer !== null) {
      clearTimeout(this._seekTimer)
      this._seekTimer = null
    }
  }
}

// ---- 可控的定时器与 rAF ----
const timers = new Map()
let timerSeq = 1
let now = 0
const rafQueue = []
let rafSeq = 1

function mockSetTimeout(fn, delay) {
  const id = timerSeq++
  timers.set(id, { fn, runAt: now + (delay || 0), kind: 'timeout' })
  return id
}
function mockClearTimeout(id) {
  timers.delete(id)
}
function mockRaf(fn) {
  const id = rafSeq++
  rafQueue.push({ id, fn })
  return id
}
function mockCancelRaf(id) {
  const i = rafQueue.findIndex((r) => r.id === id)
  if (i >= 0) rafQueue.splice(i, 1)
}

// 排空已就绪的微任务队列（async/await、Promise.then）
async function drainMicrotasks() {
  // 本测试中的异步链都很短，固定多轮空转足够让已入队微任务全部落地
  for (let i = 0; i < 20; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve()
  }
}

// 推进时间：先执行到期的 setTimeout（含 0ms），再执行全部 rAF 回调
async function tick(frames = 1) {
  for (let f = 0; f < frames; f++) {
    let guard = 0
    while (true) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.runAt <= now)
        .sort((a, b) => a[1].runAt - b[1].runAt)
      if (!due.length) break
      const [id, t] = due[0]
      timers.delete(id)
      now = t.runAt
      t.fn()
      // eslint-disable-next-line no-await-in-loop
      await drainMicrotasks()
      if (++guard > 100000) throw new Error('timer loop runaway')
    }
    now += 16
    const q = rafQueue.splice(0, rafQueue.length)
    for (const r of q) r.fn()
    // eslint-disable-next-line no-await-in-loop
    await drainMicrotasks()
  }
  // rAF 回调里可能又排了 0ms 定时器，再排空一次
  let guard = 0
  while (true) {
    const due = [...timers.entries()].filter(([, t]) => t.runAt <= now)
    if (!due.length) break
    const [id, t] = due.sort((a, b) => a[1].runAt - b[1].runAt)[0]
    timers.delete(id)
    t.fn()
    // eslint-disable-next-line no-await-in-loop
    await drainMicrotasks()
    if (++guard > 100000) throw new Error('timer loop runaway')
  }
}
function pendingTimerCount() {
  return timers.size
}
function pendingRafCount() {
  return rafQueue.length
}
function resetClock() {
  timers.clear()
  rafQueue.length = 0
  now = 0
}

function installGlobals() {
  resetClock()
  const document = new MockDocument()
  global.document = document
  global.window = {
    requestAnimationFrame: mockRaf,
    cancelAnimationFrame: mockCancelRaf,
    setTimeout: mockSetTimeout,
    clearTimeout: mockClearTimeout,
  }
  global.requestAnimationFrame = mockRaf
  global.cancelAnimationFrame = mockCancelRaf
  global.setTimeout = mockSetTimeout
  global.clearTimeout = mockClearTimeout
  return document
}

module.exports = {
  EventTarget,
  MockElement,
  MockDocument,
  MockVideo,
  MockCanvas,
  mock2dContext,
  installGlobals,
  tick,
  resetClock,
  pendingTimerCount,
  pendingRafCount,
}
