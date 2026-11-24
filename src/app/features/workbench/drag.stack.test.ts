// Stack-gather lifecycle tests for the hand-rolled pointer drag engine.
//
// The vitest environment is node (no DOM/React renderer), so we fabricate just enough of
// window/document/rAF and a local canvas store + TilePose set to drive the REAL exported
// press entry points and window pointer listeners. `actions.ts` is replaced with spies so a
// release's merge uid-list can be asserted exactly without network/game side effects.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { ElementId } from "../../../shared/api.ts";
import { useCanvas } from "../../state/canvas.ts";
import { layoutEls } from "./layout.ts";
import { held, poses, TilePose } from "./poses.ts";
import { springConfig } from "../../lib/spring.ts";
import { pressCanvasTile, pressLibraryTile, useDrag } from "./drag.ts";

vi.mock("./actions.ts", () => ({
  collapseShelf: vi.fn(),
  dropNewTile: vi.fn((): string | null => "lib-new-uid"),
  mergeTiles: vi.fn(),
  removeTile: vi.fn(),
  spawnElement: vi.fn(),
  tapTile: vi.fn(),
}));

import { dropNewTile, mergeTiles, removeTile } from "./actions.ts";

// ------------------------------------------------------------------ fake browser

type Handler = (event: any) => void;

const winListeners = new Map<string, Set<Handler>>();

const CANVAS_RECT = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} };
const LIBRARY_RECT = { left: 0, top: 600, right: 400, bottom: 700, width: 400, height: 100, x: 0, y: 600, toJSON() {} };

function makeEl(rect: DOMRect | (typeof CANVAS_RECT) = CANVAS_RECT) {
  const attrs = new Map<string, string>();
  return {
    style: { setProperty: vi.fn() } as unknown as CSSStyleDeclaration,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    getAttribute: (k: string) => attrs.get(k) ?? null,
    removeAttribute: (k: string) => void attrs.delete(k),
    hasAttribute: (k: string) => attrs.has(k),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getBoundingClientRect: () => rect,
    click: vi.fn(),
    focus: vi.fn(),
  } as unknown as HTMLElement;
}

const fakeWindow = {
  addEventListener(type: string, handler: Handler) {
    if (!winListeners.has(type)) winListeners.set(type, new Set());
    winListeners.get(type)!.add(handler);
  },
  removeEventListener(type: string, handler: Handler) {
    winListeners.get(type)?.delete(handler);
  },
  dispatchEvent: () => true,
  innerWidth: 1280,
  innerHeight: 900,
};

const fakeDocument = {
  body: { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), appendChild: vi.fn() },
  documentElement: {},
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  createElement: () => makeEl(),
};

const rafQueue = new Map<number, FrameRequestCallback>();
let rafSeq = 1;

const clock = { now: 4_000_000 };
let nowSpy: MockInstance | undefined;

function installGlobals() {
  (globalThis as any).window = fakeWindow;
  (globalThis as any).document = fakeDocument;
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = rafSeq++;
    rafQueue.set(id, cb);
    return id;
  };
  (globalThis as any).cancelAnimationFrame = (id: number): void => {
    rafQueue.delete(id);
  };
}

const savedGlobals = {
  window: (globalThis as any).window,
  document: (globalThis as any).document,
  raf: globalThis.requestAnimationFrame,
  caf: globalThis.cancelAnimationFrame,
};

function flushFrames(): void {
  let guard = 0;
  while (rafQueue.size > 0 && guard++ < 100) {
    const cbs = [...rafQueue.values()];
    rafQueue.clear();
    for (const cb of cbs) cb(clock.now);
  }
}

function dispatch(type: string, event: Record<string, unknown> = {}): void {
  for (const handler of [...(winListeners.get(type) ?? [])]) handler(event);
}

// ------------------------------------------------------------------ local canvas state

const T = 76;

interface Seeded {
  uids: string[];
  els: Record<string, HTMLElement>;
}

/** Coordinates lay tiles out in a horizontal row at y=300, 200 px apart. */
function seedCanvas(xs: number[] = [200, 400, 600, 800]): Seeded {
  held.clear();
  poses.clear();
  const tiles = xs.map((x, i) => ({ uid: `u${i}`, elementId: `e${i}` as ElementId, x, y: 300, z: i + 1 }));
  useCanvas.setState({
    tiles: tiles as any,
    T,
    bounds: { x: 0, y: 0, w: 1000, h: 800 } as any,
  });
  const els: Record<string, HTMLElement> = {};
  for (const t of tiles) {
    const el = makeEl();
    els[t.uid] = el;
    const pose = new TilePose({ x: t.x, y: t.y }, T);
    pose.attach(el);
    poses.set(t.uid, pose);
  }
  layoutEls.canvas = { getBoundingClientRect: () => CANVAS_RECT } as unknown as HTMLElement;
  layoutEls.library = null;
  return { uids: tiles.map((t) => t.uid), els };
}

