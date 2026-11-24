import { BUILD_ERROR, ProgramSwitch, RUNTIME_ERROR, TSwitchedProgram } from "./switching";
import { TPair, Routing } from "./routing";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

// Модель Web Audio: множество рёбер «узел → узел» и журнал операций
const audio = () => {
  const edges = new Set<string>();
  const log: string[] = [];

  return {
    edges,
    log,
    io: {
      connect: (a: string, b: string) => {
        edges.add(`${a}>${b}`);
        log.push(`+${a}>${b}`);
      },
      disconnect: (a: string, b: string) => {
        edges.delete(`${a}>${b}`);
        log.push(`-${a}>${b}`);
      },
    },
  };
};

const bridges = (slots: { id: string; kind: 'in' | 'out'; }[]): TPair<string>[] => (
  slots.map(({ id, kind }) => kind === 'in' ? [`outer:${id}`, `inner:${id}`] : [`inner:${id}`, `outer:${id}`])
);

type TDeferred<T> = { resolve(value: T): void; reject(error: unknown): void; promise: Promise<T>; };

const deferred = <T,>(): TDeferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
};

const program = (key: string, passthrough: TPair<string>[] = []): TSwitchedProgram<string> & { stopped: number; } => {
  const result = {
    key,
    signals: [] as unknown[],
    passthrough,
    stopped: 0,
    stop() {
      result.stopped++;
    },
  } satisfies TSwitchedProgram<string> & { stopped: number; };

  return result;
};

const setup = (slots: { id: string; kind: 'in' | 'out'; }[] = [{ id: 'x', kind: 'in' }, { id: 'y', kind: 'out' }]) => {
  // Ожидаемые ошибки не должны засорять вывод
  vi.spyOn(console, 'error').mockImplementation(() => { });

  const { io, edges, log } = audio();
  const routing = new Routing(io);
  const onProgram = vi.fn();
  const onError = vi.fn();

  const switcher = new ProgramSwitch<string>({
    routing,
    bridges: () => bridges(slots),
    onProgram,
    onError,
  });

  return { switcher, routing, edges, log, onProgram, onError, slots };
};

const build = (key: string, passthrough: TPair<string>[] = []) => (
  { key, signals: [] as unknown[], build: async () => program(key, passthrough) }
);

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('ProgramSwitch: normal switching', () => {
  it('drops bridges, starts building, then wires the program', async () => {
    const { switcher, edges, onProgram } = setup();
    const gate = deferred<TSwitchedProgram<string>>();

    // Блок звучит без компиляции: мосты на месте
    switcher.syncBridges();
    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x']);

    switcher.request({ key: 'p', signals: [], build: () => gate.promise });

    // Пока процессор собирается, мостов нет
    expect(edges.size).toBe(0);
    expect(switcher.state).toBe('building');
    expect(switcher.building).toBe(true);

    const built = program('p', [['outer:x', 'outer:y']]);
    gate.resolve(built);
    await flush();

    expect(switcher.state).toBe('compiled');
    expect(switcher.program).toBe(built);
    expect([...edges]).toEqual(['outer:x>outer:y']);
    expect(onProgram).toHaveBeenLastCalledWith(built);
  });

  it('restores bridges by the current slots when disabled', async () => {
    const { switcher, edges } = setup();

    switcher.request(build('p'));
    await flush();
    edges.clear();

    switcher.disable();

    expect(switcher.state).toBe('off');
    expect(switcher.program).toBeNull();
    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x']);
  });

  it('keeps shared bridge pairs connected across a compiled cycle', async () => {
    const { switcher, edges, log } = setup();

    switcher.request(build('p', [['outer:x', 'outer:y']]));
    await flush();

    // Прямой «вход → выход» и мост выхода не делят ни одной пары, так что временный
    // внешний маршрут не влияет на возврат к мостам
    edges.clear();
    log.length = 0;
    switcher.disable();

    expect(log.filter(line => line.startsWith('+'))).toHaveLength(2);
    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x']);
  });

  it('reuses the very same program when nothing changed', async () => {
    const { switcher } = setup();
    const buildFn = vi.fn(async () => program('p'));

    switcher.request({ key: 'p', signals: [], build: buildFn });
    await flush();
    switcher.request({ key: 'p', signals: [], build: buildFn });
    await flush();

    expect(buildFn).toHaveBeenCalledTimes(1);
    expect(switcher.state).toBe('compiled');
  });

  it('rebuilds exactly once when the graph changes', async () => {
    const { switcher } = setup();
    const first = vi.fn(async () => program('p1'));
    const second = vi.fn(async () => program('p2'));

    switcher.request({ key: 'p1', signals: [], build: first });
    await flush();
    switcher.request({ key: 'p2', signals: [], build: second });
    await flush();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(switcher.program!.key).toBe('p2');
  });

  it('rebuilds when a live signal changes, but not when it stays', async () => {
    const { switcher } = setup();
    const signal = {};
    const buildFn = vi.fn(async () => ({ ...program('p'), signals: [signal] }));

    switcher.request({ key: 'p', signals: [signal], build: buildFn });
    await flush();
    switcher.request({ key: 'p', signals: [signal], build: buildFn });
    await flush();
    expect(buildFn).toHaveBeenCalledTimes(1);

    switcher.request({ key: 'p', signals: [{}], build: buildFn });
    await flush();
    expect(buildFn).toHaveBeenCalledTimes(2);
  });

  it('stops the previous program and releases its wires when replaced', async () => {
    const { switcher } = setup();
    const old = program('p1');
    const next = program('p2');

    switcher.request({ key: 'p1', signals: [], build: async () => old });
    await flush();
    switcher.request({ key: 'p2', signals: [], build: async () => next });
    await flush();

    expect(old.stopped).toBe(1);
    expect(next.stopped).toBe(0);
  });
});

