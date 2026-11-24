// node --test tests/gpu.resources.test.mjs : the renderer's pictures (web/src/gpu.js) against the aspects a race can be played in. The
// WebGPU device is a stand-in that counts what is made and what is destroyed; the frames are made here, not drawn.
//
// What is checked, one test for each:
//   - a shape that does not change allocates once and only once, however many frames go by
//   - a new aspect (16:9 -> 4:3 and back) rebuilds on the frame it first appears, and the blit's source rect is the new picture's
//   - two aspects that round to the same W still rebuild: the key is the shape, not one of its numbers
//   - a rebuild destroys the old color and depth (no leak) and every cached group is made again over the new views
//   - a window size and an aspect that change together rebuild once, and the box comes out of the new canvas
import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer, pictureShape, shapeOf, blitBox } from '../web/src/gpu.js';

// the WebGPU constants the renderer reads as globals (undefined under Node)
Object.assign(globalThis, {
  GPUTextureUsage: { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 },
  GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 },
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  GPUColorWrite: { ALL: 15, ALPHA: 8 },
  GPUMapMode: { READ: 1 },
});

// a device that makes textures and bind groups, and says when each texture is destroyed
function mockDevice() {
  const log = { textures: [], groups: [], destroyed: 0 };
  const device = {
    createTexture(desc) {
      const t = {
        desc, size: [...desc.size], label: desc.label, destroyed: false,
        createView(viewDesc) { return { texture: t, desc: viewDesc || {} }; },
        destroy() { if (!t.destroyed) { t.destroyed = true; log.destroyed++; } },
      };
      log.textures.push(t);
      return t;
    },
    createBindGroup(desc) { const g = { desc }; log.groups.push(g); return g; },
  };
  return { device, log };
}

// a Renderer without init(): the layouts and samplers resources() reads, as bare tokens; nothing is drawn
function mockRenderer() {
  const { device, log } = mockDevice();
  const r = Object.create(Renderer.prototype);
  Object.assign(r, {
    device,
    texLayout: {}, foldLayout: {}, downLayout: {}, postLayout: {},
    samplers: { linear: 'linear', mip: 'mip' },
    palette: { createView: () => 'palette' },
    foldUniform: 'foldUniform', postUniform: 'postUniform',
    envReady: [false, false, false, false, false, false],
    sphereReady: false, rvmReady: false, prevReady: false,
    log: () => {},
  });
  return { r, log };
}

const live = log => log.textures.length - log.destroyed;
const createdSince = (log, n) => log.textures.slice(n);
const ALLOC = 20;      // pic (color + depth), rvm (2), six views (12), prev, scene, sphere, spherePrev

// the frames: the race in 16:9 (narrow = 0.75), in 4:3 (narrow = 1), and the menus in a race's picture (wide clear). `wide` is the frame's
// field, a number (u32 in native_web.h): 1 for a race, 0 for the menus
const frame = (narrow, wide, scale = 2, reflections = 0) => ({ narrow, wide: wide ? 1 : 0, scale, reflections });

// --- the normal path: one aspect, many frames ----------------------------------------------------------------
test('the same aspect over many frames allocates once', () => {
  const { r, log } = mockRenderer();
  const shape = pictureShape(frame(0.75, true));
  for (let i = 0; i < 10; i++) assert.equal(r.resources(shape), i === 0);
  assert.equal(log.textures.length, ALLOC);
  assert.equal(log.destroyed, 0);
  assert.equal(live(log), ALLOC);
  // and the shape it was made for is the one it reports
  assert.equal(r.res.pic.w, shape.W);
  assert.equal(r.res.pic.h, shape.H);
});

test('a 4:3 menu frame in a 16:9 picture reuses the race picture (its targets are the same)', () => {
  const { r, log } = mockRenderer();
  const race = pictureShape(frame(0.75, true));
  const menu = pictureShape(frame(0.75, false));      // same W, H, W43, env: only `wide` differs, and that is the blit's, not a texture's
  assert.equal(menu.W, race.W);
  assert.equal(r.resources(race), true);
  assert.equal(r.resources(menu), false);
  assert.equal(log.textures.length, ALLOC);
  // the menus show the 4:3 middle of the wide picture, the race shows all of it
  assert.equal(blitBox(race, 1280, 720).from, 0);
  assert.equal(blitBox(race, 1280, 720).across, 1364);
  assert.equal(blitBox(menu, 1280, 720).across, 1024);
  assert.equal(blitBox(menu, 1280, 720).from, (1364 - 1024) / 2);
});

// --- the boundary: 16:9 -> 4:3 (and back) --------------------------------------------------------------------
test('16:9 to 4:3 rebuilds on the first frame and the blit reads the new picture', () => {
  const { r, log } = mockRenderer();
  const wide = pictureShape(frame(0.75, true));
  const four = pictureShape(frame(1, true));
  r.resources(wide);
  const oldPic = r.res.pic;
  assert.equal(r.res.pic.w, 1364);                    // 1024 / 0.75, even
  assert.equal(r.resources(four), true);
  assert.equal(r.res.pic.w, 1024);                    // the picture itself is 4:3 now: nothing to crop
  assert.notEqual(r.res.pic, oldPic);

  // the source rect: the 4:3 picture is the whole texture, the 16:9 one all of its 1364 pixels
  const wideBox = blitBox(wide, 1280, 720);
  assert.equal(wideBox.across, 1364);
  assert.equal(wideBox.from, 0);
  const box = blitBox(four, 1280, 720);
  assert.equal(box.across, 1024);
  assert.equal(box.from, 0);
  assert.equal(box.u1 - box.u0, 1);
  // the box on screen follows the aspect: a 16:9 box for the race, a 4:3 one for the 4:3 picture
  assert.ok(Math.abs(wideBox.bw / wideBox.bh - 16 / 9) < 0.01);
  assert.ok(Math.abs(box.bw / box.bh - 4 / 3) < 0.01);

  // and back: one more rebuild, the picture wide again
  assert.equal(r.resources(wide), true);
  assert.equal(r.res.pic.w, 1364);
  assert.equal(log.textures.length, 3 * ALLOC);
});

