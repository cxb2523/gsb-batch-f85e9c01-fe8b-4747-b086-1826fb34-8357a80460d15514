/**
 * Run with `npm test`. Plain assertions, no test framework: the file is bundled
 * with esbuild and executed by node, and throws on the first failure.
 *
 * Covers the SONG-mode scheduler boundaries:
 *   - playing to the end fires onSongEnd exactly once and stops playback
 *   - a valid CYCLE loops inside its range and never ends
 *   - seek() while playing clears the old end task and recomputes the end
 *   - an empty project (or only zero-length clips) ends immediately
 *   - setMode() / setCycle() / stop() while playing leave no stale end timers
 *
 * The audio graph is never built (init() is skipped): a stand-in AudioContext
 * only supplies currentTime, and every trigger call no-ops without real nodes.
 * Time is driven by a fake clock so the tests are deterministic and instant.
 */
import { StudioEngine } from './engine'
import {
  DRUM_TRACK,
  STEPS_PER_BAR,
  type Clip,
  type DrumPattern,
  type EngineProject,
  type EngineTrack,
  type Pattern
} from './types'

// ---------- Fake clock: the only timer source for the engine under test ----------

interface TimerEntry {
  id: ReturnType<typeof setTimeout>
  at: number
  interval: number | null
  callback: () => void
}

class FakeClock {
  now = 0
  private nextId = 1
  private readonly entries = new Map<number, TimerEntry>()

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++ as unknown as ReturnType<typeof setTimeout>
    this.entries.set(id as unknown as number, { id, at: this.now + Math.max(0, delayMs), interval: null, callback })
    return id
  }

  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval> {
    const id = this.nextId++ as unknown as ReturnType<typeof setInterval>
    this.entries.set(id as unknown as number, { id, at: this.now + Math.max(0, delayMs), interval: Math.max(0, delayMs), callback })
    return id
  }

  clear(id: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null | undefined): void {
    if (id === null || id === undefined) return
    this.entries.delete(id as unknown as number)
  }

  /** Replace the process timers so the engine's scheduler runs on this clock. */
  install(): void {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay = 0) =>
      this.setTimeout(callback as () => void, delay)) as typeof setTimeout
    globalThis.setInterval = ((callback: (...args: unknown[]) => void, delay = 0) =>
      this.setInterval(callback as () => void, delay)) as typeof setInterval
    globalThis.clearTimeout = ((id: unknown) => this.clear(id as ReturnType<typeof setTimeout>)) as typeof clearTimeout
    globalThis.clearInterval = ((id: unknown) => this.clear(id as ReturnType<typeof setInterval>)) as typeof clearInterval
  }

  /** Move time forward by `seconds`, firing every task that becomes due (intervals repeat). */
  advance(seconds: number): void {
    const target = this.now + seconds * 1000
    let guard = 0
    while (true) {
      const due = [...this.entries.values()]
        .filter((entry) => entry.at <= target)
        .sort((a, b) => a.at - b.at)
      if (due.length === 0) break
      if (++guard > 100000) throw new Error('fake clock: timer storm, something is looping without making progress')
      const entry = due[0]
      this.now = entry.at
      if (entry.interval === null) this.entries.delete(entry.id as unknown as number)
      else entry.at = this.now + entry.interval
      entry.callback()
    }
    this.now = target
  }
}

class MockAudioContext {
  readonly sampleRate = 44100
  constructor(private readonly clock: FakeClock) {}
  get currentTime(): number {
    return this.clock.now / 1000
  }
  resume(): Promise<void> {
    return Promise.resolve()
  }
}

// ---------- Test harness ----------

let checks = 0
function check(ok: boolean, message: string): void {
  checks += 1
  if (!ok) throw new Error(`engine boundary check ${checks} failed: ${message}`)
}

