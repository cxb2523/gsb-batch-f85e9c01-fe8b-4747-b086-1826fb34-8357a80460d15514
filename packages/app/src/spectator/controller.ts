// Owns spectator camera policy: which survivor to follow (or free
// overview), cycling between survivors, and handing the render package's
// SmoothedCamera a fresh target every frame so motion is eased rather
// than snapped. This is the "client side" of spectate-on-death: it reads
// a MatchAdapter and a live fighter-position list, and produces a
// CameraView the renderer paints verbatim via RenderFrame.cameraOverride.
//
// Retargeting (auto-switch on elimination, TAB cycling) never snaps the
// camera: a short retarget transition glides the view from wherever it
// is toward the new target's live follow framing, then hands off to the
// SmoothedCamera's exponential tracking. Only one transition exists at a
// time and every new selection re-bases it from the camera's current
// spot, so mashing TAB converges on the final choice without lingering
// on intermediate ones. A target the controller switched away from after
// an elimination is never re-acquired on its own (e.g. a transient
// elimination that a reconnect/resync reverts) — only an explicit
// cycleNext() from the user can bring it back. deactivate() clears all
// of this so leaving spectating (or the match ending) can't leak a
// half-finished glide into the next session.
// Imported from the render package's spectator-camera module directly
// (not the package index, which pulls in PixiJS) so this controller stays
// loadable in plain Node for unit tests — same pattern as
// ui/settings-panel.ts importing render/src/camera.ts.
import {
  computeFollowCamera,
  computeOverviewCamera,
  SmoothedCamera,
} from '@bash-fighter/render/src/spectator-camera.ts';
import type { ArenaBounds, CameraView } from '@bash-fighter/render/src/camera.ts';
import type { MatchAdapter } from './types.ts';

export type SpectatorMode = 'follow' | 'overview';

export interface SpectatorFrameInput {
  positions: readonly { x: number; y: number }[]; // indexed like the sim
  viewWidth: number;
  viewHeight: number;
  arena: ArenaBounds;
  dtSeconds: number;
}

const FOLLOW_SCALE = 4.5;
const FOLLOW_VERTICAL_OFFSET = 8;
const OVERVIEW_MIN_SCALE = 1.6;
const OVERVIEW_MAX_SCALE = 5.5;
const OVERVIEW_PADDING = 20;
/** How long the camera glides toward a newly chosen follow target before
 * settling into plain exponential tracking. Short enough to feel
 * responsive, long enough to read as a move rather than a cut. */
const RETARGET_SECONDS = 0.35;

/** An in-flight glide toward a newly selected follow target. `from` is
 * the camera view at the moment of the switch; the blend aims at the new
 * target's *live* follow view each frame, so it lands cleanly even while
 * that fighter keeps moving. */
interface RetargetTransition {
  from: CameraView;
  elapsedSeconds: number;
}

export class SpectatorController {
  private mode: SpectatorMode = 'follow';
  private followIndex: number | null = null;
  private readonly camera: SmoothedCamera;
  private active = false;
  private transition: RetargetTransition | null = null;
  /** Set by deactivate(): the smoothed camera's position no longer
   * matches anything on screen, so the next activate() must re-seed from
   * the freshly computed view instead of gliding in from the leftover
   * spot (which could be a half-finished transition midpoint). */
  private cameraStale = false;
  private snapPending = false;
  private readonly adapter: MatchAdapter;
  /** The local slot spectating (excluded from follow/cycle targets). */
  private readonly localIndex: number;

  constructor(
    adapter: MatchAdapter,
    localIndex: number,
    initialView: CameraView,
  ) {
    this.adapter = adapter;
    this.localIndex = localIndex;
    this.camera = new SmoothedCamera(initialView);
  }

  get isActive(): boolean {
    return this.active;
  }

  get currentMode(): SpectatorMode {
    return this.mode;
  }

  get followedIndex(): number | null {
    return this.followIndex;
  }