test('two aspects that round to the same W still rebuild', () => {
  const { r } = mockRenderer();
  const a = pictureShape(frame(0.7507, true));         // the setting read a little off
  const b = pictureShape(frame(0.75, true));           // and as it should be
  assert.equal(a.W, b.W);                              // the old key (W x H / W43 / env) could not tell them apart
  assert.equal(a.H, b.H);
  assert.equal(a.W43, b.W43);
  assert.notEqual(a.narrow, b.narrow);
  r.resources(a);
  assert.equal(r.resources(b), true);
  assert.equal(r.res.narrow, b.narrow);
});

// --- the negative path: nothing of the old picture survives a rebuild ---------------------------------------
test('a rebuild destroys the old targets and rebinds every cached group', () => {
  const { r, log } = mockRenderer();
  const wide = pictureShape(frame(0.75, true));
  const four = pictureShape(frame(1, true));
  r.resources(wide);
  const old = r.res;
  r.blitGroups = { linear: { stale: true }, nearest: { stale: true } };
  r.blitBgGroup = { stale: true };
  r.depthGroup = { stale: true };
  r.depthGroupFor = old.pic;
  r.envReady.fill(true);
  r.sphereReady = r.rvmReady = r.prevReady = true;

  r.resources(four);

  // every old texture is destroyed, exactly once; the live ones are the new picture's
  for (const t of [old.pic, old.rvm, ...old.env]) { assert.equal(t.color.destroyed, true); assert.equal(t.depth.destroyed, true); }
  for (const t of [old.prev, old.scene, old.sphere, old.spherePrev]) assert.equal(t.destroyed, true);
  assert.equal(live(log), ALLOC);
  assert.equal(log.destroyed, ALLOC);

  // the groups that hold a view of the picture are the new picture's
  assert.equal(r.res.postGroup.desc.entries[0].resource.texture, r.res.pic.depth);
  assert.equal(r.res.postGroup.desc.entries[2].resource.texture, r.res.scene);
  for (let i = 0; i < 6; i++) {
    const e = r.res.foldGroups[i].desc.entries;
    assert.equal(e[0].resource.texture, r.res.env[i].color);
    assert.equal(e[1].resource.texture, r.res.spherePrev);
  }
  for (let l = 0; l < r.res.sceneLevels.length - 1; l++) assert.equal(r.res.downGroups[l].desc.entries[0].resource.texture, r.res.scene);

  // the caches that would bind the gone views are empty again, and the frame-dependent flags are re-learnt
  assert.deepEqual(r.blitGroups, {});
  assert.equal(r.blitBgGroup, null);
  assert.equal(r.depthGroup, null);
  assert.equal(r.envReady.some(Boolean), false);
  assert.equal(r.sphereReady || r.rvmReady || r.prevReady, false);
});

test('a picture made again twice leaks nothing', () => {
  const { r, log } = mockRenderer();
  for (let i = 0; i < 6; i++) r.resources(pictureShape(frame(i % 2 ? 1 : 0.75, true)));
  assert.equal(live(log), ALLOC);                       // always one picture live, whatever the aspects in between
  assert.equal(log.destroyed, 5 * ALLOC);
});

// --- the shape and the box say the same thing ---------------------------------------------------------------
test('the box comes out of the shape, so a canvas change cannot bring back the old aspect', () => {
  const wide = pictureShape(frame(0.75, true));
  const four = pictureShape(frame(1, true));
  // the same canvases: each aspect's box is the largest of its own shape in the middle of the canvas
  for (const [cw, ch] of [[1280, 720], [1920, 1080], [800, 800], [1000, 500]]) {
    const w = blitBox(wide, cw, ch), f = blitBox(four, cw, ch);
    const fit = (box, a) => box.bw <= cw && box.bh <= ch && Math.abs(box.bw / box.bh - a) < 0.01 && (box.bw === cw || box.bh === ch);
    assert.ok(fit(w, 16 / 9), `${cw}x${ch} 16:9 box ${w.bw}x${w.bh}`);
    assert.ok(fit(f, 4 / 3), `${cw}x${ch} 4:3 box ${f.bw}x${f.bh}`);
    assert.equal(w.across, 1364);
    assert.equal(f.across, 1024);
  }
});

test('the window and the aspect changing together make one picture', () => {
  const { r, log } = mockRenderer();
  r.resources(pictureShape(frame(0.75, true)));
  const after = log.textures.length;
  // one frame: the canvas grew and the aspect went to 4:3. resources() hears one shape, so one rebuild
  const shape = pictureShape(frame(1, true));
  assert.equal(r.resources(shape), true);
  assert.equal(createdSince(log, after).length, ALLOC);
  const box = blitBox(shape, 2560, 1440);               // the new canvas
  assert.ok(Math.abs(box.bw / box.bh - 4 / 3) < 0.01);
  assert.equal(box.across, 1024);
});

// --- shapeOf: the four numbers alone keep the aspect -----------------------------------------------
test('shapeOf reads the aspect W and W43 imply', () => {
  const s = shapeOf(1364, 896, 1024, 64);
  assert.equal(s.wide, true);
  assert.ok(Math.abs(s.aspect - 4 / 3 / s.narrow) < 1e-12);
  const four = shapeOf(1024, 896, 1024, 64);
  assert.equal(four.wide, false);
  assert.equal(blitBox(four, 1280, 720).across, 1024);
});
