import * as Tone from 'tone'
import type { ChordEvent } from '../../core/schemas/chord.schema'
import type { AppNote } from '../../core/schemas/note.schema'
import { STEPS_PER_BAR, type ProjectConfig } from '../../core/schemas/project.schema'
import type { ChordPreset, LeadPreset } from '../../core/schemas/synth.schema'
import {
  createEventGenerationTracker,
  type EventGenerationTracker,
  type PlaybackSession
} from '../../core/synth/event-generation'
import { EffectsRack } from '../mixer'
import { getStepDurationSeconds } from '../../core/transport/playback-timing'
import { PreviewController, type NotesAuditionOptions } from './preview-controller'
import { SynthRegistry } from './synth-registry'
import { TransportMidiLifecycle } from './midi-lifecycle'
import { TransportScheduler } from './transport-scheduler'
import { TrackOutputRouter, type TrackOutputRuntime } from '../output-router'
import { pickupActiveChord } from './chord-pickup'
import type { SynthPatch } from '../../core/synth/patch'
import {
  clampToProjectStep,
  foldPlayheadStep,
  resolvePlayheadStep,
  type PlayheadBounds
} from '../../core/transport/playhead'
import { transportSecondsToPlayheadStep } from '../../core/audio-dsp/output-latency'
import { DEFAULT_PROJECT_SETTINGS } from '../../config/defaults'
import {
  ensureAudioContextRunning,
  getAudibleTransportSeconds,
  setTransportLoop,
  stepToTransportPosition
} from '../transport-adapter'
import { TRUNCATE_SILENCE_POLICY } from '../../core/audio/voice-lifecycle'
import { RhythmPreviewController } from '../rhythm-preview'
import type { CustomRhythmPattern } from '../../core/schemas/custom-rhythm.schema'

export { stepToTransportPosition } from '../transport-adapter'

/** How close (in seconds) the raw clock must get to the target for the seek to count as landed. */
function seekLandingToleranceSeconds(stepSeconds: number): number {
  return Math.max(0.01, stepSeconds * 0.25)
}

/**
 * Documented audible semantics of every transport/preview boundary. Each entry names the three
 * things that must happen together: future callbacks are invalidated, voices are released, and
 * events that already reached audio nodes are withdrawn by a short track fade.
 *
 * - `stop`     Rewinds the transport, releases every voice and fades the track inputs for
 *              12 ms, so notes that were already scheduled into nodes cannot ring on.
 * - `pause`    Keeps the transport position, releases every voice with the same short fade;
 *              resuming re-renders the schedule from the current step.
 * - `seek`     Moves the transport and releases any sounding voices so notes do not hang.
 *              The transport schedule stays intact and valid for playback.
 * - `preview`  Cancelling a progression or audition releases that session's voices and fades
 *              the corresponding track, because queued note-ons cannot be withdrawn otherwise.
 * - `panic`    Cancels the transport schedule, releases all voices and applies a 35 ms fade to
 *              every track so release tails and effect returns are cleared.
 */
export const TRANSPORT_LIFECYCLE_SEMANTICS = {
  stop: 'rewind + invalidate + release + short track fade',
  pause: 'hold position + invalidate + release + short track fade',
  seek: 'move position + release sounding voices',
  preview: 'cancel session + release session voices + short track fade',
  panic: 'cancel schedule + release all voices + clear tails'
} as const

/**
 * Central PlaybackEngine managing multi-track scheduling on Tone.Transport,
 * live auditioning, synths, and master bus effects.
 *
 * The engine stays a thin orchestrator: voice graphs and presets live in the {@link SynthRegistry},
 * transport events in the {@link TransportScheduler} and auditions in the {@link PreviewController}.
 * It owns the session generation and the transport/preview lifecycle boundaries that tie them
 * together.
 */
export class PlaybackEngine {
  readonly outputRouter: TrackOutputRouter
  readonly effectsRack: EffectsRack
  readonly generations: EventGenerationTracker = createEventGenerationTracker()

  private readonly synths: SynthRegistry
  private readonly midiLifecycle: TransportMidiLifecycle
  private startOperation = 0
  private readonly scheduler: TransportScheduler
  private readonly previews: PreviewController
  private rhythmPreview: RhythmPreviewController | null = null

  private readonly expiryTimers = new Set<ReturnType<typeof setTimeout>>()
  private isDisposed = false

