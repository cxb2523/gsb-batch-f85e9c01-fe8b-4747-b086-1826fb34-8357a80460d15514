import { describe, expect, it } from 'vitest'
import {
  clampToProjectStep,
  foldPlayheadStep,
  getLoopRegion,
  normalizeLoopSteps,
  resolvePlayheadStep,
  type PlayheadBounds
} from '../../../src/core/transport/playhead'

// 120 BPM: one sixteenth note is 0.125 s.
const STEP = 0.125

const bounds = (overrides: Partial<PlayheadBounds> = {}): PlayheadBounds => ({
  loopStartStep: 0,
  loopEndStep: 64,
  isLooping: true,
  totalSteps: 64,
  ...overrides
})

describe('normalizeLoopSteps', () => {
  it('rounds to integer steps and enforces a minimum one-step span', () => {
    expect(normalizeLoopSteps(8, 16)).toEqual({ startStep: 8, endStep: 16 })
    expect(normalizeLoopSteps(-4, 3.4)).toEqual({ startStep: 0, endStep: 3 })
    // A collapsed or inverted region always spans at least one step so the transport can wrap.
    expect(normalizeLoopSteps(10, 10)).toEqual({ startStep: 10, endStep: 11 })
    expect(normalizeLoopSteps(10, 4)).toEqual({ startStep: 10, endStep: 11 })
  })
})

describe('getLoopRegion', () => {
  it('never lets the loop extend past the known project end', () => {
    expect(getLoopRegion(bounds({ loopStartStep: 8, loopEndStep: 200, totalSteps: 64 }))).toEqual({
      startStep: 8,
      endStep: 64
    })
    // An unknown project end leaves the loop untouched.
    expect(getLoopRegion(bounds({ loopEndStep: 200, totalSteps: Infinity }))).toEqual({ startStep: 0, endStep: 200 })
  })
})

describe('foldPlayheadStep — loop wrapping', () => {
  it('keeps an in-range playback position untouched', () => {
    expect(foldPlayheadStep(20, bounds({ loopStartStep: 8, loopEndStep: 24 }))).toBe(20)
  })

  it('wraps the open loop end straight onto the loop start, never onto the loop end', () => {
    const region = bounds({ loopStartStep: 8, loopEndStep: 24 })
    expect(foldPlayheadStep(24, region)).toBe(8)
    expect(foldPlayheadStep(25, region)).toBe(9)
    expect(foldPlayheadStep(40, region)).toBe(8) // exactly one span past the end
    expect(foldPlayheadStep(47, region)).toBe(15) // last step of the next iteration
    // The loop end is exclusive: no input ever yields the loop end itself.
    for (let step = 24; step < 60; step += 0.25) {
      expect(foldPlayheadStep(step, region)).toBeLessThan(24)
      expect(foldPlayheadStep(step, region)).toBeGreaterThanOrEqual(8)
    }
  })

  it('snaps a latency-induced wrap undershoot onto the loop start', () => {
    const region = bounds({ loopStartStep: 8, loopEndStep: 24 })
    // 0.4-step latency: the first samples of a new iteration land just before the loop start and
    // must show the loop start, not the previous iteration's tail.
    expect(foldPlayheadStep(7.7, region, 0.4)).toBe(8)
    // Without a compensation window the same position is a legitimate pre-roll and stays put.
    expect(foldPlayheadStep(7.7, region, 0)).toBeCloseTo(7.7, 9)
  })

  it('leaves a genuine pre-roll position before the loop start alone', () => {
    const region = bounds({ loopStartStep: 16, loopEndStep: 32 })
    expect(foldPlayheadStep(4, region, 0.4)).toBe(4)
  })
})

describe('foldPlayheadStep — looping disabled', () => {
  it('clamps to the project length instead of wrapping', () => {
    const project = bounds({ isLooping: false, totalSteps: 32 })
    expect(foldPlayheadStep(10, project)).toBe(10)
    expect(foldPlayheadStep(32, project)).toBe(32)
    expect(foldPlayheadStep(48, project)).toBe(32)
  })
})

describe('resolvePlayheadStep', () => {
  it('subtracts output latency only while playing', () => {
    const region = bounds({ loopStartStep: 0, loopEndStep: 64 })
    // 0.025 s of latency at 0.125 s/step removes 0.2 steps.
    expect(resolvePlayheadStep(2, STEP, 0.025, region, true)).toBeCloseTo(15.8, 6)
    // Paused/stopped: latency is not applied, the musical position is exact.
    expect(resolvePlayheadStep(2, STEP, 0.025, region, false)).toBeCloseTo(16, 6)
  })

  it('wraps a playing position through the open loop end', () => {
    const region = bounds({ loopStartStep: 8, loopEndStep: 24 })
    // 3.0 s = step 24 == the exclusive loop end -> wraps to the loop start.
    expect(resolvePlayheadStep(3.0, STEP, 0, region, true)).toBe(8)
    // 2.875 s = step 23 -> last step of the iteration.
    expect(resolvePlayheadStep(2.875, STEP, 0, region, true)).toBe(23)
  })

  it('never applies latency to a resting position even past the loop end', () => {
    const region = bounds({ loopStartStep: 8, loopEndStep: 24 })
    // Paused exactly on the (exclusive) loop end: musical position 24 is reported, not 8 or 23.
    expect(resolvePlayheadStep(3.0, STEP, 0.025, region, false)).toBe(24)
  })

  it('constrains a non-looping playing position to the project total steps', () => {
    const project = bounds({ isLooping: false, totalSteps: 32 })
    expect(resolvePlayheadStep(6, STEP, 0, project, true)).toBe(32)
  })

  it('forces the loop start when latency pushes the cursor just before it', () => {
    const region = bounds({ loopStartStep: 8, loopEndStep: 24 })
    // Playback resumes exactly at the loop start (step 8 = 1.0 s); subtracting 0.02 s of latency
    // lands the cursor at step 7.84 — still inside the latency window, so it snaps to 8.
    const step = resolvePlayheadStep(1.0, STEP, 0.02, region, true)
    expect(step).toBe(8)
  })

  it('returns 0 for a non-positive step duration', () => {
    expect(resolvePlayheadStep(2, 0, 0.025, bounds(), true)).toBe(0)
    expect(resolvePlayheadStep(2, Number.NaN, 0.025, bounds(), true)).toBe(0)
  })
})

describe('resting positions leave the loop region untouched', () => {
  it('keeps a stop to bar 0 at step 0 even with a loop enabled', () => {
    const region = bounds({ loopStartStep: 16, loopEndStep: 32 })
    // resolvePlayheadStep(isPlaying=false) only clamps to the project, never to the loop.
    expect(resolvePlayheadStep(0, STEP, 0.025, region, false)).toBe(0)
    expect(clampToProjectStep(0, region)).toBe(0)
  })

  it('clamps only to the project length while resting', () => {
    const region = bounds({ loopStartStep: 16, loopEndStep: 32, totalSteps: 64 })
    expect(resolvePlayheadStep(100 * STEP, STEP, 0.025, region, false)).toBe(64)
    expect(clampToProjectStep(-3, region)).toBe(0)
  })
})
