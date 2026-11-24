// Unit tests for SpectatorController's retarget behaviour: smooth
// (non-snapping) transitions when the follow target changes, last-selection-
// wins under rapid TAB cycling, no auto-return to a reconnected target,
// and full cleanup of interpolation state on deactivate/re-entry.
// Uses a hand-rolled MatchAdapter so no sim/DOM is needed (same pattern
// as sim-adapter.test.ts's duck-typed Match).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpectatorController, type SpectatorFrameInput } from '../src/spectator/controller.ts';
import type { FighterMatchStatus, LiveArenaBounds, MatchAdapter } from '../src/spectator/types.ts';
import type { CameraView } from '@bash-fighter/render/src/camera.ts';

const LOCAL = 0;
const ARENA = { minX: -260, maxX: 260, minY: -260, maxY: 260 };
const FOLLOW_SCALE = 4.5;
const FOLLOW_VERTICAL_OFFSET = 8;
const DT = 1 / 60;

class FakeAdapter implements MatchAdapter {
  readonly fighterCount = 4;
  private readonly eliminatedSet = new Set<number>([LOCAL]);

  update(): void {}
  eliminate(i: number): void {
    this.eliminatedSet.add(i);
  }
  /** Stand-in for a reconnect/resync reverting an elimination. */
  revive(i: number): void {
    this.eliminatedSet.delete(i);
  }
  status(index: number): FighterMatchStatus {
    return {
      eliminated: this.eliminatedSet.has(index),
      eliminationTick: null,
      placement: null,
      koCount: 0,
    };
  }
  survivorIndices(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.fighterCount; i++) {
      if (!this.eliminatedSet.has(i)) out.push(i);
    }
    return out;
  }
  liveArenaBounds(): LiveArenaBounds | null {
    return null;
  }
  isMatchOver(): boolean {
    return false;
  }
}

interface Fixture {
  adapter: FakeAdapter;
  controller: SpectatorController;
  positions: { x: number; y: number }[];
}

/** Three spectators' worth of fighters at well-separated x positions;
 * slot 0 is the (eliminated) local player. */
function makeFixture(xs: [number, number, number]): Fixture {
  const adapter = new FakeAdapter();
  const positions = [{ x: 0, y: 0 }, ...xs.map((x) => ({ x, y: 0 }))];
  const controller = new SpectatorController(adapter, LOCAL, {
    centerX: 0,
    centerY: 0,
    scale: 3,
  });
  return { adapter, controller, positions };
}

function frame(f: Fixture, dtSeconds = DT): SpectatorFrameInput {
  return {
    positions: f.positions,
    viewWidth: 800,
    viewHeight: 450,
    arena: ARENA,
    dtSeconds,
  };
}

function followViewOf(f: Fixture, index: number): CameraView {
  const p = f.positions[index] as { x: number; y: number };
  return { centerX: p.x, centerY: p.y + FOLLOW_VERTICAL_OFFSET, scale: FOLLOW_SCALE };
}

function run(f: Fixture, frames: number, dtSeconds = DT): CameraView {
  let view: CameraView = f.controller.update(frame(f, dtSeconds));
  for (let i = 1; i < frames; i++) view = f.controller.update(frame(f, dtSeconds));
  return view;
}

