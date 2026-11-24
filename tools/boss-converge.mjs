// 보스 페이즈 전환/사망 공격 수렴 체인 검증
// 시나리오:
//  1. 보스가 예고+근접판정+투사체+장판을 깔아둔 상태에서 강제 페이즈 전환
//     → 예고 폭발 안 함(then 미실행), 투사체 소실 및 비히트, 장판 틱 중단, 근접판정 제거
//  2. 전환 직후 새로 만든 공격(차세대 공격)은 청산되지 않고 정상 동작
//  3. 플레이어 본인의 공격/투사체/장판은 보스 수렴에 영향받지 않음
//  4. 보스 사망 시에도 동일하게 전부 수렴 + 예고 아이콘/투사체 텍스처 잔류 0
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const URL = process.env.URL || 'http://localhost:5173/';
// 시스템 Chrome(158)이 playwright-core 1.64의 CDP 파이프와 충돌하는 환경이라
// PLAYWRIGHT_BROWSERS_PATH 아래 번들 Chromium을 우선 사용하고, 없으면 시스템 Chrome으로 폴백
const candidates = [
  process.env.CHROME_BIN,
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1254/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
const wait = (ms) => page.waitForTimeout(ms);
const ev = (f) => page.evaluate(f);
const W = `__game.scene.getScene('World')`;
const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra: String(extra) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}

// ---------- 부팅: 새 게임 → 블레이드 → 보스 아레나 ----------
await page.goto(URL + '?debug', { waitUntil: 'domcontentloaded' });
await wait(2200);
await ev(() => localStorage.clear());
await page.reload({ waitUntil: 'domcontentloaded' });
await wait(2000);
await page.click('[data-a="guestNew"]');
await wait(400);
await page.click('[data-a="ccClass:blade"]');
await wait(200);
await page.click('[data-a="ccCreate"]');
await wait(1500);
for (let i = 0; i < 6; i++) { await page.keyboard.press('Space'); await wait(90); }
await ev(`(()=>{ const w=${W}; w.travel({mode:'boss',ch:1,bossId:'forest_predator'}); })()`);
await wait(2500);

// ---------- 테스트 하네스: 플레이어 피격 로그 + 보스 공격 4종 살포 ----------
const harness = `(()=>{
  const w=${W}; const C=w.combat, B=w.boss, P=w.player;
  if(!w.__hits){ w.__hits=[]; const orig=P.receive.bind(P);
    P.receive=(h)=>{ w.__hits.push({name:h.name||'', dot:!!h.dot, src:h.src&&h.src===B?'boss':(h.src===P?'player':'other')}); return orig(h); }; }
  P.invulnUntil=0; P.hp=P.maxHp;
  B.invuln=0; B.phase=0; B.fsm='RECOVERY'; B.q=[]; B.pendingDeath=false; B.alive=true;
  // 플레이어 위치/보스 위치 고정(판정 재현성)
  P.x=400; P.y=400; B.x=300; B.y=300;
  const sh={k:'circle',x:P.x,y:P.y,r:120};
  const out={};
  // 1) 아직 터지지 않은 예고(1000ms) — then이 세팅되면 카운트
  w.__thenFired=0;
  out.tele = C.telegraph(sh, 1000, {}, ()=>{ w.__thenFired++; }, B);
  // 2) 활성 근접 판정(플레이어 위에 깔림)
  out.atk = C.strike(B, {k:'circle',x:P.x,y:P.y,r:120}, {coef:0.5,name:'근접잔류'}, 5000, 99);
  // 3) 플레이어를 향해 날아가는 투사체(300ms 뒤 도달 권장, 수명 길게)
  out.proj = C.projectile(B, B.x, B.y, Math.atan2(P.y-B.y,P.x-B.x), 120, 2000, 14, 'fx_trace', 0xa8f0ff, {coef:0.5,name:'보스투사체'}, {});
  // 4) 플레이어 위에 5초 장판(250ms 첫 틱)
  out.zone = C.zone(B, {k:'circle',x:P.x,y:P.y,r:120}, 5000, {coef:0.2,name:'보스장판'}, 0x80ff60, 250);
  // 플레이어 자신의 공격 3종(보스 수렴에 쓸리면 안 됨)
  out.pTele = C.telegraph({k:'circle',x:B.x,y:B.y,r:80}, 1000, {subtle:true}, ()=>{ w.__pThen=(w.__pThen||0)+1; }, P);
  out.pAtk = C.strike(P, {k:'circle',x:B.x,y:B.y,r:200}, {coef:1,name:'플레이어타격',noNet:true}, 5000, 99);
  out.pProj = C.projectile(P, P.x, P.y, 0, 200, 2000, 10, 'fx_trace', 0xffe6b0, {coef:1,name:'플레이어투사체',noNet:true}, {});
  out.pZone = C.zone(P, {k:'circle',x:B.x,y:B.y,r:90}, 5000, {coef:1,name:'플레이어장판',noNet:true}, 0xffe6b0, 250);
  out.snap = {
    teles: C.teles.length, atks: C.atks.length, projs: C.projs.length, zones: C.zones.length,
    bossTele: C.teles.filter(t=>t.owner===B).length,
    bossProj: C.projs.filter(p=>p.owner===B).length,
    bossZone: C.zones.filter(z=>z.owner===B).length,
    bossAtk: C.atks.filter(a=>a.owner===B).length,
    pTele: C.teles.filter(t=>t.owner===P).length,
    pProj: C.projs.filter(p=>p.owner===P).length,
    pZone: C.zones.filter(z=>z.owner===P).length,
    pAtk: C.atks.filter(a=>a.owner===P).length,
  };
  return out.snap;
})()`;
const snap = await ev(harness);
console.log('snapshot before phase switch:', JSON.stringify(snap));
check('수렴 전 보스 공격 4종이 모두 존재', snap.bossTele === 1 && snap.bossAtk === 1 && snap.bossProj === 1 && snap.bossZone === 1, JSON.stringify(snap));
check('수렴 전 플레이어 공격 4종이 모두 존재', snap.pTele === 1 && snap.pAtk === 1 && snap.pProj === 1 && snap.pZone === 1, JSON.stringify(snap));

