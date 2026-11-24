import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { Ghost } from "./Ghost";
import type { Recording } from "../game/recording";

const recording: Recording = [
  [0, false],
  [100, true],
  [400, false],
];

type RafQueue = {
  callbacks: Map<number, FrameRequestCallback>;
  nextId: number;
  cancelled: number[];
};

describe("Ghost", () => {
  let queue: RafQueue;
  let clock: number;

  beforeEach(() => {
    queue = { callbacks: new Map(), nextId: 1, cancelled: [] };
    clock = 0;

    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
      (cb: FrameRequestCallback) => {
        const id = queue.nextId++;
        queue.callbacks.set(id, cb);
        return id;
      },
    );
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(
      (id: number) => {
        queue.callbacks.delete(id);
        queue.cancelled.push(id);
      },
    );
    vi.spyOn(performance, "now").mockImplementation(() => clock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const flushFrames = (ticks: number[]) => {
    act(() => {
      for (const t of ticks) {
        clock = t;
        const callbacks = [...queue.callbacks.values()];
        queue.callbacks.clear();
        for (const cb of callbacks) cb(clock);
      }
    });
  };

  it("renders nothing while the live game is not playing", () => {
    const { container } = render(
      <Ghost
        recording={recording}
        runId="run-1:1"
        active={false}
        windowHeight={800}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(queue.callbacks.size).toBe(0);
  });

  it("replays the recording on the run's local timeline while active", () => {
    const { container } = render(
      <Ghost
        recording={recording}
        runId="run-1:1"
        active
        windowHeight={800}
      />,
    );

    // First frame at the origin: the leading edge says down.
    flushFrames([0]);
    expect(container.firstChild).not.toBeNull();
    const el = container.firstChild as HTMLElement;
    expect(el.style.transform).toContain("1600px"); // windowHeight * 2 (down)

    // t=150: past the [100, true] edge, the ghost moves up.
    flushFrames([150]);
    expect(el.style.transform).toContain("-800px"); // windowHeight * -1 (up)

    // t=500: past the [400, false] edge, back down.
    flushFrames([500]);
    expect(el.style.transform).toContain("1600px");
  });

  it("stops the replay clock and leaves no frame loop when play is interrupted", () => {
    const { rerender } = render(
      <Ghost
        recording={recording}
        runId="run-1:1"
        active
        windowHeight={800}
      />,
    );
    flushFrames([150]);
    // The frame scheduled by the latest flush is the one still looping.
    const loopId = queue.nextId - 1;
    expect(queue.callbacks.has(loopId)).toBe(true);

    act(() => {
      rerender(
        <Ghost
          recording={recording}
          runId="run-1:1"
          active={false}
          windowHeight={800}
        />,
      );
    });

    expect(queue.cancelled).toContain(loopId);
    expect(queue.callbacks.size).toBe(0);
  });

  it("restarts the replay from t=0 for the next flight with no residual progress", () => {
    const { container, rerender } = render(
      <Ghost
        recording={recording}
        runId="run-1:1"
        active
        windowHeight={800}
      />,
    );
    // Advance deep into the previous flight's timeline.
    flushFrames([150]);
    const firstEl = container.firstChild as HTMLElement;
    expect(firstEl.style.transform).toContain("-800px");

    // Level transition / restart deactivates the ghost...
    act(() => {
      rerender(
        <Ghost
          recording={recording}
          runId="run-1:1"
          active={false}
          windowHeight={800}
        />,
      );
    });
    // ...and the next flight starts a fresh replay identity at t=0.
    clock = 9_999; // wall clock moved on; the replay clock must ignore that.
    act(() => {
      rerender(
        <Ghost
          recording={recording}
          runId="run-1:2"
          active
          windowHeight={800}
        />,
      );
    });

    flushFrames([9_999]); // elapsed relative to the new origin is 0
    const nextEl = container.firstChild as HTMLElement;
    // First edge of the fresh tape is [0, false] → down, not the old up state.
    expect(nextEl.style.transform).toContain("1600px");
  });
});
