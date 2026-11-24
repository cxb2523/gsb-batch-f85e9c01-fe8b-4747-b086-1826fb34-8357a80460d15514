import { describe, expect, it } from 'vitest';
import { PitchTrack } from '../../src/systems/audio/pitchTrack';

/** AudioParam stand-in that records every ramp target. */
class Param {
  value = 0;
  readonly targets: number[] = [];
  setTargetAtTime(value: number): unknown {
    this.targets.push(value);
    this.value = value;
    return this;
  }
  get last(): number {
    return this.targets.length ? this.targets[this.targets.length - 1] : this.value;
  }
}

const RAMP = 0.04;

describe('PitchTrack', () => {
  it('writes base × pitch when pitch changes', () => {
    const track = new PitchTrack(1);
    const freq = new Param();
    track.register(freq, 55);
    track.setPitch(2, 0, RAMP);
    expect(freq.last).toBeCloseTo(110, 6);
  });

  it('composes a subsequent base update with the current pitch', () => {
    const track = new PitchTrack(1);
    const freq = new Param();
    track.register(freq, 55);
    track.setPitch(1.5, 0, RAMP);
    expect(freq.last).toBeCloseTo(82.5, 6);
    // Engine rpm update after a pitch change keeps the pitch.
    track.setBase(freq, 110, 0.1, RAMP);
    expect(freq.last).toBeCloseTo(165, 6);
  });

  it('composes a pitch change after a base update (no independent frequencies)', () => {
    const track = new PitchTrack(1);
    const freq = new Param();
    track.register(freq, 55);
    track.setBase(freq, 137.5, 0.1, RAMP);
    expect(freq.last).toBeCloseTo(137.5, 6);
    track.setPitch(0.5, 0.2, RAMP);
    expect(freq.last).toBeCloseTo(68.75, 6);
  });

  it('valueFor reports the combined pitch-scaled frequency', () => {
    const track = new PitchTrack(1.25);
    expect(track.valueFor(100)).toBeCloseTo(125, 6);
    track.setPitch(0.8, 0, RAMP);
    expect(track.valueFor(100)).toBeCloseTo(80, 6);
  });

  it('tracks multiple params independently', () => {
    const track = new PitchTrack(1);
    const a = new Param();
    const b = new Param();
    track.register(a, 100);
    track.register(b, 200);
    track.setPitch(3, 0, RAMP);
    expect(a.last).toBeCloseTo(300, 6);
    expect(b.last).toBeCloseTo(600, 6);
    track.setBase(a, 50, 0, RAMP);
    expect(a.last).toBeCloseTo(150, 6);
    expect(b.last).toBeCloseTo(600, 6);
  });
});