function drumPattern(): DrumPattern {
  const pattern: DrumPattern = {
    id: 'p',
    name: 'A',
    trackId: DRUM_TRACK,
    kind: 'drums',
    bars: 1,
    drums: {
      kick: new Array(STEPS_PER_BAR).fill(0),
      snare: new Array(STEPS_PER_BAR).fill(0),
      clap: new Array(STEPS_PER_BAR).fill(0),
      hat: new Array(STEPS_PER_BAR).fill(0),
      openhat: new Array(STEPS_PER_BAR).fill(0),
      perc: new Array(STEPS_PER_BAR).fill(0),
      crash: new Array(STEPS_PER_BAR).fill(0),
      bass808: new Array(STEPS_PER_BAR).fill(0)
    }
  }
  pattern.drums.kick[0] = 1
  return pattern
}

const drumTrack: EngineTrack = { id: DRUM_TRACK, kind: 'drums', patternId: 'p' }

function projectWith(clips: Clip[]): EngineProject {
  const patterns: Record<string, Pattern> = { p: drumPattern() }
  return { tracks: [drumTrack], patterns, clips }
}

function clip(start: number, length: number): Clip {
  return { id: `c-${start}-${length}`, trackId: DRUM_TRACK, patternId: 'p', start, length, offset: 0 }
}

const EMPTY_PROJECT: EngineProject = { tracks: [drumTrack], patterns: { p: drumPattern() }, clips: [] }

/** 16th-note duration at 120 bpm. */
const STEP_SECONDS = 60 / 120 / 4

interface Harness {
  engine: StudioEngine
  clock: FakeClock
  stepEvents: number[]
  endEvents: number
}

function makeHarness(project: EngineProject): Harness {
  const clock = new FakeClock()
  clock.install()
  const engine = new StudioEngine()
  // Skip init(): give the scheduler its clock without constructing an audio graph.
  ;(engine as unknown as { ctx: AudioContext }).ctx = new MockAudioContext(clock) as unknown as AudioContext
  engine.setProject(project)
  engine.setMode('song')
  engine.setBpm(120)
  const stepEvents: number[] = []
  const harness: Harness = { engine, clock, stepEvents, endEvents: 0 }
  engine.onStep = (step) => stepEvents.push(step)
  engine.onSongEnd = () => {
    harness.endEvents += 1
  }
  return harness
}

// ---------- 1. Normal playback runs to the end: onSongEnd fires exactly once ----------

{
  const h = makeHarness(projectWith([clip(0, 16)]))
  h.engine.start()
  check(h.engine.playing, 'playing after start()')
  h.clock.advance(STEP_SECONDS * 20)
  check(!h.engine.playing, 'playback stops at the end of the last clip')
  check(h.endEvents === 1, `onSongEnd fired once, got ${h.endEvents}`)
  check(h.stepEvents.length === 16, `all 16 clip steps fired, got ${h.stepEvents.length}`)
  check(h.stepEvents[0] === 0 && h.stepEvents[15] === 15, 'steps fire in order 0..15')

  // Time keeps passing: nothing may re-fire after the end.
  h.clock.advance(STEP_SECONDS * 64)
  check(h.endEvents === 1, `no second onSongEnd after stopping, got ${h.endEvents}`)
  check(h.stepEvents.length === 16, 'no step callbacks after the end')
}

// ---------- 2. Restarting after an end recomputes and ends again, once per run ----------

{
  const h = makeHarness(projectWith([clip(0, 8)]))
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 12)
  check(h.endEvents === 1, 'first run ends once')
  check(!h.engine.playing, 'stopped after first run')

  h.engine.start()
  check(h.engine.playing, 'playing again on second start()')
  h.clock.advance(STEP_SECONDS * 12)
  check(h.endEvents === 2, 'second run fires its own onSongEnd')
  check(!h.engine.playing, 'stops again after second run')
}

// ---------- 3. A valid CYCLE loops inside its range and never ends ----------

{
  const h = makeHarness(projectWith([clip(0, 64)]))
  h.engine.setCycle({ start: 4, end: 12 })
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 80)
  check(h.engine.playing, 'playback keeps running while cycling')
  check(h.endEvents === 0, 'CYCLE never triggers onSongEnd')
  check(h.stepEvents.length > 32, `cycling keeps scheduling steps, got ${h.stepEvents.length}`)
  // Steps before the cycle start play once on the way in; once entered, the
  // playhead may never leave the [4, 12) range again.
  const entry = h.stepEvents.indexOf(4)
  check(entry >= 0, 'playback reaches the cycle start')
  const cycledSteps = h.stepEvents.slice(entry)
  const inside = cycledSteps.every((step) => step >= 4 && step < 12)
  check(inside, `every step after entering the cycle stays within [4, 12), got ${JSON.stringify(cycledSteps)}`)
  check(cycledSteps.filter((s) => s === 4).length > 1, 'the cycle wrapped back to its start')
}