function assertClose(actual: number, expected: number, tolerance: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test('spectator: follows the first survivor and converges smoothly, not by snapping', () => {
  const f = makeFixture([100, 200, 300]);
  f.controller.activate();
  assert.equal(f.controller.followedIndex, 1);

  const first = f.controller.update(frame(f));
  // One frame in, the camera has left the initial view but is nowhere
  // near the target yet — a glide, not a cut.
  assert.ok(first.centerX > 0 && first.centerX < 50, `first frame centerX ${first.centerX}`);

  const settled = run(f, 180);
  const want = followViewOf(f, 1);
  assertClose(settled.centerX, want.centerX, 1, 'settled centerX');
  assertClose(settled.centerY, want.centerY, 1, 'settled centerY');
  assertClose(settled.scale, want.scale, 0.05, 'settled scale');
});

test('spectator: elimination auto-switches to the next survivor with a smooth transition', () => {
  const f = makeFixture([100, 200, 300]);
  f.controller.activate();
  // Follow target 2 (not the first survivor) so "next after the
  // eliminated one" is distinguishable from "first survivor".
  f.controller.cycleNext();
  run(f, 180);
  assert.equal(f.controller.followedIndex, 2);

  f.adapter.eliminate(2);
  const during = f.controller.update(frame(f));
  assert.equal(f.controller.followedIndex, 3, 'auto-switch picks the cyclically next survivor');
  // The switch frame itself must not teleport the camera to the new
  // target: it has only just started gliding from 200 toward 300.
  assert.ok(during.centerX >= 200 && during.centerX < 230, `switch frame centerX ${during.centerX}`);

  const settled = run(f, 180);
  assertClose(settled.centerX, 300, 1, 'settled centerX after auto-switch');
});

test('spectator: rapid TAB cycling converges only to the final selection', () => {
  const f = makeFixture([0, 500, 60]);
  f.controller.activate();
  run(f, 180); // settled on fighter 1 at x=0
  assert.equal(f.controller.followedIndex, 1);

  // Two quick presses with a single frame between them: 1 -> 2 -> 3.
  let maxX = -Infinity;
  const track = (): void => {
    const v = f.controller.update(frame(f));
    maxX = Math.max(maxX, v.centerX);
  };
  f.controller.cycleNext(); // toward fighter 2 at x=500
  track();
  f.controller.cycleNext(); // re-target to fighter 3 at x=60 mid-glide
  assert.equal(f.controller.followedIndex, 3);
  for (let i = 0; i < 240; i++) track();

  // The camera never got anywhere near the intermediate target at x=500…
  assert.ok(maxX < 150, `camera drifted toward intermediate target, maxX ${maxX}`);
  // …and it ends up framed on the final selection.
  const want = followViewOf(f, 3);
  const settled = f.controller.update(frame(f));
  assertClose(settled.centerX, want.centerX, 1, 'final centerX');
  assertClose(settled.scale, want.scale, 0.05, 'final scale');
});

test('spectator: a reconnected former target never steals the camera back', () => {
  const f = makeFixture([0, 500, -500]);
  f.controller.activate();
  run(f, 180); // settled on fighter 1 at x=0

  f.adapter.eliminate(1);
  f.controller.update(frame(f));
  assert.equal(f.controller.followedIndex, 2, 'elimination auto-switches away');
  run(f, 5); // mid-transition toward fighter 2, not yet arrived

  // The elimination turns out to be transient (reconnect/resync reverts
  // it) while the transition is still in flight.
  f.adapter.revive(1);
  for (let i = 0; i < 240; i++) {
    f.controller.update(frame(f));
    assert.equal(f.controller.followedIndex, 2, 'reconnected target must not be re-acquired');
  }
  const settled = f.controller.update(frame(f));
  assertClose(settled.centerX, 500, 1, 'camera stays on the replacement target');

  // …unless the user actively cycles back to it.
  f.controller.cycleNext(); // 2 -> 3
  f.controller.cycleNext(); // 3 -> 1
  assert.equal(f.controller.followedIndex, 1, 'explicit selection can return to the revived fighter');
  const reSettled = run(f, 240);
  assertClose(reSettled.centerX, 0, 1, 'camera follows the explicitly reselected target');
});

test('spectator: deactivate clears interpolation state; re-entry starts at the correct framing', () => {
  const f = makeFixture([0, 500, -500]);
  f.controller.activate();
  run(f, 180); // settled on fighter 1 at x=0

  // Begin an auto-switch and leave the transition half-finished.
  f.adapter.eliminate(1);
  f.controller.update(frame(f));
  f.controller.update(frame(f));
  assert.equal(f.controller.followedIndex, 2);

  f.controller.deactivate();
  assert.equal(f.controller.isActive, false);
  assert.equal(f.controller.followedIndex, null);

  // While spectating is off, the remaining field changes.
  f.adapter.eliminate(2);
  f.controller.activate();
  assert.equal(f.controller.followedIndex, 3);

  // The very first frame back must already frame the current target —
  // no glide in from the leftover mid-transition spot near x≈0..500.
  const first = f.controller.update(frame(f));
  const want = followViewOf(f, 3);
  assertClose(first.centerX, want.centerX, 1e-9, 're-entry centerX');
  assertClose(first.centerY, want.centerY, 1e-9, 're-entry centerY');
  assertClose(first.scale, want.scale, 1e-9, 're-entry scale');

  // And it stays there (no residual transition pulling it elsewhere).
  const settled = run(f, 60);
  assertClose(settled.centerX, want.centerX, 1e-9, 'post-re-entry centerX');
});

test('spectator: falls back to an arena overview when nobody is left to follow', () => {
  const f = makeFixture([100, 200, 300]);
  f.controller.activate();
  f.adapter.eliminate(1);
  f.adapter.eliminate(2);
  f.adapter.eliminate(3);
  const view = run(f, 10);
  assert.equal(f.controller.followedIndex, null);
  assert.ok(Number.isFinite(view.centerX) && Number.isFinite(view.centerY) && Number.isFinite(view.scale));
});
