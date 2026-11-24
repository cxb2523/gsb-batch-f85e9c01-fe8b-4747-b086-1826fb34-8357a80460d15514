import {
  acquireSharedTransport,
  releaseSharedTransport,
} from '../transportRegistry';
import { WorkletTransport } from '../transportWorklet';

/**
 * Mock AudioWorkletNode whose instances are tracked so tests can assert
 * creation counts and disconnection timing.
 */
class MockMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage = jest.fn();
  close = jest.fn();
}

class MockAudioWorkletNode {
  static instances: MockAudioWorkletNode[] = [];

  port = new MockMessagePort();
  connect = jest.fn();
  disconnect = jest.fn();

  constructor(
    public context: AudioContext,
    public name: string,
    public options?: AudioWorkletNodeOptions
  ) {
    MockAudioWorkletNode.instances.push(this);
  }
}

interface MockContextOptions {
  addModule?: jest.Mock;
  currentTime?: number;
}

const createMockAudioContext = (options: MockContextOptions = {}) => {
  const addModule =
    options.addModule ?? jest.fn(() => Promise.resolve(undefined));
  const context = {
    currentTime: options.currentTime ?? 0,
    destination: {},
    audioWorklet: { addModule },
    createGain: jest.fn(() => ({
      connect: jest.fn(),
      disconnect: jest.fn(),
      gain: { value: 0 },
    })),
  } as unknown as AudioContext;

  return { context, addModule };
};

const tickMessage = {
  type: 'tick' as const,
  time: 1,
  beat: 2,
  bpm: 120,
  running: true,
};

const emitThroughNode = (node: AudioWorkletNode | null, data = tickMessage) => {
  const handler = (node as unknown as MockAudioWorkletNode | null)?.port
    .onmessage;
  if (!handler) {
    throw new Error('expected the worklet node to have an onmessage handler');
  }
  handler({ data });
};

