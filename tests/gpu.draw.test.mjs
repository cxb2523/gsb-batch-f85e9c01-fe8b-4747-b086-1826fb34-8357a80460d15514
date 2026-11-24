// node --test tests/gpu.draw.test.mjs : the renderer's whole frame (Renderer.draw) over frames built here, with a WebGPU device that only
// records. No game, no browser: the frame is a WFrame laid out in an ArrayBuffer (runtime/native_web.h), the device counts the textures it
// makes and the views its bind groups hold, and the pass records the viewport and the blit's rect.
//
// It is the same path the page takes: shape -> resources -> passes -> blit. The aspects are the setting's (16:9: narrow 0.75; 4:3: narrow 1),
// the frames are a race's (wide 1). What is checked: one allocation for one aspect over many frames; a rebuild on the first frame of a new
// aspect; the blit's rect and box from the new shape; the old targets destroyed and the groups over the new views; a canvas resize and an
// aspect change on one frame still one rebuild; and no rebuild at all when only the canvas changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../web/src/gpu.js';

Object.assign(globalThis, {
  GPUTextureUsage: { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 },
  GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2, COPY_SRC: 4, STORAGE: 8, VERTEX: 16, INDEX: 32 },
  GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 },
  GPUColorWrite: { ALL: 15, ALPHA: 8 },
  GPUMapMode: { READ: 1 },
});
globalThis.window ??= {};
globalThis.window.devicePixelRatio ??= 1;

// the WFrame's words (gpu.js's F, native_web.h's WFrame: every field 32 bits, the same order)
const F = { number: 2, wide: 17, narrow: 27, scale: 28, brightness: 29, contrast: 30, gamma: 31, smooth: 34, reflections: 36, dynBase: 41 };
const TARGETS = 20;       // pic (color + depth), rvm (2), six views (12), prev, scene, sphere, spherePrev

function fakeDevice() {
  const stats = { textures: 0, destroyed: 0, groups: [], viewport: null, uniforms: [] };
  const device = {
    createTexture(desc) {
      stats.textures++;
      const t = { desc, w: desc.size[0], h: desc.size[1], destroyed: false,
        createView: v => ({ texture: t, desc: v || {} }),
        destroy() { if (!t.destroyed) { t.destroyed = true; stats.destroyed++; } } };
      return t;
    },
    createBindGroup(desc) { stats.groups.push(desc); return { desc }; },
    createBuffer(desc) { return { size: desc.size, destroy() {} }; },
    createRenderPipeline() { return {}; },
    queue: {
      writeBuffer(buf, off, data) { if (buf && buf.uniform) stats.uniforms.push({ buf, data: Array.from(data) }); },
      writeTexture() {}, submit() {},
    },
    createCommandEncoder() { return encoder(stats); },
  };
  return { device, stats };
}
function encoder(stats) {
  const pass = () => ({
    setViewport(x, y, w, h) { stats.viewport = [x, y, w, h]; },
    setScissorRect() {}, setVertexBuffer() {}, setIndexBuffer() {}, setBindGroup() {}, setPipeline() {},
    draw() {}, drawIndexed() {}, end() {},
  });
  return { beginRenderPass: pass, beginComputePass: pass, copyTextureToTexture() {}, copyBufferToBuffer() {}, finish() { return {}; } };
}

// a Renderer past init(): the device and the things init makes that a frame reads
function newRenderer() {
  const memory = { buffer: new ArrayBuffer(1 << 16) };
  const { device, stats } = fakeDevice();
  const canvas = { clientWidth: 1280, clientHeight: 720, width: 0, height: 0 };
  const r = new Renderer(memory, 0, canvas, { textContent: '' }, () => {});
  Object.assign(r, {
    device, canvas, context: { getCurrentTexture: () => ({ createView: () => ({}) }) }, format: 'bgra8unorm',
    buffers: {}, pipelines: new Map(),
    sceneLayout: {}, frameLayout: {}, texLayout: {}, blitLayout: {}, foldLayout: {}, postLayout: {}, downLayout: {},
    samplers: { linear: 'linear', nearest: 'nearest', mip: 'mip' },
    palette: { createView: () => 'palette' }, white: {}, whiteGroup: 'white',
    blitUniform: { size: 32, uniform: 'blit' }, blitBgUniform: { size: 32, uniform: 'blitBg' },
    foldUniform: { size: 16 }, postUniform: { size: 8 * 256 },
    blitPipeline: {}, blitBgPipeline: {}, foldPipeline: {}, postPipelines: [{}, {}, {}], downPipeline: {},
  });
  return { r, stats, canvas, memory };
}

// a frame in the shared memory: the fields a race's picture needs, all else zero
function putFrame(memory, { narrow, wide = 1, scale = 2, reflections = 0, smooth = 1 }) {
  const u32 = new Uint32Array(memory.buffer), f32 = new Float32Array(memory.buffer);
  u32.fill(0, 0, 64);
  f32[F.narrow] = narrow;
  u32[F.wide] = wide;
  u32[F.scale] = scale;
  u32[F.reflections] = reflections;
  u32[F.smooth] = smooth;
  u32[F.contrast] = 100;
  u32[F.gamma] = 100;
  return 0;
}

