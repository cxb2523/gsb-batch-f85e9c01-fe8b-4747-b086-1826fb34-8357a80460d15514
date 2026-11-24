// Bun side of the map kit: a GameSource that reads the player's install directly, and the `mod map ...` commands.
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { GAME_DIR, ROOT, WWW, readGameKey } from '../gamedir.ts';
import { ModEngine } from './engine.ts';
import { buildMaps, previewMap, type Built, type GameSource, type MapSpec } from './mapkit.ts';
import { scanStory, storyReport, type ScanSource, type StoryIndex } from './storyscan.ts';

const dec = new TextDecoder();

export function gameSource(modDir?: string): GameSource {
    const engine = new ModEngine(readGameKey, () => {});
    const cache = new Map<string, any>();
    const read = (rel: string): any => {
        if (cache.has(rel)) return cache.get(rel);
        const p = join(WWW, rel);
        if (!existsSync(p)) throw new Error(`${rel} not found in the game (${GAME_DIR})`);
        const v = JSON.parse(dec.decode(engine.decrypt(new Uint8Array(readFileSync(p)))));
        cache.set(rel, v);
        return v;
    };
    const lower = (dir: string, name: string) => { // game files are matched case-insensitively
        const hit = readdirSync(join(WWW, dir)).find(f => f.toLowerCase() === name.toLowerCase());
        return hit ? `${dir}/${hit}` : `${dir}/${name}`;
    };
    return {
        tiledMap: id => read(lower('maps', `map${id}.AUBREY`)),
        mapData: id => read(lower('data', `Map${String(id).padStart(3, '0')}.KEL`)),
        mapInfos: () => read('data/MapInfos.KEL'),
        tileset: source => { try { return read(lower('maps', source.replace(/\.json$/i, '.AUBREY'))); } catch { return null; } },
        commonEventCount: () => (read('data/CommonEvents.KEL') as unknown[]).length - 1,
        systemCounts: () => { try { const s = read('data/System.KEL'); return { switches: s.switches.length - 1, variables: s.variables.length - 1 }; } catch { return null; } },
        pngSize: rel => {
            const f = modDir && join(modDir, 'files', rel);
            if (!f || !existsSync(f)) return null;
            const b = readFileSync(f);
            if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
            return [b.readUInt32BE(16), b.readUInt32BE(20)];
        },
        assetExists: rel => {
            const base = rel.replace(/\.png$/i, '');
            if (modDir && [`files/${rel}`, `files/${base}.png`].some(f => existsSync(join(modDir, f)))) return true;
            return [`${base}.rpgmvp`, `${base}.png`].some(f => { try { return existsSync(join(WWW, dirname(f), readdirSync(join(WWW, dirname(f))).find(n => n.toLowerCase() === f.split('/').pop()!.toLowerCase()) ?? '\0')); } catch { return false; } });
        },
    };
}

const modDirOf = (p: string) => [resolve(p), join(ROOT, 'mods', p), join(ROOT, 'examples', p)].find(d => existsSync(join(d, 'mod.json'))) ?? join(ROOT, 'mods', p);

export function loadSpecs(modDir: string): { file: string; spec: MapSpec }[] {
    const dir = join(modDir, 'maps');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => /\.spec\.json$/.test(f)).sort().map(f => ({ file: f, spec: JSON.parse(readFileSync(join(dir, f), 'utf8')) as MapSpec }));
}

export interface LoadedSpecFile { file: string; spec: MapSpec | null; error: string | null }

/** Like loadSpecs, but a spec file that is not valid JSON becomes a failed entry instead of aborting the batch. */
export function loadSpecFiles(modDir: string): LoadedSpecFile[] {
    const dir = join(modDir, 'maps');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => /\.spec\.json$/.test(f)).sort().map(file => {
        try { return { file, spec: JSON.parse(readFileSync(join(dir, file), 'utf8')) as MapSpec, error: null }; }
        catch (e) { return { file, spec: null, error: (e as Error).message }; }
    });
}

