import { describe, expect, it } from "vitest";
import {
    CoordinateTransformer,
    ICamera,
    ItemCollection,
    paintKey,
    type ImageItem,
    type ItemCollectionChange,
    type LinearGradient,
} from "@canvas-tile-engine/core";
import { Layer } from "@canvas-tile-engine/renderer-shared/scene";
import { WebGLDraw, type WebGLDrawContext } from "../../src/modules/WebGLDraw";
import { GLRenderer } from "../../src/modules/gl/GLRenderer";
import type { RGBA } from "../../src/utils/color";

/**
 * Recording mock WebGL context, in the style of gl-texture.test.ts: every
 * unknown member resolves to a permissive function so the real GLRenderer can
 * construct its programs and issue draws. Texture creation/deletion and atlas
 * uploads are captured for assertions.
 */
function makeMockGL() {
    const created: unknown[] = [];
    const deleted: unknown[] = [];
    const uploads: Array<{ width: number; height: number; pixels: Uint8Array }> = [];

    const overrides: Record<string, unknown> = {
        createTexture: () => {
            const texture = { id: created.length };
            created.push(texture);
            return texture;
        },
        deleteTexture: (texture: unknown) => {
            deleted.push(texture);
        },
        texImage2D: (...args: unknown[]) => {
            // 9-arg atlas form: target, level, internal, width, height,
            // border, format, type, pixels.
            if (args.length === 9 && typeof args[3] === "number" && args[8] instanceof Uint8Array) {
                uploads.push({
                    width: args[3],
                    height: args[4] as number,
                    pixels: new Uint8Array(args[8] as Uint8Array),
                });
            }
        },
    };

    const target: Record<string, unknown> = {};
    const gl = new Proxy(target, {
        get(_t, prop: string) {
            if (prop in overrides) {
                return overrides[prop];
            }
            if (!(prop in target)) {
                target[prop] = () => ({});
            }
            return target[prop];
        },
    });

    return { gl: gl as unknown as WebGLRenderingContext, created, deleted, uploads };
}

function setup() {
    const camera = { x: 0, y: 0, scale: 10 } as unknown as ICamera;
    const transformer = new CoordinateTransformer(camera);
    const layers = new Layer<WebGLDrawContext>();
    const draw = new WebGLDraw(layers, transformer, camera);
    const config = { size: { width: 100, height: 100 }, scale: 10 } as never;
    const ctx = { save() {}, restore() {} } as unknown as CanvasRenderingContext2D;
    const mock = makeMockGL();
    const renderer = new GLRenderer(mock.gl);

    const render = () => layers.drawAll({ gl: renderer, ctx, camera, transformer, config, topLeft: { x: 0, y: 0 } });

    return { draw, layers, render, renderer, ...mock };
}

const image = () => ({ width: 10, height: 10 }) as unknown as HTMLImageElement;
const imageItem = (img: HTMLImageElement, x = 2, y = 2): ImageItem => ({ x, y, img }) as ImageItem;

const redBlueGradient: LinearGradient = {
    type: "linear",
    from: { x: 0, y: 0 },
    to: { x: 0, y: 1 },
    stops: [
        { offset: 0, color: "#f00" },
        { offset: 1, color: "#00f" },
    ],
};

const redStops = [{ offset: 0, color: [1, 0, 0, 1] as RGBA }];
const blueStops = [{ offset: 0, color: [0, 0, 1, 1] as RGBA }];

/** White-box view of private bookkeeping, localized to these tests. */
function drawInternals(draw: WebGLDraw) {
    return draw as unknown as {
        destroyed: boolean;
        textureRefs: Map<TexImageSource, number>;
        rampRefs: Map<string, number>;
        handleResources: Map<symbol, unknown>;
    };
}