const blitUniformOf = stats => { const u = [...stats.uniforms].reverse().find(x => x.buf.uniform === 'blit'); return u && u.data; };
const lastBlitGroup = (r, smooth) => r.blitGroups[smooth];

test('the same aspect over many frames makes one picture', () => {
  const { r, stats, memory } = newRenderer();
  for (let i = 0; i < 8; i++) r.draw(putFrame(memory, { narrow: 0.75 }));
  assert.equal(stats.textures, TARGETS);
  assert.equal(stats.destroyed, 0);
  assert.equal(r.res.W, 1364);
  assert.equal(r.res.pic.color.destroyed, false);
  // the blit's group holds the live picture, and the rect is the whole of it (a race)
  const g = lastBlitGroup(r, 'linear');
  assert.equal(g.desc.entries[0].resource.texture, r.res.pic.color);
  const u = blitUniformOf(stats);
  assert.equal(u[0], 0);
  assert.equal(u[2], 1);
});

test('16:9 to 4:3: the first frame rebuilds, the old picture goes, the blit reads the new one', () => {
  const { r, stats, memory } = newRenderer();
  r.draw(putFrame(memory, { narrow: 0.75 }));
  const old = r.res, oldGroup = lastBlitGroup(r, 'linear');
  assert.equal(old.pic.w, 1364);

  r.draw(putFrame(memory, { narrow: 1 }));
  // made again, twice as many textures, the old ones destroyed exactly once
  assert.equal(stats.textures, 2 * TARGETS);
  assert.equal(stats.destroyed, TARGETS);
  for (const t of [old.pic, old.rvm, ...old.env]) { assert.equal(t.color.destroyed, true); assert.equal(t.depth.destroyed, true); }
  for (const t of [old.prev, old.scene, old.sphere, old.spherePrev]) assert.equal(t.destroyed, true);

  // the picture is 4:3 now and the blit's group holds it, never the destroyed view
  assert.equal(r.res.pic.w, 1024);
  assert.equal(r.res.pic.h, 896);
  const g = lastBlitGroup(r, 'linear');
  assert.notEqual(g, oldGroup);
  assert.equal(g.desc.entries[0].resource.texture, r.res.pic.color);
  const u = blitUniformOf(stats);
  assert.equal(u[0], 0);
  assert.equal(u[1], 0);
  assert.equal(u[2], 1);                                  // the whole 4:3 picture
  // the box on screen: the largest 4:3 in the 1280x720 canvas, in the middle
  assert.deepEqual(stats.viewport, [160, 0, 960, 720]);
});

test('two aspects that round to the same W still rebuild (the aspect is in the key)', () => {
  const { r, stats, memory } = newRenderer();
  r.draw(putFrame(memory, { narrow: 0.7507 }));
  const first = r.res;
  r.draw(putFrame(memory, { narrow: 0.75 }));
  assert.equal(r.res.W, first.W);                          // W alone could not tell them apart
  assert.equal(stats.textures, 2 * TARGETS);
  assert.equal(first.pic.color.destroyed, true);
});

test('the window and the aspect changing on one frame rebuild once', () => {
  const { r, stats, canvas, memory } = newRenderer();
  r.draw(putFrame(memory, { narrow: 0.75 }));
  const before = stats.textures;
  canvas.clientWidth = 2560; canvas.clientHeight = 1440;   // the window grew
  r.draw(putFrame(memory, { narrow: 1 }));                 // and the aspect went to 4:3, in the same frame
  assert.equal(stats.textures - before, TARGETS);          // one picture, not two
  assert.equal(stats.destroyed, TARGETS);
  assert.deepEqual(stats.viewport, [320, 0, 1920, 1440]);
});

test('the window changing alone rebuilds nothing', () => {
  const { r, stats, canvas, memory } = newRenderer();
  r.draw(putFrame(memory, { narrow: 1 }));
  const before = stats.textures, picture = r.res;
  canvas.clientWidth = 1920; canvas.clientHeight = 1080;
  for (let i = 0; i < 3; i++) r.draw(putFrame(memory, { narrow: 1 }));
  assert.equal(stats.textures, before);
  assert.equal(stats.destroyed, 0);
  assert.equal(r.res, picture);
  assert.deepEqual(stats.viewport, [240, 0, 1440, 1080]);
});

test('the reflections setting at the same aspect still makes a new picture (its own key)', () => {
  const { r, stats, memory } = newRenderer();
  r.draw(putFrame(memory, { narrow: 1, reflections: 0 }));
  r.draw(putFrame(memory, { narrow: 1, reflections: 2 }));     // High: 128-texel views
  assert.equal(stats.textures, 2 * TARGETS);
  assert.equal(r.res.envSize, 128);
  assert.equal(r.res.sphere.desc.size[0], 512);
  // and the same settings again: no more
  r.draw(putFrame(memory, { narrow: 1, reflections: 2 }));
  assert.equal(stats.textures, 2 * TARGETS);
});
