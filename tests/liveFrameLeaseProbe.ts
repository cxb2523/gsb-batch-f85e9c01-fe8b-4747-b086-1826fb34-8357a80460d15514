import { CanvasRenderer, loadModel, RigPlayer, type LiveFrame, type PosedFrame } from '../src/index';

/** Whether `fn` throws an error whose message contains every given code. */
function throwsCode(fn: () => unknown, ...codes: string[]): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    const message = String(error);
    return codes.every(code => message.includes(code));
  }
}

/** Flat numeric values of a posed frame, in draw order, including its clip polygons. */
function frameNumbers(frame: PosedFrame): number[] {
  const out: number[] = [];
  for (const slot of frame.order) {
    const points = slot.kind === 'region' ? slot.corners : slot.vertices;
    out.push(...points);
    if (slot.clip) out.push(...slot.clip.polygon);
  }
  return out;
}

/**
 * Acceptance chain for the borrowed live frame:
 * normal playback reads, stale/refused leases after a pose change, read-only
 * buffers, detached snapshots, runtime→oracle hand-over and disposal.
 */
export async function liveFrameLeaseProbe() {
  const assets = await loadModel({ modelUrl: '/rigs/figure/skeleton.model.json' });
  const root = document.createElement('div');
  document.body.append(root);
  const player = new RigPlayer(root, assets, { mode: 'canvas', liveFrameChecks: true });
  try {
    // 'mask' activates the rig's clipping attachment, so clip and polygon
    // leases are real views rather than absent nulls.
    const animation = assets.animations.some(value => value.name === 'mask') ? 'mask' : assets.animations[0].name;
    player.play(animation);
    player.advance(0.1);

    // 1. Normal playback: consecutive borrows and draws behave identically.
    //    A borrow is consumed before the next pose mutation, the documented window.
    const first = player.liveFrame();
    const firstGeneration = first.generation;
    const firstReads = first.count > 0 && typeof first.vertices[first.attachments[first.drawOrder[0]].offset] === 'number';
    const second = player.liveFrame();
    const normalReads = firstReads && second.count === first.count;
    const generationMonotonic = second.generation >= firstGeneration;
    player.advance(0.05);

    // 2. Borrow on a quiet player, advance one pose, then every read of the old
    //    lease — including retained nested views — must fail stale.
    const lease = player.liveFrame();
    const nestedVertices = lease.vertices;
    const nestedAttachment = lease.attachments[lease.drawOrder[0]];
    const nestedClip = nestedAttachment.clip;
    const nestedPolygon = nestedClip?.polygon;
    const heldTint = lease.tint;
    // The chosen animation must actually carry a clip, or these checks are vacuous.
    const clipPresent = nestedClip !== null && nestedClip !== undefined && nestedPolygon !== undefined;
    const leaseCount = lease.count;
    player.advance(0.125);
    const stale = throwsCode(() => lease.count, 'LIVE_FRAME_STALE');
    const staleNested = throwsCode(() => nestedVertices[0], 'LIVE_FRAME_STALE');
    const staleAttachment = throwsCode(() => nestedAttachment.slot, 'LIVE_FRAME_STALE');
    const staleTint = throwsCode(() => heldTint[0], 'LIVE_FRAME_STALE');
    const staleClip = !clipPresent || throwsCode(() => nestedClip!.inverse, 'LIVE_FRAME_STALE');
    const stalePolygon = !clipPresent || throwsCode(() => nestedPolygon![0], 'LIVE_FRAME_STALE');
    // A renderer handed a stale lease refuses before drawing.
    const rendererStale = throwsCode(() => player.renderer.render(lease), 'LIVE_FRAME_STALE');
    const advancedGeneration = player.generation;

    // 3. A fresh lease reads the new generation and the same buffers draw.
    const fresh = player.liveFrame();
    const freshReads = fresh.generation === advancedGeneration && fresh.count === leaseCount;

    // 4. Writes and backing-store access refuse as read-only on a live lease.
    const live = player.liveFrame();
    const readonlyWrite = throwsCode(() => { Reflect.set(live.vertices, '0', 123); }, 'LIVE_FRAME_READONLY');
    const readonlyBuffer = throwsCode(() => Reflect.get(live.vertices, 'buffer'), 'LIVE_FRAME_READONLY');
    const readonlyNestedWrite = throwsCode(() => {
      const attachment = live.attachments[live.drawOrder[0]];
      Reflect.set(attachment, 'slot', 'wrong');
    }, 'LIVE_FRAME_READONLY');
    const readonlyPolygonWrite = (() => {
      const clip = live.attachments.map(value => value.clip).find(value => value !== null && value !== undefined);
      return clip !== undefined && throwsCode(() => Reflect.set(clip.polygon, '0', 9), 'LIVE_FRAME_READONLY');
    })();

    // 5. A posedFrame() snapshot keeps its numbers through later pose changes,
    //    and shares neither vertex arrays nor clip objects with later frames.
    const snapshot = player.posedFrame();
    const snapshotNumbers = frameNumbers(snapshot);
    const geometryOf = (frame: PosedFrame): Map<string, number[]> =>
      new Map(frame.order.map(slot => [slot.slot, slot.kind === 'region' ? slot.corners : slot.vertices]));
    const snapshotGeometry = geometryOf(snapshot);
    const snapshotClips = snapshot.order.filter(slot => slot.clip).map(slot => slot.clip!);
    player.advance(0.25);
    const next = player.posedFrame();
    const nextGeometry = geometryOf(next);
    const nextClips = next.order.filter(slot => slot.clip).map(slot => slot.clip!);
    const snapshotKept = JSON.stringify(frameNumbers(snapshot)) === JSON.stringify(snapshotNumbers);
    // Compare geometry references by slot name so a draw-order change can't
    // line two unrelated arrays up by index.
    const noSharedVertices = [...snapshotGeometry].every(([slot, ref]) => nextGeometry.get(slot) !== ref);
    const noSharedClips = snapshotClips.every(clip => !nextClips.includes(clip));
    const noSharedClipPolygons = snapshotClips.every(clip => !nextClips.some(other => other.polygon === clip.polygon));
    // Covered slots still share one clip object inside the one snapshot.
    const internalClipSharing = snapshotClips.length < 2 || snapshotClips.every(clip => clip === snapshotClips[0]);

    return {
      normalReads, generationMonotonic, freshReads, clipPresent,
      stale, staleNested, staleAttachment, staleTint, staleClip, stalePolygon, rendererStale,
      readonlyWrite, readonlyBuffer, readonlyNestedWrite, readonlyPolygonWrite,
      snapshotKept, noSharedVertices, noSharedClips, noSharedClipPolygons, internalClipSharing,
      snapshotRows: snapshot.order.length,
    };
  } finally {
    player.dispose();
    root.remove();
    assets.dispose();
  }
}

