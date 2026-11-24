/** Minimal AudioParam surface used here (kept structural so tests can fake it). */
export interface PitchParam {
  value: number;
  setTargetAtTime(value: number, startTime: number, timeConstant: number): unknown;
}

/**
 * Single source of truth for pitch-scaled frequencies on a voice.
 *
 * Every frequency that should follow the voice pitch (oscillators, engine rpm-derived
 * frequencies, rotor LFOs) registers here with its *unscaled* base. `setPitch` then
 * rewrites `base × pitch` for all of them, and `setBase` updates a base while applying
 * `base × pitch` — so an engine update and a pitch change can never compute their own
 * separate frequencies: whichever runs last leaves the same combined value.
 */
export class PitchTrack {
  private current: number;
  private readonly bases = new Map<PitchParam, number>();

  constructor(pitch = 1) {
    this.current = pitch;
  }

  get pitch(): number {
    return this.current;
  }

  /** Registers (or re-registers) a frequency param with its unscaled base. */
  register(param: PitchParam, base: number): void {
    this.bases.set(param, base);
  }

  /** Multiplies every registered base by `mult` immediately. */
  setPitch(mult: number, at: number, ramp: number): void {
    this.current = mult;
    for (const [param, base] of this.bases) param.setTargetAtTime(base * mult, at, ramp);
  }

  /** Sets the unscaled base of `param` and applies `base × pitch` right away. */
  setBase(param: PitchParam, base: number, at: number, ramp: number): void {
    this.bases.set(param, base);
    param.setTargetAtTime(base * this.current, at, ramp);
  }

  /** Combined value that would be written for `base` at the current pitch. */
  valueFor(base: number): number {
    return base * this.current;
  }
}
