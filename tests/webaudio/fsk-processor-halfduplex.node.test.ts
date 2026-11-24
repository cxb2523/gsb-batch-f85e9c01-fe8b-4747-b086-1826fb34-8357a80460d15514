// FSKProcessor half-duplex / abort / reset tests - Node.js compatible.
// The AudioWorklet globals are mocked so the worklet processor can be
// instantiated directly and driven through its port messages.
import { describe, test, expect, beforeEach, vi } from 'vitest';

// Minimal AudioWorkletProcessor / registration mocks ----------------------
class MockAudioWorkletProcessor {
  port = {
    onmessage: null as ((_event: MessageEvent) => void) | null,
    postMessage: vi.fn()
  };
}

vi.stubGlobal('AudioWorkletProcessor', MockAudioWorkletProcessor);
vi.stubGlobal('registerProcessor', vi.fn());
vi.stubGlobal('sampleRate', 48000);

const processorModule = await import(
  '../../src/webaudio/processors/fsk-processor.js'
) as any;
const FSKProcessor = processorModule.FSKProcessor;

import { FSKCore, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk';

// Drive a message through the worklet port and await its handler
async function sendMessage(processor: any, message: any): Promise<void> {
  await processor.port.onmessage({ data: message } as MessageEvent);
}

function latestPostedMessage(processor: any): any {
  const calls = processor.port.postMessage.mock.calls;
  return calls[calls.length - 1][0];
}

describe('FSKProcessor half-duplex state handling', () => {
  let processor: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    processor = new FSKProcessor();
    await sendMessage(processor, {
      id: 'configure',
      type: 'configure',
      data: { config: { ...DEFAULT_FSK_CONFIG } }
    });
    expect(latestPostedMessage(processor).data).toEqual({ success: true });
    processor.port.postMessage.mockClear();
  });

  // Drive modulation to completion by pumping the audio graph
  async function pumpModulation(): Promise<void> {
    for (let i = 0; i < 500 && processor.pendingModulation; i++) {
      processor.process([[]], [[new Float32Array(1024)]]);
      await Promise.resolve();
    }
  }

  // Build a clean reference signal with a fresh standalone core for each
  // frame, mirroring a separate transmitter on the other end of the link.
  async function referenceSignal(payload: Uint8Array): Promise<Float32Array> {
    const source = new FSKCore();
    source.configure({ ...DEFAULT_FSK_CONFIG });
    return source.modulateData(payload);
  }

  // Feed a complete signal into the processor and collect every demodulated
  // byte. The worklet demodulates independently of demodulate() requests and
  // buffers the bytes, so the whole signal is pumped in first and the buffer
  // is drained afterwards with simple requests.
  let drainSequence = 0;
  async function loopbackReceive(payload: Uint8Array): Promise<number[]> {
    const signal = await referenceSignal(payload);
    const CHUNK = 512;

    // 1. Pump all audio input through the processor
    for (let fed = 0; fed < signal.length; fed += CHUNK) {
      const chunk = signal.slice(fed, fed + CHUNK);
      processor.process([[chunk]], [[new Float32Array(CHUNK)]]);
      await Promise.resolve();
    }
    // Flush trailing microtasks (EOD handling etc.)
    for (let i = 0; i < 10; i++) {
      processor.process([[]], [[new Float32Array(CHUNK)]]);
      await Promise.resolve();
    }

    // 2. Drain the demodulated buffer. processDemodulation() is async, so a
    // byte can still be in flight when the buffer is momentarily empty; pump
    // generous idle rounds before concluding that all bytes have arrived.
    const received: number[] = [];
    let idleRounds = 0;
    while (idleRounds < 20 && received.length < payload.length + 2) {
      if (processor.demodulatedBuffer.length === 0) {
        idleRounds++;
        for (let i = 0; i < 10; i++) {
          processor.process([[]], [[new Float32Array(CHUNK)]]);
          await Promise.resolve();
        }
        if (processor.demodulatedBuffer.length === 0) continue;
        idleRounds = 0;
      }
      const id = `drain-${drainSequence++}`;
      await sendMessage(processor, { id, type: 'demodulate', data: {} });
      const reply = processor.port.postMessage.mock.calls
        .map((c: any[]) => c[0])
        .find((m: any) => m.id === id);
      expect(reply.type).toBe('result');
      received.push(...reply.data.bytes);
    }

    return received;
  }

  test('modulate message clears the receive buffer to prevent self-reception', async () => {
    processor.demodulatedBuffer.put(0x41, 0x42, 0x43);
    expect(processor.demodulatedBuffer.length).toBe(3);

    const modulateDone = sendMessage(processor, {
      id: 'mod-1',
      type: 'modulate',
      data: { bytes: [0x48] }
    });

    // Pump the audio graph until modulation completes
    for (let i = 0; i < 200 && processor.pendingModulation; i++) {
      processor.process([[]], [[new Float32Array(128)]]);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await modulateDone;

    const reply = latestPostedMessage(processor);
    expect(reply.id).toBe('mod-1');
    expect(reply.type).toBe('result');
    expect(reply.data.success).toBe(true);
    expect(processor.demodulatedBuffer.length).toBe(0);
  });

  test('two consecutive send->receive cycles on one processor return original bytes', async () => {
    const payloads = [
      new Uint8Array([0x41, 0x42]),
      new Uint8Array([0x48, 0x65, 0x6C])
    ];

    for (let round = 0; round < payloads.length; round++) {
      const payload = payloads[round];

      // --- send phase ---
      const modDone = sendMessage(processor, {
        id: `mod-${round}`,
        type: 'modulate',
        data: { bytes: Array.from(payload) }
      });
      await pumpModulation();
      await modDone;
      // Self-reception guard: receive buffer is empty after sending
      expect(processor.demodulatedBuffer.length).toBe(0);

      // --- receive phase (loop the modulated signal back in) ---
      const received = await loopbackReceive(payload);
      expect(received).toEqual(Array.from(payload));
    }
  });

  test('demodulate waiting for data rejects with AbortError on abort and leaves no waiter', async () => {
    // No data buffered -> the request hangs until aborted
    const demodDone = sendMessage(processor, {
      id: 'demod-wait',
      type: 'demodulate',
      data: {}
    });
    // Let the handler reach the awaiting state
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(processor.awaitingCallback).not.toBeNull();

    await sendMessage(processor, { id: 'abort-1', type: 'abort', data: {} });
    await demodDone;

    const reply = latestPostedMessage(processor);
    expect(reply.id).toBe('demod-wait');
    expect(reply.type).toBe('error');
    expect(reply.data.message).toMatch(/aborted/i);

    // The wait slot must be gone, otherwise later requests hang forever
    expect(processor.awaitingCallback).toBeNull();
  });

  test('demodulate() rejects with an AbortError DOMException when its signal aborts', async () => {
    // The internal abort controller is created lazily per operation; force
    // that initialization exactly like a demodulate message would.
    processor.resetAbortController();
    const signal = processor.abortController.signal;

    const waitPromise = processor.demodulate({ signal });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(processor.awaitingCallback).not.toBeNull();

    processor.abortController.abort();

    await expect(waitPromise).rejects.toBeInstanceOf(DOMException);
    await expect(waitPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(processor.awaitingCallback).toBeNull();
  });

  test('after abort, a subsequent demodulate resolves normally with new data', async () => {
    // First request is aborted while waiting
    const first = sendMessage(processor, {
      id: 'demod-first',
      type: 'demodulate',
      data: {}
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    await sendMessage(processor, { id: 'abort-2', type: 'abort', data: {} });
    await first;
    expect(processor.awaitingCallback).toBeNull();

    // Second request must be able to wait and then resolve
    const second = sendMessage(processor, {
      id: 'demod-second',
      type: 'demodulate',
      data: {}
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(processor.awaitingCallback).not.toBeNull();

    // Simulate one demodulated byte arriving from the audio graph
    processor.demodulatedBuffer.put(0x7E);
    const waiter = processor.awaitingCallback;
    processor.awaitingCallback = null;
    waiter();
    await second;

    const reply = latestPostedMessage(processor);
    expect(reply.id).toBe('demod-second');
    expect(reply.type).toBe('result');
    expect(reply.data.bytes).toEqual([0x7E]);
  });

  test('reset message clears pending waits, modulation and buffers and keeps core ready', async () => {
    // A demodulate request is pending ...
    const pendingDemod = sendMessage(processor, {
      id: 'demod-pending',
      type: 'demodulate',
      data: {}
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(processor.awaitingCallback).not.toBeNull();

    // ... plus stale received bytes
    processor.demodulatedBuffer.put(0x99);

    await sendMessage(processor, { id: 'reset-1', type: 'reset', data: {} });
    await pendingDemod;

    const demodReply = processor.port.postMessage.mock.calls
      .map((c: any[]) => c[0])
      .find((m: any) => m.id === 'demod-pending');
    expect(demodReply.type).toBe('error');
    expect(demodReply.data.message).toMatch(/aborted/i);

    const resetReply = processor.port.postMessage.mock.calls
      .map((c: any[]) => c[0])
      .find((m: any) => m.id === 'reset-1');
    expect(resetReply.data).toEqual({ success: true });

    expect(processor.awaitingCallback).toBeNull();
    expect(processor.pendingModulation).toBeNull();
    expect(processor.demodulatedBuffer.length).toBe(0);
    expect(processor.fskCore.isReady()).toBe(true);

    // The processor still serves a normal demodulate request afterwards
    processor.demodulatedBuffer.put(0x21);
    await sendMessage(processor, {
      id: 'demod-after-reset',
      type: 'demodulate',
      data: {}
    });
    const after = processor.port.postMessage.mock.calls
      .map((c: any[]) => c[0])
      .find((m: any) => m.id === 'demod-after-reset');
    expect(after.data.bytes).toEqual([0x21]);
  });

  test('reset followed by a full send->receive loopback succeeds', async () => {
    const payload = new Uint8Array([0x41, 0x42, 0x43]);

    await sendMessage(processor, { id: 'reset-2', type: 'reset', data: {} });
    expect(processor.fskCore.isReady()).toBe(true);

    const modDone = sendMessage(processor, {
      id: 'mod-after-reset',
      type: 'modulate',
      data: { bytes: Array.from(payload) }
    });
    await pumpModulation();
    await modDone;
    expect(processor.demodulatedBuffer.length).toBe(0);

    const received = await loopbackReceive(payload);
    expect(received).toEqual(Array.from(payload));
  });
});