// ---------- 1. 강제 페이즈 전환(실제 게임 경로: enterPhase → cancelAll → combat.cancelOwner) ----------
await ev(`(()=>{ const w=${W}; w.__thenFired=0; w.boss.enterPhase(); })()`);
const afterSwitch = await ev(`(()=>{
  const w=${W}; const C=w.combat, B=w.boss, P=w.player;
  return {
    fsm: B.fsm,
    bossTele: C.teles.filter(t=>t.owner===B).length,
    bossAtk: C.atks.filter(a=>a.owner===B).length,
    bossProj: C.projs.filter(p=>p.owner===B).length,
    bossZone: C.zones.filter(z=>z.owner===B).length,
    pTele: C.teles.filter(t=>t.owner===P).length,
    pAtk: C.atks.filter(a=>a.owner===P).length,
    pProj: C.projs.filter(p=>p.owner===P).length,
    pZone: C.zones.filter(z=>z.owner===P).length,
    bossProjImgs: C.projs.filter(p=>p.owner===B).filter(p=>p.img&&p.img.active).length,
  };
})()`);
console.log('after enterPhase:', JSON.stringify(afterSwitch));
check('전환 후 보스 예고 전부 취소', afterSwitch.bossTele === 0);
check('전환 후 보스 근접판정 전부 제거', afterSwitch.bossAtk === 0);
check('전환 후 보스 투사체 전부 소실', afterSwitch.bossProj === 0);
check('전환 후 보스 장판 전부 제거', afterSwitch.bossZone === 0);
check('전환 후 보스 투사체 이미지 잔류 0', afterSwitch.bossProjImgs === 0);
check('플레이어 예고는 보존', afterSwitch.pTele === 1);
check('플레이어 근접판정은 보존', afterSwitch.pAtk === 1);
check('플레이어 투사체는 보존', afterSwitch.pProj === 1);
check('플레이어 장판은 보존', afterSwitch.pZone === 1);
check('보스 FSM이 PHASE_CHANGE', afterSwitch.fsm === 'PHASE_CHANGE');

// 1200ms 진행: 취소된 예고의 then이 발동해서는 안 되고, 장판 틱/투사체 히트도 없어야 함
const hitsBefore = (await ev(`${W}.__hits.length`));
await wait(1200);
const mid = await ev(`(()=>{
  const w=${W}; const C=w.combat, B=w.boss, P=w.player;
  return {
    thenFired: w.__thenFired,
    hits: w.__hits.length,
    bossObjs: C.teles.filter(t=>t.owner===B).length + C.atks.filter(a=>a.owner===B).length
      + C.projs.filter(p=>p.owner===B).length + C.zones.filter(z=>z.owner===B).length,
    // 보스 예고 아이콘이 씬에 남아있는지(텍스트 오브젝트)
    strayIcons: w.children.getChildren().filter(o=>o.type==='Text'&&o.text==='!'&&o.active).length,
  };
})()`);
console.log('1200ms after switch:', JSON.stringify(mid), 'hitsBefore', hitsBefore);
check('취소된 예고의 then 콜백 미실행', mid.thenFired === 0);
check('전환 애니메이션 구간 보스 공격 피격 0건', mid.hits === hitsBefore, `hits ${hitsBefore}→${mid.hits}`);
check('이후 프레임에도 보스 공격 객체 재생성 0', mid.bossObjs === 0);