function rendererInternals(renderer: GLRenderer) {
    return renderer as unknown as {
        disposed: boolean;
        rampRows: Map<string, { row: number; signature: string }>;
        rampFreeRows: Set<number>;
        rampHighWater: number;
        rampPixels: Uint8Array;
        rampTexture: WebGLTexture | null;
    };
}

describe("texture reuse", () => {
    it("reuses one GL texture for the same image across items and getTexture calls", () => {
        const env = setup();
        const shared = image();
        const other = image();

        env.draw.drawImage([imageItem(shared, 2), imageItem(shared, 4)]);
        env.draw.drawImage([imageItem(other, 6)], 2);
        env.render();

        const first = env.renderer.getTexture(shared);
        const second = env.renderer.getTexture(shared);
        expect(first).not.toBeNull();
        expect(second).toBe(first);
        // One GL texture per distinct source, however many items/handles use it.
        expect(env.created).toHaveLength(2);
        expect(env.renderer.getTexture(other)).not.toBe(first);
    });
});

describe("texture release with layer and handle lifetime", () => {
    it("deletes a shared texture only after the last layer referencing it is cleared", () => {
        const env = setup();
        const shared = image();

        env.draw.drawImage([imageItem(shared)], 1);
        env.draw.drawImage([imageItem(shared, 4)], 2);
        env.render();
        const texture = env.renderer.getTexture(shared);

        env.draw.clearLayer(1);
        expect(env.deleted).toHaveLength(0);

        env.draw.clearLayer(2);
        expect(env.deleted).toEqual([texture]);
    });

    it("keeps a texture when one of two handles using it is removed, then deletes once", () => {
        const env = setup();
        const shared = image();

        const first = env.draw.drawImage([imageItem(shared)], 1);
        const second = env.draw.drawImage([imageItem(shared, 4)], 1);
        env.render();
        const texture = env.renderer.getTexture(shared);

        env.draw.removeDrawHandle(first);
        expect(env.deleted).toHaveLength(0);

        env.draw.removeDrawHandle(second);
        expect(env.deleted).toEqual([texture]);

        // Removing the same handle again cannot delete the texture twice.
        env.draw.removeDrawHandle(second);
        expect(env.deleted).toHaveLength(1);
    });

    it("does not delete textures still used by another layer or image", () => {
        const env = setup();
        const removed = image();
        const kept = image();

        const handle = env.draw.drawImage([imageItem(removed)], 1);
        env.draw.drawImage([imageItem(kept)], 2);
        env.draw.drawImage([imageItem(removed, 5)], 3);
        env.render();
        const removedTexture = env.renderer.getTexture(removed);
        const keptTexture = env.renderer.getTexture(kept);

        env.draw.removeDrawHandle(handle);

        // Layer 3 still references `removed`; layer 2 references another image.
        expect(env.deleted).toHaveLength(0);

        env.draw.clearLayer(3);
        expect(env.deleted).toEqual([removedTexture]);
        expect(env.renderer.getTexture(kept)).toBe(keptTexture);
        expect(env.deleted).toHaveLength(1);
    });

    it("retains an image shared between a dynamic and a static draw", () => {
        const env = setup();
        const shared = image();

        env.draw.drawImage([imageItem(shared)], 1);
        env.draw.drawStaticImage([imageItem(shared, 4)], "static-image", 2);
        env.render();
        const texture = env.renderer.getTexture(shared);

        env.draw.clearLayer(1);
        expect(env.deleted).toHaveLength(0);

        env.draw.clearLayer(2);
        expect(env.deleted).toEqual([texture]);
    });

    it("releases a texture when the last occurrence is removed via collection changes", () => {
        const env = setup();
        const shared = image();
        const items = [imageItem(shared, 2), imageItem(shared, 4)];
        const handle = env.draw.drawImage(items);
        env.render();
        const texture = env.renderer.getTexture(shared);

        const remove = (index: number): ItemCollectionChange<ImageItem> =>
            ({ type: "remove", key: `k${index}`, item: items[index], index }) as ItemCollectionChange<ImageItem>;

        env.draw.applyDrawChanges(handle, [remove(1)]);
        expect(env.deleted).toHaveLength(0);

        env.draw.applyDrawChanges(handle, [remove(0)]);
        expect(env.deleted).toEqual([texture]);
    });

    it("releases a texture through a real ItemCollection remove/update lifecycle", () => {
        const env = setup();
        const firstImage = image();
        const secondImage = image();
        const items = [
            { id: "a", ...imageItem(firstImage, 2) },
            { id: "b", ...imageItem(secondImage, 4) },
        ];
        const source = new ItemCollection(items, { keyOf: (item) => item.id });
        const handle = env.draw.drawImage(source.items as unknown as ImageItem[]);
        source.subscribe((changes) => env.draw.applyDrawChanges(handle, changes));
        env.render();

        const textureA = env.renderer.getTexture(firstImage);
        const textureB = env.renderer.getTexture(secondImage);

        source.remove("a");
        expect(env.deleted).toEqual([textureA]);

        // Updating the survivor in place keeps its texture.
        source.update("b", { id: "b", ...imageItem(secondImage, 6) });
        expect(env.deleted).toHaveLength(1);
        env.render();
        expect(env.renderer.getTexture(secondImage)).toBe(textureB);

        env.draw.removeDrawHandle(handle);
        expect(env.deleted.filter((t) => t === textureB)).toHaveLength(1);
    });

    it("drops the old image reference on an update that swaps the image", () => {
        const env = setup();
        const oldImage = image();
        const newImage = image();
        const item = imageItem(oldImage);
        const handle = env.draw.drawImage([item]);
        env.render();
        const oldTexture = env.renderer.getTexture(oldImage);

        const replacement = { ...item, img: newImage };
        env.draw.applyDrawChanges(handle, [
            {
                type: "update",
                key: "k",
                index: 0,
                item: replacement,
                previous: item,
            } as ItemCollectionChange<ImageItem>,
        ]);

        expect(env.deleted).toEqual([oldTexture]);
    });

    it("does not release a texture when an update keeps the same image", () => {
        const env = setup();
        const shared = image();
        const item = imageItem(shared);
        const handle = env.draw.drawImage([item]);
        env.render();

        env.draw.applyDrawChanges(handle, [
            {
                type: "update",
                key: "k",
                index: 0,
                item: { ...item, x: 3 },
                previous: item,
            } as ItemCollectionChange<ImageItem>,
        ]);

        expect(env.deleted).toHaveLength(0);
    });
});

