import * as loaderModule from '@cxing/media-loader';
import { PlayerLoadCancelledError, createPlayer } from './player.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (errorValue: unknown) => void;
};

/**
 * Controllable promise used to simulate out-of-order (late) load completion.
 */
const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (errorValue: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Lets every already-scheduled microtask/timer continuation run. */
const flushAsyncWork = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

const createTrack = ({
  trackId,
  mediaKind,
}: {
  trackId: string;
  mediaKind: loaderModule.LoadedTrackMediaKind;
}): loaderModule.LoadedTrack => ({
  trackId,
  sourceSummary: `${trackId}.zip`,
  audioBuffer: new ArrayBuffer(8),
  mediaKind,
  mediaMimeType: mediaKind === 'video' ? 'video/mp4' : 'audio/mpeg',
  audioMimeType: mediaKind === 'video' ? 'video/mp4' : 'audio/mpeg',
  hasGraphics: mediaKind === 'audio',
  cdgBytes: mediaKind === 'audio' ? new Uint8Array(24) : null,
  metadata: { title: trackId, artist: 'Artist', album: 'Album' },
  warnings: [],
});

type DeferredLoader = {
  loader: loaderModule.CdgLoader;
  /** Deferred per load() call, in call order. */
  requests: Array<Deferred<loaderModule.LoadedTrack>>;
};

/**
 * Loader whose calls each return a separately controllable promise, so tests
 * can resolve request #2 before request #1 to exercise late returns.
 */
const createDeferredLoader = (): DeferredLoader => {
  const requests: Array<Deferred<loaderModule.LoadedTrack>> = [];

  const loader = {
    load: (() => {
      const deferred = createDeferred<loaderModule.LoadedTrack>();
      requests.push(deferred);
      return deferred.promise;
    }) as loaderModule.CdgLoader['load'],
    probe: (() => {
      throw new Error('probe is not used in load-session tests.');
    }) as loaderModule.CdgLoader['probe'],
    cancel: (() => {
      // No-op: these tests model a loader that ignores cancellation and
      // resolves only when the test says so.
    }) as loaderModule.CdgLoader['cancel'],
    dispose: (() => {
      // No resources to release.
    }) as loaderModule.CdgLoader['dispose'],
  } as loaderModule.CdgLoader;

  return { loader, requests };
};

type Harness = {
  canvas: HTMLCanvasElement;
  audio: HTMLAudioElement;
  video: HTMLVideoElement | null;
  deferredLoader: DeferredLoader;
  player: ReturnType<typeof createPlayer>;
  createdObjectUrls: string[];
  revokedObjectUrls: string[];
  /** Present when `spyOnAudioListeners` was set; installed before construction. */
  audioAddEventListenerSpy?: ReturnType<typeof vi.spyOn>;
};

const createHarness = ({
  withVideo = false,
  spyOnAudioListeners = false,
}: {
  withVideo?: boolean;
  spyOnAudioListeners?: boolean;
} = {}): Harness => {
  const imageData = {
    data: new Uint8ClampedArray(300 * 216 * 4),
    width: 300,
    height: 216,
  } as unknown as ImageData;

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        imageSmoothingEnabled: false,
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        createImageData: vi.fn(() => imageData),
        putImageData: vi.fn(),
      }) as unknown as CanvasRenderingContext2D,
  );

  const canvas = document.createElement('canvas');
  const audio = document.createElement('audio');
  const video = withVideo ? document.createElement('video') : null;

  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {
    // jsdom does not implement media pausing.
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
    async () => undefined,
  );
  vi.spyOn(audio, 'load').mockImplementation(() => {
    // jsdom does not implement media loading.
  });

  if (video) {
    vi.spyOn(video, 'canPlayType').mockReturnValue('probably');
    vi.spyOn(video, 'load').mockImplementation(() => {
      // Simulate a decodable video: expose dimensions and advance readyState so
      // the attach path does not wait on events the mock elements never emit.
      Object.defineProperty(video, 'videoWidth', {
        configurable: true,
        value: 1280,
      });
      Object.defineProperty(video, 'videoHeight', {
        configurable: true,
        value: 720,
      });
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: HTMLMediaElement.HAVE_ENOUGH_DATA,
      });
    });
  }

  const createdObjectUrls: string[] = [];
  const revokedObjectUrls: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(
    (blob: Blob | MediaSource) => {
      void blob;
      const url = `blob:track-${createdObjectUrls.length + 1}`;
      createdObjectUrls.push(url);
      return url;
    },
  );
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revokedObjectUrls.push(url);
  });

  const deferredLoader = createDeferredLoader();

  // Install before construction so the constructor's initial bind is counted.
  const audioAddEventListenerSpy = spyOnAudioListeners
    ? vi.spyOn(audio, 'addEventListener')
    : undefined;

  const player = createPlayer({
    options: {
      canvas,
      audio,
      ...(video ? { video } : {}),
      loader: deferredLoader.loader,
      loadTransport: 'main-thread',
    },
  });

  return {
    canvas,
    audio,
    video,
    deferredLoader,
    player,
    createdObjectUrls,
    revokedObjectUrls,
    ...(audioAddEventListenerSpy ? { audioAddEventListenerSpy } : {}),
  };
};

