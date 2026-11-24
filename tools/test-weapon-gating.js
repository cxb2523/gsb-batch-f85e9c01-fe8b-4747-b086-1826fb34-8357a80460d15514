/* Weapon/input state-machine acceptance tests for Operation Ironhold.
 *
 * Runs only against the live page — it drives the SAME input paths the player
 * uses (dispatched mousedown/mouseup/keydown events + the real update loop) and
 * never calls fireWeapon() to bypass the trigger/state machine.
 *
 * Inject by pasting this whole file into the devtools console on the running
 * game, then:
 *
 *     await WeaponGate.run()        // prints one block, returns the summary
 *
 * It prints a PASS/FAIL line per check and a final "GATE: n/n passed" banner.
 * Every check is a plain boolean; the returned object is machine-judgeable.
 */
(function () {
  'use strict';

  /* one real animation frame — the game's own rAF loop advances the state */
  const frame = () => new Promise(res => requestAnimationFrame(() => res()));
  const now = () => performance.now();

  /* ---- real input: dispatch the very events the game listens for --------- */
  function mouse(type, button) {
    window.dispatchEvent(new MouseEvent(type, {
      button: button == null ? 0 : button,
      buttons: type === 'mousedown' ? (button === 2 ? 2 : 1) : 0,
      bubbles: true, cancelable: true, view: window
    }));
  }
  function key(type, code) {
    window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true }));
  }
  const press = () => mouse('mousedown', 0);
  const release = () => mouse('mouseup', 0);
  const rightClick = () => mouse('mousedown', 2);
  const tapKey = code => { key('keydown', code); key('keyup', code); };

  /* ---- known quiet state ------------------------------------------------ */
  function quiet() {
    G.over = false; G.started = true; G.running = true; G.paused = false;
    if (UI.pause) UI.pause.classList.remove('on');
    player.dead = false; player.hp = 100; player.armor = 50;
    window.__god = true;
    player.switching = 0; player.switchTo = -1;
    player.reloadT = 0; player.pumpT = 0; player.boltT = 0; player.fireCooldown = 0;
    player.triggerHeld = false; player.triggerEdge = false;
    player.triggerReleased = true; player.clickBuf = 0;
    player.reloadWeapon = -1;
    player.ads = false; player.adsK = 0; player.adsEase = 0; player.adsSettled = false;
    player.vel.set(0, 0, 0);
    for (const w of WEAPONS) w.spread = w.spreadBase;
    if (window.H && H.resume) H.resume();
  }

  const shots = () => G.shots;
  const hits = () => G.hits;
  const liveShells = () => SHELLS.filter(s => s.life > 0).length;
  const flashNow = () => +muzzleSprite.material.opacity.toFixed(3);
  const vmLightNow = () => +vmMuzzleLight.intensity.toFixed(2);

  function equip(i) {
    if (window.H && H.wep) { H.wep(i); return; }
    player.weapon = i; player.switching = 0; player.switchTo = -1;
    for (const w of WEAPONS) w.vm.group.visible = false;
    WEAPONS[i].vm.group.visible = true;
    updateAmmoUI();
  }
  function setAmmo(i, mag, res) { WEAPONS[i].mag = mag; WEAPONS[i].res = res; updateAmmoUI(); }

  function makeReport() {
    const checks = [];
    const add = (name, ok, detail) => {
      checks.push({ name, ok: !!ok, detail: detail == null ? '' : detail });
      return ok;
    };
    return { checks, add };
  }

  /* Run `fn` every frame while `cond()` holds, with an absolute cap. `fn` sees
     the state *after* the frame. Returns the number of frames observed. */
  async function whileState(cond, fn, maxMs) {
    const t0 = now();
    let n = 0;
    while (cond()) {
      await frame();
      n++;
      if (fn) fn();
      if (now() - t0 > (maxMs || 8000)) break;
      if (n > 100000) break;
    }
    return n;
  }

  /* =====================================================================
     SCENARIO 1 — reload blocks every firing side-effect; held trigger then
     resumes according to the weapon's fire mode.
     ===================================================================== */
  async function reloadHold(mode) {
    const { checks, add } = makeReport();
    const wi = mode === 'fullauto' ? 0 : mode === 'pump' ? 1 : 2;  // rifle / shotgun / pistol
    quiet();
    equip(wi);
    const w = WEAPONS[wi];
    const startMag = Math.max(2, Math.floor(w.magSize / 2));
    setAmmo(wi, startMag, w.reserve);
    player.fireCooldown = 0;

    /* start reload through the real R path */
    tapKey('KeyR');
    await frame(); await frame();
    add(mode + ': reload armed by R', player.reloadT > 0, 'reloadT=' + player.reloadT.toFixed(3));

    /* hold the trigger and sample every frame strictly while reloading.
       A shot on the completion frame (reloadT hits 0 then firing resolves) is
       the intended resume, not a during-reload shot — so side-effects are only
       counted on frames that are still reloading *after* the update. */
    const s0 = shots(), h0 = hits(), sh0 = liveShells();
    let violations = 0, hitViol = 0, flashPeak = 0, vmPeak = 0, shellPeak = 0;
    let magAtCompletion = startMag, resumeShotOnCompletion = 0;
    press();
    const tStart = now();
    /* headless software rendering can run well under 10 fps, and the game
       clamps dt, so game time advances far slower than wall clock — give the
       reload a generous ceiling rather than counting frames */
    while (now() - tStart < 45000) {
      if (player.reloadT <= 0) break;      // reload already finished
      const sBefore = shots();
      await frame();
      if (player.reloadT > 0) {
        /* still mid-reload after this update: nothing may have fired */
        if (shots() > sBefore) violations++;
        if (hits() > h0) hitViol++;
        flashPeak = Math.max(flashPeak, flashNow());
        vmPeak = Math.max(vmPeak, vmLightNow());
        shellPeak = Math.max(shellPeak, liveShells() - sh0);
      } else {
        /* the reload completed on this update; a shot now is a resume shot */
        magAtCompletion = w.mag;
        resumeShotOnCompletion = shots() - sBefore;
        break;
      }
    }

    add(mode + ': no shot while reloading', violations === 0, 'violatingFrames=' + violations);
    add(mode + ': no hit statistic while reloading', hitViol === 0, 'hitFrames=' + hitViol);
    add(mode + ': no muzzle flash while reloading', flashPeak <= 1e-6 && vmPeak <= 1e-6,
        'flashPeak=' + flashPeak + ' vmPeak=' + vmPeak);
    add(mode + ': no casing while reloading', shellPeak === 0, 'shellPeak=' + shellPeak);
    add(mode + ': reload completed while trigger held', player.reloadT === 0,
        'reloadT=' + player.reloadT.toFixed(4));
    add(mode + ': magazine refilled on completion', magAtCompletion >= startMag + 1,
        'mag=' + magAtCompletion + ' was=' + startMag);

    /* still holding: count resume shots. The completion-frame shot (if any)
       already counts, so seed the tally from total shots since reload start. */
    const want = mode === 'fullauto' ? 3 : 1;
    let resumeTotal = shots() - s0;
    const t0 = now();
    while (resumeTotal < want && now() - t0 < 20000) {
      await frame();
      resumeTotal = shots() - s0;
    }
    if (mode === 'fullauto') {
      add('fullauto: resumed sustained fire while held', resumeTotal >= 3, 'shots=' + resumeTotal);
    } else {
      add(mode + ': exactly one round per held press on resume', resumeTotal === 1,
          'shots=' + resumeTotal + ' (onCompletion=' + resumeShotOnCompletion + ')');
      /* keep holding well past the pump/bolt cycle: a semi/pump/bolt gun must
         NOT fire again without a fresh press. Budget is generous in wall clock
         because the cycle is measured in game time, which creeps under load. */
      const sFlat = shots();
      await whileState(() => true, null, mode === 'pump' ? 8000 : 5000);
      add(mode + ': no repeat fire while held', shots() === sFlat, 'extra=' + (shots() - sFlat));
    }

    /* release and confirm the gun goes quiet */
    release();
    await frame(); await frame();
    const sIdle = shots();
    await whileState(() => true, null, 400);
    add(mode + ': quiet after release', shots() === sIdle, 'extra=' + (shots() - sIdle));
    return { name: 'reload-hold-' + mode, checks };
  }

  /* =====================================================================
     SCENARIO 2 — swap transition blocks fire and never spends the new mag.
     ===================================================================== */
  async function swapGate() {
    const { checks, add } = makeReport();
    quiet();
    equip(0);
    setAmmo(0, WEAPONS[0].magSize, WEAPONS[0].reserve);
    setAmmo(3, WEAPONS[3].magSize, WEAPONS[3].reserve);
    const sniperMag0 = WEAPONS[3].mag, sniperRes0 = WEAPONS[3].res;

    tapKey('Digit4');
    await frame(); await frame();
    add('swap: transition started', player.switching > 0, 'switching=' + player.switching.toFixed(3));

    /* hold the trigger across the whole transition; sample strictly while
       switching > 0 (at both the start and end of each frame) */
    press();
    let violations = 0, flashPeak = 0, vmPeak = 0, shellPeak = 0;
    let magMoved = false, resMoved = false;
    const sh0 = liveShells();
    const sSwapStart = shots();
    const t0 = now();
    while (player.switching > 0 && now() - t0 < 6000) {
      const sBefore = shots();
      await frame();
      /* if the transition ended on this frame (switching hit 0 during the
         update), a resume shot fired that same frame is legitimate */
      if (player.switching > 0) {
        if (shots() > sBefore) violations++;
        flashPeak = Math.max(flashPeak, flashNow());
        vmPeak = Math.max(vmPeak, vmLightNow());
        shellPeak = Math.max(shellPeak, liveShells() - sh0);
        if (WEAPONS[3].mag !== sniperMag0) magMoved = true;
        if (WEAPONS[3].res !== sniperRes0) resMoved = true;
      }
    }
    add('swap: transition finished', player.switching === 0, 'switching=' + player.switching);
    add('swap: reached the new weapon', player.weapon === 3, 'weapon=' + player.weapon);
    add('swap: no shot during transition', violations === 0, 'violatingFrames=' + violations);
    add('swap: no muzzle flash during transition', flashPeak <= 1e-6 && vmPeak <= 1e-6,
        'flashPeak=' + flashPeak + ' vmPeak=' + vmPeak);
    add('swap: no casing during transition', shellPeak === 0, 'shellPeak=' + shellPeak);
    add('swap: new weapon mag untouched during transition', !magMoved, 'mag=' + WEAPONS[3].mag);
    add('swap: new weapon reserve untouched during transition', !resMoved, 'res=' + WEAPONS[3].res);

    /* the held trigger may now produce exactly one sniper round — that is the
       intended post-transition resume, not a transition shot. Seed the tally
       from total shots since the swap began so a completion-frame shot counts. */
    const tPost = now();
    while (shots() - sSwapStart < 1 && now() - tPost < 1500) await frame();
    const post = shots() - sSwapStart;
    add('swap: exactly one round after transition, never before', post === 1,
        'postShots=' + post + ' violatingDuringSwitching=0');
    add('swap: new mag spent only by the post-transition shot',
        WEAPONS[3].mag === sniperMag0 - 1, 'mag=' + WEAPONS[3].mag + ' was=' + sniperMag0);
    release();
    await frame(); await frame();
    return { name: 'swap-gate', checks };
  }

  /* =====================================================================
     SCENARIO 3 — firing mid-ADS uses the hipfire cone, not the aimed one.
     ===================================================================== */
  async function adsEaseSpread() {
    const { checks, add } = makeReport();
    quiet();
    equip(0);
    const w = WEAPONS[0];
    setAmmo(0, w.magSize, w.reserve);
    player.fireCooldown = 0; player.adsK = 0; player.adsEase = 0; player.adsSettled = false;

    /* begin the 0.2s ease with a real right click */
    rightClick();
    await frame();
    /* sample the ease mid-flight (well before adsK reaches 1) */
    const easeMid = player.adsK;
    add('ads: shot taken mid-ease', easeMid > 0.02 && easeMid < 0.95, 'adsK=' + easeMid.toFixed(2));
    const spreadBaseMid = w.spread;
    player.fireCooldown = 0;
    press(); await frame(); await frame(); release();
    const usedMid = player.lastShotSpread;
    const settledMid = player.lastShotAdsSettled;
    add('ads: mid-ease shot marked not settled', settledMid === false, 'adsSettled=' + settledMid);
    /* hipfire cone applies the whole ADS blend at 1.0 (no tightening) */
    const hipConeMid = spreadBaseMid;              // adsEase factor treated as 0
    const aimedConeMid = spreadBaseMid * w.adsSpread;
    add('ads: mid-ease cone ≈ hipfire (not tightened)',
        usedMid >= hipConeMid - 1e-9 && usedMid > aimedConeMid + 1e-6,
        'used=' + usedMid.toFixed(5) + ' hip=' + hipConeMid.toFixed(5) +
        ' aimed=' + aimedConeMid.toFixed(5));

    /* let the sight settle fully, then fire and confirm the aimed cone applies */
    const t0 = now();
    while (!player.adsSettled && now() - t0 < 3000) await frame();
    add('ads: ease eventually settles', player.adsSettled, 'adsK=' + player.adsK.toFixed(3));
    if (player.adsSettled) {
      const spreadBaseSettled = w.spread;
      player.fireCooldown = 0;
      press(); await frame(); await frame(); release();
      const usedSettled = player.lastShotSpread;
      const aimedConeSettled = spreadBaseSettled * w.adsSpread;
      add('ads: settled shot is flagged settled', player.lastShotAdsSettled === true,
          'adsSettled=' + player.lastShotAdsSettled);
      add('ads: settled shot uses the tightened cone',
          Math.abs(usedSettled - aimedConeSettled) < 1e-3 && usedSettled < spreadBaseSettled * 0.6,
          'used=' + usedSettled.toFixed(5) + ' aimed=' + aimedConeSettled.toFixed(5));
    }
    rightClick();   // aim back down
    await frame(); await frame();
    return { name: 'ads-ease-spread', checks };
  }

  /* =====================================================================
     SCENARIO 4 — reload interrupted (swap / ADS) conserves ammo, clears timer.
     ===================================================================== */
  async function reloadInterrupt() {
    const { checks, add } = makeReport();
    quiet();
    equip(0);
    const w = WEAPONS[0];
    setAmmo(0, 5, 120);
    player.fireCooldown = 0;
    tapKey('KeyR');
    await frame(); await frame();
    add('interrupt: reload started', player.reloadT > 0, 'reloadT=' + player.reloadT.toFixed(3));
    const beforeMag = WEAPONS[0].mag, beforeRes = WEAPONS[0].res;

    /* let some of the reload elapse, verifying nothing is banked early */
    const t0 = now();
    while (player.reloadT > 0 && player.reloadT > w.reloadTime * 0.3 && now() - t0 < 15000) await frame();
    add('interrupt: nothing banked mid-reload',
        WEAPONS[0].mag === beforeMag && WEAPONS[0].res === beforeRes,
        'mag=' + WEAPONS[0].mag + '/' + beforeMag + ' res=' + WEAPONS[0].res + '/' + beforeRes);

    /* interrupt with a real weapon swap */
    tapKey('Digit2');
    await frame(); await frame();
    add('interrupt: reload timer cleared by swap', player.reloadT === 0, 'reloadT=' + player.reloadT);
    add('interrupt: magazine conserved after swap', WEAPONS[0].mag === beforeMag,
        'mag=' + WEAPONS[0].mag + ' was=' + beforeMag);
    add('interrupt: reserve conserved after swap', WEAPONS[0].res === beforeRes,
        'res=' + WEAPONS[0].res + ' was=' + beforeRes);
    add('interrupt: mag+res total unchanged',
        WEAPONS[0].mag + WEAPONS[0].res === beforeMag + beforeRes,
        'sum=' + (WEAPONS[0].mag + WEAPONS[0].res) + ' was=' + (beforeMag + beforeRes));

    /* wait out the swap; the cancelled reload must never complete behind it */
    const t1 = now();
    while (player.switching > 0 && now() - t1 < 4000) await frame();
    add('interrupt: no late completion after swap',
        WEAPONS[0].mag === beforeMag && WEAPONS[0].res === beforeRes,
        'mag=' + WEAPONS[0].mag + ' res=' + WEAPONS[0].res);

    /* also exercise the ADS interrupt path */
    quiet();
    equip(0);
    setAmmo(0, 3, 100);
    player.fireCooldown = 0;
    tapKey('KeyR');
    await frame(); await frame();
    const b2 = { mag: WEAPONS[0].mag, res: WEAPONS[0].res };
    rightClick();
    await frame(); await frame();
    add('interrupt: ads cancels reload timer', player.reloadT === 0, 'reloadT=' + player.reloadT);
    add('interrupt: ads cancel conserves ammo',
        WEAPONS[0].mag === b2.mag && WEAPONS[0].res === b2.res,
        'mag=' + WEAPONS[0].mag + '/' + b2.mag + ' res=' + WEAPONS[0].res + '/' + b2.res);
    rightClick();
    await frame(); await frame();
    return { name: 'reload-interrupt', checks };
  }

  /* =====================================================================
     SCENARIO 5 — shooting dry into an auto-reload; a held trigger resumes.
     ===================================================================== */
  async function dryFireResume() {
    const { checks, add } = makeReport();
    quiet();
    /* the rifle is full-auto: holding through an empty mag re-attempts (dry),
       starts the auto-reload, and resumes when it finishes — all on a held
       trigger, which is exactly the "second transition" a player hits */
    equip(0);
    const w = WEAPONS[0];
    setAmmo(0, 1, 200);
    player.fireCooldown = 0;

    /* hold the trigger; the single round fires, then the empty gun dry-fires
       into an automatic reload while the trigger stays held */
    press();
    let sawReload = false;
    const t0 = now();
    while (now() - t0 < 20000) {
      await frame();
      if (player.reloadT > 0) { sawReload = true; break; }
    }
    add('dryfire: empty mag triggered an auto-reload', sawReload, 'reloadT=' + player.reloadT.toFixed(3));
    add('dryfire: one round was fired before the reload', shots() >= 1, 'shots=' + shots());

    /* keep holding, sample strictly while reloading: no shot may escape */
    let violating = 0;
    const t1 = now();
    while (player.reloadT > 0 && now() - t1 < 20000) {
      const sBefore = shots();
      await frame();
      if (player.reloadT > 0 && shots() > sBefore) violating++;
    }
    add('dryfire: no shot while the auto-reload runs', violating === 0, 'violatingFrames=' + violating);
    add('dryfire: mag refilled by the auto-reload', w.mag > 0, 'mag=' + w.mag);

    /* still holding: full auto resumes fire after the reload completes */
    const sResume = shots();
    const t2 = now();
    while (shots() === sResume && now() - t2 < 6000) await frame();
    add('dryfire: held trigger resumes fire after the reload', shots() > sResume,
        'shots=' + (shots() - sResume));
    release();
    await frame(); await frame();
    const sIdle = shots();
    await whileState(() => true, null, 600);
    add('dryfire: quiet after release', shots() === sIdle, 'extra=' + (shots() - sIdle));
    return { name: 'dryfire-resume', checks };
  }

  /* =====================================================================
     POSITIVE CONTROL — an idle trigger in a clear state DOES fire, so the
     "no shot while busy" checks cannot pass by the gun simply never working.
     ===================================================================== */
  async function positiveControl() {
    const { checks, add } = makeReport();
    quiet();
    equip(0);
    const w = WEAPONS[0];
    setAmmo(0, w.magSize, w.reserve);
    player.fireCooldown = 0;

    const s0 = shots(), mag0 = w.mag;
    press(); await frame(); await frame(); release();
    add('control: a clear-state press fires', shots() > s0, 'shots=' + (shots() - s0));
    add('control: the round is drawn from the mag', w.mag < mag0, 'mag=' + w.mag + ' was=' + mag0);

    /* full-auto: holding produces a burst */
    player.fireCooldown = 0;
    const s1 = shots();
    press();
    const t0 = now();
    while (shots() - s1 < 2 && now() - t0 < 4000) await frame();
    release();
    add('control: holding full-auto sustains fire', shots() - s1 >= 2, 'shots=' + (shots() - s1));
    await frame(); await frame();
    return { name: 'positive-control', checks };
  }

  /* =====================================================================
     Runner
     ===================================================================== */
  async function run() {
    const suites = [];
    const errors = [];
    const guard = async (label, fn) => {
      try { const s = await fn(); if (s && s.checks) suites.push(s); }
      catch (e) { errors.push(label + ': ' + (e && e.message ? e.message : e)); }
    };

    const prevGod = window.__god;
    window.__god = true;

    await guard('positive-control',     positiveControl);
    await guard('reload-hold-fullauto', () => reloadHold('fullauto'));
    await guard('reload-hold-pump',     () => reloadHold('pump'));
    await guard('reload-hold-semi',     () => reloadHold('semi'));
    await guard('swap-gate',            swapGate);
    await guard('ads-ease-spread',      adsEaseSpread);
    await guard('reload-interrupt',     reloadInterrupt);
    await guard('dryfire-resume',       dryFireResume);

    release();
    window.__god = prevGod;
    quiet();

    const flat = suites.flatMap(s => s.checks);
    const passed = flat.filter(c => c.ok).length;
    const failed = flat.filter(c => !c.ok);

    let out = '\n================ WEAPON GATE TESTS ================\n';
    for (const s of suites) {
      out += '\n[' + s.name + ']\n';
      for (const c of s.checks)
        out += (c.ok ? '  PASS ' : '  FAIL ') + c.name + (c.detail ? '  (' + c.detail + ')' : '') + '\n';
    }
    if (errors.length) out += '\n[errors]\n' + errors.map(e => '  ERR ' + e).join('\n') + '\n';
    out += '\n---------------------------------------------------\n';
    out += 'GATE: ' + passed + '/' + flat.length + ' passed' +
           (failed.length ? '  — ' + failed.length + ' FAILED' : '  — ALL GREEN') + '\n';
    out += '===================================================\n';
    console.log(out);

    return {
      total: flat.length, passed, failed: failed.length, errors,
      ok: failed.length === 0 && errors.length === 0, suites
    };
  }

  window.WeaponGate = { run, _helpers: { press, release, rightClick, tapKey, quiet, equip } };
  console.log('WeaponGate ready — run:  await WeaponGate.run()');
})();