// ---------- 4. CYCLE switched on mid-playback cancels the pending end ----------

{
  const h = makeHarness(projectWith([clip(0, 16)]))
  h.engine.start()
  // Advance to within a step of the end so the song-end task is already queued.
  h.clock.advance(STEP_SECONDS * 15.8)
  check(h.endEvents === 0, 'no end before the cycle is enabled')
  const queuedEnd = (h.engine as unknown as { songEndTimeout: unknown }).songEndTimeout
  check(queuedEnd !== null, 'the song-end task is queued before CYCLE is enabled')
  h.engine.setCycle({ start: 0, end: 8 })
  check(
    (h.engine as unknown as { songEndTimeout: unknown }).songEndTimeout === null,
    'enabling CYCLE discards the queued end task'
  )
  h.clock.advance(STEP_SECONDS * 40)
  check(h.engine.playing, 'enabling CYCLE keeps playback alive past the old end')
  check(h.endEvents === 0, 'the end queued before CYCLE never fires')
  const wrapped = h.stepEvents.filter((s) => s === 0).length
  check(wrapped >= 2, `playhead wrapped through the cycle, saw step 0 ${wrapped} times`)
}

// ---------- 5. CYCLE switched off mid-playback re-arms the real end ----------

{
  const h = makeHarness(projectWith([clip(0, 16)]))
  h.engine.setCycle({ start: 0, end: 8 })
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 24)
  check(h.endEvents === 0 && h.engine.playing, 'cycling with no end while CYCLE is on')
  h.engine.setCycle(null)
  check(h.engine.playing, 'turning CYCLE off does not stop playback by itself')
  h.clock.advance(STEP_SECONDS * 24)
  check(!h.engine.playing, 'after CYCLE off, playback reaches the real song end')
  check(h.endEvents === 1, `exactly one onSongEnd after leaving CYCLE, got ${h.endEvents}`)
}

// ---------- 6. seek() while playing clears the old end; the new timeline still ends ----------

{
  const h = makeHarness(projectWith([clip(0, 32)]))
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 28)
  check(h.endEvents === 0, 'still playing near the end')
  // Jump back before the end: the end task queued for the old position is discarded.
  h.engine.seek(4)
  h.clock.advance(STEP_SECONDS * 20)
  check(h.engine.playing, 'seek backwards keeps playback going past the old end time')
  check(h.endEvents === 0, 'no end callback from the pre-seek position')
  h.clock.advance(STEP_SECONDS * 16)
  check(!h.engine.playing, 'playback ends after reaching the end from the new position')
  check(h.endEvents === 1, `onSongEnd fires once after seek, got ${h.endEvents}`)
  check(h.stepEvents.includes(4), 'steps restart from the seek target')
}

// ---------- 7. seek() to (or past) the end while playing ends immediately, once ----------

{
  const h = makeHarness(projectWith([clip(0, 16)]))
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 4)
  h.engine.seek(16)
  h.clock.advance(STEP_SECONDS * 4)
  check(!h.engine.playing, 'seeking onto the end stops playback')
  check(h.endEvents === 1, `seeking onto the end fires onSongEnd once, got ${h.endEvents}`)

  const again = makeHarness(projectWith([clip(0, 16)]))
  again.engine.start()
  again.clock.advance(STEP_SECONDS * 2)
  again.engine.seek(99)
  again.clock.advance(STEP_SECONDS * 4)
  check(!again.engine.playing, 'seeking past the end stops playback')
  check(again.endEvents === 1, `seeking past the end fires onSongEnd once, got ${again.endEvents}`)
}

// ---------- 8. Empty project ends immediately instead of idling ----------

