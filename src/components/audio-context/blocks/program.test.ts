import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Что тест должен видеть: созданные узлы и соединения параметров
const audio = vi.hoisted(() => ({
  nodes: [] as any[],
  pipes: [] as { from: any; to: any; }[],
  unpipes: [] as { from: any; to: any; }[],
}));

vi.mock("../ctx", () => ({ ctx: {} }));

vi.mock("../lib/runtimeWorklet", () => ({
  defineRuntimeWorklet: vi.fn(async () => 'TestProcessor'),
}));

// Настоящий SignalNode тянет AudioContext: для проверки достаточно метки класса
vi.mock("../lib/signalNode", () => ({
  SignalNode: class SignalNode {
    constructor(public node: any) { }
  },
}));

vi.mock("../lib/pipe", () => ({
  pipe: (from: any, to: any) => {
    audio.pipes.push({ from, to });
    return () => audio.unpipes.push({ from, to });
  },
}));

const { STOP_MESSAGE } = await import("$library/expression");
const { SignalNode } = await import("../lib/signalNode");
const { BuildAbortError, buildProgram } = await import("./program");

const label = (target: any): string => (
  target instanceof FakeWorkletNode ? 'processor' : target?.label ?? String(target)
);

// Заглушка обычного AudioNode (внешний Gain слота)
const gain = (name: string) => ({
  label: name,
  connected: [] as [string, number | undefined, number | undefined][],
  connect(target: any, output?: number, input?: number) {
    this.connected.push([label(target), output, input]);
  },
  disconnect() { },
});

class FakeParam {
  value = Number.NaN;
}

class FakeWorkletNode {
  parameters = new Map<string, FakeParam>();
  port = {
    messages: [] as unknown[],
    postMessage(this: { messages: unknown[]; }, message: unknown) {
      this.messages.push(message);
    },
  };
  onprocessorerror: (() => void) | null = null;
  connected: [string, number | undefined, number | undefined][] = [];
  disconnected: [string, number | undefined, number | undefined][] = [];
  disconnectedAll = 0;

  constructor(public context: unknown, public processor: string, public options: any) {
    for (let k = 0; k < 16; k++)
      this.parameters.set(`k${k}`, new FakeParam());

    audio.nodes.push(this);
  }

  connect(target: any, output?: number, input?: number) {
    this.connected.push([label(target), output, input]);
  }

  disconnect(target?: any, output?: number, input?: number) {
    if (target === undefined)
      this.disconnectedAll++;
    else
      this.disconnected.push([label(target), output, input]);
  }

  fireError() {
    this.onprocessorerror?.();
  }
}

const result = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  source: 'function () {}',
  inputs: ['in'],
  outputs: ['out'],
  params: [],
  passthrough: [],
  delayed: [],
  ...overrides,
}) as any;

const outers = new Map<string, ReturnType<typeof gain>>();
const outer = (id: string) => {
  var node = outers.get(id);
  if (!node) outers.set(id, node = gain(`outer:${id}`));
  return node as any;
};

const build = (overrides: Partial<Parameters<typeof buildProgram>[0]> = {}) => buildProgram({
  key: 'k',
  result: result(),
  signals: [],
  defaults: [],
  outer,
  onError: () => { },
  ...overrides,
});

beforeEach(() => {
  audio.nodes.length = 0;
  audio.pipes.length = 0;
  audio.unpipes.length = 0;
  outers.clear();
  (globalThis as any).AudioWorkletNode = FakeWorkletNode;
});

afterEach(() => {
  delete (globalThis as any).AudioWorkletNode;
  vi.clearAllMocks();
});

