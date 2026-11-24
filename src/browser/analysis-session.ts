// Browser-side analysis session.
//
// The workbench lets users change analysis parameters (FFT size, window,
// hop) while a recording is open. Frames, per-frame spectra and the
// spectrogram all derive from one AudioAnalysis, so this class rebuilds
// them together behind a single swap:
//
//   1. Validate and merge the requested parameters against the current ones.
//   2. Run the full analysis into local variables. The hop size depends on
//      the recording length, so it is resolved here rather than relying on
//      analyzeAudio's default.
//   3. Build every derived view (spectra, spectrogram columns) from the new
//      analysis while the previous snapshot stays untouched.
//   4. Commit the snapshot as one assignment.
//
// If anything throws during steps 1-3, the previous snapshot remains the
// live state and is still fully readable. No field is mutated until the
// rebuild has completely succeeded, so observers can never see a session
// that mixes old and new FFT sizes.

import { analyzeAudio, type AudioAnalysis } from '../analysis.js';
import type { AudioBuffer } from '../core/buffer.js';
import type { WindowType } from '../core/window.js';
import { serializeAnalysis } from '../io/analysis-export.js';

export interface AnalysisSessionOptions {
  fftSize?: number;
  hopSize?: number;
  window?: WindowType;
  channel?: number | 'mix';
  maxFrames?: number;
}

interface ResolvedOptions {
  fftSize: number;
  hopSize: number;
  window: WindowType;
  channel: number | 'mix';
  maxFrames: number;
}

interface AnalysisSnapshot {
  analysis: AudioAnalysis;
  /** Per-frame decibel spectra; one column per analysis frame. */
  spectra: Float32Array[];
  /** Alias of spectra kept under its workbench name for clarity. */
  spectrogram: Float32Array[];
}

export class AnalysisSession {
  private audio: AudioBuffer;
  private options: ResolvedOptions;
  /** False while the hop follows the workbench auto formula. */
  private explicitHop: boolean;
  private snapshot: AnalysisSnapshot;
  private frameIndex = 0;

  constructor(audio: AudioBuffer, options: AnalysisSessionOptions = {}) {
    this.audio = audio;
    this.explicitHop = options.hopSize !== undefined;
    this.options = AnalysisSession.resolveOptions(audio, options, this.explicitHop);
    // The initial build has no previous state to preserve; an invalid
    // constructor configuration is therefore allowed to throw.
    this.snapshot = AnalysisSession.buildSnapshot(audio, this.options);
  }

  private static resolveOptions(
    audio: AudioBuffer,
    options: AnalysisSessionOptions,
    explicitHop: boolean,
  ): ResolvedOptions {
    const fftSize = options.fftSize ?? 1024;
    // Match the workbench default: roughly 1000 frames across the
    // recording, never less than a quarter-frame hop.
    const hopSize = explicitHop
      ? (options.hopSize as number)
      : Math.max(fftSize / 4, Math.ceil(audio.numSamples / 1000));
    return {
      fftSize,
      hopSize,
      window: options.window ?? 'hann',
      channel: options.channel ?? 'mix',
      maxFrames: options.maxFrames ?? 4096,
    };
  }

  private static buildSnapshot(audio: AudioBuffer, options: ResolvedOptions): AnalysisSnapshot {
    // analyzeAudio performs all parameter validation before allocating
    // frames, so a throw here leaves every caller-held object untouched.
    const analysis = analyzeAudio(audio, { ...options });
    const spectra = analysis.frames.map((frame) => frame.decibels);
    return { analysis, spectra, spectrogram: spectra };
  }

  /**
   * Apply new analysis parameters atomically. On success the frames,
   * spectra and spectrogram all correspond to the new parameters. On
   * failure nothing changes: the previous data stays readable and the
   * error is rethrown for the caller to report.
   */
  update(changes: AnalysisSessionOptions): AudioAnalysis {
    const merged: AnalysisSessionOptions = { ...this.options, ...changes };
    const nextExplicitHop = this.explicitHop || changes.hopSize !== undefined;
    const candidate = AnalysisSession.resolveOptions(this.audio, merged, nextExplicitHop);
    // Build fully before touching any instance state.
    const next = AnalysisSession.buildSnapshot(this.audio, candidate);
    this.options = candidate;
    this.explicitHop = nextExplicitHop;
    this.snapshot = next;
    this.frameIndex = Math.min(this.frameIndex, Math.max(0, next.analysis.frames.length - 1));
    return next.analysis;
  }

  /**
   * Swap the underlying recording and rebuild with the current parameters,
   * optionally applying parameter overrides in the same atomic step.
   */
  setAudio(audio: AudioBuffer, changes: AnalysisSessionOptions = {}): AudioAnalysis {
    const nextExplicitHop = this.explicitHop || changes.hopSize !== undefined;
    const candidate = AnalysisSession.resolveOptions(
      audio,
      { ...this.options, ...changes },
      nextExplicitHop,
    );
    const next = AnalysisSession.buildSnapshot(audio, candidate);
    this.audio = audio;
    this.options = candidate;
    this.explicitHop = nextExplicitHop;
    this.snapshot = next;
    this.frameIndex = 0;
    return next.analysis;
  }

  get analysis(): AudioAnalysis {
    return this.snapshot.analysis;
  }

  get fftSize(): number {
    return this.options.fftSize;
  }

  get hopSize(): number {
    return this.options.hopSize;
  }

  get window(): WindowType {
    return this.options.window;
  }

  get parameters(): Readonly<AnalysisSessionOptions> {
    return { ...this.options };
  }

  get frameCount(): number {
    return this.snapshot.analysis.frames.length;
  }

  get currentFrameIndex(): number {
    return this.frameIndex;
  }

  setFrameIndex(index: number): number {
    const max = Math.max(0, this.snapshot.analysis.frames.length - 1);
    this.frameIndex = Math.max(0, Math.min(max, Math.trunc(index)));
    return this.frameIndex;
  }

  /** Decibel spectrum of the selected frame (empty array when no frames). */
  currentSpectrum(): Float32Array {
    return this.snapshot.analysis.frames[this.frameIndex]?.decibels ?? new Float32Array(0);
  }

  /** One decibel column per frame, all sharing the current FFT size. */
  spectrogramColumns(): readonly Float32Array[] {
    return this.snapshot.spectrogram;
  }

  /** JSON export guaranteed to describe the live session parameters. */
  exportJson(): string {
    return serializeAnalysis(this.snapshot.analysis);
  }
}
