/**
 * Acceptance coverage for merged-building massing (task: re-plan volumes for
 * the new footprint and keep rooftop props visible / attached).
 *
 * These tests complement buildingMassing.test.ts with the exact matrix called
 * out in the task — single 1×1 lots and merged 2×2 / 4×2 rectangles for every
 * zone type — plus:
 *   - field-by-field determinism for identical inputs,
 *   - footprint sensitivity (no stale 1×1 layout after a merge),
 *   - cache-key invalidation when the structure footprint changes,
 *   - prop-to-host top alignment and roof containment,
 *   - the occlusion rule for front/taller wings and towers.
 */

import { describe, it, expect } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import {
  buildMassingPlan,
  massingSeed,
  type MassingInput,
  type MassingPlan,
  type MassingBox,
  type MassingProp,
} from './buildingMassing';
import { massingBoxFaces } from './massingGeometry';
import { normalizeFootprint, type Point } from './cubeGeometry';
import { CubeBuildingVisual } from './CubeBuildingVisual';
import type { BuildingVisualInput } from '../TileVisual';
import type { BuildingType } from '@/game/core/Building';

const TYPES: readonly BuildingType[] = ['residential', 'commercial', 'industrial'];
const DENSITIES = [0, 1, 2] as const;
const FOOTPRINTS = [
  { label: '1x1 (single)', w: 1, h: 1 },
  { label: '2x2 (merged)', w: 2, h: 2 },
  { label: '4x2 (merged row)', w: 4, h: 2 },
] as const;
const LEVELS = [1, 2, 3, 4, 5];
const SEEDS = Array.from({ length: 128 }, (_, i) => i);

function makeInput(overrides: Partial<MassingInput> = {}): MassingInput {
  return {
    type: 'residential',
    level: 3,
    density: 1,
    w: 2,
    h: 2,
    bodyHeightPx: 48,
    seed: 11,
    ...overrides,
  };
}

function boxTop(b: MassingBox): number {
  return b.baseLiftPx + b.wallHeightPx + (b.roof.kind === 'gable' ? b.roof.risePx : 0);
}

/** The unique flat box whose roof-top height equals the prop's base lift. */
function hostBox(plan: MassingPlan, prop: MassingProp): MassingBox | undefined {
  return plan.boxes.find(
    (b) => b.roof.kind === 'flat' && b.baseLiftPx + b.wallHeightPx === prop.baseLiftPx,
  );
}

// ---------------------------------------------------------------------------
// A1 — every type × footprint produces legal, non-empty boxes
// ---------------------------------------------------------------------------

