// 局域网联机端到端验证：主机权威的回合推进 / KO 收尾 / 下一回合 / 结算 / 重赛 / 回标题清理
//
// 前提：本机 Chromium（playwright-core）+ 项目 server.js。
// 运行：node tests/lan-round-sync.mjs
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const PORT = Number(process.env.TEST_PORT || 3312);
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe';

const log = (...a) => console.log('[lan]', ...a);
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
    executablePath: CHROME,
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const wire = (page, tag) => {
    page.__errors = [];
    page.on('pageerror', e => page.__errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.__errors.push('console: ' + m.text()); });
    page.on('close', () => {});
    return page;
  };

  try {
    const hostPage = wire(await browser.newPage({ viewport: { width: 900, height: 640 } }), 'host');
    await hostPage.goto(`${BASE}/?lan=1&pick=0`, { waitUntil: 'load' });
    // 等主机就位（先到者即主机）
    await waitFor(hostPage, () => window.__netDebug && window.__game && window.__game.netRole === 'host', 20000, 'host role');

    const guestPage = wire(await browser.newPage({ viewport: { width: 900, height: 640 } }), 'guest');
    await guestPage.goto(`${BASE}/?lan=1&pick=4`, { waitUntil: 'load' });
    await waitFor(guestPage, () => window.__game && window.__game.netRole === 'guest', 20000, 'guest role');

    // ---------- 1) 双方进入对战，且阵容/世代一致 ----------
    log('阶段 1：开局同步');
    await waitFor(hostPage, () => window.__game.phase === 'fight' && window.__game.fighters.length === 2, 25000, 'host fight');
    await waitFor(guestPage, () => window.__game.phase === 'fight' && window.__game.fighters.length === 2, 25000, 'guest fight');
    let h = await dbg(hostPage), g = await dbg(guestPage);
    check('主机/客机世代号一致', h.gen === g.gen, { h: h.gen, g: g.gen });
    check('双方回合均为 1', h.round === 1 && g.round === 1, { h: h.round, g: g.round });
    check('双方比分 0-0', h.score[0] === 0 && h.score[1] === 0 && g.score[0] === 0 && g.score[1] === 0, { h: h.score, g: g.score });
    check('舞台一致', h.stage === g.stage, { h: h.stage, g: g.stage });
    check('客机阶段为 fight（非 result）', g.phase === 'fight', g);

    // 等 intro 结束进入 live
    await waitFor(hostPage, () => window.__game.subPhase === 'live', 8000, 'host live');
    await waitFor(guestPage, () => window.__game.subPhase === 'live', 8000, 'guest live');

    // ---------- 2) 第 1 回合 KO：主客机一致，客机进 KO 慢动作、分数 +1 ----------
    log('阶段 2：第 1 回合 KO 收尾');
    const koEvtCountBefore = (await dbg(guestPage)).played.ko || 0;
    await hostPage.evaluate(() => window.__forceKO(1));
    await waitFor(guestPage, () => window.__game.subPhase === 'koSlow', 6000, 'guest koSlow');
    g = await dbg(guestPage);
    check('客机进入 KO 慢动作', g.sub === 'koSlow', g.sub);
    check('客机时间缩放跟随主机慢动作', (await guestPage.evaluate(() => window.__game.world.timeScale)) < 0.6);
    // 分数应 +1 给 P1
    await waitFor(guestPage, () => window.__netDebug().score[0] === 1, 8000, 'guest score p1=1');
    g = await dbg(guestPage); h = await dbg(hostPage);
    check('客机比分镜像主机 1-0', g.score[0] === 1 && g.score[1] === 0, g.score);
    check('主机比分 1-0', h.score[0] === 1, h.score);
    const koEvtCountAfter = (await dbg(guestPage)).played.ko || 0;
    check('客机 KO 事件恰好播放一次', koEvtCountAfter === koEvtCountBefore + 1, { before: koEvtCountBefore, after: koEvtCountAfter });

    // ---------- 3) 自动进入第 2 回合：主客机 round=2，计时与血量重置 ----------
    log('阶段 3：下一回合开始');
    await waitFor(guestPage, () => window.__netDebug().round === 2, 12000, 'guest round 2');
    await waitFor(hostPage, () => window.__game.round === 2, 12000, 'host round 2');
    // 回合刚开始时计时接近满值
    await waitFor(guestPage, () => window.__game.subPhase === 'intro' || window.__game.timer > 50, 6000, 'guest round2 start');
    h = await dbg(hostPage); g = await dbg(guestPage);
    check('双方进入第 2 回合', h.round === 2 && g.round === 2, { h: h.round, g: g.round });
    check('第 2 回合计时重置（>50s）', g.timer > 50, g.timer);
    // 新回合血量应恢复为该角色满血（角色不同 maxHp 不同，用主机值对齐）
    const maxHp = await hostPage.evaluate(() => window.__game.fighters.map(f => f.maxHp));
    check('第 2 回合血量恢复满血', g.hp[0] === maxHp[0] && g.hp[1] === maxHp[1], { hp: g.hp, maxHp });
    check('客机血量与主机一致', g.hp[0] === h.hp[0] && g.hp[1] === h.hp[1], { g: g.hp, h: h.hp });
    check('回合提示与主机一致', (g.announce || '').includes('ROUND 2') || g.sub === 'intro', g.announce);

    // ---------- 4) 第 2 回合再 KO → 结算（2-0），客机以主机结果为准 ----------
    log('阶段 4：第 2 回合 KO → 结算');
    await waitFor(hostPage, () => window.__game.subPhase === 'live', 8000, 'host live 2');
    await waitFor(guestPage, () => window.__game.subPhase === 'live', 8000, 'guest live 2');
    await hostPage.evaluate(() => window.__forceKO(1));
    await waitFor(hostPage, () => window.__game.phase === 'result', 12000, 'host result');
    await waitFor(guestPage, () => window.__netDebug().phase === 'result', 12000, 'guest result');
    await sleep(400);
    h = await dbg(hostPage); g = await dbg(guestPage);
    check('主机结算 2-0', h.score[0] === 2 && h.score[1] === 0, h.score);
    check('客机结算比分与主机一致 2-0', g.score[0] === 2 && g.score[1] === 0, g.score);
    check('客机结算面板显示 P1 获胜', /P1/.test(g.resultText) && /2\s*-\s*0/.test(g.resultText), g.resultText);
    check('结算面板与主机一致', g.resultText === h.resultText, { h: h.resultText, g: g.resultText });
    check('客机胜者索引来自主机', g.winners === h.winners, { h: h.winners, g: g.winners });

    // ---------- 5) 客机点击「再来一局」→ 由主机权威重开，双方归零 ----------
    log('阶段 5：客机发起重赛');
    await guestPage.evaluate(() => document.getElementById('btn-rematch').click());
    await waitFor(hostPage, () => window.__game.phase === 'fight' && window.__game.round === 1 && window.__game.score[0] === 0, 12000, 'host rematch');
    await waitFor(guestPage, () => window.__netDebug().phase === 'fight' && window.__netDebug().round === 1, 12000, 'guest rematch');
    await sleep(300);
    h = await dbg(hostPage); g = await dbg(guestPage);
    check('重赛后主机比分归零', h.score[0] === 0 && h.score[1] === 0, h.score);
    check('重赛后客机比分归零', g.score[0] === 0 && g.score[1] === 0, g.score);
    check('重赛后回合归 1', h.round === 1 && g.round === 1, { h: h.round, g: g.round });
    check('重赛后计时重置', g.timer > 50, g.timer);
    check('重赛后能量归零', g.meter[0] === 0 && g.meter[1] === 0, g.meter);
    check('重赛后结算面板已隐藏', g.resultText === '', g.resultText);
    check('重赛后双方世代号仍一致且递增', h.gen === g.gen && h.gen > 1, { h: h.gen, g: g.gen });
    check('重赛公告不残留上一局胜负', !/胜/.test(g.announce || '') || /ROUND/.test(g.announce || ''), g.announce);

    // ---------- 6) 主机点击「再来一局」→ 客机同样跟随 ----------
    log('阶段 6：主机发起重赛，客机跟随');
    await waitFor(hostPage, () => window.__game.subPhase === 'live', 8000, 'host live 3');
    await hostPage.evaluate(() => window.__forceKO(0));           // P2 赢一回合
    await waitFor(hostPage, () => window.__game.subPhase === 'roundend', 10000, 'host roundend');
    await waitFor(guestPage, () => window.__netDebug().score[1] === 1, 10000, 'guest score p2=1');
    h = await dbg(hostPage); g = await dbg(guestPage);
    check('客机镜像 P2 拿分', g.score[1] === 1, g.score);
    // 直接调用结算按钮所在流程：把主机推进到 result 需要再赢一回合，这里改为验证 host 重赛按钮守卫不误触发
    // 用第二个 KO 推进到 result
    await waitFor(hostPage, () => window.__game.subPhase === 'live', 12000, 'host live 4');
    await hostPage.evaluate(() => window.__forceKO(0));
    await waitFor(hostPage, () => window.__game.phase === 'result', 12000, 'host result 2');
    await waitFor(guestPage, () => window.__netDebug().phase === 'result', 12000, 'guest result 2');
    h = await dbg(hostPage); g = await dbg(guestPage);
    check('主机结算 0-2、客机一致', h.score[0] === 0 && h.score[1] === 2 && g.score[1] === 2, { h: h.score, g: g.score });
    check('客机结算显示 P2 获胜', /P2/.test(g.resultText), g.resultText);

    await hostPage.evaluate(() => document.getElementById('btn-rematch').click());
    await waitFor(guestPage, () => window.__netDebug().phase === 'fight' && window.__netDebug().score[1] === 0, 12000, 'guest follows host rematch');
    await sleep(300);
    h = await dbg(hostPage); g = await dbg(guestPage);
    check('主机重赛后客机比分归零', g.score[0] === 0 && g.score[1] === 0, g.score);
    check('主机重赛后客机回合归 1', g.round === 1, g.round);
    check('主机重赛后客机结算面板隐藏', g.resultText === '', g.resultText);

    // ---------- 7) 回标题：释放联机、清空待发事件与远端输入 ----------
    log('阶段 7：回标题清理');
    await hostPage.evaluate(() => document.getElementById('btn-to-menu').click());
    await waitFor(hostPage, () => window.__game.phase === 'title', 8000, 'host title');
    await waitFor(guestPage, () => window.__game.phase === 'title', 8000, 'guest title (peer/menu)');
    await sleep(300);
    h = await dbg(hostPage);
    const cleanup = await hostPage.evaluate(() => ({
      net: window.__game.net,
      pending: window.__game._pendingNetEvts.length,
      remote: Object.keys(window.__game.remoteInput || {}).length,
      fighters: window.__game.fighters.length,
      score: window.__game.score.slice(),
      evtLast: window.__game._netEvtLast,
    }));
    check('回标题后释放 NetSession', cleanup.net === null, cleanup.net);
    check('回标题后待发事件清空', cleanup.pending === 0, cleanup.pending);
    check('回标题后远端输入清空', cleanup.remote === 0, cleanup.remote);
    check('回标题后斗士已销毁', cleanup.fighters === 0, cleanup.fighters);
    check('回标题后比分归零', cleanup.score[0] === 0 && cleanup.score[1] === 0, cleanup.score);
    check('客机也回到标题', (await dbg(guestPage)).phase === 'title');

    // ---------- 8) 页面无脚本错误 ----------
    const errs = [...hostPage.__errors, ...guestPage.__errors];
    check('无未捕获脚本错误', errs.length === 0, errs.slice(0, 5));

    log(failures === 0 ? '≡ 全部通过' : `≡ ${failures} 项失败`);
    if (failures) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    server.kill();
  }
}

main().catch(e => { console.error('[lan] FATAL', e); process.exitCode = 1; });
