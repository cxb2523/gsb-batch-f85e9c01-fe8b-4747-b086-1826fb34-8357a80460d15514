# 局域网联机回合同步 —— 主机权威模型

本文说明联机对局的回合推进契约，以及如何用自动化脚本复现「回合切换 / KO 收尾 / 重赛 / 断线清理」。

## 权威模型

- **主机（net-host）** 运行完整模拟（`World.step`），是回合数、比分、计时、双方状态、胜负的唯一事实来源。
- **客机（net-guest）** 不跑战斗模拟，只：
  1. 以 30Hz 上行本地输入；
  2. 用主机快照驱动木偶插值渲染（`Fighter.applySnapshot` / `puppetStep`）；
  3. 播放主机转发的事件（火花/必杀/KO/ROUND/胜负公告）。

客机**绝不本地推断**回合结果：胜负索引、比分、结算面板内容全部来自快照里的 `winner` / `score`。

## 状态快照（`src/main.js::_netSnap`）

```js
{
  gen,                 // 对局世代号：主机每开一局（含重赛）+1，客机跟随
  phase, sub, st,      // result/fight、intro/live/koSlow/roundend、子阶段计时
  t, round, score,     // 计时、回合、比分（权威）
  ts,                  // world.timeScale（KO 慢动作）
  ko,                  // KO 慢动作聚焦的败者索引
  winner,              // 结算态胜者索引（客机据此显示结算，绝不自行推断）
  picks, stage,        // 双方角色与舞台（中途加入/重建用）
  f: [serialize, ...], // 双方完整可回放状态
  evts: [...],         // 尚未被客机确认的事件（未确认即重发）
}
```

## 事件不丢、不重

- 主机每条事件带 `{ g: 世代号, id: 单调递增 }`，进入 `_pendingNetEvts`。
- 快照**下发全部未确认事件**（不是 `splice` 一次性取走），因此断流/丢包后下一次快照会自动补发。
- 客机按 `id <= _netEvtLast` 去重，每个事件**只播一次**；消费后回 `{cmd:'ack', g, id}`。
- 主机收到 ack 才从队列移除（另有 512 条硬上限兜底，防止客机永久掉线时无限积压）。
- 回合切换等关键时刻调用 `net.flushState()` **立即**推一帧，不必等 33ms 定时器，避免"事件与快照错位一帧"。

## 回合流程契约（主机侧）

| 切换 | 主机动作 | 下发 |
|------|----------|------|
| intro→live | `subPhase='live'` | 事件 `fight` + 立即快照 |
| 命中 KO | `_handleKo` → `koSlow` + `timeScale=slowmoKO` | 事件 `ko` + 立即快照 |
| koSlow→roundend | `_finishRound` 计分、`setWinner` | 事件 `winner` + 立即快照（含新 `score`） |
| roundend→下一回合 | `_beginRound` 重置血量/计时/回合号 | 事件 `round{n,score,meter}` + 立即快照 |
| roundend→结算 | `_showResult` | 立即快照（`phase=result, winner`） |
| rematch | `_hostRestartMatch`：`gen+1`、比分归零、`startMatch` | `cmd rematch{gen,stage,c1,c2}`；客机跟随重建 |

TIME UP 同样走 `timeup` 事件 + 立即快照。

## 重赛

- **任一端**点「再来一局」：
  - 主机点击 → `_hostRestartMatch()`（仅结算态允许）→ 广播 `rematch` 并本地开新局。
  - 客机点击 → 发送 `rematch` 请求；主机收到后（仅结算态）执行 `_hostRestartMatch()` 广播，客机等广播/快照跟随。
- 重赛后双方 `score=[0,0]`、`round=1`、`timer=60`、能量归零、结算面板隐藏、公告不残留上一局胜负。

## 中途加入 / 断线重连

- 客机快照应用前先校验：`gen < 本地 gen` 的旧包直接丢弃；`gen > 本地` 或角色阵容不一致 → 按快照 `picks/stage` 完整重建本局。
- 中途加入（本局已过半）时，快照里积压的历史事件会按 `now` 过滤：早于当前 0.6s 的**瞬时特效**（火花等）丢弃，但 `round/fight/ko/winner/timeup` 等**关键流程事件**始终补播，保证客机结算与公告与主机一致，又不会"历史特效齐放"。
- 断线（`peer-left` 或 socket close）：`_leaveNet()` 释放循环、清空待发事件/快照/远端输入/世代号，再回标题；重进对局不携带上一局残留。

## URL 调试钩子（保留）

| 参数 | 作用 |
|------|------|
| `?lan=1` | 自动连服务器并匹配 |
| `&pick=N` | 自动确认第 N 个角色 |
| `&auto=1` | 自动驾驶（主机出招 / 客机上行），用于无人值守联机测试 |
| `&stage=night\|forest\|sunset` | 固定舞台（主机权威，客机跟随） |

测试专用（仅存在于 `window`，不影响正常游玩）：
`__netDebug()` 读取权威状态；`__forceKO(idx)` 走真实 KO 流程；`__dropSnaps(n)` 模拟客机丢包；`__netPending()` 读主机事件队列。

## 自动化验证

```bash
npm run test:lan          # 回合推进 / KO 收尾 / 下一回合 / 结算 / 双向重赛 / 回标题清理
npm run test:lan:robust   # 客机丢包补发不丢失、事件去重不重播、队列收敛、断线清理
```

脚本基于 `playwright-core` + 本机 Chromium（`CHROME_PATH` 可覆盖），自带临时服务端口，互不干扰。