describe('merged massing — legal boxes for 1x1 / 2x2 / 4x2 per type', () => {
  for (const type of TYPES) {
    for (const fp of FOOTPRINTS) {
      it(`${type} on ${fp.label} generates legal boxes`, () => {
        const plan = buildMassingPlan(
          makeInput({ type, w: fp.w, h: fp.h, level: 4, density: 1, bodyHeightPx: 56, seed: 11 }),
        );
        expect(plan.boxes.length).toBeGreaterThan(0);
        for (const b of plan.boxes) {
          expect(Number.isFinite(b.rect.x0)).toBe(true);
          expect(Number.isFinite(b.rect.y0)).toBe(true);
          expect(Number.isFinite(b.rect.x1)).toBe(true);
          expect(Number.isFinite(b.rect.y1)).toBe(true);
          // Positive extents.
          expect(b.rect.x1).toBeGreaterThan(b.rect.x0);
          expect(b.rect.y1).toBeGreaterThan(b.rect.y0);
          // Inside the declared footprint (allow floating-point slack).
          expect(b.rect.x0).toBeGreaterThanOrEqual(-1e-9);
          expect(b.rect.y0).toBeGreaterThanOrEqual(-1e-9);
          expect(b.rect.x1).toBeLessThanOrEqual(fp.w + 1e-9);
          expect(b.rect.y1).toBeLessThanOrEqual(fp.h + 1e-9);
          expect(b.baseLiftPx).toBeGreaterThanOrEqual(0);
          expect(b.wallHeightPx).toBeGreaterThan(0);
        }
      });
    }
  }

  it('holds for every level / density / seed across the matrix', () => {
    for (const type of TYPES) {
      for (const fp of FOOTPRINTS) {
        for (const level of LEVELS) {
          for (const density of DENSITIES) {
            for (const seed of SEEDS) {
              const plan = buildMassingPlan(
                makeInput({
                  type,
                  w: fp.w,
                  h: fp.h,
                  level,
                  density,
                  seed,
                  bodyHeightPx: 12 + level * 12,
                }),
              );
              expect(plan.boxes.length, `${type} ${fp.label} L${level} d${density} s${seed}`).toBeGreaterThan(0);
              for (const b of plan.boxes) {
                expect(b.rect.x1).toBeGreaterThan(b.rect.x0);
                expect(b.rect.y1).toBeGreaterThan(b.rect.y0);
                expect(b.rect.x0).toBeGreaterThanOrEqual(-1e-9);
                expect(b.rect.y0).toBeGreaterThanOrEqual(-1e-9);
                expect(b.rect.x1).toBeLessThanOrEqual(fp.w + 1e-9);
                expect(b.rect.y1).toBeLessThanOrEqual(fp.h + 1e-9);
              }
            }
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// A2 — determinism: identical inputs → field-by-field identical plans
// ---------------------------------------------------------------------------

describe('merged massing — determinism', () => {
  it('repeated calls return deeply-equal boxes, props and total height', () => {
    for (const type of TYPES) {
      for (const fp of FOOTPRINTS) {
        for (const seed of SEEDS) {
          const input = makeInput({ type, w: fp.w, h: fp.h, seed, level: 4, density: 2, bodyHeightPx: 72 });
          const a = buildMassingPlan(input);
          const b = buildMassingPlan({ ...input });
          expect(b).toEqual(a);
          // Serialised form is character-for-character identical too.
          expect(JSON.stringify(b)).toBe(JSON.stringify(a));
        }
      }
    }
  });

  it('massingSeed(buildingId) is stable for the same id', () => {
    for (const id of [1, 2, 42, 999, 2 ** 31 - 7]) {
      expect(massingSeed(id)).toBe(massingSeed(id));
      const input = makeInput({ seed: massingSeed(id), w: 2, h: 2 });
      expect(buildMassingPlan(input)).toEqual(buildMassingPlan(input));
    }
  });

  it('different building ids usually produce different merged plans', () => {
    const variants = new Set<string>();
    for (let id = 1; id <= 64; id++) {
      const plan = buildMassingPlan(makeInput({ seed: massingSeed(id), w: 2, h: 2 }));
      variants.add(JSON.stringify(plan));
    }
    // 64 sequential ids must not collapse to one silhouette.
    expect(variants.size).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------
// A1 cache half — changing footprint changes the plan and the cache key
// ---------------------------------------------------------------------------

describe('merged massing — footprint change invalidates old layout/cache', () => {
  it('plan extents grow with the new footprint instead of reusing the 1x1 layout', () => {
    for (const type of TYPES) {
      // Same id/seed/level/density — only the footprint changes, exactly the
      // merge transition 1×1 → 2×2 → 4×2.
      const p11 = buildMassingPlan(makeInput({ type, w: 1, h: 1 }));
      const p22 = buildMassingPlan(makeInput({ type, w: 2, h: 2 }));
      const p42 = buildMassingPlan(makeInput({ type, w: 4, h: 2 }));

      const maxX = (p: MassingPlan): number => Math.max(...p.boxes.map((b) => b.rect.x1));
      const maxY = (p: MassingPlan): number => Math.max(...p.boxes.map((b) => b.rect.y1));

      expect(p22).not.toEqual(p11);
      expect(p42).not.toEqual(p11);
      expect(p42).not.toEqual(p22);
      // The outer rect is `w*(1-inset)` / `h*(1-inset)` with the same seed, so
      // the reachable extents scale with the declared footprint.
      expect(maxX(p22)).toBeGreaterThan(maxX(p11) + 0.5);
      expect(maxX(p42)).toBeGreaterThan(maxX(p22) + 0.5);
      expect(maxY(p22)).toBeGreaterThan(maxY(p11) + 0.5);
      expect(maxY(p42)).toBeGreaterThan(maxY(p11) + 0.5);
    }
  });

  it('normalizeFootprint yields distinct geometry-cache tokens for 1x1 / 2x2 / 4x2', () => {
    const token = (w: number, h: number): string => {
      const cells: { x: number; y: number }[] = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.push({ x, y });
      return normalizeFootprint(cells, { x: 0, y: 0 });
    };
    const t11 = token(1, 1);
    const t22 = token(2, 2);
    const t42 = token(4, 2);
    expect(new Set([t11, t22, t42]).size).toBe(3);
    // Position-independent: the same 2×2 shape translated by (8, 3) matches.
    const shifted: { x: number; y: number }[] = [];
    for (let y = 3; y < 5; y++) for (let x = 8; x < 10; x++) shifted.push({ x, y });
    expect(normalizeFootprint(shifted, { x: 8, y: 3 })).toBe(t22);
  });

  it('CubeBuildingVisual rebuilds the cached faces context after a merge', () => {
    const visual = new CubeBuildingVisual();
    const parent = new Container();

    const visualInput = (w: number, h: number): BuildingVisualInput => {
      const footprint: { x: number; y: number }[] = [];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) footprint.push({ x, y });
      return {
        buildingId: 77,
        type: 'industrial',
        anchor: { x: 0, y: 0 },
        footprint,
        level: 4,
        density: 1,
        frontage: 'S',
        structureRect: { x: 0, y: 0, w, h },
        renderHeight: 0,
        abandoned: false,
      };
    };

    const wrapper = visual.mount(visualInput(1, 1), parent);
    const faces = wrapper.children[0] as Graphics;
    const ctx11 = faces.context;
    expect(ctx11).toBeTruthy();

    visual.update(visualInput(2, 2), wrapper);
    const ctx22 = faces.context;
    expect(ctx22).not.toBe(ctx11);

    visual.update(visualInput(4, 2), wrapper);
    const ctx42 = faces.context;
    expect(ctx42).not.toBe(ctx22);

    // Identical footprint reuses the warm cache entry …
    visual.update(visualInput(4, 2), wrapper);
    expect(faces.context).toBe(ctx42);
    // … and shrinking back to 1×1 restores its still-cached context rather
    // than keeping the stale 4×2 geometry.
    visual.update(visualInput(1, 1), wrapper);
    expect(faces.context).toBe(ctx11);

    visual.unmount(wrapper);
    visual.dispose();
    parent.destroy({ children: true });
  });
});

// ---------------------------------------------------------------------------
// A3 — prop base sits exactly on its host box top; prop lies on that roof
// ---------------------------------------------------------------------------

describe('merged massing — rooftop props attach to their host roof', () => {
  it('every prop baseLift equals its flat host box top and stays inside it', () => {
    for (const type of TYPES) {
      for (const fp of FOOTPRINTS) {
        for (const level of LEVELS) {
          for (const density of DENSITIES) {
            for (const seed of SEEDS) {
              const plan = buildMassingPlan(
                makeInput({ type, w: fp.w, h: fp.h, level, density, seed, bodyHeightPx: 14 + level * 16 }),
              );
              for (const prop of plan.props) {
                const hosts = plan.boxes.filter(
                  (b) => b.roof.kind === 'flat' && b.baseLiftPx + b.wallHeightPx === prop.baseLiftPx,
                );
                expect(hosts.length, `unique host for ${prop.kind} ${type} ${fp.label} s${seed}`).toBe(1);
                const host = hosts[0];
                // Exact bottom-to-top alignment.
                expect(prop.baseLiftPx).toBe(host.baseLiftPx + host.wallHeightPx);
                expect(prop.heightPx).toBeGreaterThan(0);

                if (prop.kind === 'antenna') {
                  expect(prop.tx).toBeGreaterThanOrEqual(host.rect.x0 - 1e-9);
                  expect(prop.tx).toBeLessThanOrEqual(host.rect.x1 + 1e-9);
                  expect(prop.ty).toBeGreaterThanOrEqual(host.rect.y0 - 1e-9);
                  expect(prop.ty).toBeLessThanOrEqual(host.rect.y1 + 1e-9);
                } else {
                  expect(prop.rect.x0).toBeGreaterThanOrEqual(host.rect.x0 - 1e-9);
                  expect(prop.rect.y0).toBeGreaterThanOrEqual(host.rect.y0 - 1e-9);
                  expect(prop.rect.x1).toBeLessThanOrEqual(host.rect.x1 + 1e-9);
                  expect(prop.rect.y1).toBeLessThanOrEqual(host.rect.y1 + 1e-9);
                  expect(prop.rect.x1).toBeGreaterThan(prop.rect.x0);
                  expect(prop.rect.y1).toBeGreaterThan(prop.rect.y0);
                }
              }
            }
          }
        }
      }
    }
  });

  it('totalHeightPx tracks the tallest box or prop', () => {
    for (const seed of SEEDS) {
      const plan = buildMassingPlan(makeInput({ w: 4, h: 2, seed, level: 5, density: 2, bodyHeightPx: 90 }));
      const expected = Math.max(
        ...plan.boxes.map(boxTop),
        ...plan.props.map((p) => p.baseLiftPx + p.heightPx),
        0,
      );
      expect(plan.totalHeightPx).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// A4 — props never overlap a different box's roof volume in footprint space,
// and the industrial taller-front-wing case hosts vents on the wing itself.
// ---------------------------------------------------------------------------

describe('merged massing — props stay clear of front/taller wings', () => {
  it('rect props do not positive-area-overlap any box other than their host', () => {
    for (const type of TYPES) {
      for (const fp of FOOTPRINTS) {
        for (const seed of SEEDS) {
          const plan = buildMassingPlan(makeInput({ type, w: fp.w, h: fp.h, seed, level: 5, density: 1, bodyHeightPx: 84 }));
          for (const prop of plan.props) {
            if (prop.kind === 'antenna') continue;
            const host = hostBox(plan, prop);
            expect(host).toBeDefined();
            for (const b of plan.boxes) {
              if (b === host) continue;
              const overlapX = Math.min(prop.rect.x1, b.rect.x1) - Math.max(prop.rect.x0, b.rect.x0);
              const overlapY = Math.min(prop.rect.y1, b.rect.y1) - Math.max(prop.rect.y0, b.rect.y0);
              // Boundary touches (overlap 0) are fine; a positive overlap means
              // the prop sits inside another box's roof/volume.
              expect(
                overlapX > 1e-9 && overlapY > 1e-9,
                `${type} ${fp.label} s${seed} ${prop.kind} overlaps a non-host box`,
              ).toBe(false);
            }
          }
        }
      }
    }
  });

  it('industrial plans keep at least one attached vent across sizes/seeds/heights', () => {
    const sizes: Array<[number, number]> = [[1, 1], [2, 2], [3, 2], [2, 3], [4, 2]];
    for (const [w, h] of sizes) {
      for (const seed of SEEDS) {
        for (const bodyHeightPx of [8, 24, 48, 84]) {
          const plan = buildMassingPlan(
            makeInput({ type: 'industrial', w, h, seed, level: 4, density: 1, bodyHeightPx }),
          );
          expect(plan.props.some((p) => p.kind === 'vent'), `${w}x${h} s${seed} bh${bodyHeightPx}`).toBe(true);
          for (const prop of plan.props) {
            const host = hostBox(plan, prop);
            expect(host, `vent host ${w}x${h} s${seed}`).toBeDefined();
          }
        }
      }
    }
  });

  it('industrial taller head-house wing carries the vents on its own roof', () => {
    // Compact 2×2 lots at a generous height are where a 1.3× front head house
    // used to project over main-roof vents. Sweep every seed.
    let tallWingSeeds = 0;
    for (const seed of SEEDS) {
      const plan = buildMassingPlan(
        makeInput({ type: 'industrial', w: 2, h: 2, level: 5, density: 1, bodyHeightPx: 84, seed }),
      );
      expect(plan.boxes.length).toBe(2);
      const [main, wing] = plan.boxes;
      for (const prop of plan.props) {
        expect(prop.kind).toBe('vent');
        if (wing.wallHeightPx > main.wallHeightPx) {
          tallWingSeeds++;
          // Vents must attach to the taller FRONT wing, not the back main roof.
          expect(prop.baseLiftPx).toBe(wing.baseLiftPx + wing.wallHeightPx);
          expect(prop.rect.x0).toBeGreaterThanOrEqual(wing.rect.x0 - 1e-9);
          expect(prop.rect.x1).toBeLessThanOrEqual(wing.rect.x1 + 1e-9);
          expect(prop.rect.y0).toBeGreaterThanOrEqual(wing.rect.y0 - 1e-9);
          expect(prop.rect.y1).toBeLessThanOrEqual(wing.rect.y1 + 1e-9);
        } else {
          // Shorter wing: vents stay on the main block, clear of the wing.
          expect(prop.baseLiftPx).toBe(main.baseLiftPx + main.wallHeightPx);
          const overlapX = Math.min(prop.rect.x1, wing.rect.x1) - Math.max(prop.rect.x0, wing.rect.x0);
          const overlapY = Math.min(prop.rect.y1, wing.rect.y1) - Math.max(prop.rect.y0, wing.rect.y0);
          expect(overlapX > 1e-9 && overlapY > 1e-9).toBe(false);
        }
      }
    }
    // The 1.3× branch must actually occur in the seed sweep, otherwise this
    // regression assertion would not exercise the fix.
    expect(tallWingSeeds).toBeGreaterThan(0);
  });

  it('projected props never intersect a later tall box (all types / 1x1 / 2x2 / 4x2)', () => {
    // Separating-axis overlap (px) between convex projected polygons.
    const satOverlap = (a: readonly Point[], b: readonly Point[]): number => {
      let minOverlap = Infinity;
      for (const poly of [a, b]) {
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i];
          const q = poly[(i + 1) % poly.length];
          const ex = q.x - p.x;
          const ey = q.y - p.y;
          const len = Math.hypot(ex, ey) || 1;
          const nx = -ey / len;
          const ny = ex / len;
          let minA = Infinity;
          let maxA = -Infinity;
          let minB = Infinity;
          let maxB = -Infinity;
          for (const pt of a) {
            const d = pt.x * nx + pt.y * ny;
            minA = Math.min(minA, d);
            maxA = Math.max(maxA, d);
          }
          for (const pt of b) {
            const d = pt.x * nx + pt.y * ny;
            minB = Math.min(minB, d);
            maxB = Math.max(maxB, d);
          }
          const overlap = Math.min(maxA, maxB) - Math.max(minA, minB);
          if (overlap <= 0) return 0;
          minOverlap = Math.min(minOverlap, overlap);
        }
      }
      return minOverlap;
    };

    const propPolys = (prop: MassingProp): Point[][] => {
      if (prop.kind === 'antenna') {
        const f = massingBoxFaces(
          { x0: prop.tx - 0.02, y0: prop.ty - 0.02, x1: prop.tx + 0.02, y1: prop.ty + 0.02 },
          prop.baseLiftPx,
          prop.heightPx,
        );
        return [f.left, f.right, f.top];
      }
      const f = massingBoxFaces(prop.rect, prop.baseLiftPx, prop.heightPx);
      return [f.left, f.right, f.top];
    };

    // Sub-pixel/rounding tolerance — real wing projection clashes are 1–3px.
    const MAX_ALLOWED_OVERLAP_PX = 0.5;

    for (const type of TYPES) {
      for (const fp of FOOTPRINTS) {
        for (const seed of SEEDS) {
          for (const bodyHeightPx of [30, 56, 84]) {
            const plan = buildMassingPlan(
              makeInput({ type, w: fp.w, h: fp.h, level: 5, density: 1, bodyHeightPx, seed }),
            );
            for (const prop of plan.props) {
              const host = hostBox(plan, prop);
              if (!host) continue;
              const hostIndex = plan.boxes.indexOf(host);
              for (let j = hostIndex + 1; j < plan.boxes.length; j++) {
                const b = plan.boxes[j];
                if (b.roof.kind === 'gable') continue;
                // A later box that never reaches the prop base cannot cover it.
                if (boxTop(b) < prop.baseLiftPx - 1e-9) continue;
                const bf = massingBoxFaces(b.rect, b.baseLiftPx, b.wallHeightPx);
                for (const pp of propPolys(prop)) {
                  for (const bp of [bf.top, bf.left, bf.right]) {
                    expect(
                      satOverlap(pp, bp),
                      `${type} ${fp.label} s${seed} bh${bodyHeightPx} ${prop.kind} intersects a later box by >${MAX_ALLOWED_OVERLAP_PX}px`,
                    ).toBeLessThanOrEqual(MAX_ALLOWED_OVERLAP_PX);
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// A5 — degenerate input yields an empty plan
// ---------------------------------------------------------------------------

describe('merged massing — empty plan for level 0 / non-positive footprint', () => {
  it('returns no boxes, props and zero total height', () => {
    const empty: MassingPlan = { boxes: [], props: [], totalHeightPx: 0 };
    expect(buildMassingPlan(makeInput({ level: 0 }))).toEqual(empty);
    expect(buildMassingPlan(makeInput({ bodyHeightPx: 0 }))).toEqual(empty);
    expect(buildMassingPlan(makeInput({ w: 0 }))).toEqual(empty);
    expect(buildMassingPlan(makeInput({ h: 0 }))).toEqual(empty);
  });
});
