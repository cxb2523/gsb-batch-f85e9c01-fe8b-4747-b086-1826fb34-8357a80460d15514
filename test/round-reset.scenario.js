'use strict';
// ======================================================================
//  round-reset.scenario.js —— 回合清场收敛的浏览器内断言场景
//  由 test/run-round-reset.mjs 通过 headless --dump-dom 执行；也可在已
//  打开的 index.html?test=1 控制台里调用 window.__roundResetScenario()。
//  结果写入 #selftest-report（JSON）与 window.__roundResetResult。
// ======================================================================
(function () {
  async function runRoundResetScenario() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 600; i++) {
      const menuReady = document.getElementById('menu') && !document.getElementById('menu').classList.contains('hidden');
      if (window.__engine && __engine.scene && __engine.world && __engine.map && __engine.vm && menuReady && typeof Game !== 'undefined') break;
      await sleep(100);
    }
    const out = { ok: true, checks: [], errors: [], pageErrors: [] };
    window.__pageErrors = out.pageErrors;
    window.addEventListener('error', (e) => {
      // 忽略资源/网络类噪声，只收脚本运行时错误
      if (e && (e.message || e.error)) out.pageErrors.push(String(e.message || (e.error && e.error.stack) || e.type));
    });
    const check = (name, pass, extra) => {
      out.checks.push({ name, pass: !!pass, extra: extra === undefined ? null : extra });
      if (!pass) out.ok = false;
    };
    const section = async (name, fn) => {
      try { await fn(); }
      catch (e) { out.ok = false; out.errors.push(`[${name}] ` + String(e && e.stack || e)); check(name + ' 未抛出异常', false, String(e && e.message || e)); }
    };

    const Engine = window.__engine;
    if (!Engine || !Engine.scene) throw new Error('Engine 未完成启动');
    Engine.forceRun = false;          // 关掉 Engine.frame 自动 tick，改由场景手动推进
    Engine.paused = false;
    Input.lock = () => {};
    Input.unlock = () => {};
    // 验收只看场景图与状态，不看像素：停掉 Engine 的 requestAnimationFrame 自循环，
    // 改由场景按需调用 g.render，保证确定性且不被 --virtual-time-budget 提前截断。
    try {
      Engine.composer.render = () => {};
      Engine.frame = () => {};
    } catch (e) { /* ignore */ }
    const safeRender = (g) => { try { g.render(TICK, 1, 0, 0); } catch (e) { out.pageErrors.push('render: ' + (e.stack || e)); } };

    const advance = (g, secs) => { const n = Math.max(1, Math.round(secs / TICK)); for (let i = 0; i < n; i++) g.tick(TICK); };
    const c4Holders = (g) => g.actors.filter((a) => a.team === 'T' && a.inv && a.inv.c4);
    const inScene = (o) => { while (o) { if (o === Engine.scene) return true; o = o.parent; } return false; };
    const freshGame = (opts) => {
      if (Engine.game) Engine.quitToMenu(true);
      Object.assign(Engine.opts, { mode: 'comp', team: 'T', size: 2, diff: 'easy', ff: false, humans: [] }, opts || {});
      Engine.startGame();
      return Engine.game;
    };

    // ---------------------------------------------------------------
    // A：单机爆破，连推回合；安放 C4 后结束回合 -> 下一回合完整收束
    // ---------------------------------------------------------------
    await section('A 单机两回合', async () => {
      await sleep(20);
      const g = freshGame();
      const md = g.mode;
      check('A: 模式为 comp', md.id === 'comp');
      check('A: 从第 1 回合开始', md.round === 1);

      advance(g, 8.3);
      check('A: R1 冻结结束进入 live', md.phase === 'live', md.phase);
      md.endRound('CT', 'elim');
      check('A: endRound 进入 post', md.phase === 'post');
      advance(g, 5.8);
      check('A: 推进到第 2 回合', md.round === 2 && md.phase === 'freeze', `round=${md.round} ph=${md.phase}`);

      advance(g, 8.3);
      check('A: R2 冻结结束进入 live', md.phase === 'live', md.phase);
      let holders = c4Holders(g);
      check('A/R2: 恰好一名 T 携带 C4', holders.length === 1, holders.map((a) => a.name + '#id' + a.id));
      check('A/R2: bomb.carrier 与携带者一致', !!md.bomb && md.bomb.carrier === holders[0]);
      check('A/R2: 炸弹未安放/未掉落', !!md.bomb && !md.bomb.planted && !md.bomb.dropped);

      // 制造上一回合的各类物件（直接调底层接口，等价于实战产生的对象）
      const carrier = md.bomb.carrier;
      md.plantBomb(carrier, 'A');
      carrier.inv.c4 = false;                 // 与 actor.updateC4 安放完成后的行为一致
      const bombMesh = md.bombMesh;
      check('A: 安放后 C4 模型在场景中', !!bombMesh && inScene(bombMesh));

      const dropActor = g.actors.find((a) => a !== carrier) || carrier;
      const drop = g.dropWeapon(dropActor, new WeaponInst('ak47'));
      const dropMesh = drop.mesh;
      g.spawnGrenade('he', dropActor.pos.clone().add(new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, 0, 0), dropActor);
      const nadeMesh = g.grenades[g.grenades.length - 1].mesh;
      const victim = g.actors.find((a) => a !== carrier && a.model && !a.model.ragdoll) || carrier;
      g.makeRagdoll(victim, new THREE.Vector3(1, 0.2, 0), 'chest', false);
      const rag = g.ragdolls[g.ragdolls.length - 1];
      let lateFired = false;
      g.later(100, () => { lateFired = true; });
      check('A: 掉落物已生成', g.drops.length >= 1 && inScene(dropMesh));
      check('A: 手雷已生成', g.grenades.length >= 1 && inScene(nadeMesh));
      check('A: 布娃娃已生成', !!rag && g.ragdolls.length >= 1);
      check('A: 待执行定时器存在', g.timers.length >= 1);

      // 安放后引爆 -> 回合结束
      md.explodeBomb();
      check('A: 爆炸后回合进入 post', md.phase === 'post', md.phase);
      advance(g, 5.8);
      check('A: 进入第 3 回合', md.round === 3, 'round=' + md.round + ' ph=' + md.phase);

      check('A: 掉落物数组清空', g.drops.length === 0, 'len=' + g.drops.length);
      check('A: 手雷数组清空', g.grenades.length === 0, 'len=' + g.grenades.length);
      check('A: 布娃娃数组清空', g.ragdolls.length === 0, 'len=' + g.ragdolls.length);
      check('A: 定时器全部释放', g.timers.length === 0, 'len=' + g.timers.length);
      check('A: 被取消的定时器回调未执行', lateFired === false);
      check('A: 旧掉落模型已移出场景', !dropMesh.parent);
      check('A: 旧手雷模型已移出场景', !nadeMesh.parent);
      check('A: 旧 C4 模型已移出场景', !bombMesh.parent);
      check('A: 旧布娃娃 root/container 已移出场景', !!rag && !rag.root.parent && !rag.container.parent);
      check('A: bombMesh 引用已清空', md.bombMesh === null);
      check('A: 新回合炸弹未安放/未掉落', !!md.bomb && md.bomb.planted === false && md.bomb.dropped === false);
      holders = c4Holders(g);
      check('A/R3: 恰好一名 T 携带 C4', holders.length === 1, holders.map((a) => a.name));
      check('A/R3: bomb.carrier 与唯一携带者一致', holders.length === 1 && md.bomb.carrier === holders[0] && holders[0].inv.c4 === true);
      check('A/R3: 携带者存活', !!md.bomb.carrier && md.bomb.carrier.alive === true);

      // 聚焦：clearRoundFx 必须让已排队的短延时回调再也不执行
      let cancelled = false;
      g.later(0.01, () => { cancelled = true; });
      check('A: 短延时回调已入队', g.timers.length >= 1);
      const bombRef = md.bomb;
      g.clearRoundFx();
      check('A: clear 原地复位同一个炸弹对象', md.bomb === bombRef);
      check('A: clear 后炸弹为无携带者的初始态', !!md.bomb && md.bomb.carrier === null && md.bomb.dropped === false && md.bomb.planted === false);
      advance(g, 0.2);
      check('A: 清场后越过触发时刻，回调未执行', cancelled === false && g.timers.length === 0);

      // 对局结束（finish）同样必须完整收束
      g.dropWeapon(g.player, new WeaponInst('glock'));
      g.makeRagdoll(g.actors.find((a) => a.model && !a.model.ragdoll) || g.player, new THREE.Vector3(), 'chest', false);
      let finishTimerFired = false;
      g.later(0.01, () => { finishTimerFired = true; });
      check('A: finish 前确有掉落/布娃娃/定时器', g.drops.length >= 1 && g.ragdolls.length >= 1 && g.timers.length >= 1);
      md.finish();
      check('A: finish 置 over', g.over === true && md.phase === 'over');
      advance(g, 0.2);
      check('A: 对局结束时掉落物释放', g.drops.length === 0, 'len=' + g.drops.length);
      check('A: 对局结束时手雷释放', g.grenades.length === 0);
      check('A: 对局结束时布娃娃释放', g.ragdolls.length === 0);
      check('A: 对局结束时定时器释放且不触发', g.timers.length === 0 && finishTimerFired === false);
      check('A: finish 后 bombMesh 为空', md.bombMesh === null);
      safeRender(g);                       // 覆盖 over + 初始态炸弹下的 HUD/渲染路径
      check('A: finish 后渲染不抛错', out.pageErrors.length === 0, out.pageErrors.slice(-2));
      await sleep(20);
    });

    // ---------------------------------------------------------------
    // B：房主侧 —— 回合间中途加入者不继承 C4 / 掉落归属
    // ---------------------------------------------------------------
    await section('B 中途加入(房主)', async () => {
      const hg = freshGame();
      const hm = hg.mode;
      advance(hg, 8.3);
      hm.endRound('CT', 'elim');
      advance(hg, 3.0);                         // 仍在 post（5.5s）
      const remote = hg.addRemote({ pid: 4242, name: '中途加入者', team: 'T', knife: 'knife' });
      check('B: 新远端角色已建立', !!remote && hg.actors.includes(remote));
      check('B: 加入者初始无 C4', remote.inv.c4 === false);
      check('B: 加入者初始无主武器', remote.inv.primary === null);
      check('B: 爆破加入时先未出生', remote.alive === false);
      check('B: 没有旧掉落以新角色为 owner', hg.drops.every((d) => d.owner !== remote));
      advance(hg, 3.2);                         // post 结束 -> R2 freeze
      check('B: 推进到下一回合', hm.round === 2, 'round=' + hm.round);
      const hs = hg.actors.filter((a) => a.team === 'T' && a.inv.c4);
      check('B: 新回合恰好一名 T 持 C4', hs.length === 1, hs.map((a) => a.name));
      check('B: bomb.carrier 合法且与持有者一致', !!hm.bomb.carrier && hm.bomb.carrier === hs[0]);
      check('B: 加入者若有 C4 则必为唯一携带者', !remote.inv.c4 || (hs.length === 1 && hs[0] === remote));
      check('B: 加入者已出生并配默认手枪', remote.alive === true && !!remote.inv.secondary);
      await sleep(20);
    });

    // ---------------------------------------------------------------
    // C：加入端 —— 收到 clr 后清掉本地镜像同类物件，并废弃旧延迟事件
    // ---------------------------------------------------------------
    await section('C 加入端收 clr', async () => {
      const stubConn = { sent: [], send(o) { this.sent.push(o); } };
      const client = new NetClient(stubConn);
      const cg = new Game(Engine, { mode: 'comp', team: 'CT', name: '镜像加入者', net: client });
      try {
        const cm = cg.mode;
        const mirror = cg.createMirror({ name: '镜像匪', team: 'T', bot: 1 });
        mirror.id = 7001;
        client.byId.set(7001, mirror);
        const mirror2 = cg.createMirror({ name: '镜像匪2', team: 'T', bot: 1 });
        mirror2.id = 7003;
        client.byId.set(7003, mirror2);
        client.me = cg.player; cg.player.id = 7002;

        client.event({ t: 'drop', n: 101, w: 'ak47', c4: 0, p: [1, 0, 2], v: [0, 0, 0], ry: 0, sp: 0 });
        const cDropMesh = cg.drops[cg.drops.length - 1].mesh;
        client.event({ t: 'nade', id: 'he', p: [1, 1, 2], v: [0, 0, 0], a: 7001 });
        const cNadeMesh = cg.grenades[cg.grenades.length - 1].mesh;
        client.event({ t: 'kill', v: 7001, k: 7002, w: 'ak47', hs: 0, dir: [1, 0, 0], g: 'chest' });
        const cRag = cg.ragdolls[cg.ragdolls.length - 1];
        cm.syncBomb({ d: 0, p: 1, x: [0, 0, 0], y: 0, e: 0, f: 0 });
        const cBombMesh = cm.bombMesh;
        let cFired = false;
        cg.later(50, () => { cFired = true; });

        // 已进入延迟队列、尚未播放的旧回合事件：不能在 clr 后复活旧物件
        // 击杀事件特意指向第二个镜像（清场前没成为布娃娃），否则 makeRagdoll 会因
        // model.ragdoll 已存在而跳过，削弱“复活”断言。
        client.evq.push(
          { ht: 0, t: 'drop', n: 202, w: 'awp', c4: 0, p: [3, 0, 4], v: [0, 0, 0], ry: 0, sp: 0 },
          { ht: 0, t: 'nade', id: 'flash', p: [3, 1, 4], v: [0, 0, 0], a: 7001 },
          { ht: 0, t: 'kill', v: 7003, k: 7002, w: 'awp', hs: 1, g: 'head' }
        );

        check('C: 清场前掉落/手雷/布娃娃/C4 均存在', cg.drops.length >= 1 && cg.grenades.length >= 1 && cg.ragdolls.length >= 1 && !!cm.bombMesh);
        client.event({ t: 'clr' });
        cg.tick(60);                          // 越过所有被取消定时器的触发时刻
        check('C: clr 后掉落物清空', cg.drops.length === 0, 'len=' + cg.drops.length);
        check('C: clr 后 NetClient.drops 映射清空', client.drops.size === 0);
        check('C: clr 后手雷清空', cg.grenades.length === 0);
        check('C: clr 后布娃娃清空', cg.ragdolls.length === 0);
        check('C: clr 后定时器清空', cg.timers.length === 0);
        check('C: clr 后定时器回调取消', cFired === false);
        check('C: clr 后 C4 模型与状态清空', cm.bombMesh === null && cm.bomb === null && !cBombMesh.parent);
        check('C: clr 后掉落/手雷模型移出场景', !cDropMesh.parent && !cNadeMesh.parent);
        check('C: clr 后布娃娃移出场景', !!cRag && !cRag.root.parent && !cRag.container.parent);
        check('C: 延迟队列旧回合事件被废弃', client.evq.length === 0, 'len=' + client.evq.length);

        client.latest = { ht: 1, A: [] };
        client.snaps = [{ ht: 1, A: [] }];
        client.off = 0;
        client.update(0.016);
        check('C: 排空更新后旧掉落不复活', cg.drops.length === 0, 'len=' + cg.drops.length);
        check('C: 排空更新后旧手雷不复活', cg.grenades.length === 0);
        check('C: 排空更新后旧布娃娃不复活', cg.ragdolls.length === 0);

        client.event({ t: 'drop', n: 303, w: 'm4a4', c4: 0, p: [5, 0, 6], v: [0, 0, 0], ry: 0, sp: 0 });
        check('C: 清场后的新事件仍正常建物件', cg.drops.length === 1);
      } finally {
        cg.dispose();
      }
    });

    // ---------------------------------------------------------------
    // D：房主 -> 加入者 的真实事件广播/快照编码路径不被新炸弹状态破坏
    // ---------------------------------------------------------------
    await section('D clr 广播与快照', async () => {
      const hg = freshGame({ size: 3 });
      const sent = [];
      const host = new NetHost({ id: 77, sendTo(pid, m) { sent.push(m); }, sendRaw(pid, json) { sent.push(json); } });
      hg.net = host; host.attach(hg);
      hg.addRemote({ pid: 555, name: '远端', team: 'CT', knife: 'knife' });
      hg.clearRoundFx();                 // 房主清场应产生 clr 事件
      check('D: clearRoundFx 广播 clr', host.evq.some((e) => e.t === 'clr'));
      // 跑若干次 postTick，覆盖快照编码（含初始态炸弹与远端角色）
      let encOk = true;
      try { for (let i = 0; i < 8; i++) host.postTick(); } catch (e) { encOk = false; out.errors.push('[D postTick] ' + (e.stack || e)); }
      check('D: postTick/encode 在初始炸弹态下不抛异常', encOk);
      check('D: 至少发出过快照', sent.some((m) => typeof m === 'string' && m.indexOf('"t":"s"') >= 0));
      // 安放后再编码一次（clear 已令 carrier 复位，直接取一名 T）
      const carrier = hg.actors.find((a) => a.team === 'T');
      hg.mode.bomb.carrier = carrier;
      hg.mode.plantBomb(carrier, 'A'); carrier.inv.c4 = false;
      let encPlantOk = true;
      try { for (let i = 0; i < 4; i++) host.postTick(); } catch (e) { encPlantOk = false; out.errors.push('[D plant postTick] ' + (e.stack || e)); }
      check('D: 安放炸弹后快照编码不抛异常', encPlantOk);
      hg.net = null;
      host.detach();
      await sleep(20);
    });

    // ---------------------------------------------------------------
    // E：自然推进多个回合（机器人实战/击杀/掉落/布娃娃），每次换回合都应收束
    // ---------------------------------------------------------------
    await section('E 多回合自然推进', async () => {
      const g = freshGame({ size: 4 });
      const md = g.mode;
      let seenRounds = 1;
      let transitions = 0;
      // post 阶段记录“上一回合的物件身份”，换回合后核对这些旧对象已离场。
      // 不能只断言 drops.length===0：botBuy 在清场后可能因升级武器而掉落“新回合”的枪。
      let oldDropMeshes = [], oldNadeMeshes = [], oldRagRoots = [];
      const maxTicks = Math.round(400 / TICK);   // 最坏：两回合各 ~(115+40+8+5.5)s ≈ 337s
      for (let i = 0; i < maxTicks && transitions < 2; i++) {
        if (md.phase === 'post') {
          oldDropMeshes = g.drops.map((d) => d.mesh);
          oldNadeMeshes = g.grenades.map((x) => x.mesh);
          oldRagRoots = g.ragdolls.map((r) => r.root);
        }
        g.tick(TICK);
        if (md.round > seenRounds) {
          transitions++;
          seenRounds = md.round;
          check(`E: 第 ${seenRounds} 回合旧掉落模型全部离场`, oldDropMeshes.every((m) => !m.parent), `${oldDropMeshes.filter((m) => m.parent).length}/${oldDropMeshes.length} 残留`);
          check(`E: 第 ${seenRounds} 回合旧手雷模型全部离场`, oldNadeMeshes.every((m) => !m.parent));
          check(`E: 第 ${seenRounds} 回合旧布娃娃全部离场`, oldRagRoots.every((r) => !r.parent));
          check(`E: 第 ${seenRounds} 回合手雷数组为空`, g.grenades.length === 0);
          check(`E: 第 ${seenRounds} 回合布娃娃数组为空`, g.ragdolls.length === 0);
          check(`E: 第 ${seenRounds} 回合开始时无遗留定时器`, g.timers.length === 0, 'timers=' + g.timers.length);
          check(`E: 第 ${seenRounds} 回合 C4 唯一且一致`, (() => {
            const hs = g.actors.filter((a) => a.team === 'T' && a.inv.c4);
            return hs.length === 1 && md.bomb && md.bomb.carrier === hs[0] && !md.bomb.planted && !md.bomb.dropped;
          })());
          // 注：此时 g.drops 可能有 t≈0 的新掉落（botBuy 买沙鹰会换掉初始手枪），
          // 那是新回合的购买行为而非上一回合残留，故只按对象身份核对旧物件。
        }
        if (i % 4000 === 3999) { safeRender(g); await sleep(0); }  // 定期覆盖渲染路径并让出主线程
      }
      safeRender(g);
      check('E: 至少自然经历 2 次回合切换', transitions >= 2, 'transitions=' + transitions + ' round=' + md.round + ' phase=' + md.phase);
      await sleep(20);
    });

    // 整个场景期间页面主循环/渲染不应抛未捕获错误
    check('F: 页面无未捕获脚本错误', out.pageErrors.length === 0, out.pageErrors.slice(0, 3));

    const box = document.createElement('pre');
    box.id = 'selftest-report';
    box.textContent = JSON.stringify(out, null, 2);
    box.setAttribute('data-ok', out.ok ? '1' : '0');
    document.body.appendChild(box);
    document.title = out.ok ? 'SELFTEST-PASS' : 'SELFTEST-FAIL';
    window.__roundResetResult = out;
    return out;
  }
  window.__roundResetScenario = runRoundResetScenario;

  // 视觉验收入口：?selftest=shot&phase=before|after
  // 在 A 包点堆出 C4 模型/掉落/手雷/布娃娃；after 再执行一次完整回合重置。
  async function runShot() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 600; i++) {
      const menuReady = document.getElementById('menu') && !document.getElementById('menu').classList.contains('hidden');
      if (window.__engine && __engine.scene && __engine.map && menuReady) break;
      await sleep(100);
    }
    const Engine = window.__engine;
    Engine.forceRun = false; Input.lock = () => {};
    Object.assign(Engine.opts, { mode: 'comp', team: 'T', size: 3, diff: 'easy', ff: false, humans: [] });
    Engine.startGame();
    const g = Engine.game, md = g.mode;
    const advance = (secs) => { const n = Math.round(secs / TICK); for (let i = 0; i < n; i++) g.tick(TICK); };
    advance(8.3);
    const phase = /[?&]phase=after/.test(location.search) ? 'after' : 'before';
    const site = g.map.sites.A;
    const C = new THREE.Vector3((site.min[0] + site.max[0]) / 2, site.center.y, (site.min[1] + site.max[1]) / 2);
    const place = (a, p) => { a.pos.copy(p); a.prevPos.copy(p); a.renderPos.copy(p); };
    const lookAt = (eye, target) => {
      const dx = target.x - eye.x, dz = target.z - eye.z, dy = target.y - eye.y;
      g.player.yaw = Math.atan2(-dx, -dz);
      g.player.pitch = Math.asin(clamp(dy / Math.hypot(dx, dy, dz), -1, 1));
      g.player.pos.set(eye.x, eye.y - PHYS.standEye, eye.z);
      g.player.alive = true; g.player.hp = 100;
    };
    const eye = C.clone().add(new THREE.Vector3(5.2, 2.0, 5.2));
    lookAt(eye, C.clone().add(new THREE.Vector3(0, 0.4, 0)));

    const carrier = md.bomb.carrier;
    place(carrier, C.clone());
    md.plantBomb(carrier, 'A'); carrier.inv.c4 = false;
    // 几件掉落武器围在包点
    ['ak47', 'awp', 'deagle'].forEach((id, i) => {
      const a = g.actors.find((x) => x !== carrier) || carrier;
      const d = g.dropWeapon(a, new WeaponInst(id));
      d.pos.copy(C.clone().add(new THREE.Vector3(1.1 - i * 1.1, 0, 0.6 + (i % 2) * 0.8)));
    });
    const nadeOwner = g.actors.find((x) => x !== carrier) || carrier;
    g.spawnGrenade('he', C.clone().add(new THREE.Vector3(-0.8, 0.4, 0.9)), new THREE.Vector3(), nadeOwner);
    // 布娃娃
    const vic = g.actors.find((x) => x !== carrier && x.model);
    if (vic) { place(vic, C.clone().add(new THREE.Vector3(0.4, 0, -1.2))); vic.alive = true; g.syncModels(); g.makeRagdoll(vic, new THREE.Vector3(1.5, 0.4, 0), 'chest', false); }
    g.syncModels();
    g.render(TICK, 1, 0, 0);

    if (phase === 'after') {
      md.startRound();                 // 完整回合重置（内部 clearRoundFx + 重新指派 C4）
      lookAt(eye, C.clone().add(new THREE.Vector3(0, 0.4, 0)));
      g.syncModels(); g.render(TICK, 1, 0, 0);
    }
    document.title = 'SHOT-' + phase.toUpperCase() + '-READY';
    const tag = document.createElement('div');
    tag.id = 'shot-tag'; tag.textContent = phase;
    tag.style.cssText = 'position:fixed;left:8px;top:8px;color:#0f0;font:20px monospace;z-index:9999;background:#000a;padding:4px 8px';
    document.body.appendChild(tag);
    window.__shotReady = { phase, drops: g.drops.length, grenades: g.grenades.length, ragdolls: g.ragdolls.length, bombMesh: !!md.bombMesh };
  }
  if (/[?&]selftest=shot/.test(location.search)) {
    window.addEventListener('load', () => setTimeout(() => { runShot().catch((e) => { document.title = 'SHOT-FAIL'; const f = document.getElementById('fatal'); if (f) { f.classList.remove('hidden'); f.textContent = String(e.stack || e); } }); }, 300));
  }
  if (/[?&]selftest=round/.test(location.search)) {
    window.addEventListener('load', () => setTimeout(() => { runRoundResetScenario().catch((e) => {
      const out = { ok: false, checks: [], errors: [String(e && e.stack || e)] };
      const box = document.createElement('pre');
      box.id = 'selftest-report'; box.textContent = JSON.stringify(out, null, 2);
      document.body.appendChild(box); document.title = 'SELFTEST-FAIL';
    }); }, 300));
  }
})();
