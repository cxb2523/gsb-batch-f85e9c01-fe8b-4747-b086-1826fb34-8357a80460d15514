// The scene-part cache (~/.cache/motlab/parts or MOTLAB_CACHE_DIR) must survive cancelled and failed renders:
// a part enters it only whole, a stopped render leaves no half files, and a later render never reads the remains.
// End to end: needs Chrome, ffmpeg and ffprobe.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { probeVideo } from '../src/ffmpeg.js';
import { renderProject } from '../src/project.js';

const dir = mkdtempSync(join(tmpdir(), 'motlab-part-cache-'));
process.env.MOTLAB_CACHE_DIR = join(dir, 'cache');   // keep the test parts out of the real cache
after(() => rmSync(dir, { recursive: true, force: true }));
const quiet = { log: () => {} };

// A deadline that only keeps a broken test from hanging. message may be a function, read when the time runs out.
function within(promise, ms, message) {
  const { promise: deadline, reject } = Promise.withResolvers();
  const timer = setTimeout(() => reject(new Error(typeof message === 'function' ? message() : message)), ms);
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const flat = (proj, name, colour) => writeFileSync(join(proj, name), `<!doctype html><canvas id="c" width="64" height="64"></canvas><script>
  const c = document.getElementById('c').getContext('2d'); window.TOTAL = 1; window.ready = Promise.resolve(true);
  window.renderAt = () => { c.fillStyle = '${colour}'; c.fillRect(0, 0, 64, 64); };</script>`);

// The cache folder of a project: one <key>.mp4 and <key>.json per part.
const partsDir = proj => join(dir, 'cache', 'parts', createHash('sha256').update(join(proj, 'project.json')).digest('hex').slice(0, 16));
const cacheFiles = proj => existsSync(partsDir(proj)) ? readdirSync(partsDir(proj)) : [];

// Every key in the cache must be a complete pair whose mp4 still probes as its manifest says, with nothing else there.
async function assertCacheClean(proj, keys) {
  const files = cacheFiles(proj);
  assert.deepEqual(files.filter(f => !/^[0-9a-f]{64}\.(mp4|json)$/.test(f)), [], `scratch files left in the cache: ${files}`);
  const found = new Set(files.map(f => f.match(/^([0-9a-f]{64})\./)?.[1]).filter(Boolean));
  if (keys !== undefined) assert.equal(found.size, keys, `cached parts: ${files}`);
  for (const k of found) {
    assert.ok(files.includes(k + '.mp4') && files.includes(k + '.json'), `half a cache entry for ${k}: ${files}`);
    const m = JSON.parse(readFileSync(join(partsDir(proj), k + '.json'), 'utf8'));
    const v = await probeVideo(join(partsDir(proj), k + '.mp4'));
    assert.equal(v.frames, m.frames, `cached part ${k} does not match its manifest`);
    assert.ok(Math.abs(v.duration - m.duration) <= 0.5 / 10, `cached part ${k} duration ${v.duration}, manifest ${m.duration}`);
  }
  return found;
}

test('part cache: a full render leaves complete parts that --only reuses, and prunes planted remains', async () => {
  const proj = join(dir, 'reuse');
  mkdirSync(proj, { recursive: true });
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 10, scenes: ['a.html', { file: 'b.html', transition: { type: 'fade', duration: 0.5, ease: 'linear' } }] }));
  const out = join(dir, 'reuse.mp4');
  await renderProject({ dir: proj, out, scale: 1, ...quiet });
  assert.equal((await probeVideo(out)).frames, 15);   // 10 + 10 frames, 5 of them shared
  await assertCacheClean(proj, 3);   // scene a, scene b, the transition

  // Remains of a stopped render: a scratch file, a .part, an mp4 without a manifest and a manifest without an mp4.
  const planted = ['deadbeef.tmp', 'cafe.mp4.part', 'e'.repeat(64) + '.mp4', 'd'.repeat(64) + '.json'];
  for (const f of planted) writeFileSync(join(partsDir(proj), f), 'half written');
  const logs = [];
  await renderProject({ dir: proj, out: join(dir, 'reuse-only.mp4'), scale: 1, only: [2], log: m => logs.push(m) });
  const seen = logs.join('\n');
  assert.ok(seen.includes('Scene 1/2: a.html (cached)'), seen);
  assert.equal((await probeVideo(join(dir, 'reuse-only.mp4'))).frames, 15);
  for (const f of planted) assert.ok(!existsSync(join(partsDir(proj), f)), `${f} was not pruned`);
  await assertCacheClean(proj, 3);
});

