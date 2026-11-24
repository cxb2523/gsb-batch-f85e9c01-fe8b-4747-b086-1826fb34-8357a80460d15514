'use strict'
/*
 * 播放器链路测试（零依赖、纯本地 mock，不访问外网）：
 * 1) 拖动/点击进度条 -> 正确定位片段与片段内偏移，cacheCurrentTime 同步，timeupdate 不重复累加
 * 2) 片段播放到 end 自动切换，playedTime 精确等于已播片段时长之和，切换瞬间无跳变/不重复切段
 * 3) 暂停恢复、最后一段播完重播
 * 4) 关闭/销毁时 rAF、定时器、video/canvas/logo 节点与事件监听全部释放
 */
const path = require('path')
const assert = require('assert')
const env = require('./mock-env')
const { installLoader, loadSourceModule } = require('./sfc-loader')
const { FakeVue } = require('./fake-vue')

installLoader()
const PlayerOptions = require(path.join(__dirname, '..', 'src', 'canvasPlayer.vue'))

const EPS = 1e-9

function approx(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < EPS, `${msg || ''} expected≈${expected}, got=${actual}`)
}

// 三段，边界均为 mock 步进 0.05 的整数倍，累计时长分别为 2 / 5 / 8（total=8）
function fixture() {
  return [
    { url: 'mock://a.mp4', width: 640, height: 360, logoPosition: { x: 'left', y: 'top' }, playPoint: { start: '0', end: '2' } },
    { url: 'mock://b.mp4', width: 640, height: 360, logoPosition: { x: 'right', y: 'top' }, playPoint: { start: '4', end: '7' } },
    { url: 'mock://c.mp4', width: 640, height: 360, logoPosition: { x: 'left', y: 'bottom' }, playPoint: { start: '10', end: '13' } },
  ]
}

function buildDom() {
  const doc = env.installGlobals()
  const videoDom = doc.createElement('div')
  videoDom.id = 'VideoDom'
  const canvasDom = doc.createElement('div')
  canvasDom.id = 'canvasDom'
  const bar = doc.createElement('div')
  bar.className = 'bar'
  const circle = doc.createElement('div')
  circle.id = 'circle'
  bar.appendChild(circle)
  canvasDom.appendChild(bar)
  videoDom.appendChild(canvasDom)
  doc.body.appendChild(videoDom)
  return { doc, videoDom, canvasDom, bar, circle }
}