  /** Called once, the frame the local player is eliminated. */
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.mode = 'follow';
    this.transition = null;
    this.followIndex = this.pickInitialTarget();
    if (this.cameraStale) {
      // Re-entry: start framing the current target right away rather
      // than gliding in from wherever a previous session left off.
      this.cameraStale = false;
      this.snapPending = true;
    }
  }

  deactivate(): void {
    this.active = false;
    this.mode = 'follow';
    this.followIndex = null;
    this.transition = null;
    this.snapPending = false;
    this.cameraStale = true;
  }

  toggleOverview(): void {
    this.mode = this.mode === 'overview' ? 'follow' : 'overview';
    if (this.mode === 'follow' && this.followIndex === null) {
      this.followIndex = this.pickInitialTarget();
    }
  }

  /** Cycle to the next surviving fighter (wraps around). */
  cycleNext(): void {
    const survivors = this.adapter.survivorIndices().filter((i) => i !== this.localIndex);
    if (survivors.length === 0) {
      this.followIndex = null;
      return;
    }
    this.mode = 'follow';
    const currentPos = this.followIndex === null ? -1 : survivors.indexOf(this.followIndex);
    const next = survivors[(currentPos + 1 + survivors.length) % survivors.length] ?? null;
    if (next !== this.followIndex) {
      this.followIndex = next;
      this.beginRetarget();
    }
  }

  private pickInitialTarget(): number | null {
    const survivors = this.adapter.survivorIndices().filter((i) => i !== this.localIndex);
    return survivors.length > 0 ? (survivors[0] as number) : null;
  }

  /** The survivor cyclically after `fromIndex` — the same "next" order
   * cycleNext() uses, so an elimination auto-switch lands where one TAB
   * press would have. */
  private pickNextSurvivorAfter(fromIndex: number): number | null {
    const survivors = this.adapter
      .survivorIndices()
      .filter((i) => i !== this.localIndex)
      .sort((a, b) => a - b);
    if (survivors.length === 0) return null;
    const after = survivors.find((i) => i > fromIndex);
    return (after ?? survivors[0]) as number;
  }

  /** Start (or re-base) the glide toward the current follow target.
   * Re-basing on every selection — never queuing — is what makes rapid
   * repeated cycling converge on only the final choice. */
  private beginRetarget(): void {
    this.transition = { from: { ...this.camera.current }, elapsedSeconds: 0 };
  }

  /** Compute this frame's smoothed camera. Safe to call with zero
   * survivors (falls back to framing the whole arena). */
  update(input: SpectatorFrameInput): CameraView {
    // Keep the follow target valid if it was eliminated since last
    // frame. This only ever looks at the *current* target: a fighter we
    // already switched away from is never re-acquired automatically,
    // even if its elimination is reverted mid-transition (reconnect /
    // resync) — the camera stays on the replacement unless the user
    // actively cycles back to it.
    if (this.followIndex !== null && this.adapter.status(this.followIndex).eliminated) {
      this.followIndex = this.pickNextSurvivorAfter(this.followIndex);
      if (this.followIndex !== null) this.beginRetarget();
    }

    const target = this.computeTargetView(input);

    if (this.snapPending) {
      this.snapPending = false;
      this.transition = null;
      this.camera.snapTo(target);
      return this.camera.current;
    }

    if (this.transition) {
      return this.advanceRetarget(target, input.dtSeconds);
    }
    return this.camera.update(target, input.dtSeconds);
  }

  private computeTargetView(input: SpectatorFrameInput): CameraView {
    if (this.mode === 'follow' && this.followIndex !== null && input.positions[this.followIndex]) {
      return computeFollowCamera(input.positions[this.followIndex] as { x: number; y: number }, {
        viewWidth: input.viewWidth,
        viewHeight: input.viewHeight,
        scale: FOLLOW_SCALE,
        verticalOffset: FOLLOW_VERTICAL_OFFSET,
      });
    }
    const survivorPositions = this.adapter
      .survivorIndices()
      .map((i) => input.positions[i])
      .filter((p): p is { x: number; y: number } => p !== undefined);
    return computeOverviewCamera(
      survivorPositions,
      input.arena,
      input.viewWidth,
      input.viewHeight,
      OVERVIEW_MIN_SCALE,
      OVERVIEW_MAX_SCALE,
      OVERVIEW_PADDING,
    );
  }

  /** Blend from the switch-time view toward the target's live follow
   * view with an ease-out, then hand off to exponential tracking. The
   * smoother is pinned to the blend every frame so the handoff is
   * continuous (no pop when the transition completes). */
  private advanceRetarget(target: CameraView, dtSeconds: number): CameraView {
    const transition = this.transition as RetargetTransition;
    transition.elapsedSeconds += Math.max(0, dtSeconds);
    const t = Math.min(1, transition.elapsedSeconds / RETARGET_SECONDS);
    const k = 1 - (1 - t) ** 3; // easeOutCubic: brisk departure, soft arrival
    const view = {
      centerX: lerp(transition.from.centerX, target.centerX, k),
      centerY: lerp(transition.from.centerY, target.centerY, k),
      scale: lerp(transition.from.scale, target.scale, k),
    };
    this.camera.snapTo(view);
    if (t >= 1) this.transition = null;
    return view;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