{
  const h = makeHarness(EMPTY_PROJECT)
  h.engine.start()
  check(h.engine.playing, 'start() engages even with no clips')
  // The end is armed on the first scheduler tick (50 ms in) and fires right after.
  h.clock.advance(0.2)
  check(!h.engine.playing, 'empty project stops itself immediately')
  check(h.endEvents === 1, `empty project fires onSongEnd once, got ${h.endEvents}`)
  check(h.stepEvents.length === 0, 'empty project schedules no steps')
  h.clock.advance(1)
  check(h.endEvents === 1, 'empty project never fires onSongEnd again')
}

// ---------- 9. Only zero-length clips: treated like an empty project ----------

{
  const h = makeHarness(projectWith([clip(0, 0), clip(16, 0)]))
  h.engine.start()
  h.clock.advance(0.2)
  check(!h.engine.playing, 'all-zero-length clips stop playback immediately')
  check(h.endEvents === 1, `zero-length clips fire onSongEnd once, got ${h.endEvents}`)
  check(h.stepEvents.length === 0, 'zero-length clips schedule no steps')
}

// ---------- 10. Zero-length clips do not extend the audible end ----------

{
  // A real 8-step clip followed by a zero-length clip far down the timeline.
  const h = makeHarness(projectWith([clip(0, 8), clip(48, 0)]))
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 12)
  check(!h.engine.playing, 'the song ends at the real clip, not at the empty one')
  check(h.endEvents === 1, `onSongEnd fires once, got ${h.endEvents}`)
  check(h.stepEvents.length === 8, `only the audible clip's 8 steps fired, got ${h.stepEvents.length}`)
}

// ---------- 11. setMode() while playing tears down the pending end, no stale callback ----------

{
  const h = makeHarness(projectWith([clip(0, 16)]))
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 14)
  check(h.endEvents === 0, 'no end before the mode switch')
  h.engine.setMode('loop')
  check(!h.engine.playing, 'switching mode while playing stops transport')
  h.clock.advance(STEP_SECONDS * 32)
  check(h.endEvents === 0, 'the song-end task queued before the switch never fires')

  // Starting again in LOOP mode wraps forever and never ends.
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 128)
  check(h.engine.playing, 'loop mode keeps playing')
  check(h.endEvents === 0, 'loop mode never fires onSongEnd')
}

// ---------- 12. stop() while playing cancels the pending end ----------

{
  const h = makeHarness(projectWith([clip(0, 16)]))
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 15)
  h.engine.stop()
  check(!h.engine.playing, 'stop() halts transport')
  h.clock.advance(STEP_SECONDS * 32)
  check(h.endEvents === 0, 'stop() prevents the queued onSongEnd from firing')
  check(h.stepEvents.length <= 16, 'no steps scheduled after stop()')

  // A fresh start after stop() recomputes the end normally.
  h.engine.setMode('song')
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 20)
  check(!h.engine.playing, 'restarted playback still reaches the end')
  check(h.endEvents === 1, `onSongEnd fires once on the fresh run, got ${h.endEvents}`)
}

// ---------- 13. An invalid CYCLE is ignored: the song still ends ----------

{
  const h = makeHarness(projectWith([clip(0, 8)]))
  h.engine.setCycle({ start: 8, end: 8 })
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 12)
  check(!h.engine.playing, 'an empty cycle range does not prevent the end')
  check(h.endEvents === 1, `invalid cycle still ends exactly once, got ${h.endEvents}`)
}

// ---------- 14. CYCLE starting beyond the playhead still loops without ending ----------

{
  const h = makeHarness(projectWith([clip(0, 64)]))
  h.engine.setCycle({ start: 16, end: 24 })
  h.engine.start()
  h.clock.advance(STEP_SECONDS * 80)
  check(h.engine.playing, 'playback continues once it enters the cycle')
  check(h.endEvents === 0, 'no song end even though the cycle starts mid-song')
  const cycled = h.stepEvents.filter((step) => step >= 16 && step < 24)
  check(cycled.length > 8, `steps repeat inside the late cycle, got ${cycled.length}`)
}

console.log(`engine boundaries: ${checks} checks passed`)