// ---------- 2. 전환 이후 새 공격은 살아남아 정상 동작해야 함 ----------
const newAtk = await ev(`(()=>{
  const w=${W}; const C=w.combat, B=w.boss, P=w.player;
  w.__newThen=0;
  const t=C.telegraph({k:'circle',x:P.x,y:P.y,r:100}, 300, {}, ()=>{ w.__newThen++; C.strike(B,{k:'circle',x:P.x,y:P.y,r:100},{coef:0.4,name:'신페이즈타격'},300); }, B);
  const p=C.projectile(B, B.x, B.y, Math.atan2(P.y-B.y,P.x-B.x), 300, 2000, 12, 'fx_trace', 0xff8080, {coef:0.4,name:'신페이즈투사체'}, {});
  const z=C.zone(B, {k:'circle',x:P.x,y:P.y,r:100}, 2000, {coef:0.2,name:'신페이즈장판'}, 0xff5050, 200);
  return {tele:C.teles.includes(t), proj:C.projs.includes(p), zone:C.zones.includes(z)};
})()`);
check('전환 후 새 예고/투사체/장판 생성 정상', newAtk.tele && newAtk.proj && newAtk.zone, JSON.stringify(newAtk));
await wait(700); // 예고 만료 → then 발동 → 신페이즈 타격 들어가야 함
const newPhase = await ev(`(()=>{
  const w=${W};
  return { newThen: w.__newThen, newHit: w.__hits.filter(h=>h.name==='신페이즈타격').length };
})()`);
console.log('new phase behavior:', JSON.stringify(newPhase));
check('전환 후 새 예고의 then 정상 발동', newPhase.newThen === 1);
check('전환 후 새 페이즈 공격이 실제로 적중', newPhase.newHit >= 1, `hits=${newPhase.newHit}`);

// ---------- 3. 보스 사망 수렴 ----------
// 잔여 보스 공격을 다시 하나씩 깔고 die() 호출
await ev(`(()=>{
  const w=${W}; const C=w.combat, B=w.boss, P=w.player;
  B.phase=0; B.B.phases=[]; B.fsm='RECOVERY'; B.pendingDeath=false; B.hp=1;
  w.__dieThen=0;
  C.telegraph({k:'circle',x:P.x,y:P.y,r:120}, 1500, {}, ()=>{ w.__dieThen++; }, B);
  C.strike(B, {k:'circle',x:P.x,y:P.y,r:120}, {coef:0.5,name:'사망근접'}, 5000, 99);
  const pr=C.projectile(B, B.x, B.y, Math.atan2(P.y-B.y,P.x-B.x), 150, 3000, 14, 'fx_trace', 0xa8f0ff, {coef:0.5,name:'사망투사체'}, {});
  C.zone(B, {k:'circle',x:P.x,y:P.y,r:120}, 5000, {coef:0.2,name:'사망장판'}, 0x80ff60, 200);
  w.__dieProjImg = pr.img;
  // 플레이어 공격도 직전에 신규 생성 — 사망 수렴이 이것들을 건드리면 안 됨
  C.telegraph({k:'circle',x:B.x,y:B.y,r:80}, 5000, {subtle:true}, ()=>{}, P);
  C.strike(P, {k:'circle',x:B.x,y:B.y,r:200}, {coef:1,name:'플레이어타격',noNet:true}, 5000, 99);
  C.projectile(P, P.x, P.y, 0, 200, 5000, 10, 'fx_trace', 0xffe6b0, {coef:1,name:'플레이어투사체',noNet:true}, {});
  C.zone(P, {k:'circle',x:B.x,y:B.y,r:90}, 5000, {coef:1,name:'플레이어장판',noNet:true}, 0xffe6b0, 250);
  w.__hits = [];
  B.die();
})()`);
const afterDeath = await ev(`(()=>{
  const w=${W}; const C=w.combat, B=w.boss, P=w.player;
  return {
    fsm: B.fsm, alive: B.alive,
    bossTele: C.teles.filter(t=>t.owner===B).length,
    bossAtk: C.atks.filter(a=>a.owner===B).length,
    bossProj: C.projs.filter(p=>p.owner===B).length,
    bossZone: C.zones.filter(z=>z.owner===B).length,
    dieProjImgActive: !!(w.__dieProjImg && w.__dieProjImg.active),
    pTele: C.teles.filter(t=>t.owner===P).length,
    pAtk: C.atks.filter(a=>a.owner===P).length,
    pProj: C.projs.filter(p=>p.owner===P).length,
    pZone: C.zones.filter(z=>z.owner===P).length,
    strayIcons: w.children.getChildren().filter(o=>o.type==='Text'&&(o.text==='!'||o.text==='⚔')&&o.active).length,
  };
})()`);
console.log('after die:', JSON.stringify(afterDeath));
check('사망 후 보스 예고 0', afterDeath.bossTele === 0);
check('사망 후 보스 근접판정 0', afterDeath.bossAtk === 0);
check('사망 후 보스 투사체 0', afterDeath.bossProj === 0);
check('사망 후 보스 장판 0', afterDeath.bossZone === 0);
check('사망 투사체 텍스처 즉시 파괴', afterDeath.dieProjImgActive === false);
check('화면에 예고 아이콘 잔류 0', afterDeath.strayIcons === 0);
check('사망 수렴이 플레이어 공격을 건드리지 않음', afterDeath.pTele >= 1 && afterDeath.pAtk >= 1 && afterDeath.pProj >= 1 && afterDeath.pZone >= 1, JSON.stringify({t:afterDeath.pTele,a:afterDeath.pAtk,p:afterDeath.pProj,z:afterDeath.pZone}));

