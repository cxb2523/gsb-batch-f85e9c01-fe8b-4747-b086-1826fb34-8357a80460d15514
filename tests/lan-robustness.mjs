// 联机健壮性验证：事件补发不丢失/去重不重播、客机中途丢包后追上权威状态
// 运行：node tests/lan-robustness.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PORT = Number(process.env.TEST_PORT2 || 3313);
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe';

const log = (...a) => console.log('[rob]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail) {
  if (cond) log('  ✓', name);
  else { failures++; log('  ✗', name, detail ? '→ ' + JSON.stringify(detail) : ''); }
}
async function waitFor(page, fn, timeout = 20000, label = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn).catch(() => undefined);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for ' + label);
    await sleep(100);
  }
}
const dbg = (page) => page.evaluate(() => window.__netDebug());

async function main() {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
  server.stdout.on('data', () => {});
  server.stderr.on('data', d => process.stderr.write('[srv-err] ' + d));
  await sleep(1200);
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const wire = (page) => {
    page.__errors = [];
    page.on('pageerror', e => page.__errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.__errors.push('console: ' + m.text()); });
    return page;
  };

  try {
    const hostPage = wire(await browser.newPage({ viewport: { width: 900, height: 640 } }));
    await hostPage.goto(`${BASE}/?lan=1&pick=0`, { waitUntil: 'load' });
    await waitFor(hostPage, () => window.__game && window.__game.netRole === 'host', 20000, 'host role');
    const guestPage = wire(await browser.newPage({ viewport: { width: 900, height: 640 } }));
    await guestPage.goto(`${BASE}/?lan=1&pick=4`, { waitUntil: 'load' });
    await waitFor(guestPage, () => window.__game && window.__game.netRole === 'guest', 20000, 'guest role');
    await waitFor(hostPage, () => window.__game.phase === 'fight', 25000, 'host fight');
    await waitFor(guestPage, () => window.__game.phase === 'fight', 25000, 'guest fight');
    await waitFor(hostPage, () => window.__game.subPhase === 'live', 8000, 'host live');
    await waitFor(guestPage, () => window.__game.subPhase === 'live', 8000, 'guest live');

    // ---------- A) 客机丢包：KO 事件必须补发且只播一次，随后比分追上 ----------
    log('A：客机短暂丢包期间 KO，事件补发不丢失');
    const koBefore = (await dbg(guestPage)).played.ko || 0;
    await guestPage.evaluate(() => window.__dropSnaps(12));   // 丢弃约 0.4s 快照
    await hostPage.evaluate(() => window.__forceKO(1));
    // KO 慢动作结束后 _finishRound 才 +1 分；等客机重新收包并追上比分
    await waitFor(guestPage, () => window.__netDebug().score[0] === 1, 12000, 'guest catches up score');
    await waitFor(guestPage, () => (window.__netDebug().played.ko || 0) > 0, 8000, 'guest ko event');
    await sleep(800);   // 给重复下发留时间（若去重失效此处 KO 会 +2）
    let g = await dbg(guestPage);
    check('丢包后客机比分追上（1-0）', g.score[0] === 1 && g.score[1] === 0, g.score);
    check('KO 事件补发且只播一次', (g.played.ko || 0) === koBefore + 1, { before: koBefore, after: g.played.ko });

    // ---------- B) 回合事件：每个已开始的回合恰好一次 ----------
    log('B：回合事件不重复播放');
    await waitFor(guestPage, () => window.__netDebug().round === 2, 12000, 'guest round2');
    await sleep(800);
    g = await dbg(guestPage);
    const hostRoundsBegun = await hostPage.evaluate(() => window.__game.round);
    check('ROUND 事件次数 = 已开始回合数（无重复）', (g.played.round || 0) === hostRoundsBegun, { played: g.played.round, rounds: hostRoundsBegun });
    check('第 2 回合血量满', g.hp[0] === (await hostPage.evaluate(() => window.__game.fighters[0].maxHp)), g.hp);

    // ---------- C) 主机事件队列被客机 ack 清理（不无限增长） ----------
    log('C：事件确认后主机队列收敛');
    await sleep(1200);
    const pending = await hostPage.evaluate(() => window.__netPending().length);
    check('主机未确认事件队列已清空（客机在持续 ack）', pending === 0, pending);

    // ---------- D) 断线：客机刷新重连后按主机快照重建，不残留上一局 ----------
    log('D：客机断线重连（刷新页面）');
    const roundBefore = (await dbg(hostPage)).round;
    await guestPage.close();
    await sleep(400);
    // 主机应收到 peer-left → 回标题
    await waitFor(hostPage, () => window.__game.phase === 'title', 8000, 'host back to title on peer left');
    check('主机收到断线后回标题并清理', (await hostPage.evaluate(() => window.__game.net === null)));
    check('主机断线清理后斗士销毁', (await hostPage.evaluate(() => window.__game.fighters.length)) === 0);

    const errs = [...hostPage.__errors];
    check('无未捕获脚本错误', errs.length === 0, errs.slice(0, 5));

    // ---------- E) 中途加入：先建房间、主机打到一半客机才进来 ----------
    log('E：中途加入（客机在主机局中才连接）');
    // 此前 D 步主机已回标题；重新建房，主机单机等待
    await hostPage.goto(`${BASE}/?lan=1&pick=0`, { waitUntil: 'load' });
    await waitFor(hostPage, () => window.__game.netRole === 'host', 20000, 'host rejoin host');
    // 主机还没对手，直接通过测试钩子先开一局（模拟已在局中）
    await hostPage.evaluate(() => {
      const g = window.__game;
      g.picks = [0, 1];
      g.mode = 'net-host';
      g._isNet = true;
      g.startMatch(0, 1);
    });
    await waitFor(hostPage, () => window.__game.phase === 'fight', 8000, 'host solo fight');
    await sleep(300);
    const guest2 = wire(await browser.newPage({ viewport: { width: 900, height: 640 } }));
    await guest2.goto(`${BASE}/?lan=1&pick=4`, { waitUntil: 'load' });
    await waitFor(guest2, () => window.__game.netRole === 'guest', 20000, 'guest2 role');
    await waitFor(hostPage, () => window.__game.netRole === 'host', 20000, 'host matched');
    // 客机入场后按主机快照重建并追到同一世代/回合/比分
    await waitFor(guest2, () => window.__game.phase === 'fight' && window.__game.fighters.length === 2, 20000, 'guest2 joins fight');
    await sleep(300);
    const h2 = await hostPage.evaluate(() => window.__netDebug());
    const g2 = await dbg(guest2);
    check('中途加入客机追上主机世代', g2.gen === h2.gen, { h: h2.gen, g: g2.gen });
    check('中途加入客机追上主机回合', g2.round === h2.round, { h: h2.round, g: g2.round });
    check('中途加入客机比分与主机一致', g2.score[0] === h2.score[0] && g2.score[1] === h2.score[1], { h: h2.score, g: g2.score });
    check('中途加入客机未残留旧局公告', !/胜/.test(g2.announce || ''), g2.announce);

    const errs2 = [...hostPage.__errors, ...guest2.__errors];
    check('中途加入无脚本错误', errs2.length === 0, errs2.slice(0, 5));

    log(failures === 0 ? '≡ 全部通过' : `≡ ${failures} 项失败`);
    if (failures) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
}
main().catch(e => { console.error('[rob] FATAL', e); process.exitCode = 1; });