describe("gradient ramp row reuse and stop changes", () => {
    it("reuses a row for the same key and identical stops", () => {
        const env = setup();
        const row = env.renderer.rampRow("g", redStops);
        expect(row).toBe(0);
        expect(env.renderer.rampRow("g", redStops)).toBe(0);
        expect(rendererInternals(env.renderer).rampRows.size).toBe(1);
    });

    it("re-rasterizes a reused key when its stops change, so no old color survives", () => {
        const env = setup();
        const internals = rendererInternals(env.renderer);

        const row = env.renderer.rampRow("g", redStops);
        expect(row).toBe(0);
        expect([...internals.rampPixels.slice(0, 4)]).toEqual([255, 0, 0, 255]);
        const redSignature = internals.rampRows.get("g")!.signature;

        const after = env.renderer.rampRow("g", blueStops);
        // The key keeps its row, but the slot content now matches the new stops.
        expect(after).toBe(row);
        expect([...internals.rampPixels.slice(0, 4)]).toEqual([0, 0, 255, 255]);
        expect(internals.rampRows.get("g")!.signature).not.toBe(redSignature);

        // Flush through a real draw and verify the uploaded atlas is blue too.
        env.renderer.drawShapes([
            {
                cx: 10,
                cy: 10,
                halfW: 5,
                halfH: 5,
                radius: [0, 0, 0, 0],
                rotation: 0,
                color: [0, 0, 1, 1],
                gradient: { axis: { x0: 0, y0: -5, x1: 0, y1: 5 }, row },
            },
        ]);
        const atlas = env.uploads.at(-1)!;
        expect(atlas.height).toBe(1);
        expect([...atlas.pixels.slice(0, 4)]).toEqual([0, 0, 255, 255]);
    });

    it("references a ramp from every layer using it and releases the row only with the last one", () => {
        const env = setup();
        const key = paintKey(redBlueGradient);

        const first = env.draw.drawRect([{ x: 2, y: 2, size: 2, style: { fillStyle: redBlueGradient } }], 1);
        env.draw.drawRect(
            [
                {
                    x: 6,
                    y: 2,
                    size: 2,
                    style: { fillStyle: { ...redBlueGradient } },
                },
            ],
            2,
        );
        env.render();

        // Structurally identical gradients share one GL row but two layer refs.
        expect(rendererInternals(env.renderer).rampRows.has(key)).toBe(true);
        expect(drawInternals(env.draw).rampRefs.get(key)).toBe(2);

        env.draw.removeDrawHandle(first);
        expect(drawInternals(env.draw).rampRefs.get(key)).toBe(1);
        expect(rendererInternals(env.renderer).rampRows.has(key)).toBe(true);

        env.draw.clearLayer(2);
        // The second handle lived on layer 2, so clearing it drops the final reference.
        expect(drawInternals(env.draw).rampRefs.get(key)).toBeUndefined();
        expect(rendererInternals(env.renderer).rampRows.has(key)).toBe(false);
        expect([...rendererInternals(env.renderer).rampFreeRows]).toContain(0);

        // The freed row number is handed to the next distinct ramp.
        expect(env.renderer.rampRow("later", redStops)).toBe(0);
    });
});

