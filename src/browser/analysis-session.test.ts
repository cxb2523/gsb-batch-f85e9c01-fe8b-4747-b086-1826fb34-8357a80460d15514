import { describe, it, expect } from 'vitest';
import { AnalysisSession } from './analysis-session.js';
import { AudioBuffer } from '../core/buffer.js';
import { generateSine } from '../core/generators.js';
import { analyzeAudio } from '../analysis.js';
import { serializeAnalysis } from '../io/analysis-export.js';

function makeAudio(numSamples = 4000, sampleRate = 8000): AudioBuffer {
  return generateSine(sampleRate, numSamples / sampleRate, 1000);
}

describe('AnalysisSession', () => {
  it('builds an initial analysis whose frames and spectra share one size', () => {
    const audio = makeAudio();
    const session = new AnalysisSession(audio, { fftSize: 256, window: 'hann' });
    expect(session.fftSize).toBe(256);
    expect(session.analysis.fftSize).toBe(256);
    const bins = 256 / 2 + 1;
    expect(session.analysis.frequencies).toHaveLength(bins);
    for (const frame of session.analysis.frames) {
      expect(frame.magnitude).toHaveLength(bins);
      expect(frame.decibels).toHaveLength(bins);
    }
    for (const column of session.spectrogramColumns()) expect(column).toHaveLength(bins);
  });

  it('switches FFT size so every frame spectrum matches the new size', () => {
    const audio = makeAudio();
    const session = new AnalysisSession(audio, { fftSize: 256 });
    const oldBins = 256 / 2 + 1;
    expect(session.currentSpectrum()).toHaveLength(oldBins);

    session.update({ fftSize: 1024 });
    expect(session.fftSize).toBe(1024);
    expect(session.analysis.fftSize).toBe(1024);
    const newBins = 1024 / 2 + 1;
    expect(session.analysis.frequencies).toHaveLength(newBins);
    // Same frame index, new length: waveform data is unchanged while the
    // spectrum and spectrogram follow the new FFT size.
    expect(session.currentSpectrum()).toHaveLength(newBins);
    for (const frame of session.analysis.frames) {
      expect(frame.magnitude).toHaveLength(newBins);
      expect(frame.decibels).toHaveLength(newBins);
    }
    for (const column of session.spectrogramColumns()) expect(column).toHaveLength(newBins);

    // And back down again.
    session.update({ fftSize: 512 });
    const midBins = 512 / 2 + 1;
    expect(session.currentSpectrum()).toHaveLength(midBins);
    expect(session.spectrogramColumns().every((column) => column.length === midBins)).toBe(true);
  });

  it('matches a fresh analysis computed directly with the same parameters', () => {
    const audio = makeAudio();
    const session = new AnalysisSession(audio, { fftSize: 256 });
    session.update({ fftSize: 2048, window: 'blackman' });
    const direct = analyzeAudio(audio, {
      fftSize: 2048,
      hopSize: session.hopSize,
      window: 'blackman',
    });
    expect(session.analysis.frames.length).toBe(direct.frames.length);
    expect(session.analysis.fftSize).toBe(direct.fftSize);
    expect(Array.from(session.analysis.frequencies)).toEqual(Array.from(direct.frequencies));
    for (const [index, frame] of session.analysis.frames.entries()) {
      expect(Array.from(frame.decibels)).toEqual(Array.from(direct.frames[index]!.decibels));
    }
  });

  it('rejects illegal parameters and keeps the previous usable state', () => {
    const audio = makeAudio();
    const session = new AnalysisSession(audio, { fftSize: 256 });
    const before = session.analysis;
    const beforeBins = 256 / 2 + 1;
    expect(() => session.update({ fftSize: 300 })).toThrow(); // not a power of two
    expect(session.fftSize).toBe(256);
    expect(session.analysis).toBe(before);
    expect(session.analysis.fftSize).toBe(256);
    expect(session.currentSpectrum()).toHaveLength(beforeBins);
    expect(session.spectrogramColumns().every((column) => column.length === beforeBins)).toBe(true);
  });

  it('preserves all old data when a rebuild fails, then recovers on retry', () => {
    const session = new AnalysisSession(makeAudio(8000), { fftSize: 256, window: 'hann' });
    const oldAnalysis = session.analysis;
    const oldColumns = session.spectrogramColumns().map((column) => Array.from(column));
    const oldJson = session.exportJson();

    // A one-sample hop at a large FFT size exceeds the analysis cell budget
    // (frameCount * bins > 2^22), so analyzeAudio throws. The session must
    // build the candidate fully before swapping: nothing visible may change.
    expect(() => session.update({ fftSize: 2048, hopSize: 1 })).toThrow(/too large/);
    expect(session.analysis).toBe(oldAnalysis);
    expect(session.frameCount).toBe(oldAnalysis.frames.length);
    expect(session.fftSize).toBe(256);
    expect(session.exportJson()).toBe(oldJson);
    for (const [index, column] of session.spectrogramColumns().entries())
      expect(Array.from(column)).toEqual(oldColumns[index]);

    // A valid retry still works and installs a coherent new snapshot.
    session.update({ fftSize: 512 });
    expect(session.fftSize).toBe(512);
    expect(session.analysis.fftSize).toBe(512);
    expect(session.currentSpectrum()).toHaveLength(512 / 2 + 1);
  });

  it('leaves the recording and snapshot untouched when setAudio cannot rebuild', () => {
    const short = makeAudio();
    const session = new AnalysisSession(short, { fftSize: 2048, hopSize: 1 });
    const before = session.analysis;
    // On the longer recording the pinned hop breaches the cell budget.
    expect(() => session.setAudio(makeAudio(8000))).toThrow(/too large/);
    expect(session.analysis).toBe(before);
    expect(session.analysis.numSamples).toBe(short.numSamples);
    expect(session.currentSpectrum()).toHaveLength(2048 / 2 + 1);
    expect(session.spectrogramColumns().every((column) => column.length === 2048 / 2 + 1)).toBe(
      true,
    );
  });

  it('never mixes sizes inside one snapshot during rapid parameter changes', () => {
    const audio = makeAudio();
    const session = new AnalysisSession(audio, { fftSize: 256 });
    for (const fftSize of [512, 1024, 2048, 4096, 1024, 512, 256]) {
      session.update({ fftSize });
      const bins = fftSize / 2 + 1;
      expect(session.analysis.fftSize).toBe(fftSize);
      expect(session.analysis.frequencies.length).toBe(bins);
      expect(session.frameCount).toBe(session.analysis.frames.length);
      for (const frame of session.analysis.frames) {
        expect(frame.magnitude.length).toBe(bins);
        expect(frame.decibels.length).toBe(bins);
      }
      for (const column of session.spectrogramColumns()) expect(column.length).toBe(bins);
    }
  });

  it('exports JSON describing exactly the current session parameters', () => {
    const audio = makeAudio();
    const session = new AnalysisSession(audio, { fftSize: 256 });
    session.update({ fftSize: 2048, window: 'hamming' });
    const parsed = JSON.parse(session.exportJson());
    expect(parsed.fftSize).toBe(2048);
    expect(parsed.window).toBe('hamming');
    expect(parsed.hopSize).toBe(session.hopSize);
    expect(parsed.frames).toHaveLength(session.frameCount);
    for (const frame of parsed.frames) expect(frame.decibels).toHaveLength(2048 / 2 + 1);
    // Identical to serializing the live analysis directly.
    expect(session.exportJson()).toBe(serializeAnalysis(session.analysis));
  });

  it('clamps the selected frame index after a rebuild shrinks the frame list', () => {
    const audio = makeAudio(2000);
    const session = new AnalysisSession(audio, { fftSize: 64, hopSize: 64 });
    const last = session.frameCount - 1;
    session.setFrameIndex(last);
    expect(session.currentFrameIndex).toBe(last);
    // A much larger hop produces fewer frames; the index must be clamped.
    session.update({ fftSize: 64, hopSize: 512 });
    expect(session.currentFrameIndex).toBeLessThanOrEqual(session.frameCount - 1);
    expect(session.currentSpectrum()).toBe(
      session.analysis.frames[session.currentFrameIndex]!.decibels,
    );
  });

  it('rebuilds with current parameters when the recording changes', () => {
    const session = new AnalysisSession(makeAudio(4000), { fftSize: 256 });
    expect(session.fftSize).toBe(256);
    session.setAudio(makeAudio(1200));
    expect(session.fftSize).toBe(256);
    expect(session.analysis.numSamples).toBe(1200);
    expect(session.currentFrameIndex).toBe(0);
    const bins = 256 / 2 + 1;
    for (const frame of session.analysis.frames) expect(frame.decibels).toHaveLength(bins);
  });

  it('applies parameter overrides atomically when swapping the recording', () => {
    const session = new AnalysisSession(makeAudio(4000), { fftSize: 256 });
    session.setAudio(makeAudio(1200), { fftSize: 1024, window: 'blackman' });
    expect(session.fftSize).toBe(1024);
    expect(session.window).toBe('blackman');
    expect(session.analysis.numSamples).toBe(1200);
    expect(session.analysis.fftSize).toBe(1024);
    expect(session.currentSpectrum()).toHaveLength(1024 / 2 + 1);
    expect(session.spectrogramColumns().every((column) => column.length === 1024 / 2 + 1)).toBe(
      true,
    );
  });
});
