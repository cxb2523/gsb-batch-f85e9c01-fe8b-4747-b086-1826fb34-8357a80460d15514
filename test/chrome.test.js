// Chrome's launch flags: --no-sandbox is added when, and only when, motlab
// runs as root, because Chrome refuses to start as root without it. And the
// Chromium that Playwright downloads is found when there is no system Chrome.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { SANDBOX_FLAGS, launchChrome, playwrightChrome } from '../src/chrome.js';

test('--no-sandbox is passed exactly when running as root', () => {
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  assert.deepEqual(SANDBOX_FLAGS, root ? ['--no-sandbox'] : []);
});

test('a failed launch leaves no Chrome profile dir behind', async () => {
  // Point the temp dir at a private folder so the check is not disturbed by other runs. os.tmpdir() reads the
  // variables at call time, and launchChrome removes the profile before the rejection reaches the caller.
  const dir = mkdtempSync(join(tmpdir(), 'motlab-launch-')), keep = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = process.env.TMP = dir;
  try {
    await assert.rejects(launchChrome({ chromePath: join(dir, 'no-such-chrome.exe') }));
    // node exits on Chrome's flags at once, which is the "Chrome exited early" path
    await assert.rejects(launchChrome({ chromePath: process.execPath }), /exited early|did not open/);
    assert.deepEqual(readdirSync(dir), [], 'a failed launch must not leave its profile dir');
  } finally {
    process.env.TEMP = keep.TEMP; process.env.TMP = keep.TMP;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Playwright's newest Chromium is found, by revision number, and only where its executable is", () => {
  const dir = mkdtempSync(join(tmpdir(), 'motlab-pw-'));
  try {
    const exe = (folder, ...rest) => { const p = join(dir, folder, ...rest); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ''); return p; };
    exe('chromium-999', 'chrome-linux64', 'chrome');
    const newest = exe('chromium-1248', 'chrome-linux64', 'chrome');
    mkdirSync(join(dir, 'chromium-1300'));                                    // an unfinished download: no executable
    exe('chromium_headless_shell-1400', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    assert.equal(playwrightChrome(dir, 'linux-x64'), newest);                 // 1248 beats 999 as a number, not as text
    assert.equal(playwrightChrome(dir, 'win32-x64'), null);                   // the Linux build is not used on Windows
    const win = exe('chromium-1248', 'chrome-win64', 'chrome.exe');
    assert.equal(playwrightChrome(dir, 'win32-x64'), win);
    assert.equal(playwrightChrome(join(dir, 'missing'), 'linux-x64'), null);
    assert.equal(playwrightChrome(dir, 'freebsd-x64'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
