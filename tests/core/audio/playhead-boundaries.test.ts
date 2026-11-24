import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mock, toneMock } = await vi.hoisted(async () => {
  const helpers = await import('../../helpers/tone-mock')
  const created = helpers.createToneMock()
  return { mock: created, toneMock: created.toneMock }
})

vi.mock('tone', () => toneMock)

import { EffectsRack } from '../../../src/audio/mixer'
import { PlaybackEngine } from '../../../src/audio/playback-engine'
import { resetMockAudioNodes } from '../../helpers/tone-mock'
import { ProjectSchema, PROJECT_SCHEMA_VERSION } from '../../../src/core/schemas/project.schema'

const { transport } = mock

/** 120 BPM: one sixteenth note is 0.125 s. */
const STEP = 0.125

function config(overrides: Record<string, unknown> = {}) {
  return ProjectSchema.parse({
    version: PROJECT_SCHEMA_VERSION,
    bpm: 120,
    bars: 4,
    loopStartStep: 8,
    loopEndStep: 24,
    isLooping: true,
    ...overrides
  })
}

function fixture(overrides: Record<string, unknown> = {}) {
  const engine = new PlaybackEngine(new EffectsRack())
  // `schedule` records the loop bounds the playhead resolves against, and writes the Tone loop.
  engine.schedule([], [], config(overrides))
  return engine
}

describe('PlaybackEngine playhead boundaries', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {})
    resetMockAudioNodes()
    transport.state = 'stopped'
    transport.seconds = 0
  })

  it('wraps a playing position that reached the open loop end onto the loop start', () => {
    const engine = fixture()
    vi.spyOn(engine, 'getOutputLatencySeconds').mockReturnValue(0)
    transport.state = 'started'

    // step 23: last sixteenth inside [8, 24)
    transport.seconds = 23 * STEP
    expect(engine.getPlayheadStep(120)).toBeCloseTo(23, 6)

    // step 24 == the exclusive loop end: wraps to the start, not to 24.
    transport.seconds = 24 * STEP
    expect(engine.getPlayheadStep(120)).toBeCloseTo(8, 6)
    expect(engine.getCurrentStep(120)).toBe(8)

    // step 30 == 8 + 22: one step into the next iteration.
    transport.seconds = 30 * STEP
    expect(engine.getPlayheadStep(120)).toBeCloseTo(14, 6)

    // The cursor never lands on the loop end while playing.
    for (let step = 24; step < 48; step += 0.5) {
      transport.seconds = step * STEP
      expect(engine.getPlayheadStep(120)).toBeLessThan(24)
      expect(engine.getPlayheadStep(120)).toBeGreaterThanOrEqual(8)
    }

    engine.dispose()
  })

  it('continues from the paused step on resume without subtracting latency', async () => {
    const engine = fixture()
    vi.spyOn(engine, 'getOutputLatencySeconds').mockReturnValue(0.025)

    transport.state = 'started'
    transport.seconds = 16 * STEP

    engine.pause()
    transport.state = 'paused'
    // Paused: the exact musical step, no latency compensation.
    expect(engine.getPlayheadStep(120)).toBeCloseTo(16, 6)
    expect(engine.getCurrentStep(120)).toBe(16)

    // Resume: the first frames still sit inside the output-latency window; the cursor holds the
    // paused step instead of jumping backwards to 15.8.
    transport.state = 'started'
    await engine.play()
    expect(engine.getPlayheadStep(120)).toBeCloseTo(16, 6)
    expect(engine.getCurrentStep(120)).toBe(16)

    engine.dispose()
  })

  it('clamps to the project total steps when looping is disabled', () => {
    const engine = fixture({ isLooping: false, loopStartStep: 0, loopEndStep: 64 })
    vi.spyOn(engine, 'getOutputLatencySeconds').mockReturnValue(0)
    transport.state = 'started'

    // 4 bars * 16 steps = 64 total steps.
    transport.seconds = 40 * STEP
    expect(engine.getPlayheadStep(120)).toBeCloseTo(40, 6)

    transport.seconds = 100 * STEP
    expect(engine.getPlayheadStep(120)).toBe(64)
    expect(engine.getCurrentStep(120)).toBe(64)

    engine.dispose()
  })

  it('applies latency compensation while playing but not while stopped or paused', () => {
    const engine = fixture({ isLooping: false, loopStartStep: 0, loopEndStep: 64 })
    vi.spyOn(engine, 'getOutputLatencySeconds').mockReturnValue(0.025)

    transport.seconds = 16 * STEP
    transport.state = 'stopped'
    expect(engine.getPlayheadStep(120)).toBeCloseTo(16, 6)

    transport.state = 'paused'
    expect(engine.getPlayheadStep(120)).toBeCloseTo(16, 6)

    transport.state = 'started'
    expect(engine.getPlayheadStep(120)).toBeCloseTo(16 - 0.025 / STEP, 6)

    engine.dispose()
  })

  it('reflects a running seek immediately and does not retain the old wrap state', () => {
    const engine = fixture()
    vi.spyOn(engine, 'getOutputLatencySeconds').mockReturnValue(0)
    transport.state = 'started'

    // Playing deep inside the loop, right before the loop end.
    transport.seconds = 23 * STEP
    expect(engine.getPlayheadStep(120)).toBeCloseTo(23, 6)

    // Seek to step 12 (1.5 s) while the mock clock still reads 23 * STEP. The cursor must show the
    // target at once, not fold the stale clock through the loop.
    engine.seekToStep(12)
    expect(engine.getPlayheadStep(120)).toBe(12)
    expect(engine.getCurrentStep(120)).toBe(12)

    // Seeking forward past the current position but still inside the loop stays on target too.
    engine.seekToStep(20)
    expect(engine.getPlayheadStep(120)).toBe(20)

    // Seeking at/past the open loop end shows the loop start the transport will wrap to, never the
    // out-of-range literal — the cursor stays inside [8, 24) at every instant.
    engine.seekToStep(40)
    expect(engine.getPlayheadStep(120)).toBe(8 + ((40 - 8) % 16))

    // Seeking before the loop start (pre-roll) is preserved, not folded into the loop.
    engine.seekToStep(3)
    expect(engine.getPlayheadStep(120)).toBe(3)

    engine.dispose()
  })

  it('reports a stopped target step immediately without loop folding', () => {
    const engine = fixture()
    transport.state = 'stopped'

    engine.stop(3)
    expect(engine.getPlayheadStep(120)).toBe(3)
    expect(engine.getCurrentStep(120)).toBe(3)

    // A stop to Bar 0 is outside the loop and must stay at 0.
    engine.stop(0)
    expect(engine.getPlayheadStep(120)).toBe(0)

    engine.dispose()
  })

  it('folds the loop start onto the cursor when latency reaches just before it', () => {
    const engine = fixture()
    // Latency large enough that step 8 lands at 7.84 after compensation.
    vi.spyOn(engine, 'getOutputLatencySeconds').mockReturnValue(0.02)
    transport.state = 'started'
    transport.seconds = 8 * STEP

    // 7.84 is inside the compensation window -> snaps to the loop start, not the loop tail.
    expect(engine.getPlayheadStep(120)).toBe(8)

    engine.dispose()
  })
})