describe('transportRegistry shared clock lifecycle', () => {
  const originalAudioWorkletNode = (global as any).AudioWorkletNode;

  beforeEach(() => {
    MockAudioWorkletNode.instances = [];
    (global as any).AudioWorkletNode = MockAudioWorkletNode;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    (global as any).AudioWorkletNode = originalAudioWorkletNode;
  });

  describe('concurrent acquisition (A1)', () => {
    it('creates exactly one WorkletTransport, bus, node and addModule call for concurrent acquires', async () => {
      const createSpy = jest.spyOn(WorkletTransport, 'create');
      const { context, addModule } = createMockAudioContext();

      const [first, second] = await Promise.all([
        acquireSharedTransport(context),
        acquireSharedTransport(context),
      ]);

      expect(first).toBe(second);
      expect(first.transport).toBe(second.transport);
      expect(first.bus).toBe(second.bus);
      expect(first.refs).toBe(2);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(MockAudioWorkletNode.instances).toHaveLength(1);

      releaseSharedTransport(context);
      releaseSharedTransport(context);
    });

    it('coalesces many synchronous concurrent acquires', async () => {
      const createSpy = jest.spyOn(WorkletTransport, 'create');
      const { context } = createMockAudioContext();

      const entries = await Promise.all(
        Array.from({ length: 8 }, () => acquireSharedTransport(context))
      );

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(MockAudioWorkletNode.instances).toHaveLength(1);
      expect(new Set(entries.map((entry) => entry.transport)).size).toBe(1);
      expect(entries[0].refs).toBe(8);

      for (let i = 0; i < 8; i += 1) {
        releaseSharedTransport(context);
      }
      expect(MockAudioWorkletNode.instances[0].disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('reference counted release (A2)', () => {
    it('keeps the clock alive until the last reference is released', async () => {
      const { context } = createMockAudioContext();
      const first = await acquireSharedTransport(context);
      const second = await acquireSharedTransport(context);
      expect(first).toBe(second);
      expect(first.refs).toBe(2);

      const node = first.transport.getNode() as unknown as MockAudioWorkletNode;
      const busListener = jest.fn();
      first.bus.on('tick', busListener);

      releaseSharedTransport(context);

      expect(first.refs).toBe(1);
      expect(node.disconnect).not.toHaveBeenCalled();
      expect(() => first.transport.start()).not.toThrow();

      // The surviving consumer still receives ticks.
      emitThroughNode(first.transport.getNode());
      expect(busListener).toHaveBeenCalledTimes(1);

      releaseSharedTransport(context);

      expect(first.refs).toBe(0);
      expect(node.disconnect).toHaveBeenCalledTimes(1);

      // Bus unsubscribed from the disposed transport: queued ticks are dropped.
      const capturedHandler = node.port.onmessage;
      expect(capturedHandler).toBeNull();
    });

    it('is safe to call release more times than acquire', async () => {
      const { context } = createMockAudioContext();
      const entry = await acquireSharedTransport(context);
      releaseSharedTransport(context);
      expect(() => {
        releaseSharedTransport(context);
        releaseSharedTransport(context);
      }).not.toThrow();
      expect(entry.refs).toBe(0);
    });
  });

  describe('rebuild after final release (A3)', () => {
    it('destroys the old clock and hands a fresh, ticking clock on re-acquire', async () => {
      const { context } = createMockAudioContext();

      const oldEntry = await acquireSharedTransport(context);
      const oldTransport = oldEntry.transport;
      const oldNode = oldTransport.getNode() as unknown as MockAudioWorkletNode;
      const oldHandler = oldNode.port.onmessage;
      const oldTickListener = jest.fn();
      oldEntry.bus.on('tick', oldTickListener);

      releaseSharedTransport(context);

      expect(oldNode.disconnect).toHaveBeenCalledTimes(1);
      expect(oldHandler).not.toBeNull();

      // Simulate a late worklet message reaching the captured handler closure.
      emitThroughNode({ port: { onmessage: oldHandler } } as unknown as AudioWorkletNode);
      expect(oldTickListener).not.toHaveBeenCalled();

      const newEntry = await acquireSharedTransport(context);
      expect(newEntry.transport).not.toBe(oldTransport);
      expect(newEntry.bus).not.toBe(oldEntry.bus);
      expect(newEntry.refs).toBe(1);
      expect(MockAudioWorkletNode.instances).toHaveLength(2);

      const newNode = newEntry.transport.getNode();
      expect(newNode).not.toBe(oldNode);

      const newTickListener = jest.fn();
      newEntry.bus.on('tick', newTickListener);
      newEntry.transport.start();
      emitThroughNode(newNode);

      expect(newTickListener).toHaveBeenCalledWith(
        expect.objectContaining({ beat: 2, bpm: 120 })
      );

      releaseSharedTransport(context);
      expect(
        (newNode as unknown as MockAudioWorkletNode).disconnect
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe('load failure and retry (A4)', () => {
    it('clears the failed loader/cache so a subsequent acquire reloads and succeeds', async () => {
      const addModule = jest
        .fn(() => Promise.resolve(undefined))
        .mockRejectedValueOnce(new Error('addModule failed'));
      const createSpy = jest.spyOn(WorkletTransport, 'create');
      const { context } = createMockAudioContext({ addModule });

      await expect(acquireSharedTransport(context)).rejects.toThrow(
        'addModule failed'
      );
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(MockAudioWorkletNode.instances).toHaveLength(0);

      const entry = await acquireSharedTransport(context);
      expect(entry.transport).toBeDefined();
      expect(entry.bus).toBeDefined();
      expect(entry.refs).toBe(1);
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(addModule).toHaveBeenCalledTimes(2);
      expect(MockAudioWorkletNode.instances).toHaveLength(1);

      releaseSharedTransport(context);
    });

    it('rejects every concurrent waiter of the same failed load, then retries cleanly', async () => {
      const addModule = jest
        .fn(() => Promise.resolve(undefined))
        .mockRejectedValueOnce(new Error('boom'));
      const { context } = createMockAudioContext({ addModule });

      const results = await Promise.allSettled([
        acquireSharedTransport(context),
        acquireSharedTransport(context),
        acquireSharedTransport(context),
      ]);

      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(addModule).toHaveBeenCalledTimes(1);

      const entry = await acquireSharedTransport(context);
      expect(entry.refs).toBe(1);
      expect(addModule).toHaveBeenCalledTimes(2);

      releaseSharedTransport(context);
    });

    it('does not leave a usable entry when release happens before a failed load settles', async () => {
      let rejectLoad: (error: Error) => void = () => {};
      const addModule = jest.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectLoad = reject;
          })
      );
      const { context } = createMockAudioContext({ addModule });

      const pending = acquireSharedTransport(context);
      releaseSharedTransport(context);

      rejectLoad(new Error('late failure'));
      await expect(pending).rejects.toThrow('late failure');

      // A later acquire starts a fresh load and works.
      addModule.mockImplementation(() => Promise.resolve(undefined));
      const entry = await acquireSharedTransport(context);
      expect(entry.refs).toBe(1);
      expect(MockAudioWorkletNode.instances).toHaveLength(1);

      releaseSharedTransport(context);
    });
  });

  describe('teardown isolation and generation safety', () => {
    it('disposes a newborn transport when every user released before loading settled', async () => {
      const createSpy = jest.spyOn(WorkletTransport, 'create');
      let resolveCreate: (transport: unknown) => void = () => {};
      createSpy.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve as (transport: unknown) => void;
          })
      );
      const dispose = jest.fn();
      const fakeTransport = { dispose };
      const { context } = createMockAudioContext();

      const pending = acquireSharedTransport(context);
      releaseSharedTransport(context);

      resolveCreate(fakeTransport);
      const entry = await pending;

      expect(dispose).toHaveBeenCalledTimes(1);
      expect(entry.transport).toBe(fakeTransport);

      // A later acquire ignores the torn generation and creates again.
      createSpy.mockRestore();
      (global as any).AudioWorkletNode = MockAudioWorkletNode;
      const next = await acquireSharedTransport(context);
      expect(next.transport).not.toBe(fakeTransport);
      expect(next.refs).toBe(1);
      releaseSharedTransport(context);
    });

    it('keeps independent clocks for different AudioContexts', async () => {
      const createSpy = jest.spyOn(WorkletTransport, 'create');
      const a = createMockAudioContext();
      const b = createMockAudioContext();

      const [ea, eb] = await Promise.all([
        acquireSharedTransport(a.context),
        acquireSharedTransport(b.context),
      ]);

      expect(ea).not.toBe(eb);
      expect(ea.transport).not.toBe(eb.transport);
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(MockAudioWorkletNode.instances).toHaveLength(2);

      releaseSharedTransport(a.context);
      // Releasing context A must not dispose context B's clock.
      expect(eb.refs).toBe(1);
      const bNode = eb.transport.getNode() as unknown as MockAudioWorkletNode;
      expect(bNode.disconnect).not.toHaveBeenCalled();

      releaseSharedTransport(b.context);
      expect(bNode.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('release/acquire interleaving (A5)', () => {
    it('never destroys a clock that a concurrent acquirer still holds', async () => {
      const { context } = createMockAudioContext();

      const owner = await acquireSharedTransport(context);
      const node = owner.transport.getNode() as unknown as MockAudioWorkletNode;

      // B acquires (synchronous claim) while A releases in the same tick.
      const pendingB = acquireSharedTransport(context);
      releaseSharedTransport(context);

      const b = await pendingB;
      expect(b).toBe(owner);
      expect(b.refs).toBe(1);
      expect(node.disconnect).not.toHaveBeenCalled();

      const tickListener = jest.fn();
      b.bus.on('tick', tickListener);
      emitThroughNode(b.transport.getNode());
      expect(tickListener).toHaveBeenCalledTimes(1);

      releaseSharedTransport(context);
      expect(node.disconnect).toHaveBeenCalledTimes(1);
    });

    it('reuses the in-flight load when release and re-acquire race before settlement', async () => {
      let resolveLoad: () => void = () => {};
      const addModule = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveLoad = resolve;
          })
      );
      const createSpy = jest.spyOn(WorkletTransport, 'create');
      const { context } = createMockAudioContext({ addModule });

      const first = acquireSharedTransport(context);
      // First consumer leaves while the worklet is still loading.
      releaseSharedTransport(context);
      // A second consumer arrives before the load settles.
      const second = acquireSharedTransport(context);

      resolveLoad();
      const [a, b] = await Promise.allSettled([first, second]);

      expect(a.status).toBe('fulfilled');
      expect(b.status).toBe('fulfilled');
      if (a.status === 'fulfilled' && b.status === 'fulfilled') {
        expect(a.value).toBe(b.value);
        expect(a.value.refs).toBe(1);
        const node = a.value.transport.getNode() as unknown as MockAudioWorkletNode;
        expect(node.disconnect).not.toHaveBeenCalled();

        releaseSharedTransport(context);
        expect(node.disconnect).toHaveBeenCalledTimes(1);
      }

      // Only a single creation was started for the whole interleave.
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it('converges refs and disposal across mixed acquire/release orderings', async () => {
      const { context } = createMockAudioContext();

      const a = await acquireSharedTransport(context); // refs 1
      const bPromise = acquireSharedTransport(context); // refs 2
      const cPromise = acquireSharedTransport(context); // refs 3
      releaseSharedTransport(context); // refs 2
      const b = await bPromise;
      const c = await cPromise;
      expect(b.refs).toBe(2);
      expect(c.refs).toBe(2);

      releaseSharedTransport(context); // refs 1
      expect(a.transport.getNode()?.disconnect).not.toHaveBeenCalled();

      releaseSharedTransport(context); // refs 0
      expect(
        a.transport.getNode() as unknown as MockAudioWorkletNode | null
      ).toBeNull();

      // Balanced re-acquisition after teardown yields a fresh clock.
      const d = await acquireSharedTransport(context);
      expect(d.transport).not.toBe(a.transport);
      expect(d.refs).toBe(1);
      releaseSharedTransport(context);
    });
  });
});