describe('ProgramSwitch: rapid switching', () => {
  it('builds once for repeated enable toggles', async () => {
    const { switcher } = setup();
    const buildFn = vi.fn(async () => program('p'));

    switcher.request({ key: 'p', signals: [], build: buildFn });
    switcher.request({ key: 'p', signals: [], build: buildFn });
    switcher.request({ key: 'p', signals: [], build: buildFn });
    await flush();

    expect(buildFn).toHaveBeenCalledTimes(1);
  });

  it('discards a late build after a rebuild and never lets it sound', async () => {
    const { switcher, edges } = setup();
    const oldGate = deferred<TSwitchedProgram<string>>();
    const late = program('old', [['late', 'late-target']]);
    const fresh = program('new', [['fresh', 'fresh-target']]);

    switcher.request({ key: 'old', signals: [], build: () => oldGate.promise });
    switcher.request({ key: 'new', signals: [], build: async () => fresh });
    await flush();

    oldGate.resolve(late);
    await flush();

    expect(late.stopped).toBe(1);
    expect(switcher.program).toBe(fresh);
    expect([...edges]).toEqual(['fresh>fresh-target']);
  });

  it('frees a build that was cancelled by disable and keeps bridges', async () => {
    const { switcher, edges } = setup();
    const gate = deferred<TSwitchedProgram<string>>();
    const stale = program('p', [['stale', 'target']]);

    switcher.request({ key: 'p', signals: [], build: () => gate.promise });
    switcher.disable();

    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x']);

    gate.resolve(stale);
    await flush();

    expect(stale.stopped).toBe(1);
    expect(switcher.program).toBeNull();
    expect(switcher.state).toBe('off');
    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x']);
  });

  it('frees a late build after dispose and stops the running one', async () => {
    const { switcher } = setup();
    const gate = deferred<TSwitchedProgram<string>>();
    const late = program('p');

    switcher.request({ key: 'p', signals: [], build: () => gate.promise });
    switcher.dispose();

    gate.resolve(late);
    await flush();

    expect(late.stopped).toBe(1);
    expect(switcher.program).toBeNull();
  });

  it('aborts the in-flight request when superseded', async () => {
    const { switcher } = setup();
    const signals: AbortSignal[] = [];

    switcher.request({ key: 'a', signals: [], build: signal => { signals.push(signal); return new Promise(() => { }); } });
    switcher.request({ key: 'b', signals: [], build: signal => { signals.push(signal); return new Promise(() => { }); } });

    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);

    switcher.disable();
    expect(signals[1].aborted).toBe(true);
  });

  it('restores bridges from the latest slots when a build is cancelled', async () => {
    const { switcher, edges, slots } = setup();
    const gate = deferred<TSwitchedProgram<string>>();

    switcher.request({ key: 'p', signals: [], build: () => gate.promise });
    slots.push({ id: 'z', kind: 'in' });
    switcher.disable();

    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x', 'outer:z>inner:z']);

    gate.resolve(program('p', [['stale', 'target']]));
    await flush();

    // Поздняя сборка не вернула старые мосты и не добавила своих соединений
    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x', 'outer:z>inner:z']);
  });

  it('lets a newer state win when toggled on/off/on quickly', async () => {
    const { switcher, edges } = setup();

    switcher.request(build('p1'));
    await flush();
    switcher.disable();
    switcher.request(build('p2', [['outer:x', 'outer:y']]));
    await flush();

    expect(switcher.state).toBe('compiled');
    expect(switcher.program!.key).toBe('p2');
    expect([...edges]).toEqual(['outer:x>outer:y']);
  });
});

