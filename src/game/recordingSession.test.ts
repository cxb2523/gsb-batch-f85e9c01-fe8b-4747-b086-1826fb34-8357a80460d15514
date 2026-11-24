import { describe, expect, it } from "vitest";
import { RecordingSession } from "./recordingSession";

describe("RecordingSession", () => {
  it("resets the tape and clock when a flight begins", () => {
    const session = new RecordingSession();
    session.beginFlight(1000);
    session.recordEdge(1100, true);
    session.recordEdge(1250, false);
    expect(session.flightRecording()).toEqual([
      [0, false],
      [100, true],
      [250, false],
    ]);

    // Starting another playable flight re-establishes the origin and initial
    // event, discarding the previous flight's events.
    session.beginFlight(5000);
    expect(session.isRecording()).toBe(true);
    expect(session.flightRecording()).toEqual([[0, false]]);

    // The new timeline is measured from the new origin, not the old clock.
    session.recordEdge(5120, true);
    expect(session.flightRecording()).toEqual([
      [0, false],
      [120, true],
    ]);
  });

  it("keeps events from separate levels on separate timelines and stitches them for submission", () => {
    const session = new RecordingSession();

    // Level 1 flight.
    session.beginFlight(0);
    session.recordEdge(100, true);
    session.recordEdge(200, false);
    session.endFlight();
    expect(session.isRecording()).toBe(false);
    const levelOne = session.runRecording();
    expect(levelOne).toEqual([
      [0, false],
      [100, true],
      [200, false],
    ]);

    // Level 2 flight starts from a clean, zero-based tape: no level-1 edges.
    session.beginFlight(10_000);
    expect(session.flightRecording()).toEqual([[0, false]]);
    session.recordEdge(10_300, true);
    session.recordEdge(10_500, false);
    session.endFlight();

    // The submitted run contains both levels: level-2 timestamps continue
    // after level 1's last edge, with the shared down-state seam collapsed so
    // no duplicate edge survives and no level-1 event leaks into flight 2.
    expect(session.runRecording()).toEqual([
      [0, false],
      [100, true],
      [200, false],
      [500, true],
      [700, false],
    ]);
  });

  it("freezes the recording on game over and only submits the finished run", () => {
    const session = new RecordingSession();
    session.beginFlight(0);
    session.recordEdge(100, true);
    session.endFlight();

    // After game over the tape is frozen: further edges are ignored.
    session.recordEdge(9999, true);
    const submitted = session.runRecording();
    expect(submitted).toEqual([
      [0, false],
      [100, true],
    ]);

    // A restart starts a brand-new run; nothing from the previous run survives.
    session.reset();
    expect(session.runRecording()).toEqual([]);
    expect(session.flightRecording()).toEqual([]);
    expect(session.isRecording()).toBe(false);

    session.beginFlight(7_000);
    session.recordEdge(7_050, true);
    session.endFlight();
    expect(session.runRecording()).toEqual([
      [0, false],
      [50, true],
    ]);
  });

  it("returns the timeline to zero after a restart within a session object", () => {
    const session = new RecordingSession();

    session.beginFlight(1_000);
    session.recordEdge(1_400, true);
    session.endFlight();
    expect(session.runRecording()).toEqual([
      [0, false],
      [400, true],
    ]);

    session.reset();
    session.beginFlight(2_000);
    // Local origin is zero again even though wall-clock time moved forward.
    expect(session.flightRecording()).toEqual([[0, false]]);
    session.recordEdge(2_100, false); // no edge: value unchanged
    session.recordEdge(2_200, true);
    expect(session.flightRecording()).toEqual([
      [0, false],
      [200, true],
    ]);
  });

  it("ignores edges when no flight is active", () => {
    const session = new RecordingSession();
    session.recordEdge(100, true);
    expect(session.flightRecording()).toEqual([]);
    expect(session.runRecording()).toEqual([]);
  });

  it("does not append a redundant leading edge when stitching flights", () => {
    const session = new RecordingSession();
    session.beginFlight(0);
    session.recordEdge(100, true);
    session.endFlight(); // run ends on `true` at t=100

    session.beginFlight(500);
    session.recordEdge(600, false);
    session.endFlight(); // local [0, true] is dropped as a duplicate seam

    expect(session.runRecording()).toEqual([
      [0, false],
      [100, true],
      [100, false],
    ]);
  });
});
