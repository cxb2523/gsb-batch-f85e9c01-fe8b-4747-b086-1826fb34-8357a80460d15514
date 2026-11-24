# 回合清场验收（最小本地测试 / 调试入口）

这套测试不依赖 npm 包或测试框架，使用本机已安装的 Chrome / Edge（Chromium 内核）
以 headless 方式运行，覆盖任务要求的回合重置收敛行为。

## 运行断言（约几秒）

```bash
# 需要 Node 18+（脚本使用全局 fetch / WebSocket 无关，仅用 child_process）
node test/run-round-reset.mjs
```

可用环境变量：

- `CHROME="C:\\path\\to\\chrome.exe"` 指定浏览器
- `BUDGET=12000` 虚拟时间预算（毫秒）

退出码 `0` 表示全部通过；非 0 表示有失败项或浏览器启动问题。
运行器会输出每条 `PASS/FAIL`，并在失败时给出实际值。

## 它验证了什么

场景脚本 `test/round-reset.scenario.js` 在真实页面、真实 THREE 场景图中运行：

- **A 单机爆破**：连推回合 → 第二回合安放 C4、制造掉落/手雷/布娃娃/定时器 →
  引爆并进入下一回合，核对旧 C4 模型、掉落物、手雷、布娃娃、定时器全部释放，
  回调不再触发；新回合 C4 未安放/未掉落且仅由一名 T 携带。
  另核对 `ModeComp.finish()`（对局结束）执行同样的完整收束。
- **B 中途加入（房主侧）**：回合间 `addRemote()` 的玩家没有 C4 / 主武器 /
  旧掉落归属，下一回合仍只有一名 T 携带 C4，加入者正确出生并拿到默认手枪。
- **C 加入端收 `clr`**：镜像掉落物 / 手雷 / 布娃娃 / C4 模型与状态被清空，
  `NetClient.drops` 映射清空；尤其验证**清场前已进入插值延迟队列的旧
  `drop/nade/kill` 事件会被一并废弃**，不会在清场后把旧物件重新演出来；
  清场后的新事件不受影响。
- **D 广播/快照契约**：`clearRoundFx()` 产生 `clr` 事件，初始态/安放态炸弹
  都能正常通过 `NetHost.postTick()` 编码。
- **E 自然多回合**：实战 AI 连续推进两次换回合，按对象身份核对上一回合的
  掉落/手雷/布娃娃全部离场，C4 唯一且与 `bomb.carrier` 一致。

页面会把 JSON 结果写入 `#selftest-report`，并把标题置为
`SELFTEST-PASS` / `SELFTEST-FAIL`，因此也可以手动用浏览器打开：

```
index.html?test=1&selftest=round
```

## 视觉检查 / 调试入口

```
index.html?test=1&selftest=shot&phase=before   # 包点堆满 C4/掉落/手雷/布娃娃
index.html?test=1&selftest=shot&phase=after    # 同一机位执行一次完整回合重置后
```

`window.__engine` 始终暴露引擎实例，可在控制台直接驱动，例如：

```js
const g = Engine.game;
g.mode.plantBomb(g.mode.bomb.carrier, 'A');
g.mode.finish();
```
