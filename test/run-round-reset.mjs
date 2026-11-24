#!/usr/bin/env node
'use strict';
// ======================================================================
//  run-round-reset.mjs —— 零依赖本地验收运行器
//  用本机 Chrome/Edge 的 headless --dump-dom + --virtual-time-budget
//  打开 index.html?test=1&selftest=round，执行 test/round-reset.scenario.js
//  中的回合清场断言，并从 DOM 里的 #selftest-report 读取 JSON 结果。
//
//  用法： node test/run-round-reset.mjs
//  环境变量： CHROME=/path/to/chrome.exe  BUDGET=20000  KEEP_PROFILE=1
// ======================================================================
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function findBrowser() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) { try { if (p && existsSync(p)) return p; } catch { /* next */ } }
  return 'chrome.exe';
}

function runDump(browserPath, url, budget, profile) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-features=Translate,MediaRouter',
      '--window-size=960,600',
      `--user-data-dir=${profile}`,
      `--virtual-time-budget=${budget}`,
      '--dump-dom', url,
    ];
    const child = spawn(browserPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); if (err.length > 30000) err = err.slice(-30000); });
    const timer = setTimeout(() => { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }, 180000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ out, err, code }); });
  });
}

function extractReport(dom) {
  const m = dom.match(/<pre id="selftest-report"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  // dump-dom 会转义 JSON 里的 & < >
  const text = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  try { return JSON.parse(text); } catch (e) { return { parseError: e.message, raw: text.slice(0, 4000) }; }
}

async function main() {
  const budget = Number(process.env.BUDGET || 20000);
  const browserPath = findBrowser();
  const profile = process.env.KEEP_PROFILE ? join(tmpdir(), 'rr-chrome-kept') : mkdtempSync(join(tmpdir(), 'rr-chrome-'));
  const url = pathToFileURL(join(repoRoot, 'index.html')).href + '?test=1&selftest=round';
  console.log('浏览器：', browserPath);
  console.log('页面：', url);
  const t0 = Date.now();
  const { out, err, code } = await runDump(browserPath, url, budget, profile);
  console.log(`headless 退出码 ${code}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，DOM ${out.length} 字节`);
  if (!process.env.KEEP_PROFILE) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }

  const result = extractReport(out);
  if (!result) {
    console.error('未找到 #selftest-report —— 场景可能未执行或浏览器启动失败。');
    const fatal = out.match(/id="fatal"[^>]*>([\s\S]*?)<\/div>/);
    if (fatal) console.error('页面 fatal：', fatal[1].replace(/<[^>]+>/g, '').trim().slice(0, 800));
    console.error('--- chrome stderr 尾部 ---\n' + err.split('\n').slice(-12).join('\n'));
    process.exit(2);
  }
  if (result.parseError) {
    console.error('报告 JSON 解析失败：', result.parseError);
    console.error(result.raw);
    process.exit(2);
  }

  let failed = 0;
  for (const c of result.checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass || c.extra == null ? '' : '  -> ' + JSON.stringify(c.extra)}`);
    if (!c.pass) failed++;
  }
  if (result.errors && result.errors.length) { console.log('\n场景错误：'); for (const e of result.errors) console.log(e.split('\n').slice(0, 6).join('\n')); }
  console.log(`\n共 ${result.checks.length} 项，通过 ${result.checks.length - failed}，失败 ${failed}`);
  process.exit(failed || !result.ok ? 1 : 0);
}
main();
