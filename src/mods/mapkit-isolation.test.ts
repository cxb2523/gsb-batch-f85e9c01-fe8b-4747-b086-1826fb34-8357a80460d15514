// Acceptance coverage for per-spec isolated map builds:
// A1 shared custom tileset size conflicts skip only the conflicting spec
// A2 the MapInfos patch is generated from successful new specs only (ordered, unique)
// A3 self-base edits are not registered, new maps are
// A4 failed specs leave no map/data/dialogue residue on disk; successes are complete
// A5 every build returns per-spec success/failure detail
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMaps, type GameSource, type MapSpec } from './mapkit.ts';
import { buildModReport } from './mapkit-node.ts';
import { applyJsonPatch } from './patch.ts';

const W = 8, H = 6;
const layer = (name: string) => ({ type: 'tilelayer', name, width: W, height: H, data: new Array(W * H).fill(0), opacity: 1, visible: true, x: 0, y: 0 });
const tiledBase = {
    width: W, height: H, tilewidth: 32, tileheight: 32,
    tilesets: [{ firstgid: 1, source: 'Tile_Collisions_32x32.json' }, { firstgid: 25, source: 'A.json' }],
    layers: [layer('GROUND - I'), layer('COLLISION')],
};
const mapDataBase = { width: W, height: H, displayName: 'base', note: '', events: [null], data: new Array(W * H * 6).fill(0) };

function fakeSrc(over: Partial<GameSource> = {}): GameSource {
    return {
        tiledMap: () => tiledBase as any,
        mapData: () => mapDataBase as any,
        mapInfos: () => [null, { id: 1, name: 'one' }],
        tileset: s => (({ 'A.json': { tilecount: 64 }, 'Tile_Collisions_32x32.json': { tilecount: 24 } }) as Record<string, any>)[s] ?? null,
        commonEventCount: () => 10,
        systemCounts: () => ({ switches: 50, variables: 50 }),
        assetExists: () => true,
        pngSize: () => [96, 64],
        ...over,
    };
}
const newSpec = (id: number, o: Partial<MapSpec> = {}): MapSpec => ({ id, name: `Map ${id}`, size: [W, H], ...o });
const parsePatch = (b: ReturnType<typeof buildMaps>) => JSON.parse(b.files['patches/data/MapInfos.json.patch.json']!);
/** Non-null MapInfos values the patch installs (the actual registrations). */
const registeredValues = (ops: any[]) => ops.filter(o => o.value && typeof o.value === 'object' && 'id' in o.value).map(o => o.value);