async function createPlayer(list) {
  const dom = buildDom()
  const Ctor = FakeVue.extend(PlayerOptions)
  const vm = new Ctor({ list: list || fixture(), logo: 'mock://logo.png' })
  vm.$mount() // 触发 mounted -> gotoPlay
  await env.tick(1) // 完成初始加载/seek/play
  return Object.assign(vm, dom)
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

// ---------- 1. seek：拖动定位 ----------
test('seek 到第 2 段中间：片段下标、片段内偏移与 cacheCurrentTime 正确，timeupdate 不重复累加', async () => {
  const vm = await createPlayer()
  assert.strictEqual(vm.playIndex, 0)
  const initialVideo = vm.videoObj

  // 累计时间 3.5：第 1 段占 2s，落在第 2 段（base=2），片段内偏移 1.5 -> video.currentTime = 4+1.5 = 5.5
  vm.playedTime = 3.5
  vm.skipProgress()
  await env.tick(1)

  assert.strictEqual(vm.playIndex, 1, '应定位到第 2 段')
  approx(vm.cacheCurrentTime, 5.5, 'cacheCurrentTime 应同步到片段start+偏移')
  assert.strictEqual(vm.videoObj, initialVideo, '复用同 id 的 video 元素')

  const before = vm.playedTime
  const ctBefore = vm.videoObj.currentTime
  await env.tick(30) // 跨过若干个 250ms 的 timeupdate 周期，每个步进 0.25，且不越过本段 end=7
  assert.strictEqual(vm.playIndex, 1, '推进过程中没有提前切段')
  const delta = vm.videoObj.currentTime - ctBefore
  assert.ok(delta > 0, '视频确实在推进')
  approx(vm.playedTime, before + delta, 'playedTime 按实际 currentTime 推导，无重复累加')
  approx(vm.playedTime, 2 + (vm.videoObj.currentTime - 4), 'playedTime = base + 片段内 local')
  approx(vm.cacheCurrentTime, vm.videoObj.currentTime, 'cacheCurrentTime 与 currentTime 同步')
  vm.setFree()
})

test('seek 到第 3 段（base 非 0）：偏移计算正确', async () => {
  const vm = await createPlayer()
  vm.playedTime = 6 // 第 3 段 base=5，偏移 1 -> currentTime=11
  vm.skipProgress()
  await env.tick(1)
  assert.strictEqual(vm.playIndex, 2)
  approx(vm.cacheCurrentTime, 11)
  approx(vm.playedTime, 6)
  await env.tick(1)
  approx(vm.playedTime, 5 + (vm.videoObj.currentTime - 10))
  vm.setFree()
})

test('seek 到片段边界：边界累计时间归属于下一段且偏移为 0', async () => {
  const vm = await createPlayer()
  vm.playedTime = 2 // skipDict[0]
  vm.skipProgress()
  await env.tick(1)
  assert.strictEqual(vm.playIndex, 1)
  approx(vm.cacheCurrentTime, 4, '下一段 start=4，偏移 0')
  vm.setFree()
})

test('seek 超出总时长被收敛到末段末尾并停在 end；负数收敛到开头', async () => {
  const vm = await createPlayer()
  vm.playedTime = 999
  vm.skipProgress()
  await env.tick(1)
  assert.strictEqual(vm.playIndex, 2)
  approx(vm.playedTime, 8, 'playedTime 收敛到 totalTime')
  await env.tick(1)
  assert.strictEqual(vm.endFlag, true, '末段到 end 后 endFlag=true')
  assert.strictEqual(vm.paused, true)

  vm.playedTime = -5
  vm.skipProgress()
  await env.tick(1)
  assert.strictEqual(vm.playIndex, 0)
  approx(vm.playedTime, 0)
  approx(vm.cacheCurrentTime, 0)
  vm.setFree()
})

test('skipLine 点击进度条按 clientX 比例定位', async () => {
  const vm = await createPlayer()
  const bar = vm.bar
  bar.clientWidth = 200
  vm.skipLine({ clientX: 100, currentTarget: bar }) // 50% -> 累计 4 -> 第 2 段，偏移 2 -> currentTime 6
  await env.tick(1)
  assert.strictEqual(vm.playIndex, 1)
  approx(vm.cacheCurrentTime, 6)
  approx(vm.playedTime, 4)
  vm.setFree()
})

test('连续快速 seek：只有最后一次目标生效，不发生片段错乱', async () => {
  const vm = await createPlayer()
  vm.playedTime = 3.5 // 先请求第 2 段
  vm.skipProgress()
  vm.playedTime = 6 // 紧接着请求第 3 段，前一次的加载回调过期
  vm.skipProgress()
  await env.tick(2)
  assert.strictEqual(vm.playIndex, 2, '最终落在最后一次请求的第 3 段')
  approx(vm.cacheCurrentTime, 11)
  approx(vm.playedTime, 6)
  assert.strictEqual(vm.endFlag, false)
  vm.setFree()
})

test('拖动 mousedown 暂停播放，mouseup 后按拖动位置跳转且只绑定一次事件', async () => {
  const vm = await createPlayer()
  const circle = vm.circle
  assert.strictEqual(circle.listenerCount('mousedown'), 1, 'initDrop2 已绑定一次')
  circle.dispatchEvent({ type: 'mousedown' })
  assert.strictEqual(vm.drag, 1)
  assert.strictEqual(vm.paused, true)
  assert.strictEqual(vm.videoObj.paused, true)
  // mouseup 结束本次拖动（未改变 playedTime，仍在第 1 段）
  vm.mouseup()
  assert.strictEqual(vm.drag, 0)
  assert.strictEqual(vm.playIndex, 0)
  // 恢复播放
  vm.changeVideoState()
  await env.tick(1)
  assert.strictEqual(vm.paused, false)

  // 非拖动状态下 mouseup 不应触发跳转
  vm.playedTime = 3.5
  vm.mouseup()
  assert.strictEqual(vm.playIndex, 0)

  // 再走一次完整拖动跳转
  circle.dispatchEvent({ type: 'mousedown' })
  vm.playedTime = 3.5
  vm.mouseup()
  await env.tick(1)
  assert.strictEqual(vm.playIndex, 1)
  assert.strictEqual(circle.listenerCount('mousedown'), 1, '事件没有重复绑定')
  assert.strictEqual(vm.doc.listenerCount('mousemove'), 1)
  assert.strictEqual(vm.doc.listenerCount('mouseup'), 1)
  vm.setFree()
})

// ---------- 2. 自动切换 ----------
test('第 1 段播放到 end 自动切换，playedTime 精确对齐片段边界且不重复切段', async () => {
  const vm = await createPlayer()
  assert.strictEqual(vm.playIndex, 0)
  // 第 1 段 [0,2]，步进 0.05：约 40 次 timeupdate 后越过 end
  let guard = 0
  while (vm.playIndex === 0 && guard < 200) {
    // eslint-disable-next-line no-await-in-loop
    await env.tick(1)
    guard++
  }
  assert.strictEqual(vm.playIndex, 1, '应自动切到第 2 段')
  approx(vm.playedTime, 2, 'playedTime 等于已播完片段时长之和')
  assert.strictEqual(vm.switching, false, 'VideoPlay 已复位 switching')

  // 切换瞬间残留的 timeupdate / raf 不得再次切段
  vm.videoObj.dispatchEvent({ type: 'timeupdate' })
  assert.strictEqual(vm.playIndex, 1, '旧回调不能重复切段')
  approx(vm.playedTime, 2, '旧回调不能造成进度跳变')

  await env.tick(1)
  // 第 2 段继续累计：base=2，currentTime 从 start=4 开始
  approx(vm.playedTime, 2 + (vm.videoObj.currentTime - 4))
  vm.setFree()
})

test('连续自动播放直到最后一段结束：endFlag 置位、停在总时长', async () => {
  const vm = await createPlayer()
  let guard = 0
  while (!vm.endFlag && guard < 1000) {
    // eslint-disable-next-line no-await-in-loop
    await env.tick(1)
    guard++
  }
  assert.ok(guard < 1000, '应在限定帧数内播完')
  assert.strictEqual(vm.endFlag, true)
  assert.strictEqual(vm.playIndex, 2, '不越过最后一段')
  approx(vm.playedTime, 8, '结束时 playedTime = totalTime')
  assert.strictEqual(vm.paused, true)
  vm.setFree()
})

// ---------- 3. 暂停/恢复、重播 ----------
test('暂停后恢复从原位置继续，rAF 同步停止与重启', async () => {
  const vm = await createPlayer()
  await env.tick(4)
  const t1 = vm.videoObj.currentTime
  const p1 = vm.playedTime
  vm.changeVideoState() // 暂停
  assert.strictEqual(vm.paused, true)
  assert.strictEqual(vm.videoObj.paused, true)
  assert.strictEqual(env.pendingRafCount(), 0, '暂停后无残留 rAF')
  await env.tick(5)
  approx(vm.videoObj.currentTime, t1, '暂停期间 currentTime 不前进')
  approx(vm.playedTime, p1, '暂停期间 playedTime 不前进')

  vm.changeVideoState() // 恢复
  assert.strictEqual(vm.paused, false)
  assert.strictEqual(vm.videoObj.paused, false)
  await env.tick(50) // 跨过 3 个 250ms 周期
  approx(vm.videoObj.currentTime, t1 + 0.75, '恢复后从原位置继续')
  approx(vm.playedTime, p1 + 0.75)
  vm.setFree()
})

test('最后一段播完后重播从 0 开始', async () => {
  const vm = await createPlayer()
  let guard = 0
  while (!vm.endFlag && guard < 1000) {
    // eslint-disable-next-line no-await-in-loop
    await env.tick(1)
    guard++
  }
  assert.strictEqual(vm.endFlag, true)
  vm.changeVideoState() // 重播
  await env.tick(1)
  assert.strictEqual(vm.endFlag, false)
  assert.strictEqual(vm.playIndex, 0)
  approx(vm.playedTime, 0)
  approx(vm.cacheCurrentTime, 0)
  assert.strictEqual(vm.paused, false)
  assert.strictEqual(vm.videoObj.paused, false)
  await env.tick(20)
  approx(vm.playedTime, vm.videoObj.currentTime, '第 1 段 start=0，累计等于 currentTime')
  vm.setFree()
})

// ---------- 4. 资源释放 ----------
test('setFree：取消 rAF、暂停视频、移除 video/canvas/logo 节点', async () => {
  const vm = await createPlayer()
  await env.tick(2)
  // 手动创建 logo（onplay 已创建过则复用）
  vm.createAndPutLogo(vm.canvasDom, 'logoId', { logo: 'mock://logo.png', position: { x: 'left', y: 'top' } })
  await env.tick(1)
  assert.ok(vm.doc.getElementById('AutoVideoId'), '前置：video 节点存在')
  assert.ok(vm.doc.getElementById('AutoCanvasId'), '前置：canvas 节点存在')
  assert.ok(vm.doc.getElementById('logoId'), '前置：logo 节点存在')
  assert.ok(env.pendingRafCount() >= 1 || vm.RAFCancelReq !== null, '前置：存在渲染循环')

  vm.setFree()
  assert.strictEqual(env.pendingRafCount(), 0, '无残留 rAF')
  assert.strictEqual(env.pendingTimerCount(), 0, '无残留定时器')
  assert.strictEqual(vm.videoObj.paused, true, '当前视频已暂停')
  for (const id of ['AutoVideoId', 'preLoadVideoId', 'AutoCanvasId', 'logoId']) {
    assert.strictEqual(vm.doc.getElementById(id), null, `${id} 已移除`)
  }
  // 销毁后的异步回调全部失效
  const before = vm.playedTime
  vm.videoObj.dispatchEvent({ type: 'timeupdate' })
  assert.strictEqual(vm.playedTime, before, '销毁后 timeupdate 不再改进度')
})

test('close 延迟销毁：到点真正 destroy、移除根节点并解绑文档事件', async () => {
  const vm = await createPlayer()
  await env.tick(2)
  const doc = vm.doc
  assert.strictEqual(doc.listenerCount('keydown'), 1)
  assert.strictEqual(doc.listenerCount('mousemove'), 1)
  assert.strictEqual(doc.listenerCount('mouseup'), 1)

  vm.close()
  // 200ms 内尚未销毁
  await env.tick(5)
  assert.strictEqual(vm.destroyed, false)
  assert.ok(doc.getElementById('AutoVideoId'))
  // 跨过 close 的 200ms 定时器
  await env.tick(20)
  assert.strictEqual(vm.destroyed, true, 'beforeDestroy/setFree 已执行')
  assert.strictEqual(vm.$el.parentNode, null, '根节点已移除')
  assert.strictEqual(doc.listenerCount('keydown'), 0)
  assert.strictEqual(doc.listenerCount('mousemove'), 0)
  assert.strictEqual(doc.listenerCount('mouseup'), 0)
  assert.strictEqual(env.pendingRafCount(), 0)
  assert.strictEqual(env.pendingTimerCount(), 0)
  for (const id of ['AutoVideoId', 'preLoadVideoId', 'AutoCanvasId', 'logoId']) {
    assert.strictEqual(doc.getElementById(id), null, `${id} 已移除`)
  }
})

test('销毁过程中 closeTimer 被 setFree 清理，不会触发延迟销毁', async () => {
  const vm = await createPlayer()
  vm.close()
  assert.ok(vm.closeTimer !== null, 'close 已登记延迟销毁定时器')
  let destroyedEvents = 0
  vm.$on('hook:beforeDestroy', () => destroyedEvents++)
  vm.setFree() // 手动清理应取消 close 内部定时器
  assert.strictEqual(vm.closeTimer, null, 'closeTimer 已被清理')
  await env.tick(30)
  assert.strictEqual(destroyedEvents, 0, '未触发延迟销毁')
})

test('ESC 键触发 close 流程并完成销毁', async () => {
  const vm = await createPlayer()
  const doc = vm.doc
  vm.doc.dispatchEvent({ type: 'keydown', keyCode: 27 })
  assert.ok(vm.closeTimer !== null, 'ESC 已登记关闭定时器')
  await env.tick(20)
  assert.strictEqual(vm.destroyed, true)
  assert.strictEqual(doc.listenerCount('keydown'), 0, 'keydown 监听已移除')
})

test('canvas 点击可暂停/恢复播放', async () => {
  const vm = await createPlayer()
  const canvas = vm.doc.getElementById('AutoCanvasId')
  assert.strictEqual(canvas, vm.doc.getElementById('AutoCanvasId'))
  assert.strictEqual(vm.paused, false)
  canvas.dispatchEvent({ type: 'click' })
  assert.strictEqual(vm.paused, true)
  assert.strictEqual(vm.videoObj.paused, true)
  canvas.dispatchEvent({ type: 'click' })
  assert.strictEqual(vm.paused, false)
  assert.strictEqual(vm.videoObj.paused, false)
  vm.setFree()
})

// ---------- 5. 入口 index.js：保持 $canvasVideoPlayer(list) 调用方式 ----------
test('$canvasVideoPlayer(list) 数组入参可创建播放器，销毁后可再次打开', async () => {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('src', 'index.js')) || k.endsWith('canvasPlayer.vue')) delete require.cache[k]
  }
  const entry = loadSourceModule(path.join(__dirname, '..', 'src', 'index.js'))
  FakeVue.use = function(plugin) {
    plugin.install(FakeVue)
  }
  FakeVue.use(entry)
  assert.strictEqual(typeof FakeVue.prototype.$canvasVideoPlayer, 'function')

  const vm1 = FakeVue.prototype.$canvasVideoPlayer(fixture())
  assert.ok(vm1, '返回 vm 实例')
  assert.strictEqual(vm1.list.length, 3)
  assert.strictEqual(vm1.playerlist.length, 3)
  approx(vm1.totalTime, 8)
  await env.tick(3)
  assert.strictEqual(vm1.paused, false)

  // 单例：未关闭时再次调用直接返回 undefined
  const again = FakeVue.prototype.$canvasVideoPlayer(fixture())
  assert.strictEqual(again, undefined)

  // 真实关闭流程：$destroy 触发 beforeDestroy -> setFree，入口监听器复位 seed
  vm1.$destroy()
  assert.strictEqual(vm1.destroyed, true)
  // seed 已复位，可重新打开
  const vm2 = FakeVue.prototype.$canvasVideoPlayer(fixture())
  assert.ok(vm2, '销毁后可再次创建播放器')
  assert.notStrictEqual(vm2, vm1)
  vm2.$destroy()
})

// ---- 执行 ----
;(async () => {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await t.fn()
      passed++
      console.log(`  ✓ ${t.name}`)
    } catch (e) {
      failed++
      console.error(`  ✗ ${t.name}\n    ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n    ') : e}`)
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
  process.exit(failed ? 1 : 0)
})()