/** Per-spec disk outcome, returned by buildModReport for the CLI (or tests) to print. */
export interface ModSpecReport {
    file: string | null;
    id: number | null;
    ok: boolean;
    success: boolean;
    editing: boolean;
    errors: string[];
    warnings: string[];
    /** Mod-relative files written for this successful spec. */
    written: string[];
    /** Stale/partial files of this failed spec deleted from disk. */
    removed: string[];
}

export interface BuildModOptions {
    /** Compile against a caller-supplied source (tests use a fake GameSource, no game install needed). */
    source?: GameSource;
    quiet?: boolean;
}

export interface BuildModReport {
    modDir: string;
    modId: string | null;
    /** True only when every spec compiled and the batch wrote without a global failure. */
    ok: boolean;
    results: ModSpecReport[];
    /** All mod-relative files written this run (successful spec files + unified MapInfos patch). */
    files: string[];
    /** Stale generated files removed while isolating failed specs / clearing an obsolete MapInfos patch. */
    removed: string[];
    errors: string[];
    warnings: string[];
    built: Built | null;
    /** Set when the run could not even start (missing mod.json / unreadable mod id / source failure). */
    fatal?: string;
}

export const MAPINFOS_PATCH_REL = 'patches/data/MapInfos.json.patch.json';

/** Delete mod-relative `rel` only when it resolves inside `modDir`; returns true when a file was removed. */
function safeUnlink(modDir: string, rel: string): boolean {
    const root = resolve(modDir);
    const abs = resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + sep)) return false;
    try { if (existsSync(abs)) { unlinkSync(abs); return true; } } catch { /* best-effort cleanup; never mask the compile error */ }
    return false;
}

/**
 * Compile every maps/*.spec.json independently: successful specs are written, failed specs are skipped and any
 * partial/stale output of theirs is removed. The MapInfos patch is generated once from the successful new maps.
 * Never throws for a per-spec problem; global startup/source problems come back as `fatal`.
 */
export function buildModReport(modArg: string, options: BuildModOptions = {}): BuildModReport {
    const modDir = modDirOf(modArg);
    const base: BuildModReport = { modDir, modId: null, ok: false, results: [], files: [], removed: [], errors: [], warnings: [], built: null };
    if (!existsSync(join(modDir, 'mod.json'))) return { ...base, errors: [`${modDir} has no mod.json`], fatal: 'no-mod-json' };

    let modId: string;
    try { modId = JSON.parse(readFileSync(join(modDir, 'mod.json'), 'utf8')).id as string; }
    catch (e) { return { ...base, errors: [`mod.json is not valid JSON: ${(e as Error).message}`], fatal: 'bad-mod-json' }; }

    const loaded = loadSpecFiles(modDir);
    if (!loaded.length) return { ...base, modId, ok: true };

    const valid = loaded.filter((l): l is { file: string; spec: MapSpec; error: null } => l.spec !== null);
    const source = options.source ?? gameSource(modDir);

    let built: Built;
    try { built = buildMaps(modId, valid.map(v => v.spec), source); }
    catch (e) {
        const msg = (e as Error).message;
        return { ...base, modId, errors: [msg], fatal: msg };
    }

    // Write exactly the aggregated files of the successful specs plus the unified MapInfos patch.
    for (const [rel, text] of Object.entries(built.files)) {
        const abs = join(modDir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, text);
        base.files.push(rel);
    }

    // Align pure results back onto the loaded files (buildMaps only saw the parseable specs, in the same order).
    const reports: ModSpecReport[] = [];
    let vi = 0;
    for (const l of loaded) {
        if (!l.spec) {
            reports.push({ file: l.file, id: null, ok: false, success: false, editing: false, errors: [`invalid spec JSON: ${l.error ?? 'parse error'}`], warnings: [], written: [], removed: [] });
            continue;
        }
        const r = built.results[vi++]!;
        const rep: ModSpecReport = {
            file: l.file, id: r.id, ok: r.ok, success: r.ok, editing: r.editing,
            errors: r.errors, warnings: r.warnings,
            written: r.ok ? r.files.filter(rel => rel in built.files) : [],
            removed: [],
        };
        if (!r.ok) {
            // Remove this failed spec's partial output unless the same path is produced by a successful spec
            // (e.g. a duplicate id whose first spec succeeded, or a shared tileset a success also writes).
            for (const rel of r.outputs) {
                if (rel in built.files) continue;
                if (safeUnlink(modDir, rel)) { rep.removed.push(rel); base.removed.push(rel); }
            }
        }
        reports.push(rep);
    }

    // Reconcile the global MapInfos patch with the successful new maps: no successful registrations means no stale patch.
    if (!(MAPINFOS_PATCH_REL in built.files) && safeUnlink(modDir, MAPINFOS_PATCH_REL)) {
        base.removed.push(MAPINFOS_PATCH_REL);
    }

    const ok = reports.every(r => r.ok);
    const labelOf = (r: ModSpecReport) => r.file ?? (r.id !== null ? `map ${r.id}` : 'spec');
    return {
        ...base, modId, ok, results: reports, built,
        errors: reports.flatMap(r => r.errors.map(m => `${labelOf(r)}: ${m}`)),
        warnings: reports.flatMap(r => r.warnings.map(m => `${labelOf(r)}: ${m}`)),
    };
}