describe('buildProgram', () => {
  it('wires each slot to its processor input and output by index', async () => {
    const program = await build({
      result: result({ inputs: ['a', 'b'], outputs: ['x', 'y'] }),
    });

    const node = audio.nodes[0] as FakeWorkletNode;
    expect(node.options).toMatchObject({ numberOfInputs: 2, numberOfOutputs: 2 });

    // внешний Gain входа → вход процессора
    expect(outer('a').connected).toEqual([['processor', 0, 0]]);
    expect(outer('b').connected).toEqual([['processor', 0, 1]]);

    // выход процессора → внешний Gain выхода
    expect(node.connected).toEqual([['outer:x', 0, 0], ['outer:y', 1, 0]]);

    program.stop();
  });

  it('applies defaults to parameters without a wire', async () => {
    await build({
      result: result({ params: [{ node: 0, key: '_a' }, { node: 0, key: '_b' }] }),
      signals: [0.25, 0.75],
      defaults: [0.25, 0.75],
    });

    const node = audio.nodes[0] as FakeWorkletNode;
    expect(node.parameters.get('k0')!.value).toBe(0.25);
    expect(node.parameters.get('k1')!.value).toBe(0.75);
    expect(audio.pipes).toHaveLength(0);
  });

  it('pipes live signals into parameters and releases them on stop', async () => {
    const signal = new SignalNode({ label: 'const' } as any);

    const program = await build({
      result: result({ params: [{ node: 0, key: '_a' }] }),
      signals: [signal],
      defaults: [0],
    });

    expect(audio.pipes).toHaveLength(1);
    expect(audio.pipes[0].from).toBe(signal.node);
    expect(audio.unpipes).toHaveLength(0);

    program.stop();
    expect(audio.unpipes).toEqual(audio.pipes);
  });

  it('stops the processor, disconnects every wire and releases params', async () => {
    const program = await build({
      result: result({
        inputs: ['in'],
        outputs: ['out'],
        params: [{ node: 0, key: '_a' }],
      }),
      signals: [new SignalNode({ label: 'const' } as any)],
      defaults: [0],
    });

    const node = audio.nodes[0] as FakeWorkletNode;

    program.stop();

    // Ни один провод не остался: и к целям, и к параметрам
    expect(node.disconnected).toContainEqual(['outer:out', 0, 0]);
    expect(node.disconnectedAll).toBe(1);
    expect(audio.unpipes).toHaveLength(1);
    expect(node.port.messages).toEqual([STOP_MESSAGE]);
    expect(node.onprocessorerror).toBeNull();

    // Повторный stop ничего не ломает и не дублирует сообщения
    program.stop();
    expect(node.disconnectedAll).toBe(1);
    expect(node.port.messages).toEqual([STOP_MESSAGE]);
  });

  it('does not create a processor for a block with no outputs', async () => {
    const program = await build({
      result: result({ inputs: [], outputs: [], passthrough: [['in', 'out']] }),
    });

    expect(audio.nodes).toHaveLength(0);
    expect(program.passthrough).toEqual([[outer('in'), outer('out')]]);
    program.stop();
  });

  it('rejects with an abort error before creating any node', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(build({ signal: controller.signal })).rejects.toBeInstanceOf(BuildAbortError);
    expect(audio.nodes).toHaveLength(0);
  });

  it('rejects after the module loads when cancelled meanwhile', async () => {
    const controller = new AbortController();
    const pending = build({ signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(BuildAbortError);
    expect(audio.nodes).toHaveLength(0);
  });

  it('rolls back a partially wired program when wiring fails', async () => {
    const params = new Map<string, FakeParam>();
    // Первый параметр есть, второй — нет: обрыв на середине подключения
    params.set('k0', new FakeParam());

    class BrokenNode extends FakeWorkletNode {
      parameters = params;
    }

    (globalThis as any).AudioWorkletNode = BrokenNode;

    await expect(build({
      result: result({
        inputs: ['in'],
        outputs: ['out'],
        params: [{ node: 0, key: '_a' }, { node: 0, key: '_b' }],
      }),
      signals: [0, 0],
      defaults: [0, 0],
    })).rejects.toBeTruthy();

    const node = audio.nodes[0] as BrokenNode;
    // Всё, что успели подключить, снято
    expect(node.disconnected).toContainEqual(['outer:out', 0, 0]);
    expect(node.disconnectedAll).toBe(1);
  });

  it('reports a processor error through onError until stopped', async () => {
    const onError = vi.fn();
    const program = await build({ onError });

    const node = audio.nodes[0] as FakeWorkletNode;
    node.fireError();
    expect(onError).toHaveBeenCalledTimes(1);

    program.stop();
    node.fireError();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