describe("palette LRU eviction and row-number reuse", () => {
    const MAX_ROWS = 256;

    it("evicts the least recently used ramp and reuses its row number", () => {
        const env = setup();
        const internals = rendererInternals(env.renderer);

        for (let i = 0; i < MAX_ROWS; i++) {
            expect(env.renderer.rampRow(`k${i}`, redStops)).toBe(i);
        }
        expect(internals.rampRows.size).toBe(MAX_ROWS);

        // Touch k0 so it is most-recently-used; k1 becomes the LRU entry.
        expect(env.renderer.rampRow("k0", redStops)).toBe(0);

        const evictedRow = env.renderer.rampRow("overflow", blueStops);
        expect(evictedRow).toBe(1);
        expect(internals.rampRows.size).toBe(MAX_ROWS);
        expect(internals.rampRows.has("k1")).toBe(false);
        expect(internals.rampRows.has("overflow")).toBe(true);

        // k1 was evicted; re-registering it now takes the next LRU row (k2).
        expect(env.renderer.rampRow("k1", redStops)).toBe(2);
    });

    it("evicts row 0 for a fresh cache with no recent access", () => {
        const env = setup();
        for (let i = 0; i < MAX_ROWS; i++) {
            env.renderer.rampRow(`k${i}`, redStops);
        }
        expect(env.renderer.rampRow("one-too-many", blueStops)).toBe(0);
        expect(rendererInternals(env.renderer).rampRows.size).toBe(MAX_ROWS);
    });

    it("reuses explicitly released rows before growing the atlas", () => {
        const env = setup();
        expect(env.renderer.rampRow("a", redStops)).toBe(0);
        expect(env.renderer.rampRow("b", blueStops)).toBe(1);

        expect(env.renderer.releaseRampRow("a")).toBe(true);
        expect(env.renderer.releaseRampRow("missing")).toBe(false);

        expect(env.renderer.rampRow("c", redStops)).toBe(0);
        // The surviving b row is untouched.
        expect(env.renderer.rampRow("b", blueStops)).toBe(1);
        expect(rendererInternals(env.renderer).rampHighWater).toBe(2);
    });
});