// 1500ms 더 진행: 사망 후 잔여 공격 피격/then 없어야 함
await wait(1500);
const post = await ev(`(()=>{
  const w=${W}; const C=w.combat, B=w.boss;
  return {
    dieThen: w.__dieThen,
    bossHits: w.__hits.filter(h=>h.src==='boss').length,
    bossObjs: C.teles.filter(t=>t.owner===B).length + C.atks.filter(a=>a.owner===B).length
      + C.projs.filter(p=>p.owner===B).length + C.zones.filter(z=>z.owner===B).length,
    // 살아있는 투사체가 참조 중인 이미지는 정상 분류 — 고아(어떤 투사체도 참조 안 함)만 잔재로 간주
    strayProjImgs: w.children.getChildren().filter(o=>o.type==='Image'&&o.texture&&o.texture.key==='fx_trace'
      &&o.blendMode===1&&o.active&&o.depth===100001&&!C.projs.some(p=>p.img===o)).length,
  };
})()`);
console.log('post-death 1500ms:', JSON.stringify(post));
check('사망 후 예고 then 미발동', post.dieThen === 0);
check('사망 후 보스 잔여 공격 피격 0건', post.bossHits === 0);
check('사망 후 보스 공격 객체 재생성 0', post.bossObjs === 0);
check('화면에 투사체 텍스처 잔류 0', post.strayProjImgs === 0);

// ---------- 4. 실제 보스전 종단간: 보스 패턴 도중 HP 깎아 자연 페이즈 전환 ----------
// 새 아레나에서 투사체 패턴을 가진 보스로 재진입 후 강제 페이즈 문턱까지 HP 하강
await ev(`(()=>{ const w=${W}; w.travel({mode:'boss',ch:3,bossId:'frost_hunter'}); })()`);
await wait(2500);
const e2e = await ev(`(async()=>{
  const w=${W}; const C=w.combat, B=w.boss, P=w.player;
  P.invulnUntil=1e12; // 관측만: 죽지 않도록
  // 보스가 투사체/예고를 만들 때까지 패턴 직접 실행
  const pat=B.B.patterns.find(p=>p.type==='projFan')||B.B.patterns[0];
  B.run(pat);
  // 예고가 잡히도록 잠시 대기(동기 스텝 대신 now 인위 전진은 위험하니 생성 여부만 확인)
  const hadTele=C.teles.some(t=>t.owner===B);
  // 페이즈 문턱 강제 돌입
  B.hp=Math.ceil(B.maxHp*0.49);
  B.enterPhase();
  return {
    hadTele,
    bossTele: C.teles.filter(t=>t.owner===B).length,
    bossAtk: C.atks.filter(a=>a.owner===B).length,
    bossProj: C.projs.filter(p=>p.owner===B).length,
    bossZone: C.zones.filter(z=>z.owner===B).length,
    fsm: B.fsm, phase: B.phase,
  };
})()`);
console.log('real-boss phase transition:', JSON.stringify(e2e));
check('실보스: 패턴 중 예고가 생성됨', e2e.hadTele === true);
check('실보스: 자연 페이즈 전환에 보스 공격 수렴', e2e.bossTele === 0 && e2e.bossAtk === 0 && e2e.bossProj === 0 && e2e.bossZone === 0, JSON.stringify(e2e));
check('실보스: 페이즈/모드 정상 진행', e2e.fsm === 'PHASE_CHANGE' && e2e.phase === 1);

const failed = results.filter((r) => !r.pass);
console.log(`\\n==== ${results.length - failed.length}/${results.length} passed ====`);
if (errors.length) { console.log('BROWSER ERRORS:', errors.length); errors.slice(0, 10).forEach((e) => console.log(' ', e)); }
await page.screenshot({ path: 'tools/boss-converge-final.png' });
await browser.close();
process.exit(failed.length ? 1 : 0);