test('part cache: a render cancelled mid-way leaves the cache as it was and the next render succeeds', async () => {
  const proj = join(dir, 'abort');
  mkdirSync(proj, { recursive: true });
  flat(proj, 'a.html', '#000');
  // Scene b waits on a fetch that never answers, so the render is cancelled while it waits for ready.
  const { promise: waiting, resolve: reached } = Promise.withResolvers();
  const marker = createServer(() => reached());
  await new Promise(r => marker.listen(0, '127.0.0.1', r));
  writeFileSync(join(proj, 'b.html'), `<!doctype html><canvas id="c" width="64" height="64"></canvas><script>
    window.TOTAL = 1; window.renderAt = () => {};
    window.ready = { then(resolve, reject) { fetch('http://127.0.0.1:${marker.address().port}/ready').then(resolve, reject); } };
    </script>`);
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 10, scenes: ['a.html', 'b.html'] }));
  const out = join(dir, 'abort.mp4'), controller = new AbortController();
  let rendering;
  try {
    rendering = renderProject({ dir: proj, out, scale: 1, signal: controller.signal, ...quiet });
    await within(waiting, 240000, 'scene b did not reach its pending ready in 240 s');   // scene a renders fully first, including the encoder probe on a cold cache
    controller.abort();
    await assert.rejects(within(rendering, 60000, 'the render did not stop within 60 s of the cancel'), { name: 'AbortError' });
    // The cache holds only scene a, complete: the part that finished before the cancel may stay.
    await assertCacheClean(proj, 1);
    assert.ok(!existsSync(out) && !existsSync(out + '.part'), 'a cancelled render must not leave an output or a .part');
  } finally {
    await new Promise(r => { marker.close(r); marker.closeAllConnections(); });
    await rendering?.catch(() => {});
  }
  // Scene b fixed: the same project renders to the end, not reading anything the cancelled render left.
  flat(proj, 'b.html', '#fff');
  await renderProject({ dir: proj, out, scale: 1, ...quiet });
  assert.equal((await probeVideo(out)).frames, 20);
  await assertCacheClean(proj, 2);
});

test('part cache: a scene whose ready fails does not enter the cache', async () => {
  const proj = join(dir, 'broken');
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, 'a.html'), `<!doctype html><canvas id="c" width="64" height="64"></canvas><script>
    window.TOTAL = 1; window.renderAt = () => {}; window.ready = Promise.reject(new Error('ready failed'));</script>`);
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 10, scenes: ['a.html'] }));
  const out = join(dir, 'broken.mp4');
  await assert.rejects(renderProject({ dir: proj, out, scale: 1, ...quiet }), /ready failed/);
  assert.deepEqual(cacheFiles(proj), [], 'a failed part must not enter the cache');
  assert.ok(!existsSync(out) && !existsSync(out + '.part'));
});

test('part cache: a part failed in parallel leaves no remains the one-at-a-time retry could reuse', async () => {
  const proj = join(dir, 'fallback');
  mkdirSync(proj, { recursive: true });
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff'); flat(proj, 'd.html', '#00f');
  writeFileSync(join(proj, 'c.html'), `<!doctype html><canvas id="c" width="64" height="64"></canvas><script>
    window.TOTAL = 1; window.renderAt = () => {}; window.ready = Promise.reject(new Error('c is broken'));</script>`);
  const fade = { type: 'fade', duration: 0.4, ease: 'linear' };
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 10, scenes: ['a.html', { file: 'b.html', transition: fade }, 'c.html', { file: 'd.html', transition: fade }] }));
  const out = join(dir, 'fallback.mp4'), failLogs = [];
  await assert.rejects(renderProject({ dir: proj, out, scale: 1, parallel: 3, log: m => failLogs.push(m) }), /c is broken/);
  assert.ok(failLogs.some(l => l.includes('Rendering the remaining parts one at a time')), failLogs.join('\n'));
  assert.ok(!existsSync(out) && !existsSync(out + '.part'));
  // Whatever finished before the failure is cached whole; the failed scene left nothing, half or otherwise.
  const cached = await assertCacheClean(proj);
  assert.ok(cached.size <= 3, `only scene a, scene b and their transition can have finished: ${[...cached]}`);

  flat(proj, 'c.html', '#f00');
  const logs = [];
  await renderProject({ dir: proj, out, scale: 1, parallel: 3, log: m => logs.push(m) });
  assert.ok(logs.join('\n').includes('Scene 1/4: a.html (cached)'), logs.join('\n'));
  assert.equal((await probeVideo(out)).frames, 32);   // four scenes of 10 frames, two transitions of 4 shared frames
  await assertCacheClean(proj, 6);
});

test('part cache: a truncated cached part is rendered again, not joined', async () => {
  const proj = join(dir, 'truncated');
  mkdirSync(proj, { recursive: true });
  flat(proj, 'a.html', '#000'); flat(proj, 'b.html', '#fff');
  writeFileSync(join(proj, 'project.json'), JSON.stringify({ fps: 10, scenes: ['a.html', { file: 'b.html', transition: { type: 'fade', duration: 0.5, ease: 'linear' } }] }));
  await renderProject({ dir: proj, out: join(dir, 'truncated1.mp4'), scale: 1, ...quiet });
  // Cut every cached mp4 in half, as a cancelled write would leave one.
  for (const f of cacheFiles(proj).filter(f => f.endsWith('.mp4'))) {
    const file = join(partsDir(proj), f), bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, statSync(file).size / 2));
  }
  const logs = [];
  const out = join(dir, 'truncated2.mp4');
  await renderProject({ dir: proj, out, scale: 1, only: [2], log: m => logs.push(m) });
  const seen = logs.join('\n');
  assert.ok(seen.includes('Scene 1/2: a.html (no cached part, rendering it)'), seen);
  assert.equal((await probeVideo(out)).frames, 15);
  await assertCacheClean(proj, 3);
});