describe('ProgramSwitch: failures', () => {
  it('returns to bridges and reports the reason when building fails', async () => {
    const { switcher, edges, onError } = setup();

    switcher.request({ key: 'p', signals: [], build: async () => { throw new Error('boom'); } });
    await flush();

    expect(switcher.state).toBe('failed');
    expect(switcher.program).toBeNull();
    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x']);
    expect(onError).toHaveBeenCalledWith(BUILD_ERROR);
  });

  it('returns to bridges when the graph cannot be validated', () => {
    const { switcher, edges, onError } = setup();

    switcher.want();
    switcher.fail('Math has an unknown operation');

    expect(switcher.state).toBe('failed');
    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x']);
    expect(onError).toHaveBeenCalledWith('Math has an unknown operation');
  });

  it('tears down a running program that reports a processor error', async () => {
    const { switcher, edges, onError } = setup();

    switcher.request(build('p', [['outer:x', 'outer:y']]));
    await flush();
    const running = switcher.program as ReturnType<typeof program>;

    switcher.fail();

    expect(running.stopped).toBe(1);
    expect(switcher.state).toBe('failed');
    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x']);
    expect(onError).toHaveBeenCalledWith(RUNTIME_ERROR);
  });

  it('ignores failures requested after the switch was disabled', async () => {
    const { switcher, onError } = setup();

    switcher.request(build('p'));
    await flush();
    switcher.disable();
    switcher.fail();

    expect(onError).not.toHaveBeenCalled();
    expect(switcher.state).toBe('off');
  });

  it('keeps bridges on the new slots after a failure', async () => {
    const { switcher, edges, slots } = setup();

    switcher.request({ key: 'p', signals: [], build: async () => { throw new Error('boom'); } });
    await flush();

    slots.push({ id: 'z', kind: 'in' });
    switcher.syncBridges();

    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x', 'outer:z>inner:z']);
  });

  it('never installs a program that already reported an error', async () => {
    const { switcher, edges, onError } = setup();
    const broken = { ...program('p'), failed: () => true };
    const stopped = vi.fn(broken.stop);
    broken.stop = stopped;

    switcher.request({ key: 'p', signals: [], build: async () => broken });
    await flush();

    expect(stopped).toHaveBeenCalledTimes(1);
    expect(switcher.state).toBe('failed');
    expect(switcher.program).toBeNull();
    expect([...edges].sort()).toEqual(['inner:y>outer:y', 'outer:x>inner:x']);
    expect(onError).toHaveBeenCalledWith(RUNTIME_ERROR);
  });

  it('does not touch bridges on sync while compiled', async () => {
    const { switcher, edges, slots } = setup();

    switcher.request(build('p', [['outer:x', 'outer:y']]));
    await flush();

    slots.push({ id: 'z', kind: 'in' });
    switcher.syncBridges();

    expect([...edges]).toEqual(['outer:x>outer:y']);
  });
});