describe('per-spec isolation in buildMaps', () => {
    test('A1: same tileset name with disagreeing PNG sizes fails only the later conflicting spec', () => {
        const sizes: [number, number][] = [[96, 64], [32, 32]];
        const src = fakeSrc({ pngSize: () => sizes.shift() ?? null });
        const b = buildMaps('m', [
            newSpec(1001, { tilesets: [{ name: 'MINE' }], paint: [{ layer: 'GROUND - I', tileset: 'MINE', tile: 0 }] }),
            newSpec(1002, { tilesets: [{ name: 'MINE' }], paint: [{ layer: 'GROUND - I', tileset: 'MINE', tile: 0 }] }),
            newSpec(1003),
        ], src);

        expect(b.results.map(r => r.ok)).toEqual([true, false, true]);
        expect(b.results[1]!.errors.join()).toMatch(/MINE/);
        expect(b.results[1]!.errors.join()).toMatch(/sizes disagree|already/);
        // successful specs only (none of these specs use {say}, so no dialogue yml is generated)
        expect(Object.keys(b.files).sort()).toEqual([
            'files/data/Map1001.json', 'files/data/Map1003.json',
            'files/maps/MINE.json', 'files/maps/map1001.json', 'files/maps/map1003.json',
            'patches/data/MapInfos.json.patch.json',
        ]);
        expect(b.files['files/maps/map1001.json']).toBeTruthy();
        expect(b.files['files/maps/map1003.json']).toBeTruthy();
        expect(b.files['files/maps/map1002.json']).toBeUndefined();
        // the first declaration fixes the shared tileset dimensions; the conflict must not overwrite it
        expect(JSON.parse(b.files['files/maps/MINE.json']!).imagewidth).toBe(96);
        // the unrelated third spec is fully present and registered
        expect(b.infos.map(i => i.id).sort((a, z) => a - z)).toEqual([1001, 1003]);
        expect(b.ok).toBe(false);
    });

    test('A1: same name with matching sizes is shared and both specs succeed', () => {
        const b = buildMaps('m', [
            newSpec(1001, { tilesets: [{ name: 'MINE' }] }),
            newSpec(1002, { tilesets: [{ name: 'MINE' }] }),
        ], fakeSrc({ pngSize: () => [96, 64] }));
        expect(b.results.every(r => r.ok)).toBe(true);
        expect(b.errors).toEqual([]);
        expect(b.files['files/maps/MINE.json']).toBeTruthy();
    });

    test('A1 completeness: a successful spec that paints a tileset registered by a failed spec still ships its JSON', () => {
        const b = buildMaps('m', [
            // declares MINE, then fails on a missing paint layer
            newSpec(1001, {
                tilesets: [{ name: 'MINE' }],
                paint: [{ layer: 'NOPE', tileset: 'A', tile: 0 }],
            }),
            // reuses the shared MINE definition without declaring a PNG itself
            newSpec(1003, { paint: [{ layer: 'GROUND - I', tileset: 'MINE', tile: 0 }] }),
        ], fakeSrc({ pngSize: () => [96, 64] }));
        expect(b.results.map(r => r.ok)).toEqual([false, true]);
        expect(b.files['files/maps/map1001.json']).toBeUndefined();
        expect(b.files['files/maps/map1003.json']).toBeTruthy();
        expect(b.files['files/maps/MINE.json']).toBeTruthy(); // referenced by map1003, so it must be complete
    });

    test('A2: one failed spec between two new maps yields an ordered, unique registration patch', () => {
        const b = buildMaps('m', [
            newSpec(1001, { events: [{ name: 'a', x: 1, y: 1, do: [{ say: 'hi' }] }] }),
            newSpec(1002, { paint: [{ layer: 'NOPE', tileset: 'A', tile: 0 }] }),
            newSpec(1003, { events: [{ name: 'c', x: 1, y: 1, do: [{ say: 'yo' }] }] }),
        ], fakeSrc());

        expect(b.results.map(r => r.ok)).toEqual([true, false, true]);
        const ops = parsePatch(b);
        const values = registeredValues(ops);
        expect(values.map(v => v.id)).toEqual([1001, 1003]); // id order, no duplicate
        expect(new Set(values.map(v => v.id)).size).toBe(values.length);
        // applying the patch to the base MapInfos registers exactly the two successes; failed id stays empty
        const applied = applyJsonPatch(fakeSrc().mapInfos(), ops) as any[];
        expect(applied[1001]?.name).toBe('Map 1001');
        expect(applied[1003]?.name).toBe('Map 1003');
        expect(applied[1002]).toBeNull();
    });

    test('A3: a self-base edit is compiled but not registered, mixed with a new map', () => {
        const b = buildMaps('m', [
            { id: 1, base: 1, events: [{ name: 'v', x: 2, y: 2, do: [] }] },
            newSpec(1001),
        ], fakeSrc());
        expect(b.results.map(r => [r.ok, r.editing])).toEqual([[true, true], [true, false]]);
        expect(b.infos.map(i => i.id)).toEqual([1001]);
        const values = registeredValues(parsePatch(b));
        expect(values.map(v => v.id)).toEqual([1001]);
        expect(b.files['files/data/Map001.json']).toBeTruthy();
        expect(b.files['files/maps/map1.json']).toBeTruthy();
    });

    test('A5: each result carries id/status/errors/warnings and its committed files', () => {        const b = buildMaps('m', [newSpec(1001), newSpec(1002, { size: [2, 2] })], fakeSrc());
        expect(b.results).toHaveLength(2);
        const [ok, bad] = b.results;
        expect(ok).toMatchObject({ index: 0, id: 1001, ok: true, success: true });
        expect(ok!.files).toContain('files/maps/map1001.json');
        expect(bad).toMatchObject({ index: 1, id: 1002, ok: false, success: false });
        expect(bad!.errors.join()).toMatch(/size/);
        expect(bad!.files).toEqual([]);
        expect(b.specs).toBe(b.results); // alias
    });
});

