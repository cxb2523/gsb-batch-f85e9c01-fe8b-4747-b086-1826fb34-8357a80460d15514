import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedLiveFrame, type LiveFrame } from '../src/liveFrame.js';
import { detachFrame, type PosedFrame } from '../src/posedFrame.js';

function frame(): LiveFrame {
  return { generation: 1, count: 1, drawOrder: new Int32Array([0]), vertices: new Float64Array([2, 3]), tint: new Float64Array([1, 1, 1, 1]),
    attachments: Object.freeze([Object.freeze({ slot: 's', slotIndex: 0, attachment: 'named', skin: 'default', placeholder: 'p', kind: 'region' as const, region: 'r', page: 'page', pma: false, blend: 'Normal' as const, offset: 0, count: 2, uvs: Object.freeze([0, 1]), triangles: Object.freeze([0, 1, 2]), dark: null, clip: null })]) };
}

test('held frame and nested buffers become stale; a fresh lease reads the next generation', () => {
  let generation = 1;
  const source = frame();
  const lease = checkedLiveFrame(source, () => generation);
  const vertices = lease.vertices;
  const uv = lease.attachments[0].uvs;
  const attachment = lease.attachments[0];
  assert.equal(vertices[0], 2);
  assert.deepEqual([...lease.attachments].map(value => value.slot), ['s']);
  generation++;
  for (const read of [() => lease.count, () => vertices[0], () => uv[0], () => attachment.slot]) assert.throws(read, /LIVE_FRAME_STALE/);
  assert.equal(checkedLiveFrame(source, () => generation).vertices[1], 3);
});

test('lease rejects writes and backing-store escape routes', () => {
  const lease = checkedLiveFrame(frame(), () => 1);
  assert.throws(() => { (lease.vertices as { [i: number]: number })[0] = 8; }, /LIVE_FRAME_READONLY/);
  assert.throws(() => Reflect.get(lease.vertices, 'buffer'), /LIVE_FRAME_READONLY/);
  assert.throws(() => Reflect.get(lease.vertices, 'forEach')(() => undefined), /LIVE_FRAME_READONLY/);
  assert.throws(() => Reflect.set(lease.attachments[0], 'slot', 'wrong'), /LIVE_FRAME_READONLY/);
  assert.throws(() => Object.preventExtensions(lease), /LIVE_FRAME_READONLY/);
});

test('unguarded borrowed source changes while detached numeric copies remain unchanged', () => {
  const source = frame();
  const before = Array.from(source.vertices);
  (source.vertices as Float64Array)[0] = 9;
  assert.equal(source.vertices[0], 9);
  assert.deepEqual(before, [2, 3]);
});

function posed(sharedPolygon: number[]): PosedFrame {
  const clip = { polygon: sharedPolygon, inverse: false, convex: true };
  return { order: [
    { slot: 'a', z: 0, blend: 'Normal' as const, tint: [1, 1, 1, 1], kind: 'region' as const, region: 'r', corners: [0, 0, 1, 1], page: 'p', pma: false, uvs: [0, 1], clip },
    { slot: 'b', z: 1, blend: 'Normal' as const, tint: [1, 1, 1, 1], kind: 'mesh' as const, vertices: [2, 2, 3, 3], page: 'p', pma: false, uvs: [0, 1], triangles: [0, 1, 2], sequence: 0, clip },
  ] };
}

test('detachFrame copies vertex arrays and clip polygons away from the source pose', () => {
  const sharedPolygon = [0, 0, 4, 0, 4, 4];
  const source = posed(sharedPolygon);
  const snapshot = detachFrame(source);
  // Vertex geometry is copied, not shared.
  assert.notEqual(snapshot.order[0].kind === 'region' ? snapshot.order[0].corners : null, source.order[0].kind === 'region' ? source.order[0].corners : null);
  assert.notEqual(snapshot.order[1].kind === 'mesh' ? snapshot.order[1].vertices : null, source.order[1].kind === 'mesh' ? source.order[1].vertices : null);
  // Clip polygons are copied and the covered slots still share one clip within the snapshot.
  const clipA = snapshot.order[0].clip!, clipB = snapshot.order[1].clip!;
  assert.equal(clipA, clipB);
  assert.notEqual(clipA.polygon, sharedPolygon);
  assert.deepEqual(clipA.polygon, sharedPolygon);
  // Mutating the source pose leaves the snapshot untouched.
  sharedPolygon[0] = 99;
  (source.order[0] as { corners: number[] }).corners[0] = 77;
  (source.order[1] as { vertices: number[] }).vertices[0] = 55;
  assert.equal(clipA.polygon[0], 0);
  assert.equal((snapshot.order[0] as { corners: number[] }).corners[0], 0);
  assert.equal((snapshot.order[1] as { vertices: number[] }).vertices[0], 2);
});

test('two detached snapshots never share a clip object or its polygon', () => {
  const source = posed([0, 0, 1, 1]);
  const first = detachFrame(source);
  const second = detachFrame(source);
  assert.notEqual(first.order[0].clip, second.order[0].clip);
  assert.notEqual(first.order[0].clip!.polygon, second.order[0].clip!.polygon);
  // Immutable pose caches stay shared by identity; only pose-shaped data detaches.
  assert.equal((first.order[0] as { uvs: number[] }).uvs, (second.order[0] as { uvs: number[] }).uvs);
});

test('a lease whose invalid reason is disposal names LIVE_FRAME_DISPOSED on every read', () => {
  let generation = 1;
  let disposed = false;
  const lease = checkedLiveFrame(frame(), () => generation, () => (disposed ? 'LIVE_FRAME_DISPOSED' : null));
  const nested = lease.vertices;
  disposed = true;
  generation++;
  assert.throws(() => lease.count, /LIVE_FRAME_DISPOSED/);
  assert.throws(() => nested[0], /LIVE_FRAME_DISPOSED/);
  // A non-disposed generation change keeps the plain stale contract.
  let gen2 = 1;
  const lease2 = checkedLiveFrame(frame(), () => gen2, () => null);
  gen2++;
  assert.throws(() => lease2.count, /LIVE_FRAME_STALE/);
});

test('detachFrame leaves an empty frame empty and a clip-less slot clip-less', () => {
  assert.deepEqual(detachFrame({ order: [] }), { order: [] });
  const noClip: PosedFrame = { order: [
    { slot: 'a', z: 0, blend: 'Normal' as const, tint: [1, 1, 1, 1], dark: [0.2, 0.3, 0.4], kind: 'region' as const, region: 'r', corners: [0, 0, 1, 1], page: 'p', pma: false, uvs: [0, 1] },
  ] };
  const copy = detachFrame(noClip);
  assert.equal(copy.order[0].clip, undefined);
  assert.notEqual((copy.order[0] as { corners: number[] }).corners, noClip.order[0].kind === 'region' ? noClip.order[0].corners : null);
  // The per-call tint/dark tuples are carried across and stay equal in value.
  assert.deepEqual(copy.order[0].tint, [1, 1, 1, 1]);
  assert.deepEqual(copy.order[0].dark, [0.2, 0.3, 0.4]);
});