  /**
   * Musical bounds the rendered playhead is folded into. `schedule()` and `setLoop()` keep them in
   * sync with the project so callers that only pass a tempo still get a loop-aware position.
   */
  private playheadBounds: PlayheadBounds = {
    loopStartStep: DEFAULT_PROJECT_SETTINGS.loopStartStep,
    loopEndStep: DEFAULT_PROJECT_SETTINGS.loopEndStep,
    isLooping: DEFAULT_PROJECT_SETTINGS.isLooping,
    totalSteps: DEFAULT_PROJECT_SETTINGS.bars * STEPS_PER_BAR
  }

  /**
   * An explicit seek issued while the transport is running. Tone defers the position write to its
   * next tick, then (with a loop) wraps an out-of-range write onto the loop start. The anchor shows
   * the target step the listener will actually hear and releases once the raw clock reaches either
   * the literal written position or the wrapped one. It stores only steps/seconds — never a loop
   * offset from the pre-seek position — so no stale wrap state can leak out.
   */
  private seekAnchor: { step: number; releaseSeconds: number[] } | null = null

  /**
   * Right after a resume the latency-compensated clock reports positions *before* the step playback
   * restarted from (those samples are still inside the output-latency window), which would jerk the
   * cursor backwards exactly at resume. The hold pins the cursor to the resume step until the
   * transport has advanced a full latency, then hands off to steady-state compensation seamlessly.
   */
  private resumeHold: { step: number; startSeconds: number; latencySeconds: number } | null = null

  /**
   * Last resting target written by `seekToStep`/`stop`. While the transport is not started the
   * clock may not yet reflect the write, so the engine reports the requested target instead. Pause
   * clears it so the frozen clock supplies the musical pause position.
   */
  private restingStep: number | null = null

  /** Tempo used to translate a seek target step into transport seconds for anchor release. */
  private currentBpm: number = DEFAULT_PROJECT_SETTINGS.bpm

  async initializeDiagnostics(): Promise<boolean> {
    const meteringReady = await this.effectsRack.initializeMetering()
    const protectionReady = await this.effectsRack.initializeOutputProtection()
    return meteringReady && protectionReady
  }

  constructor(
    effectsRack?: EffectsRack,
    outputRuntime?: TrackOutputRuntime,
    isChordEnabled: () => boolean = () => true
  ) {
    this.effectsRack = effectsRack ?? new EffectsRack()
    this.synths = new SynthRegistry(this.effectsRack)
    this.outputRouter = new TrackOutputRouter({
      generations: this.generations,
      runtime: outputRuntime,
      isAudible: (track) =>
        track === 'lead' ? this.effectsRack.isLeadAudible() : isChordEnabled() && this.effectsRack.isChordAudible(),
      getInstrument: (track) => (track === 'lead' ? this.synths.getLead() : this.synths.getChord()),
      holdVoice: (voiceId, holdSeconds) => this.scheduleVoiceExpiry(voiceId, holdSeconds)
    })
    this.midiLifecycle = new TransportMidiLifecycle(this.outputRouter, outputRuntime, () => {
      ++this.startOperation
      this.outputRouter.blockPreviews(false)
    })
    this.scheduler = new TransportScheduler({ outputRouter: this.outputRouter })
    this.previews = new PreviewController({
      outputRouter: this.outputRouter,
      generations: this.generations,
      getLeadPreviewSynth: () => this.synths.getLeadPreview(),
      getChordPreviewSynth: () => this.synths.getChordPreview(),
      holdVoice: (voiceId, holdSeconds) => this.scheduleVoiceExpiry(voiceId, holdSeconds),
      truncateVoices: () => this.truncateVoices()
    })

    // Only instantiate audio nodes if environment supports Web Audio
    if (typeof window !== 'undefined') {
      this.synths.initialize()
    }
  }