describe('buildModReport writes successes and isolates failures on disk', () => {
    let dir: string;
    beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'mapkit-iso-')); });
    afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

    test('A4: good specs fully written, failed spec and its stale files removed', () => {
        writeFileSync(join(dir, 'mod.json'), JSON.stringify({ id: 'iso' }));
        mkdirSync(join(dir, 'maps'), { recursive: true });
        writeFileSync(join(dir, 'maps', '1001.spec.json'), JSON.stringify(newSpec(1001, { events: [{ name: 'a', x: 1, y: 1, do: [{ say: 'hello' }] }] })));
        writeFileSync(join(dir, 'maps', '1002.spec.json'), JSON.stringify(newSpec(1002, { paint: [{ layer: 'NOPE', tileset: 'A', tile: 0 }] })));
        writeFileSync(join(dir, 'maps', '1003.spec.json'), JSON.stringify(newSpec(1003, { events: [{ name: 'c', x: 1, y: 1, do: [{ say: 'there' }] }] })));

        // stale leftovers from a previous successful 1002 build must be purged
        for (const rel of ['files/maps/map1002.json', 'files/data/Map1002.json', 'files/languages/en/iso_map1002.yml']) {
            const abs = join(dir, rel); mkdirSync(join(abs, '..'), { recursive: true }); writeFileSync(abs, 'stale');
        }

        const rep = buildModReport(dir, { source: fakeSrc() });
        expect(rep.ok).toBe(false);
        expect(rep.results.map(r => [r.file, r.ok])).toEqual([
            ['1001.spec.json', true], ['1002.spec.json', false], ['1003.spec.json', true],
        ]);

        // successful files are all on disk
        for (const rel of [
            'files/maps/map1001.json', 'files/data/Map1001.json', 'files/languages/en/iso_map1001.yml',
            'files/maps/map1003.json', 'files/data/Map1003.json', 'files/languages/en/iso_map1003.yml',
            'patches/data/MapInfos.json.patch.json',
        ]) expect(existsSync(join(dir, rel)), rel).toBe(true);
        expect(readFileSync(join(dir, 'files/languages/en/iso_map1001.yml'), 'utf8')).toContain('hello');

        // failed spec has no residue, including the pre-existing stale files
        for (const rel of ['files/maps/map1002.json', 'files/data/Map1002.json', 'files/languages/en/iso_map1002.yml']) {
            expect(existsSync(join(dir, rel)), `${rel} should be removed`).toBe(false);
        }
        const failed = rep.results[1]!;
        expect(failed.removed.sort()).toEqual([
            'files/data/Map1002.json', 'files/languages/en/iso_map1002.yml', 'files/maps/map1002.json',
        ]);

        // the on-disk MapInfos patch registers only 1001 and 1003
        const ops = JSON.parse(readFileSync(join(dir, 'patches/data/MapInfos.json.patch.json'), 'utf8'));
        expect(registeredValues(ops).map((v: any) => v.id)).toEqual([1001, 1003]);
    });

    test('A1 on disk: a conflicting shared tileset skips only that spec; others and the tileset land', () => {
        const dc = mkdtempSync(join(tmpdir(), 'mapkit-tileset-conflict-'));
        try {
            writeFileSync(join(dc, 'mod.json'), JSON.stringify({ id: 'conf' }));
            mkdirSync(join(dc, 'maps'), { recursive: true });
            writeFileSync(join(dc, 'maps', '1001.spec.json'), JSON.stringify(newSpec(1001, { tilesets: [{ name: 'MINE' }] })));
            writeFileSync(join(dc, 'maps', '1002.spec.json'), JSON.stringify(newSpec(1002, { tilesets: [{ name: 'MINE' }] })));
            writeFileSync(join(dc, 'maps', '1003.spec.json'), JSON.stringify(newSpec(1003)));
            const sizes: [number, number][] = [[96, 64], [32, 32]];
            const rep = buildModReport(dc, { source: fakeSrc({ pngSize: () => sizes.shift() ?? null }) });
            expect(rep.results.map(r => r.ok)).toEqual([true, false, true]);
            expect(rep.results[1]!.errors.join()).toMatch(/sizes disagree/);
            expect(existsSync(join(dc, 'files/maps/map1001.json'))).toBe(true);
            expect(existsSync(join(dc, 'files/maps/map1003.json'))).toBe(true);
            expect(existsSync(join(dc, 'files/maps/MINE.json'))).toBe(true);
            expect(existsSync(join(dc, 'files/maps/map1002.json'))).toBe(false);
            expect(existsSync(join(dc, 'files/data/Map1002.json'))).toBe(false);
        } finally { rmSync(dc, { recursive: true, force: true }); }
    });

    test('A2 cleanup: when every new map fails, an obsolete MapInfos patch is deleted', () => {        const d2 = mkdtempSync(join(tmpdir(), 'mapkit-iso-empty-'));
        try {
            writeFileSync(join(d2, 'mod.json'), JSON.stringify({ id: 'iso2' }));
            mkdirSync(join(d2, 'maps'), { recursive: true });
            writeFileSync(join(d2, 'maps', '1001.spec.json'), JSON.stringify(newSpec(1001, { size: [1, 1] }))); // invalid size
            const patchAbs = join(d2, 'patches/data/MapInfos.json.patch.json');
            mkdirSync(join(patchAbs, '..'), { recursive: true });
            writeFileSync(patchAbs, '[]');

            const rep = buildModReport(d2, { source: fakeSrc() });
            expect(rep.ok).toBe(false);
            expect(rep.results[0]!.ok).toBe(false);
            expect(existsSync(patchAbs)).toBe(false);
            expect(rep.removed).toContain('patches/data/MapInfos.json.patch.json');
        } finally { rmSync(d2, { recursive: true, force: true }); }
    });

    test('a malformed spec JSON is reported per file and does not abort the batch', () => {
        const d3 = mkdtempSync(join(tmpdir(), 'mapkit-iso-json-'));
        try {
            writeFileSync(join(d3, 'mod.json'), JSON.stringify({ id: 'iso3' }));
            mkdirSync(join(d3, 'maps'), { recursive: true });
            writeFileSync(join(d3, 'maps', '1001.spec.json'), '{ not json');
            writeFileSync(join(d3, 'maps', '1003.spec.json'), JSON.stringify(newSpec(1003)));

            const rep = buildModReport(d3, { source: fakeSrc() });
            expect(rep.results).toHaveLength(2);
            expect(rep.results[0]).toMatchObject({ file: '1001.spec.json', ok: false, id: null });
            expect(rep.results[0]!.errors.join()).toMatch(/invalid spec JSON/);
            expect(rep.errors.join()).toMatch(/1001\.spec\.json/);
            expect(rep.results[1]!.ok).toBe(true);
            expect(existsSync(join(d3, 'files/maps/map1003.json'))).toBe(true);
        } finally { rmSync(d3, { recursive: true, force: true }); }
    });
});