/**
 * Runtime → oracle hand-over: track composition first, then the physics
 * policy on a rig that can never use the runtime. The old live lease must die
 * at once and `poser` must name the new source and its reason.
 */
export async function liveFrameFallbackProbe() {
  // A) Track composition forces an auto runtime player onto the oracle.
  const assets = await loadModel({ modelUrl: '/rigs/turned/skeleton.model.json' });
  const root = document.createElement('div');
  document.body.append(root);
  const player = new RigPlayer(root, assets, { mode: 'canvas', liveFrameChecks: true });
  try {
    const name = assets.animations[0].name;
    player.play(name);
    player.advance(0.35);
    const runtimePoser = player.poser;
    const lease = player.liveFrame();
    const nested = lease.vertices;
    const at = player.time;
    player.setAlpha(0, 0.5);
    const composedPoser = player.poser;
    const composedReason = /^oracle: track composition/.test(composedPoser);
    const oldStale = throwsCode(() => lease.count, 'LIVE_FRAME_STALE');
    const nestedStale = throwsCode(() => nested[0], 'LIVE_FRAME_STALE');
    // The oracle path still hands out usable fresh leases.
    const fresh = player.liveFrame();
    const freshUsable = fresh.count >= 0 && typeof fresh.generation === 'number';
    const rendererFresh = (() => { try { player.renderer.render(fresh); return true; } catch { return false; } })();
    const timeKept = player.time === at;

    // B) A physics rig selects the named oracle policy from the first play.
    const clothAssets = await loadModel({ modelUrl: '/rigs/cloth/skeleton.model.json' });
    const clothRoot = document.createElement('div');
    document.body.append(clothRoot);
    const cloth = new RigPlayer(clothRoot, clothAssets, { mode: 'canvas', liveFrameChecks: true });
    let physicsPoser = '';
    let physicsLeaseUsable = false;
    try {
      cloth.play('hang');
      physicsPoser = cloth.poser;
      const physicsReason = /^oracle: physics constraint ".+" requires player clock, seek and movement integration$/.test(physicsPoser);
      physicsLeaseUsable = cloth.liveFrame().count >= 0;
      return {
        runtimePoser, composedPoser, composedReason, oldStale, nestedStale, freshUsable, rendererFresh, timeKept,
        physicsPoser, physicsReason, physicsLeaseUsable,
      };
    } finally {
      cloth.dispose();
      clothRoot.remove();
      clothAssets.dispose();
    }
  } finally {
    player.dispose();
    root.remove();
    assets.dispose();
  }
}

