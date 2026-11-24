import {
  appendEvent,
  mergeRecording,
  type Recording,
} from "./recording";

/**
 * Owns the recording lifecycle for one game run (title → play → game over).
 *
 * A run can span several playable flights: one per level, plus a fresh first
 * flight when the player restarts after game over. Each flight gets its own
 * tape whose timestamps start at zero, so events from an earlier level can
 * never leak into the next one. Finished flights are stitched into a single
 * run-level tape that is what eventually gets submitted.
 */
export class RecordingSession {
  /** Tape of the flight currently being played, with a local t=0 origin. */
  private flight: Recording = [];
  /** Accumulator of every finished flight within the current run. */
  private run: Recording = [];
  /** Wall-clock origin of the active flight; null while no flight is live. */
  private start: number | null = null;

  /** Begin a new playable flight, resetting the local tape and clock. */
  beginFlight(now: number): void {
    // Defensive: finish any flight that was never explicitly closed.
    this.endFlight();
    this.start = now;
    this.flight = [[0, false]];
  }

  /** Record a playerUp edge on the active flight's local timeline. */
  recordEdge(now: number, up: boolean): void {
    if (this.start === null) return;
    this.flight = appendEvent(this.flight, now - this.start, up);
  }

  /**
   * Close the active flight (level cleared or crash) and fold its tape into the
   * run-level recording. The frozen run tape keeps accepting no further edges
   * until the next flight begins.
   */
  endFlight(): void {
    if (this.start === null) return;
    const finished = this.flight;
    this.run = mergeRecording(this.run, finished);
    this.flight = [];
    this.start = null;
  }

  /** Drop every tape. Used when a brand-new run starts. */
  reset(): void {
    this.flight = [];
    this.run = [];
    this.start = null;
  }

  /** Whether a flight is currently recording. */
  isRecording(): boolean {
    return this.start !== null;
  }

  /** The active flight's tape (local timeline, starts at t=0). */
  flightRecording(): Recording {
    return this.flight;
  }

  /** The complete run built from its finished flights. */
  runRecording(): Recording {
    return this.start === null ? this.run : mergeRecording(this.run, this.flight);
  }
}