describe("WebGLDraw.destroy resource clearing and inertness", () => {
    it("deletes every referenced image texture once and empties the resource tables", () => {
        const env = setup();
        const a = image();
        const b = image();

        env.draw.drawImage([imageItem(a)], 1);
        env.draw.drawImage([imageItem(b), imageItem(a, 5)], 2);
        env.draw.drawRect([{ x: 2, y: 2, size: 2, style: { fillStyle: redBlueGradient } }], 1);
        env.render();

        const textureA = env.renderer.getTexture(a);
        const textureB = env.renderer.getTexture(b);
        expect(env.created).toContain(textureA);
        expect(env.created).toContain(textureB);

        env.draw.destroy();

        expect(env.deleted.filter((t) => t === textureA)).toHaveLength(1);
        expect(env.deleted.filter((t) => t === textureB)).toHaveLength(1);
        // The third deletion is the shared ramp atlas created by the gradient rect.
        expect(env.deleted).toHaveLength(3);
        expect(env.deleted.filter((t) => t === textureA || t === textureB)).toHaveLength(2);

        const internals = drawInternals(env.draw);
        expect(internals.destroyed).toBe(true);
        expect(internals.textureRefs.size).toBe(0);
        expect(internals.rampRefs.size).toBe(0);
        expect(internals.handleResources.size).toBe(0);
        const glInternals = rendererInternals(env.renderer);
        expect(glInternals.rampRows.size).toBe(0);
        expect(glInternals.disposed).toBe(true);
        expect(glInternals.rampTexture).toBeNull();

        // Idempotent: a second destroy releases nothing further.
        env.draw.destroy();
        env.renderer.dispose();
        expect(env.deleted).toHaveLength(3);
    });

    it("makes every later registration and render a safe no-op", () => {
        const env = setup();
        env.draw.drawImage([imageItem(image())], 1);
        env.render();
        const createdBefore = env.created.length;

        env.draw.destroy();

        expect(() => {
            const handle = env.draw.drawImage([imageItem(image(), 9, 9)]);
            env.draw.drawRect([{ x: 9, y: 9, size: 1 }]);
            env.draw.drawCircle([{ x: 9, y: 9, size: 1 }]);
            env.draw.drawLine([{ from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }]);
            env.draw.drawPath([
                {
                    points: [
                        { x: 0, y: 0 },
                        { x: 1, y: 0 },
                        { x: 1, y: 1 },
                    ],
                },
            ]);
            env.draw.drawText([{ x: 9, y: 9, text: "x" }]);
            env.draw.drawGridLines(1, { lineWidth: 1, strokeStyle: "#000" });
            env.draw.addDrawFunction(() => {});
            env.draw.applyDrawChanges(handle, []);
            env.draw.removeDrawHandle(handle);
            env.draw.clearLayer(1);
            env.draw.clearAll();
            env.draw.destroy();
            env.render();
        }).not.toThrow();

        // No texture was created after destruction and the cleared layers draw nothing.
        expect(env.created.length).toBe(createdBefore);
    });
});

describe("GLRenderer.dispose palette cleanup", () => {
    it("deletes the ramp atlas texture and stays idempotent", () => {
        const env = setup();
        env.renderer.rampRow("g", redStops);
        // bindRamps creates the atlas GL texture on first draw.
        env.renderer.drawLines([{ x1: 0, y1: 0, x2: 1, y2: 1, width: 1, color: [0, 0, 0, 1] }]);

        const deleteCallsBefore = env.deleted.length;
        env.renderer.dispose();
        // One deleteTexture for the ramp atlas (image textures none here).
        expect(env.deleted.length).toBe(deleteCallsBefore + 1);

        const afterFirst = env.deleted.length;
        env.renderer.dispose();
        expect(env.deleted.length).toBe(afterFirst);
    });
});