function pointerEvent(over: Record<string, unknown> = {}) {
  return {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    isPrimary: true,
    clientX: 0,
    clientY: 0,
    shiftKey: false,
    ...over,
  } as any;
}

/** Press a canvas tile at its centre and move a few px to activate the drag. */
function startCanvas(uid: string, pointerType: "mouse" | "touch" = "mouse"): void {
  const tile = useCanvas.getState().tiles.find((t) => t.uid === uid)!;
  pressCanvasTile(
    pointerEvent({ pointerType, clientX: tile.x, clientY: tile.y, currentTarget: poses.get(uid)?.el }),
    uid,
  );
  moveTo(tile.x + 6, tile.y, 16);
}

function startLibrary(elementId = "lib-fire", pointerType: "mouse" | "touch" = "mouse"): HTMLElement {
  const libEl = makeEl({ left: 120, top: 620, right: 196, bottom: 696, width: 76, height: 76, x: 120, y: 620, toJSON() {} } as DOMRect);
  pressLibraryTile(
    pointerEvent({ pointerType, clientX: 158, clientY: 658, currentTarget: libEl }),
    elementId as ElementId,
    "shelf-y",
  );
  moveTo(166, 658, 16); // > slop (4 for a non-canvas mouse press)
  return libEl;
}

function moveTo(clientX: number, clientY: number, dt = 16): void {
  clock.now += dt;
  dispatch("pointermove", pointerEvent({ clientX, clientY }));
  flushFrames();
}

/**
 * Move onto a tile and hold the pointer still until the engine's gather timer fires and
 * `expectedStack` is reached. Stationary ticks both advance the 450 ms dwell and decay the
 * speed EMA under the gather threshold.
 */
function gatherHere(clientX: number, clientY: number, expectedStack: number): void {
  moveTo(clientX, clientY, 16);
  for (let i = 0; i < 30 && useDrag.getState().stack < expectedStack; i++) moveTo(clientX, clientY, 50);
  expect(useDrag.getState().stack).toBe(expectedStack);
}

function releaseAt(clientX: number, clientY: number, type: "pointerup" | "pointercancel" = "pointerup", pointerType = "mouse"): void {
  clock.now += 16;
  dispatch(type, pointerEvent({ pointerType, clientX, clientY }));
  flushFrames();
}

function escape(): void {
  dispatch("keydown", { key: "Escape" });
  flushFrames();
}

const mergeUids = (call = 0): string[] => {
  const arg = vi.mocked(mergeTiles).mock.calls[call]?.[0];
  return (arg ?? []) as string[];
};

// ------------------------------------------------------------------ setup/teardown

beforeAll(() => {
  installGlobals();
  nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock.now);
});

afterAll(() => {
  nowSpy?.mockRestore();
  (globalThis as any).window = savedGlobals.window;
  (globalThis as any).document = savedGlobals.document;
  globalThis.requestAnimationFrame = savedGlobals.raf;
  globalThis.cancelAnimationFrame = savedGlobals.caf;
});

afterEach(() => {
  // Best-effort teardown of any session a failing assertion left live (clears its hold timer).
  try {
    dispatch("keydown", { key: "Escape" });
    dispatch("pointercancel", pointerEvent({ pointerType: "mouse" }));
  } catch {
    /* no live session */
  }
});

beforeEach(() => {
  clock.now = 4_000_000 + Math.floor(Math.random() * 100000);
  winListeners.clear();
  rafQueue.clear();
  held.clear();
  poses.clear();
  useDrag.setState({ ghost: null, source: null, stack: 1 });
  useCanvas.setState({ tiles: [], T, bounds: null });
  layoutEls.canvas = null;
  layoutEls.library = null;
  springConfig.reduced = true; // springs jump to targets so pose assertions are synchronous
  vi.clearAllMocks();
  vi.mocked(dropNewTile).mockImplementation(() => "lib-new-uid");
});

// ------------------------------------------------------------------ tests

