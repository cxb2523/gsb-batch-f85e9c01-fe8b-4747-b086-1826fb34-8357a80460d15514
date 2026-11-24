// Half-duplex reuse tests for FSKCore - Node.js compatible
// Covers: clean TX->RX switching on the same instance, reproducibility,
// and reset() semantics that keep the instance ready.
import { describe, test, expect, beforeEach } from 'vitest';
import { FSKCore, FSKConfig, DEFAULT_FSK_CONFIG } from '../../src/modems/fsk';

describe('FSKCore half-duplex send/receive reuse', () => {
  let fsk: FSKCore;

  beforeEach(() => {
    fsk = new FSKCore();
    fsk.configure({ ...DEFAULT_FSK_CONFIG } as FSKConfig);
  });

  test('two consecutive send->receive cycles return exactly the original bytes', async () => {
    const payloads = [
      new Uint8Array([0x41, 0x42, 0x43]),
      new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]),
    ];

    for (let round = 0; round < payloads.length; round++) {
      const payload = payloads[round];

      const signal = await fsk.modulateData(payload);
      const received = await fsk.demodulateData(signal);

      expect(received).toBeInstanceOf(Uint8Array);
      expect(received.length).toBe(payload.length);
      expect(Array.from(received)).toEqual(Array.from(payload));
    }

    // Each frame must have produced exactly one independent synchronization
    const status = fsk.getStatus();
    expect(status.syncDetections).toBe(payloads.length);
  });

  test('repeated send->receive with the same payload is reproducible', async () => {
    const payload = new Uint8Array([0x55, 0xAA, 0x7E, 0x00, 0xFF]);
    const firstRuns: number[][] = [];

    for (let round = 0; round < 3; round++) {
      const signal = await fsk.modulateData(payload);
      const received = await fsk.demodulateData(signal);
      expect(Array.from(received)).toEqual(Array.from(payload));
      firstRuns.push(Array.from(received));
    }

    // Every run must yield the identical, clean result - no preamble/SFD or
    // bytes from a previous frame may leak in
    for (let i = 1; i < firstRuns.length; i++) {
      expect(firstRuns[i]).toEqual(firstRuns[0]);
    }
  });

  test('reception interrupted without EOD does not contaminate the next frame', async () => {
    // First frame is cut off before it finishes, leaving the demodulator
    // mid-stream with no end-of-data silence
    const firstSignal = await fsk.modulateData(new Uint8Array([0xAA, 0xBB]));
    const cut = Math.floor(firstSignal.length * 0.6);
    const partial = await fsk.demodulateData(firstSignal.slice(0, cut));
    expect(partial).toBeInstanceOf(Uint8Array);

    // A fresh TX->RX cycle on the same instance must only contain the new frame
    const payload = new Uint8Array([0x11, 0x22, 0x33]);
    const signal = await fsk.modulateData(payload);
    const received = await fsk.demodulateData(signal);

    expect(received.length).toBe(payload.length);
    expect(Array.from(received)).toEqual(Array.from(payload));
    // The new frame produced exactly one fresh synchronization
    expect(fsk.getStatus().syncDetections).toBe(2);
  });

  test('reset() clears all demodulation state but keeps the instance ready', async () => {
    const firstPayload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

    const firstSignal = await fsk.modulateData(firstPayload);
    const firstResult = await fsk.demodulateData(firstSignal);
    expect(Array.from(firstResult)).toEqual(Array.from(firstPayload));

    const dirtyStatus = fsk.getStatus();
    expect(dirtyStatus.demodulationCalls).toBeGreaterThan(0);
    expect(dirtyStatus.totalSamplesProcessed).toBeGreaterThan(0);

    fsk.reset();

    // reset() must not require reconfiguration: the instance stays ready
    expect(fsk.isReady()).toBe(true);
    const cleanStatus = fsk.getStatus();
    expect(cleanStatus.byteBufferLength).toBe(0);
    expect(cleanStatus.receivedBitsLength).toBe(0);
    expect(cleanStatus.globalSampleCounter).toBe(0);
    expect(cleanStatus.frameStarted).toBe(false);
    expect(cleanStatus.demodulationCalls).toBe(0);
    expect(cleanStatus.syncDetections).toBe(0);
    expect(cleanStatus.totalSamplesProcessed).toBe(0);

    // Another full send->receive cycle works immediately after reset
    const nextPayload = new Uint8Array([0x61, 0x62, 0x63]);
    const nextSignal = await fsk.modulateData(nextPayload);
    const nextResult = await fsk.demodulateData(nextSignal);
    expect(Array.from(nextResult)).toEqual(Array.from(nextPayload));
    expect(fsk.isReady()).toBe(true);
  });

  test('reset() followed by another reset and then send->receive succeeds', async () => {
    fsk.reset();
    fsk.reset();
    expect(fsk.isReady()).toBe(true);

    const payload = new Uint8Array([0xDE, 0xAD]);
    const signal = await fsk.modulateData(payload);
    const received = await fsk.demodulateData(signal);

    expect(Array.from(received)).toEqual(Array.from(payload));
  });

  test('modulateData does not leave any demodulation residue', async () => {
    // Prime the demodulation chain with a full reception
    const priming = await fsk.modulateData(new Uint8Array([0x77]));
    await fsk.demodulateData(priming);
    expect(fsk.getStatus().syncDetections).toBe(1);

    // A modulation alone must wipe every demodulation artifact
    await fsk.modulateData(new Uint8Array([0x88]));
    const status = fsk.getStatus();
    expect(status.receivedBitsLength).toBe(0);
    expect(status.byteBufferLength).toBe(0);
    expect(status.frameStarted).toBe(false);
    expect(status.globalSampleCounter).toBe(0);

    // And the next reception starts from a single clean frame sync
    const payload = new Uint8Array([0x99, 0xAA]);
    const signal = await fsk.modulateData(payload);
    const received = await fsk.demodulateData(signal);
    expect(Array.from(received)).toEqual(Array.from(payload));
    expect(fsk.getStatus().syncDetections).toBe(2);
  });
});