/** Human-readable per-spec build output for the CLI. */
export function printBuildReport(r: BuildModReport, quiet = false) {
    if (quiet) return;
    if (r.fatal === 'no-mod-json') { console.error(`✗ ${r.errors[0]}`); return; }
    if (r.fatal) { console.error(`✗ map build could not start: ${r.fatal}`); return; }
    if (!r.results.length) { console.log(`no maps/*.spec.json in ${r.modDir}`); return; }
    for (const s of r.results) {
        const label = `${s.file ?? '(inline spec)'}${s.id !== null ? ` (map ${s.id})` : ''}`;
        if (s.ok) console.log(`✓ ${label}: ${s.written.length} file(s)${s.editing ? ' [edit, no MapInfos registration]' : ''}`);
        else console.log(`✗ ${label}: skipped with ${s.errors.length} error(s)`);
        for (const w of s.warnings) console.log(`  ! ${w}`);
        for (const e of s.errors) console.log(`  ✗ ${e}`);
        for (const rel of s.removed) console.log(`  - removed stale ${rel}`);
    }
    const failed = r.results.filter(s => !s.ok).length;
    const okN = r.results.length - failed;
    const registered = r.built?.infos.map(i => i.id).join(', ');
    if (failed) console.log(`partially built: ${okN} spec(s) written, ${failed} skipped; MapInfos ids: ${registered || 'none'}`);
    else console.log(`✓ built ${r.results.map(s => s.id).filter((x): x is number => x !== null).join(', ')} (${r.files.length} files)${registered ? `; MapInfos: ${registered}` : ''}`);
}

/**
 * Compile every maps/*.spec.json in a mod, writing successful specs only.
 * Returns false if any spec failed or the build could not start (successful files are still written).
 * Second arg is the legacy `quiet` boolean or a BuildModOptions bag (tests may inject a GameSource).
 */
export function buildMod(modArg: string, quiet: boolean | BuildModOptions = false, maybeSource?: GameSource): boolean {
    const opts: BuildModOptions = typeof quiet === 'object' && quiet !== null
        ? quiet
        : { quiet: Boolean(quiet), ...(maybeSource ? { source: maybeSource } : {}) };
    const q = opts.quiet ?? false;
    const report = buildModReport(modArg, opts);
    printBuildReport(report, q);
    return report.ok;
}

/** Alias of buildModReport for callers that look for an explicitly "detailed" build entry point. */
export const buildModDetailed = buildModReport;