describe("stack gathering", () => {
  it("locks, collects and counts gathered tiles, then excludes them from re-targeting", () => {
    const { els } = seedCanvas();
    startCanvas("u0");

    gatherHere(400, 300, 2); // collect u1

    expect([...held].sort()).toEqual(["u0", "u1"]);
    expect(useDrag.getState().stack).toBe(2);

    // Badge DOM stays in sync with the store count.
    const sourceEl = els.u0!;
    expect(sourceEl.getAttribute("data-stack")).toBe("2");
    expect((sourceEl.style.setProperty as unknown as MockInstance).mock.calls).toContainEqual(["--stack", '"2"']);

    // The gathered tile is absorbed visually.
    const p1 = poses.get("u1")!;
    expect(p1.s.value).toBeCloseTo(0.7);
    expect(p1.o.value).toBeCloseTo(0);

    // Return over the already-gathered tile and dwell: it must not re-lock/re-gather.
    moveTo(200, 300);
    gatherHere(400, 300, 2);
    expect(useDrag.getState().stack).toBe(2);
    expect(els.u1!.hasAttribute("data-target")).toBe(false);
    expect(mergeTiles).not.toHaveBeenCalled();
  });

  it("collects at most four materials (source + three gathered)", () => {
    seedCanvas([200, 400, 600, 800]);
    startCanvas("u0");
    gatherHere(400, 300, 2); // u1
    gatherHere(600, 300, 3); // u2
    gatherHere(800, 300, 4); // u3

    expect(useDrag.getState().stack).toBe(4);
    expect(held.size).toBe(4);

    // A fourth gathered tile is never added: dwelling on another candidate changes nothing.
    gatherHere(800, 300, 4);
    expect(useDrag.getState().stack).toBe(4);
  });
});

describe("normal release -> combine", () => {
  it("merges canvas source + gathered stack exactly once with unique uids", () => {
    seedCanvas();
    startCanvas("u0");
    gatherHere(400, 300, 2);

    releaseAt(400, 300);

    expect(mergeTiles).toHaveBeenCalledTimes(1);
    expect(mergeUids()).toEqual(["u0", "u1"]);
    expect(new Set(mergeUids()).size).toBe(mergeUids().length);
    expect(held.size).toBe(0);
    expect(useDrag.getState().stack).toBe(1);
    expect(useDrag.getState().ghost).toBeNull();
  });

  it("appends the locked merge target once when releasing onto a third tile", () => {
    seedCanvas();
    startCanvas("u0");
    gatherHere(400, 300, 2); // u1 gathered

    // Quickly move onto u2 and release before the gather dwell elapses: u2 is the merge target.
    moveTo(600, 300, 16);
    releaseAt(600, 300);

    expect(mergeTiles).toHaveBeenCalledTimes(1);
    expect(mergeUids()).toEqual(["u0", "u1", "u2"]);
    expect(new Set(mergeUids()).size).toBe(3);
    expect(held.size).toBe(0);
  });

  it("merges a full four-tile stack once", () => {
    seedCanvas([200, 400, 600, 800]);
    startCanvas("u0");
    gatherHere(400, 300, 2);
    gatherHere(600, 300, 3);
    gatherHere(800, 300, 4);

    releaseAt(800, 300);

    expect(mergeTiles).toHaveBeenCalledTimes(1);
    expect(mergeUids()).toEqual(["u0", "u1", "u2", "u3"]);
    expect(new Set(mergeUids()).size).toBe(4);
    expect(held.size).toBe(0);
    expect(useDrag.getState().stack).toBe(1);
  });
});

describe("Escape abort", () => {
  it("returns every gathered tile to its rest pose and clears held + stack", () => {
    seedCanvas();
    startCanvas("u0");
    gatherHere(400, 300, 2);
    gatherHere(600, 300, 3);

    escape();

    expect(mergeTiles).not.toHaveBeenCalled();
    expect(held.size).toBe(0);
    expect(useDrag.getState().stack).toBe(1);
    expect(useDrag.getState().source).toBeNull();

    // Both gathered tiles restored to their static positions with scale/opacity reset.
    for (const [uid, x] of [["u1", 400], ["u2", 600]] as const) {
      const pose = poses.get(uid)!;
      const tile = useCanvas.getState().tiles.find((t) => t.uid === uid)!;
      expect(pose.x.value).toBeCloseTo(x);
      expect(pose.y.value).toBeCloseTo(300);
      expect(tile.x).toBe(x);
      expect(pose.s.value).toBeCloseTo(1);
      expect(pose.o.value).toBeCloseTo(1);
    }

    // Source tile returns to its origin and scale 1.
    const sourcePose = poses.get("u0")!;
    expect(sourcePose.x.value).toBeCloseTo(200);
    expect(sourcePose.s.value).toBeCloseTo(1);

    // Listeners are torn down: a later pointer event cannot drive the dead session.
    expect(winListeners.get("pointermove")?.size ?? 0).toBe(0);
  });
});

