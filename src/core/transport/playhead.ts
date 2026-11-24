import { transportSecondsToPlayheadStep } from '../audio-dsp/output-latency'

/**
 * Musical bounds the visual playhead must respect. The loop is half-open — a cursor at
 * `loopEndStep` already belongs to the next iteration — while `totalSteps` is the project end,
 * used when the transport is not cycling.
 */
export interface PlayheadBounds {
  loopStartStep: number
  loopEndStep: number
  isLooping: boolean
  totalSteps: number
}

const EPSILON = 1e-9

/**
 * Canonical loop normalization shared by the transport adapter and the playhead resolver, so the
 * written Tone loop and the derived playhead agree on integer step coordinates and on a minimum
 * one-step span. The end stays open: Tone wraps once the transport reaches `endStep`.
 */
export function normalizeLoopSteps(startStep: number, endStep: number): { startStep: number; endStep: number } {
  const start = Number.isFinite(startStep) ? Math.max(0, Math.round(startStep)) : 0
  const requestedEnd = Number.isFinite(endStep) ? Math.round(endStep) : start + 1
  return { startStep: start, endStep: Math.max(start + 1, requestedEnd) }
}

function projectLength(bounds: PlayheadBounds): number {
  return Number.isFinite(bounds.totalSteps) && bounds.totalSteps >= 0 ? bounds.totalSteps : Number.POSITIVE_INFINITY
}

/** Active loop region, never extending past the project end when that end is known. */
export function getLoopRegion(bounds: PlayheadBounds): { startStep: number; endStep: number } {
  const { startStep, endStep } = normalizeLoopSteps(bounds.loopStartStep, bounds.loopEndStep)
  const totalSteps = projectLength(bounds)
  return { startStep, endStep: totalSteps > startStep ? Math.min(endStep, totalSteps) : endStep }
}

/** Clamps a step onto the project timeline without touching the loop region. */
export function clampToProjectStep(step: number, bounds: PlayheadBounds): number {
  if (!Number.isFinite(step) || step < 0) return 0
  const totalSteps = projectLength(bounds)
  return step > totalSteps ? totalSteps : step
}

function foldIntoLoop(step: number, startStep: number, endStep: number): number {
  return startStep + ((step - startStep) % (endStep - startStep))
}

/**
 * Folds a step position into the loop region while looping is active, otherwise clamps it to the
 * project length.
 *
 * With looping enabled the cursor lives inside `[loopStartStep, loopEndStep)`:
 *
 * - the open end wraps straight onto the loop start instead of briefly showing the loop end;
 * - a position pushed below the loop start by latency compensation — the first audible samples of
 *   a new iteration sit inside the output-latency window — snaps forward onto the loop start rather
 *   than showing the previous iteration's tail;
 * - a genuine pre-roll position (playing from before the loop) is left untouched.
 *
 * `latencySteps` is the compensation window in steps; it defines how far behind the loop start a
 * clock-derived position may sit before it is treated as pre-roll rather than a wrap undershoot.
 */
export function foldPlayheadStep(step: number, bounds: PlayheadBounds, latencySteps = 0): number {
  if (!Number.isFinite(step) || step < 0) return 0
  const totalSteps = projectLength(bounds)
  if (!bounds.isLooping) return step > totalSteps ? totalSteps : step

  const { startStep, endStep } = getLoopRegion(bounds)
  if (endStep <= startStep) return step > totalSteps ? totalSteps : step

  if (step >= endStep) return foldIntoLoop(step, startStep, endStep)
  if (step < startStep) {
    const compensation = Number.isFinite(latencySteps) && latencySteps > 0 ? latencySteps : 0
    return step >= startStep - compensation - EPSILON ? startStep : step > totalSteps ? totalSteps : step
  }
  return step
}

/**
 * Converts the audible transport clock into a continuous step position.
 *
 * Latency compensation is applied only while the transport is running, so the cursor matches the
 * sample the listener hears during playback but holds the exact musical position once paused or
 * stopped. A running position is folded into the loop region (or clamped to the project when
 * looping is off); a resting one is only clamped to the project, because a stop to Bar 1 must stay
 * at step 0 even with a loop enabled.
 */
export function resolvePlayheadStep(
  transportSeconds: number,
  stepDurationSeconds: number,
  latencySeconds: number,
  bounds: PlayheadBounds,
  isPlaying: boolean
): number {
  if (!Number.isFinite(stepDurationSeconds) || stepDurationSeconds <= 0) return 0

  if (!isPlaying) {
    return clampToProjectStep(transportSecondsToPlayheadStep(transportSeconds, stepDurationSeconds, 0), bounds)
  }

  const compensation = Number.isFinite(latencySeconds) && latencySeconds > 0 ? latencySeconds : 0
  const step = transportSecondsToPlayheadStep(transportSeconds, stepDurationSeconds, compensation)
  return foldPlayheadStep(step, bounds, compensation / stepDurationSeconds)
}