describe('CdgPlayer load sessions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('commits sequential track changes in order and revokes the replaced object URL', async () => {
    const harness = createHarness({ withVideo: true });
    const { player, deferredLoader, audio, video } = harness;

    const first = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });
    deferredLoader.requests[0]?.resolve(
      createTrack({ trackId: 'track-1', mediaKind: 'audio' }),
    );
    await expect(first).resolves.toMatchObject({ trackId: 'track-1' });

    const audioSrcAfterFirst = audio.getAttribute('src');

    const second = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });
    deferredLoader.requests[1]?.resolve(
      createTrack({ trackId: 'track-2', mediaKind: 'video' }),
    );
    await expect(second).resolves.toMatchObject({ trackId: 'track-2' });

    expect(player.getState().status).toBe('ready');
    expect(player.getState().trackId).toBe('track-2');
    expect(player['activeMedia']).toBe(video);
    expect(harness.revokedObjectUrls).toContain(audioSrcAfterFirst);
    expect(video?.getAttribute('src')).toBe(harness.createdObjectUrls[1]);

    player.dispose();
  });

  it('ignores a late result from a superseded session and keeps the newer track authoritative', async () => {
    const harness = createHarness();
    const { player, deferredLoader } = harness;

    const stateChanges: unknown[] = [];
    const errorEvents: unknown[] = [];
    player.addEventListener('statechange', (event) => {
      stateChanges.push((event as CustomEvent).detail);
    });
    player.addEventListener('error', (event) => {
      errorEvents.push((event as CustomEvent).detail);
    });

    // Start request #1, then immediately supersede it with request #2.
    const staleLoad = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });
    const currentLoad = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });

    expect(deferredLoader.requests).toHaveLength(2);

    // Resolve #2 first so it becomes the committed track.
    deferredLoader.requests[1]?.resolve(
      createTrack({ trackId: 'current-track', mediaKind: 'audio' }),
    );
    await expect(currentLoad).resolves.toMatchObject({
      trackId: 'current-track',
    });

    const committedState = player.getState();
    const committedInstructions = player['cdgPlayer'].instructions;
    const objectUrlsAfterCurrent = harness.createdObjectUrls.length;
    const stateChangesAfterCurrent = stateChanges.length;

    // Now the stale #1 finally returns. It must be discarded wholesale.
    deferredLoader.requests[0]?.resolve(
      createTrack({ trackId: 'stale-track', mediaKind: 'video' }),
    );

    await expect(staleLoad).rejects.toBeInstanceOf(PlayerLoadCancelledError);
    await expect(staleLoad).rejects.toMatchObject({ reason: 'superseded' });
    await flushAsyncWork();

    expect(player.getState()).toEqual(committedState);
    expect(player.getState().trackId).toBe('current-track');
    expect(player['cdgPlayer'].instructions).toBe(committedInstructions);
    expect(stateChanges.length).toBe(stateChangesAfterCurrent);
    expect(errorEvents).toHaveLength(0);
    // The discarded session never minted a blob.
    expect(harness.createdObjectUrls.length).toBe(objectUrlsAfterCurrent);

    player.dispose();
  });

  it('aborts an in-flight video attach when a newer load supersedes it', async () => {
    const harness = createHarness({ withVideo: true });
    const { player, deferredLoader, video } = harness;

    if (!video) {
      throw new Error('video harness expected');
    }

    let readyStateValue = 0;
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      get: () => readyStateValue,
    });
    Object.defineProperty(video, 'videoWidth', {
      configurable: true,
      get: () => 1280,
    });
    Object.defineProperty(video, 'videoHeight', {
      configurable: true,
      get: () => 720,
    });

    // Keep the video in a pending state so the attach blocks on readiness and
    // can be superseded mid-wait. (The shared harness mock advances readyState.)
    vi.spyOn(video, 'load').mockImplementation(() => {
      // Intentionally never signals readiness.
    });

    const staleVideoLoad = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });
    deferredLoader.requests[0]?.resolve(
      createTrack({ trackId: 'video-track', mediaKind: 'video' }),
    );
    // Let the video attach reach its metadata/canplay wait.
    await flushAsyncWork();
    const videoObjectUrl = harness.createdObjectUrls[0];
    expect(video.getAttribute('src')).toBe(videoObjectUrl);

    const currentLoad = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });
    deferredLoader.requests[1]?.resolve(
      createTrack({ trackId: 'audio-track', mediaKind: 'audio' }),
    );
    await expect(currentLoad).resolves.toMatchObject({
      trackId: 'audio-track',
    });

    await expect(staleVideoLoad).rejects.toMatchObject({
      reason: 'superseded',
    });

    // The superseded session must not keep its blob attached to the video element.
    expect(harness.revokedObjectUrls).toContain(videoObjectUrl);
    expect(video.getAttribute('src')).not.toBe(videoObjectUrl);
    expect(player.getState().trackId).toBe('audio-track');
    expect(player['activeMedia']).toBe(harness.audio);

    readyStateValue = HTMLMediaElement.HAVE_ENOUGH_DATA;
    player.dispose();
  });

  it('drops a load result that arrives after dispose without events or leaked blobs', async () => {
    const harness = createHarness();
    const { player, deferredLoader, audio } = harness;

    const stateChangesAfterDispose: unknown[] = [];
    const errorEvents: unknown[] = [];

    const pendingLoad = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });

    player.dispose();

    // Attach after dispose so only post-dispose dispatches are observed.
    player.addEventListener('statechange', (event) => {
      stateChangesAfterDispose.push((event as CustomEvent).detail);
    });
    player.addEventListener('error', (event) => {
      errorEvents.push((event as CustomEvent).detail);
    });

    deferredLoader.requests[0]?.resolve(
      createTrack({ trackId: 'late-track', mediaKind: 'audio' }),
    );

    await expect(pendingLoad).rejects.toBeInstanceOf(PlayerLoadCancelledError);
    await expect(pendingLoad).rejects.toMatchObject({ reason: 'disposed' });
    await flushAsyncWork();

    expect(stateChangesAfterDispose).toHaveLength(0);
    expect(errorEvents).toHaveLength(0);
    expect(harness.createdObjectUrls).toHaveLength(0);
    expect(audio.getAttribute('src')).toBeNull();
    expect(player.getState().trackId).toBeNull();
  });

  it('rejects a load issued after dispose without starting a session', async () => {
    const harness = createHarness();
    const { player, deferredLoader } = harness;
    player.dispose();

    const lateLoad = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });

    await expect(lateLoad).rejects.toMatchObject({ reason: 'disposed' });
    expect(deferredLoader.requests).toHaveLength(0);
    expect(harness.createdObjectUrls).toHaveLength(0);
  });

  it('does not surface an error from a superseded session', async () => {
    const harness = createHarness();
    const { player, deferredLoader } = harness;

    const errorEvents: unknown[] = [];
    player.addEventListener('error', (event) => {
      errorEvents.push((event as CustomEvent).detail);
    });

    const staleLoad = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });
    const currentLoad = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });

    deferredLoader.requests[1]?.resolve(
      createTrack({ trackId: 'current-track', mediaKind: 'audio' }),
    );
    await expect(currentLoad).resolves.toMatchObject({
      trackId: 'current-track',
    });

    // The stale request now *fails*. Its failure belongs to a dead session and
    // must neither flip status to `error` nor emit an `error` event.
    deferredLoader.requests[0]?.reject(new Error('stale load failed'));

    await expect(staleLoad).rejects.toBeInstanceOf(PlayerLoadCancelledError);
    await expect(staleLoad).rejects.toMatchObject({ reason: 'superseded' });
    await flushAsyncWork();

    expect(errorEvents).toHaveLength(0);
    expect(player.getState().status).toBe('ready');
    expect(player.getState().trackId).toBe('current-track');

    player.dispose();
  });

  it('still reports ready state and statechange events for a single load', async () => {
    const harness = createHarness();
    const { player, deferredLoader } = harness;

    const statuses: string[] = [];
    player.addEventListener('statechange', (event) => {
      const detail = (event as CustomEvent).detail as {
        next: { status: string };
      };
      statuses.push(detail.next.status);
    });

    const loadPromise = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });
    deferredLoader.requests[0]?.resolve(
      createTrack({ trackId: 'solo-track', mediaKind: 'audio' }),
    );
    await expect(loadPromise).resolves.toMatchObject({
      trackId: 'solo-track',
    });

    expect(statuses).toContain('loading');
    expect(statuses).toContain('ready');
    expect(player.getState().status).toBe('ready');
    expect(player.getState().trackId).toBe('solo-track');

    player.dispose();
  });

  it('dispose drops a pending video-attach result without events', async () => {
    const harness = createHarness({ withVideo: true });
    const { player, deferredLoader, video } = harness;

    if (!video) {
      throw new Error('video harness expected');
    }

    // Keep the video request pending so dispose lands mid-attach.
    vi.spyOn(video, 'load').mockImplementation(() => {
      // Never signals readiness.
    });
    Object.defineProperty(video, 'readyState', {
      configurable: true,
      value: 0,
    });

    const errorEvents: unknown[] = [];
    player.addEventListener('error', (event) => {
      errorEvents.push((event as CustomEvent).detail);
    });

    const pendingLoad = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });
    deferredLoader.requests[0]?.resolve(
      createTrack({ trackId: 'video-track', mediaKind: 'video' }),
    );
    await flushAsyncWork();
    const videoObjectUrl = harness.createdObjectUrls[0];
    expect(video.getAttribute('src')).toBe(videoObjectUrl);

    player.dispose();
    await expect(pendingLoad).rejects.toMatchObject({ reason: 'disposed' });
    await flushAsyncWork();

    expect(errorEvents).toHaveLength(0);
    expect(harness.revokedObjectUrls).toContain(videoObjectUrl);
    expect(video.getAttribute('src')).toBeNull();
  });

  it('does not stack duplicate transport listeners on the same media element', async () => {
    const harness = createHarness({ spyOnAudioListeners: true });
    const { player, deferredLoader, audioAddEventListenerSpy } = harness;

    if (!audioAddEventListenerSpy) {
      throw new Error('listener spy expected');
    }

    const addSpy = audioAddEventListenerSpy;

    const first = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });
    deferredLoader.requests[0]?.resolve(
      createTrack({ trackId: 'track-1', mediaKind: 'audio' }),
    );
    await first;

    const second = player.load({
      input: { kind: 'arrayBuffer', arrayBuffer: new ArrayBuffer(8) },
    });
    deferredLoader.requests[1]?.resolve(
      createTrack({ trackId: 'track-2', mediaKind: 'audio' }),
    );
    await second;

    const transportEvents = ['timeupdate', 'play', 'pause', 'ended'];
    for (const eventName of transportEvents) {
      const count = addSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === eventName,
      ).length;
      // Bound once in the constructor; reusing the same element must not add a
      // second, duplicate handler.
      expect(count).toBe(1);
    }

    player.dispose();
  });
});