function show(args: string[]) {
    const src = gameSource();
    const gi = args.indexOf('--game');
    if (gi >= 0) { // preview a map of the real game, with its events
        const id = Number(args[gi + 1]);
        const t = src.tiledMap(id);
        const ev = (src.mapData(id).events as any[]).filter(Boolean).map(e => ({ x: e.x, y: e.y, name: e.name }));
        console.log(`map ${id}: ${src.mapInfos()[id]?.name ?? '?'}\n${previewMap(t, ev)}`);
        return;
    }
    const [modArg, idArg] = args;
    if (!modArg || !idArg) { console.error('usage: bun run mod map show <mod> <id>   |   bun run mod map show --game <id>'); process.exit(1); }
    const dir = modDirOf(modArg), id = Number(idArg);
    const t = JSON.parse(readFileSync(join(dir, `files/maps/map${id}.json`), 'utf8'));
    const d = JSON.parse(readFileSync(join(dir, `files/data/Map${id}.json`), 'utf8'));
    console.log(previewMap(t, (d.events as any[]).filter(Boolean).map(e => ({ x: e.x, y: e.y, name: e.name }))));
}

function create(args: string[]) {
    const [modArg, idArg, name, size] = args;
    const m = /^(\d+)x(\d+)$/.exec(size ?? '');
    if (!modArg || !idArg || !name || !m) { console.error('usage: bun run mod map new <mod> <id> "<Name>" <W>x<H> [--tiles-from <mapId>]'); process.exit(1); }
    const dir = modDirOf(modArg), id = Number(idArg);
    if (!existsSync(join(dir, 'mod.json'))) { console.error(`${dir} is not a mod (run \`bun run mod new ${modArg}\` first)`); process.exit(1); }
    const tf = args.indexOf('--tiles-from');
    const spec: MapSpec = {
        id, name, size: [Number(m[1]), Number(m[2])], ...(tf >= 0 ? { tilesFrom: Number(args[tf + 1]) } : {}),
        stamps: [], blocked: [],
        events: [{ name: 'Hello', x: 2, y: 2, sprite: 'FA_KEL', do: [{ say: 'Hello from my new map!' }] }],
    };
    const p = join(dir, 'maps', `${id}.spec.json`);
    if (existsSync(p)) { console.error(`${p} already exists`); process.exit(1); }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(spec, null, 2) + '\n');
    console.log(`created ${p}\nEdit it, then: bun run mod map build ${modArg}   and   bun run mod map show ${modArg} ${id}`);
}

export function mapCommand(args: string[]) {
    const [sub, ...rest] = args;
    switch (sub) {
        case 'new': create(rest); break;
        case 'build': process.exit(buildMod(rest[0] ?? '') ? 0 : 1);
        case 'show': show(rest); break;
        default: console.log('bun run mod map new <mod> <id> "<Name>" <W>x<H> [--tiles-from <mapId>]   starter spec\nbun run mod map build <mod>                                          compile maps/*.spec.json into the mod\nbun run mod map show <mod> <id> | --game <id>                        ASCII picture (# blocked, . drawn, letters = events)');
    }
}

/** Reads straight from the install, one map at a time (nothing is cached: the scan touches ~470 maps). */
export function storySource(): ScanSource {
    const engine = new ModEngine(readGameKey, () => {});
    const read = (rel: string): any => JSON.parse(dec.decode(engine.decrypt(new Uint8Array(readFileSync(join(WWW, rel))))));
    const files = new Map(readdirSync(join(WWW, 'data')).map(f => [f.toLowerCase(), f]));
    return {
        mapInfos: () => read('data/MapInfos.KEL'),
        commonEvents: () => read('data/CommonEvents.KEL'),
        system: () => { const sys = read('data/System.KEL'); return { switches: sys.switches, variables: sys.variables }; },
        mapData: id => { const f = files.get(`map${String(id).padStart(3, '0')}.kel`); return f ? read(`data/${f}`) : null; },
    };
}

let storyCache: StoryIndex | null = null;
export const storyIndex = (): StoryIndex => (storyCache ??= scanStory(storySource()));

export function routesCommand(args: string[]) {
    const ix = storyIndex();
    const out = args.find(a => a !== '--json');
    const text = args.includes('--json') ? JSON.stringify(ix, null, 2) : storyReport(ix);
    if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(resolve(out), text); console.log(`wrote ${resolve(out)} (${ix.spine.length} spine switches, ${ix.hubs.length} hubs, ${ix.mapsScanned} maps)`); }
    else console.log(text);
}