/** After dispose(): new borrows refuse, and reads of a lease taken earlier refuse too. */
export async function liveFrameDisposeProbe() {
  const assets = await loadModel({ modelUrl: '/rigs/figure/skeleton.model.json' });
  const root = document.createElement('div');
  document.body.append(root);
  const player = new RigPlayer(root, assets, { mode: 'canvas', liveFrameChecks: true });
  try {
    player.play(assets.animations.some(value => value.name === 'mask') ? 'mask' : assets.animations[0].name);
    player.advance(0.1);
    const lease = player.liveFrame();
    const nested = lease.vertices;
    const clip = lease.attachments.map(value => value.clip).find(value => value !== null && value !== undefined) ?? null;
    const clipPresent = clip !== null;
    player.dispose();
    const borrowAfterDispose = throwsCode(() => player.liveFrame(), 'LIVE_FRAME_DISPOSED');
    const oldReadAfterDispose = throwsCode(() => lease.count, 'LIVE_FRAME_DISPOSED');
    const nestedAfterDispose = throwsCode(() => nested[0], 'LIVE_FRAME_DISPOSED');
    const clipAfterDispose = clipPresent && throwsCode(() => clip!.polygon[0], 'LIVE_FRAME_DISPOSED');
    const rendererAfterDispose = throwsCode(() => player.renderer.render(lease), 'LIVE_FRAME_DISPOSED');
    // A second dispose stays harmless.
    let doubleDisposeSafe = true;
    try { player.dispose(); } catch { doubleDisposeSafe = false; }
    return { clipPresent, borrowAfterDispose, oldReadAfterDispose, nestedAfterDispose, clipAfterDispose, rendererAfterDispose, doubleDisposeSafe };
  } finally {
    root.remove();
    assets.dispose();
  }
}

/**
 * The production borrow (liveFrameChecks: false) still tracks generations:
 * its object is reused across poses and a new generation is visible, while a
 * posedFrame snapshot remains an independent copy.
 */
export async function liveFrameProductionProbe() {
  const assets = await loadModel({ modelUrl: '/rigs/figure/skeleton.model.json' });
  const root = document.createElement('div');
  document.body.append(root);
  const player = new RigPlayer(root, assets, { mode: 'canvas', liveFrameChecks: false });
  try {
    player.play(assets.animations[0].name);
    const before = player.liveFrame() as LiveFrame;
    const beforeGeneration = before.generation;
    const buffers = { vertices: before.vertices, tint: before.tint, drawOrder: before.drawOrder, attachments: before.attachments };
    const snapshot = player.posedFrame();
    const snapshotValues = frameNumbers(snapshot);
    player.advance(0.25);
    const after = player.liveFrame();
    const reused = after === before && after.vertices === buffers.vertices && after.tint === buffers.tint
      && after.drawOrder === buffers.drawOrder && after.attachments === buffers.attachments;
    const advanced = after.generation > beforeGeneration;
    const snapshotDetached = JSON.stringify(frameNumbers(snapshot)) === JSON.stringify(snapshotValues);
    return { reused, advanced, snapshotDetached };
  } finally {
    player.dispose();
    root.remove();
    assets.dispose();
  }
}