  private trackExpiry(callback: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.expiryTimers.delete(timer)
      callback()
    }, delayMs)
    this.expiryTimers.add(timer)
  }

  /**
   * Releases the note that this handle owns after its duration and release, so voice ownership
   * stays bounded instead of assuming that a release callback exists for every note-on.
   */
  private scheduleVoiceExpiry(id: string, holdSeconds: number): void {
    this.trackExpiry(() => this.generations.endVoice(id), Math.max(50, (holdSeconds + 0.25) * 1000))
  }

  /**
   * Schedules melody notes and accompaniment chords on Tone.Transport under fresh generations,
   * so events of the previous schedule can never start.
   */
  schedule(notes: AppNote[], chords: ChordEvent[], projectConfig: ProjectConfig, preserveTempoRamp = false): void {
    this.midiLifecycle.refreshLead(notes, true)
    this.midiLifecycle.cancel('chord')
    const transport = Tone.getTransport()
    if (!preserveTempoRamp) transport.bpm.value = projectConfig.bpm
    this.setTempo(projectConfig.bpm)
    this.setPlayheadBounds(projectConfig)
    setTransportLoop(projectConfig.loopStartStep, projectConfig.loopEndStep, projectConfig.isLooping)

    const leadGen = this.beginTransportTrackSession('transport-lead')
    const chordGen = this.beginTransportTrackSession('transport-chord')
    this.scheduler.schedule(notes, chords, projectConfig, leadGen, chordGen)
  }

  /**
   * Remembers the musical range the playhead may occupy. Called from every path that knows the
   * project shape, so `getPlayheadStep(bpm)` can stay loop-aware without taking a config argument.
   */
  private setPlayheadBounds(projectConfig: ProjectConfig): void {
    this.playheadBounds = {
      loopStartStep: projectConfig.loopStartStep,
      loopEndStep: projectConfig.loopEndStep,
      isLooping: projectConfig.isLooping,
      totalSteps: Math.max(0, projectConfig.bars * STEPS_PER_BAR)
    }
  }

  /**
   * Updates only melody notes on the transport, leaving scheduled chords and active chord voices
   * completely untouched.
   */
  scheduleLead(notes: AppNote[], projectConfig: ProjectConfig, replace = false): void {
    this.midiLifecycle.refreshLead(notes, replace)
    const leadGen = this.beginTransportTrackSession('transport-lead')
    this.scheduler.scheduleLead(notes, projectConfig, leadGen)
  }

  /**
   * Updates only chord accompaniment on the transport, leaving melody notes completely untouched.
   */
  scheduleChords(chords: ChordEvent[], projectConfig: ProjectConfig): void {
    this.midiLifecycle.cancel('chord')
    const chordGen = this.beginTransportTrackSession('transport-chord')
    this.scheduler.scheduleChords(chords, projectConfig, chordGen)
    if (Tone.getTransport().state === 'started') {
      pickupActiveChord(
        this.outputRouter,
        chords,
        projectConfig,
        chordGen,
        this.getCurrentStep(projectConfig.bpm),
        Tone.now()
      )
    }
  }

  setTempo(bpm: number): void {
    if (Number.isFinite(bpm) && bpm > 0) this.currentBpm = bpm
    this.synths.setTempo(bpm, Tone.now())
  }

  /**
   * Invalidates and resets one transport track session. When the transport is actively playing,
   * currently sounding voices are kept alive so they decay naturally instead of creating dropouts.
   */
  private beginTransportTrackSession(track: 'transport-lead' | 'transport-chord'): number {
    if (track === 'transport-lead') {
      this.scheduler.clearLead()
    } else {
      this.scheduler.clearChords()
    }
    this.generations.invalidate(track)
    if (Tone.getTransport().state !== 'started') {
      this.releaseSessionVoices(track)
    }
    return this.generations.openGeneration(track)
  }

  clearScheduledEvents(): void {
    this.generations.invalidate('transport-lead')
    this.generations.invalidate('transport-chord')
    this.midiLifecycle.cancel()
    this.scheduler.clear()
  }

  /**
   * Invalidates queued transport note-ons and releases the voices they already own. Tone keeps
   * scheduled attacks inside its event timeline, which `transport.clear` does not always reach.
   */
  private invalidateTransportSession(): void {
    this.generations.invalidate('transport')
    this.generations.invalidate('transport-lead')
    this.generations.invalidate('transport-chord')
    this.releaseSessionVoices('transport')
    this.releaseSessionVoices('transport-lead')
    this.releaseSessionVoices('transport-chord')
  }

  // --- Voice ownership ---

  private releaseSessionVoices(session: PlaybackSession): number {
    const released = this.generations.releaseSession(session)
    this.synths.releaseSessionVoices(session)
    return released.length
  }

  /**
   * Withdraws events that are already queued inside audio nodes. `releaseAll` stops future
   * note-ons from that synth but cannot withdraw an envelope that was already scheduled, so the
   * track inputs are faded to silence for a few milliseconds.
   */
  private truncateVoices(): void {
    this.effectsRack.silenceVoices(TRUNCATE_SILENCE_POLICY)
  }

  // --- Transport Controls ---

  async play(): Promise<void> {
    const operation = ++this.startOperation
    this.outputRouter.blockPreviews(true)
    // A start directly after a stop or panic must not begin inside the 12–35 ms silencing window.
    this.effectsRack.restoreVoiceGains()
    if (!(await ensureAudioContextRunning())) {
      if (operation === this.startOperation) this.outputRouter.blockPreviews(false)
      throw new Error('Audio context is not running.')
    }
    if (this.isDisposed || operation !== this.startOperation) return
    try {
      await this.midiLifecycle.resume()
    } catch (error) {
      if (operation === this.startOperation) this.outputRouter.blockPreviews(false)
      throw error
    }
    if (this.isDisposed || operation !== this.startOperation) return
    this.outputRouter.blockPreviews(true)
    // Starting from rest: pin the cursor to the position playback actually starts from until the
    // compensated clock catches up, so stop→play and pause→play never jump backwards on resume.
    this.beginResumeHold()
    this.restingStep = null
    this.seekAnchor = null
    Tone.getTransport().start()
  }

  pause(): void {
    ++this.startOperation
    this.midiLifecycle.suspend()
    this.clearScheduledEvents()
    this.invalidateTransportSession()
    this.truncateVoices()
    Tone.getTransport().pause()
    // The frozen transport clock now holds the musical pause position; derive the resting step from
    // it (no latency compensation) rather than from the last seek/stop target.
    this.restingStep = null
    this.seekAnchor = null
    this.resumeHold = null
  }

  stop(targetStep = 0): void {
    ++this.startOperation
    this.midiLifecycle.suspend()
    this.previews.stopNotesAudition()
    const transport = Tone.getTransport()
    transport.stop()
    this.clearScheduledEvents()
    this.invalidateTransportSession()
    this.truncateVoices()
    const target = clampToProjectStep(targetStep, this.playheadBounds)
    transport.position = stepToTransportPosition(target)
    this.restingStep = target
    this.seekAnchor = null
    this.resumeHold = null
  }

  /**
   * Single panic action: cancels the remaining transport schedule, releases every voice and
   * clears release tails and effect returns through a short track fade. The transport position is
   * left untouched, so panic can be used as a safety action during playback.
   */
  panic(): void {
    ++this.startOperation
    this.outputRouter.blockPreviews(false)
    this.midiLifecycle.panic()
    this.outputRouter.cancelPreviews()
    this.previews.stopNotesAudition()
    Tone.getTransport().cancel()
    this.scheduler.reset()
    this.generations.releaseAll()
    this.synths.releaseAllVoices()
    this.effectsRack.silenceVoices()
    this.previews.stopProgressionPreview()
  }

  syncOutputAudibility(): void {
    this.midiLifecycle.syncAudibility()
  }

  setLoop(startStep: number, endStep: number, isLooping: boolean): void {
    this.midiLifecycle.cancel()
    this.scheduler.refreshLoop({ loopStartStep: startStep, loopEndStep: endStep, isLooping })
    this.outputRouter.setLoop({ loopEndStep: endStep, isLooping })
    this.playheadBounds = { ...this.playheadBounds, loopStartStep: startStep, loopEndStep: endStep, isLooping }
    setTransportLoop(startStep, endStep, isLooping)
  }

  /**
   * Moves the playhead. Tone defers a transport jump while the clock runs (it stops and restarts
   * on the next tick, up to one lookahead away), so a follow-up `getPlayheadStep` would still read
   * the pre-seek position. The seek anchor reports the requested target immediately and releases
   * once the clock lands on it; it stores only the target step, never a loop offset, so a seek can
   * never leave stale wrap state behind. Lifecycle semantics stay those of
   * `TRANSPORT_LIFECYCLE_SEMANTICS` `seek`: move position + release sounding voices.
   */
  seekToStep(step: number): void {
    this.midiLifecycle.cancel()
    if (this.midiLifecycle.isExternal) this.scheduler.refreshLoop()
    // Release any sounding voices so notes do not hang across the seek position
    this.releaseSessionVoices('transport')
    this.releaseSessionVoices('transport-lead')
    this.releaseSessionVoices('transport-chord')

    const target = clampToProjectStep(Math.round(Number.isFinite(step) ? step : 0), this.playheadBounds)
    const transport = Tone.getTransport()
    const wasPlaying = transport.state === 'started'
    // The transport holds the literal target from the write until its next tick. While a loop is
    // active Tone then wraps an out-of-range position, so the cursor should already show the folded
    // value the listener will hear — never the raw out-of-loop step, which would briefly leave the
    // region. A pre-roll target before the loop start is preserved.
    const displayTarget = foldPlayheadStep(target, this.playheadBounds, 0)
    transport.position = stepToTransportPosition(target)
    this.restingStep = target
    this.resumeHold = null
    if (wasPlaying) {
      const stepSeconds = getStepDurationSeconds(this.currentBpm, '16n')
      // Tone reads the literal write first, then wraps it to the loop start; release on either.
      const releaseSeconds = [target * stepSeconds]
      if (displayTarget !== target) releaseSeconds.push(displayTarget * stepSeconds)
      this.seekAnchor = { step: displayTarget, releaseSeconds }
    } else {
      this.seekAnchor = null
    }
  }

  /**
   * Requested target of an in-flight seek, or null once the transport clock has landed on it. Tone
   * sets the position absolutely on its next tick, so the audible clock reads the (literal, then
   * possibly loop-wrapped) target right after the jump. Only the display target step is returned, so
   * the resolver never inherits wrap state from the pre-seek position, and the anchor drops the
   * moment the raw clock matches any release point.
   */
  private currentSeekAnchor(): number | null {
    const anchor = this.seekAnchor
    if (!anchor) return null
    if (Tone.getTransport().state !== 'started') {
      this.seekAnchor = null
      return null
    }
    const stepSeconds = getStepDurationSeconds(this.currentBpm, '16n')
    const tolerance = seekLandingToleranceSeconds(stepSeconds)
    const clock = this.getCurrentTimeSeconds()
    if (anchor.releaseSeconds.some((seconds) => Math.abs(clock - seconds) <= tolerance)) {
      this.seekAnchor = null
      return null
    }
    return anchor.step
  }

  // --- Audition / Preview ---

  testMidiNote(track: 'lead' | 'chord') {
    return this.outputRouter.testMidiNote(track)
  }

  previewNote(pitch: string, duration = '8n', velocity = 0.8): void {
    this.previews.previewNote(pitch, duration, velocity)
  }

  previewChord(notes: string[], duration = '2n', velocity = 0.7): void {
    this.previews.previewChord(notes, duration, velocity)
  }

  auditionNotes(notes: AppNote[], bpm: number, onFinish?: () => void, options?: NotesAuditionOptions): void {
    this.previews.auditionNotes(notes, bpm, onFinish, options)
  }

  stopNotesAudition(): void {
    this.previews.stopNotesAudition()
  }

  previewProgression(
    chords: ChordEvent[],
    bpm: number,
    onChordChangeOrFinish?: ((chordId: string | null) => void) | (() => void),
    maybeFinish?: () => void
  ): void {
    this.previews.previewProgression(chords, bpm, onChordChangeOrFinish, maybeFinish)
  }

  stopProgressionPreview(): void {
    this.previews.stopProgressionPreview()
  }

  previewRhythm(
    pattern: CustomRhythmPattern,
    bpm: number,
    onStep: (step: number) => void,
    onFinished: () => void
  ): Promise<boolean> {
    this.rhythmPreview ??= new RhythmPreviewController(this.effectsRack)
    return this.rhythmPreview.start(
      pattern,
      bpm,
      { transportRunning: Tone.getTransport().state === 'started' },
      onStep,
      onFinished
    )
  }

  stopRhythmPreview(): void {
    this.rhythmPreview?.stop()
  }

  // --- Playhead & Time Queries ---

  getCurrentTimeSeconds(): number {
    return getAudibleTransportSeconds()
  }

  /** Fixed latency of the always-on final output protection stage and audio hardware in seconds. */
  getOutputLatencySeconds(): number {
    const rackLatency = this.effectsRack.getOutputLatencySeconds()
    let hardwareLatency = 0
    try {
      const rawCtx = Tone.getContext().rawContext as AudioContext | undefined
      if (rawCtx) {
        hardwareLatency = (rawCtx.outputLatency ?? 0) + (rawCtx.baseLatency ?? 0)
      }
    } catch {
      // Ignore in non-browser or mock environments
    }
    return rackLatency + hardwareLatency
  }

  /**
   * Continuous playhead position on the project step grid (fractional steps), never quantized —
   * the sole time source for smooth rendering.
   *
   * - While the transport runs the position is latency-compensated and folded into
   *   `[loopStartStep, loopEndStep)` (or clamped to the project length when looping is off). The
   *   open loop end wraps straight onto the loop start, so the cursor never rests on the loop end.
   * - An in-flight seek reports its target until the clock lands on it, so the cursor reflects the
   *   jump immediately and never carries the old loop-wrap state.
   * - Right after a resume the cursor holds the step playback restarted from until the compensated
   *   clock has advanced past the latency window, keeping the resume continuous.
   * - While paused or stopped it reports the resting musical position without latency compensation,
   *   so pause and stop land exactly on the position the transport holds.
   */
  getPlayheadStep(bpm: number): number {
    const stepSeconds = getStepDurationSeconds(bpm, '16n')
    if (stepSeconds <= 0) return 0

    if (Tone.getTransport().state !== 'started') {
      return this.resolveRestingStep(stepSeconds)
    }

    const anchor = this.currentSeekAnchor()
    if (anchor !== null) return anchor

    const resumeHold = this.currentResumeHold()
    if (resumeHold !== null) return resumeHold

    return resolvePlayheadStep(
      this.getCurrentTimeSeconds(),
      stepSeconds,
      this.getOutputLatencySeconds(),
      this.playheadBounds,
      true
    )
  }

  /** Whole-step index of the continuous playhead, floored to the enclosing sixteenth. */
  getCurrentStep(bpm: number): number {
    if (getStepDurationSeconds(bpm, '16n') <= 0) return 0
    return Math.floor(this.getPlayheadStep(bpm))
  }

  /** Starts the resume hold at the step the transport is beginning from. */
  private beginResumeHold(): void {
    const latencySeconds = this.getOutputLatencySeconds()
    if (latencySeconds <= 0) {
      this.resumeHold = null
      return
    }
    const stepSeconds = getStepDurationSeconds(this.currentBpm, '16n')
    const startStep = this.restingStep ?? transportSecondsToPlayheadStep(this.getCurrentTimeSeconds(), stepSeconds, 0)
    this.resumeHold = { step: startStep, startSeconds: this.getCurrentTimeSeconds(), latencySeconds }
  }

  /**
   * Pins the cursor to the resume step until the transport has advanced a full latency past the
   * origin, at which point the compensated clock and the held value coincide and the hold drops.
   */
  private currentResumeHold(): number | null {
    const hold = this.resumeHold
    if (!hold) return null
    const elapsed = this.getCurrentTimeSeconds() - hold.startSeconds
    if (elapsed >= hold.latencySeconds || elapsed < 0) {
      this.resumeHold = null
      return null
    }
    return foldPlayheadStep(hold.step, this.playheadBounds, 0)
  }

  /**
   * Resting position while paused or stopped: prefer the step requested by the last seek/stop,
   * otherwise derive it from the (uncompensated) transport clock. Only the project length
   * constrains it — a stop to Bar 1 stays at step 0 even when a loop is enabled.
   */
  private resolveRestingStep(stepSeconds: number): number {
    const raw = this.restingStep ?? transportSecondsToPlayheadStep(this.getCurrentTimeSeconds(), stepSeconds, 0)
    return clampToProjectStep(raw, this.playheadBounds)
  }

  // --- Preset Selection ---

  setLeadPreset(preset: LeadPreset | SynthPatch): void {
    this.synths.setLeadPreset(preset, typeof window !== 'undefined' && !this.isDisposed)
  }

  setChordPreset(preset: ChordPreset | SynthPatch): void {
    this.synths.setChordPreset(preset, typeof window !== 'undefined' && !this.isDisposed)
  }

  // --- Disposal ---

  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    ++this.startOperation
    this.midiLifecycle.dispose()
    this.previews.dispose()
    this.rhythmPreview?.dispose()
    for (const timer of this.expiryTimers) clearTimeout(timer)
    this.expiryTimers.clear()
    this.generations.releaseAll()
    this.clearScheduledEvents()
    this.synths.dispose()
    this.effectsRack.dispose()
  }
}