describe("pointercancel abort", () => {
  it.each(["mouse", "touch"] as const)("returns gathered tiles and clears held/stack (%s)", (pointerType) => {
    seedCanvas();
    startCanvas("u0", pointerType);
    gatherHere(400, 300, 2);

    releaseAt(400, 300, "pointercancel", pointerType);

    expect(mergeTiles).not.toHaveBeenCalled();
    expect(held.size).toBe(0);
    expect(useDrag.getState().stack).toBe(1);
    expect(useDrag.getState().ghost).toBeNull();

    const p1 = poses.get("u1")!;
    expect(p1.x.value).toBeCloseTo(400);
    expect(p1.y.value).toBeCloseTo(300);
    expect(p1.s.value).toBeCloseTo(1);
    expect(p1.o.value).toBeCloseTo(1);

    expect(winListeners.get("pointermove")?.size ?? 0).toBe(0);
  });
});

describe("library (ghost) source release", () => {
  it("creates one canvas uid and merges it with the gathered tile, no duplicate uids", () => {
    seedCanvas();
    startLibrary();

    // Ghost starts at (166,658); move it onto u1 at (400,300) and dwell to gather.
    gatherHere(400, 300, 2);
    expect([...held]).toEqual(["u1"]); // the library source itself is not held

    releaseAt(400, 300);

    expect(dropNewTile).toHaveBeenCalledTimes(1);
    expect(mergeTiles).toHaveBeenCalledTimes(1);
    expect(mergeUids()).toEqual(["lib-new-uid", "u1"]);
    expect(new Set(mergeUids()).size).toBe(2);
    expect(held.size).toBe(0);
    expect(useDrag.getState().ghost).toBeNull();
    expect(useDrag.getState().source).toBeNull();
    expect(useDrag.getState().stack).toBe(1);
  });

  it("merges new uid + gathered + locked target all unique", () => {
    seedCanvas();
    startLibrary();
    gatherHere(400, 300, 2); // u1
    moveTo(600, 300, 16); // lock u2, release quickly before it gathers
    releaseAt(600, 300);

    expect(mergeTiles).toHaveBeenCalledTimes(1);
    expect(mergeUids()).toEqual(["lib-new-uid", "u1", "u2"]);
    expect(new Set(mergeUids()).size).toBe(3);
    expect(held.size).toBe(0);
  });

  it("returns gathered tiles instead of stranding them when the new tile cannot be created", () => {
    seedCanvas();
    startLibrary();
    gatherHere(400, 300, 2);

    vi.mocked(dropNewTile).mockReturnValueOnce(null); // workbench full, etc.
    releaseAt(400, 300);

    expect(mergeTiles).not.toHaveBeenCalled();
    expect(held.size).toBe(0);
    const p1 = poses.get("u1")!;
    expect(p1.s.value).toBeCloseTo(1);
    expect(p1.o.value).toBeCloseTo(1);
    expect(p1.x.value).toBeCloseTo(400);
    expect(useDrag.getState().stack).toBe(1);
  });

  it("returns gathered tiles when the stack is released outside the canvas without a target", () => {
    seedCanvas();
    startCanvas("u0");
    gatherHere(400, 300, 2); // u1 gathered

    // Drag the stack outside the canvas rect (and off the library zone) and release.
    moveTo(1120, 420, 16);
    releaseAt(1120, 420);

    expect(mergeTiles).not.toHaveBeenCalled();
    expect(held.size).toBe(0);
    expect(useDrag.getState().stack).toBe(1);
    const p1 = poses.get("u1")!;
    expect(p1.s.value).toBeCloseTo(1);
    expect(p1.o.value).toBeCloseTo(1);
    expect(p1.x.value).toBeCloseTo(400);
    expect(p1.y.value).toBeCloseTo(300);
  });

  it("dropping a canvas source over the library returns gathered tiles and removes the source", () => {
    seedCanvas();
    layoutEls.library = { getBoundingClientRect: () => LIBRARY_RECT } as unknown as HTMLElement;
    startCanvas("u0");
    gatherHere(400, 300, 2);

    // Pointer over the library zone (60,650) and release.
    releaseAt(60, 650);

    expect(removeTile).toHaveBeenCalledWith("u0", true);
    expect(mergeTiles).not.toHaveBeenCalled();
    expect(held.size).toBe(0);
    const p1 = poses.get("u1")!;
    expect(p1.s.value).toBeCloseTo(1);
    expect(p1.o.value).toBeCloseTo(1);
  });
});
