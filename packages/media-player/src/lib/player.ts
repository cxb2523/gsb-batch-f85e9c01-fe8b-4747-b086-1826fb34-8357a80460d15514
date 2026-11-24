import {
  CDGPlayer,
  HEIGHT,
  WIDTH,
  type CdgInstructionLike,
  type CdgRenderContext,
} from '@cxing/media-parser-cdg';
import { createScopedLogger } from '@cxing/logger';
import {
  createLoader,
  type CdgLoader,
  LoaderError,
  type LoadedTrack,
  type LoadedTrackMediaKind,
  type LoaderInput,
  type LoaderOptions,
  loadInWorker,
} from '@cxing/media-loader';
import { createRenderer, type CdgRenderer } from './renderer.js';
import {
  createAudioEngine,
  type CdgAudioEngine,
  type PlayerAudioEngineMode,
} from './audio-engine.js';
import {
  MAX_PITCH_SEMITONES,
  MAX_SEEK_PERCENT,
  MAX_TEMPO,
  MAX_VOLUME,
  MIN_PITCH_SEMITONES,
  MIN_SEEK_PERCENT,
  MIN_TEMPO,
  MIN_VOLUME,
} from './utils/player.constants.js';
import {
  asMilliseconds,
  canElementPlayMimeType,
  clamp,
  createInitialState,
} from './utils/player.functions.js';

/** Playback lifecycle states for high-level player consumers. */
export type PlayerStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'error';

/** Snapshot of externally observable player state. */
export interface PlayerState {
  status: PlayerStatus;
  trackId: string | null;
  currentTimeMs: number;
  durationMs: number;
  volume: number;
  playbackRate: number;
  pitchSemitones: number;
}

/** Input options for load requests. */
export interface PlayerLoadOptions {
  input: LoaderInput;
  loaderOptions?: LoaderOptions;
  autoplay?: boolean;
}

/** Construction options for CdgPlayer runtime wrapper. */
export interface CdgPlayerOptions {
  canvas: HTMLCanvasElement;
  audio: HTMLAudioElement;
  video?: HTMLVideoElement;
  loader?: CdgLoader;
  debug?: boolean;
  renderMode?: 'auto' | 'main-thread' | 'worker';
  loadTransport?: 'auto' | 'main-thread' | 'worker';
  audioEngineMode?: PlayerAudioEngineMode;
}

/** Event detail payload for `statechange` events. */
export interface PlayerStateChangeDetail {
  previous: PlayerState;
  next: PlayerState;
}

type CdgCorePlayerAsyncLoad = CDGPlayer & {
  loadAsync?: (args: { data: Uint8Array }) => Promise<CDGPlayer>;
};

/** Deferred CDG work a session applies only at commit time. */
type CdgCommitPayload =
  | { kind: 'async'; instructions: CdgInstructionLike[] }
  | { kind: 'sync'; bytes: Uint8Array }
  | null;

/** Reason an in-flight load session stopped being authoritative. */
export type PlayerLoadCancelledReason = 'superseded' | 'disposed';

/**
 * Rejection value produced when a load session is invalidated before it could
 * commit. Late results from cancelled sessions never emit `statechange` or
 * `error` and never touch player state, CDG output, or media elements.
 *
 * Consumers that fire-and-forget rapid track switches can treat this as a
 * no-op; loads that already fetched their track resolve normally instead.
 */
export class PlayerLoadCancelledError extends Error {
  readonly reason: PlayerLoadCancelledReason;

  constructor({ reason }: { reason: PlayerLoadCancelledReason }) {
    super(
      reason === 'disposed'
        ? 'Player was disposed before the load completed.'
        : 'Load was superseded by a newer request.',
    );
    this.name = 'PlayerLoadCancelledError';
    this.reason = reason;
  }
}

/**
 * Returns true when a rejected `load()` value is a cancelled-session signal
 * rather than a real playback failure. Use this to ignore stale loads when the
 * UI switches tracks quickly.
 */
export const isPlayerLoadCancelledError = (
  errorValue: unknown,
): errorValue is PlayerLoadCancelledError =>
  errorValue instanceof PlayerLoadCancelledError;

/**
 * Independent, cancellable load attempt. Every `load()` call owns exactly one
 * session; starting a new one invalidates the previous session so its late
 * results can no longer mutate player state, CDG state, or media elements.
 */
interface LoadSession {
  readonly id: number;
  cancelled: boolean;
  cancelReason: PlayerLoadCancelledReason | null;
  /** Object URL owned by this session until it is committed to the player. */
  objectUrl: string | null;
  /** Media element that received `objectUrl`, if any. */
  mediaForObjectUrl: HTMLMediaElement | null;
  /** Aborts awaits that are only meaningful while the session is current. */
  readonly controller: AbortController;
}

/**
 * High-level karaoke player that orchestrates loading and audio playback.
 * CDG rendering/synchronization are enabled only when the loaded track includes
 * a graphics stream.
 */
export class CdgPlayer extends EventTarget {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly audio: HTMLAudioElement;
  private readonly video: HTMLVideoElement | null;
  private readonly loader: CdgLoader;
  private readonly ownsLoader: boolean;
  private readonly logger: ReturnType<typeof createScopedLogger>;
  private readonly debug: boolean;
  private readonly loadTransport: 'auto' | 'main-thread' | 'worker';
  private readonly cdgPlayer: CDGPlayer;
  private readonly renderer: CdgRenderer;
  private readonly audioEngineMode: PlayerAudioEngineMode;
  private readonly audioEnginesByMedia = new Map<
    HTMLMediaElement,
    CdgAudioEngine
  >();

  private audioEngine: CdgAudioEngine;
  private activeMedia: HTMLMediaElement;
  private activeMediaKind: LoadedTrackMediaKind = 'audio';

  private state: PlayerState = createInitialState();
  private currentObjectUrl: string | null = null;
  private hasGraphicsTrack = false;

  /** Monotonic counter used to mint unique load-session ids. */
  private loadSessionCounter = 0;
  /** Session whose result is currently allowed to mutate player state. */
  private activeLoadSession: LoadSession | null = null;
  /** True once `dispose()` ran; all in-flight and future sessions are dead. */
  private disposed = false;
  /** Media elements that currently have the player's transport listeners. */
  private readonly boundMedia = new Set<HTMLMediaElement>();

  /**
   * Creates a player bound to canvas/audio elements and optional strategy overrides.
   */
  constructor({
    canvas,
    audio,
    video,
    loader,
    debug = false,
    renderMode = 'auto',
    loadTransport = 'auto',
    audioEngineMode = 'auto',
  }: CdgPlayerOptions) {
    super();
    this.canvas = canvas;
    this.audio = audio;
    this.video = video ?? null;
    this.debug = debug;
    this.logger = createScopedLogger({ scope: 'cdg-player', debug });
    this.loader = loader ?? createLoader({ debug });
    this.ownsLoader = !loader;
    this.loadTransport = loadTransport;
    this.audioEngineMode = audioEngineMode;
    this.activeMedia = this.audio;

    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;

    const resolvedContext = this.canvas.getContext('2d');
    if (!resolvedContext) {
      throw new Error('Unable to create 2D context for karaoke player canvas.');
    }

    this.ctx = resolvedContext;
    this.ctx.imageSmoothingEnabled = false;

    this.renderer = createRenderer({
      mode: renderMode,
      canvas: this.canvas,
      ctx: this.ctx,
    });

    this.audioEngine = createAudioEngine({
      media: this.activeMedia,
      mode: audioEngineMode,
      debug,
    });
    this.audioEnginesByMedia.set(this.activeMedia, this.audioEngine);

    this.cdgPlayer = new CDGPlayer({
      afterRender: (renderContext: CdgRenderContext) => {
        this.renderer.render({ renderContext });
      },
    });

    this.audio.preload = 'auto';
    if (this.video) {
      this.video.preload = 'auto';
      this.video.controls = false;
      this.video.playsInline = true;
    }

    this.bindMediaListeners({ media: this.activeMedia });
  }

  /**
   * Returns immutable player state snapshot.
   */
  getState(): Readonly<PlayerState> {
    return this.state;
  }

  /**
   * Loads track assets and prepares playback for either karaoke (audio+graphics)
   * or audio-only content.
   *
   * Each call starts an independent, cancellable session. Starting a newer load
   * invalidates the older one: a superseded session rejects with
   * {@link PlayerLoadCancelledError} and never mutates player state, CDG output,
   * or media elements afterwards.
   */
  async load({
    input,
    loaderOptions,
    autoplay = false,
  }: PlayerLoadOptions): Promise<LoadedTrack> {
    if (this.disposed) {
      throw new PlayerLoadCancelledError({ reason: 'disposed' });
    }

    const session = this.beginLoadSession();

    this.applyState({ status: 'loading' });
    this.logger.debug({
      message: 'load:start',
      sessionId: session.id,
      inputKind: input.kind,
      loadTransport: this.loadTransport,
      autoplay,
    });

    try {
      const useWorkerLoader = this.shouldUseWorkerLoader();
      this.logger.debug({
        message: 'load:transport-selected',
        useWorkerLoader,
        loadTransport: this.loadTransport,
      });
      let loadedTrack: LoadedTrack;
      const effectiveLoaderOptions: LoaderOptions = {
        ...(loaderOptions ?? {}),
        debug: loaderOptions?.debug ?? this.debug,
        // Propagate session cancellation to real loaders so superseded fetches
        // stop early. A caller-supplied signal is combined, not replaced.
        signal: this.resolveLoadSignal({
          session,
          ...(loaderOptions?.signal
            ? { externalSignal: loaderOptions.signal }
            : {}),
        }),
      };

      if (useWorkerLoader) {
        try {
          loadedTrack = await loadInWorker({
            input,
            options: effectiveLoaderOptions,
          });
          this.logger.debug({
            message: 'load:worker-success',
            trackId: loadedTrack.trackId,
            sourceSummary: loadedTrack.sourceSummary,
          });
        } catch (errorValue: unknown) {
          this.logger.debug({ message: 'load:worker-error', errorValue });
          // A superseded/disposed session must never fall back and keep loading.
          this.assertSessionActive({ session });
          if (!this.shouldFallbackToMainThreadLoad({ errorValue })) {
            throw errorValue;
          }

          this.logger.debug({ message: 'load:fallback-main-thread' });

          loadedTrack = await this.loader.load({
            input,
            options: effectiveLoaderOptions,
          });
          this.logger.debug({
            message: 'load:main-thread-success-after-fallback',
            trackId: loadedTrack.trackId,
            sourceSummary: loadedTrack.sourceSummary,
          });
        }
      } else {
        loadedTrack = await this.loader.load({
          input,
          options: effectiveLoaderOptions,
        });
        this.logger.debug({
          message: 'load:main-thread-success',
          trackId: loadedTrack.trackId,
          sourceSummary: loadedTrack.sourceSummary,
        });
      }

      this.assertSessionActive({ session });

      // The fetch succeeded, but a newer load may still have replaced us while
      // the media attach awaited readiness. Discard instead of overwriting.
      await this.attachLoadedTrack({ loadedTrack, session });
      this.assertSessionActive({ session });

      this.applyState({
        status: 'ready',
        trackId: loadedTrack.trackId,
      });

      if (autoplay) {
        await this.startPlayback({ session });
        this.assertSessionActive({ session });
      }

      this.logger.debug({
        message: 'load:ready',
        sessionId: session.id,
        trackId: loadedTrack.trackId,
      });

      return loadedTrack;
    } catch (errorValue: unknown) {
      if (errorValue instanceof PlayerLoadCancelledError) {
        this.releaseSessionObjectUrl({ session });
        this.logger.debug({
          message: 'load:cancelled',
          sessionId: session.id,
          reason: errorValue.reason,
        });
        throw errorValue;
      }

      if (!this.isSessionActive({ session })) {
        // A late error from a superseded/disposed session is dropped: it must
        // not drive `error` state or dispatch `error` for the current track.
        this.releaseSessionObjectUrl({ session });
        this.logger.debug({
          message: 'load:error-ignored-stale-session',
          sessionId: session.id,
        });
        throw new PlayerLoadCancelledError({
          reason: this.disposed ? 'disposed' : 'superseded',
        });
      }

      // An error from the active session is surfaced, but any blob it had
      // already attached must not survive: the failed track never committed.
      this.releaseSessionObjectUrl({ session });
      this.logger.error({ message: 'load:error', errorValue });
      this.applyState({ status: 'error' });
      this.dispatchEvent(new CustomEvent('error', { detail: { errorValue } }));
      throw errorValue;
    } finally {
      if (this.activeLoadSession === session) {
        this.activeLoadSession = null;
      }
    }
  }

  /**
   * Starts media playback and, when graphics exist, advances CDG frame playback.
   */
  async play(): Promise<void> {
    await this.startPlayback({ session: null });
  }

  /**
   * Shared playback start. When a `session` is supplied (autoplay after load),
   * state is only advanced while that session is still current, so a superseded
   * load cannot force a stale `playing` state.
   */
  private async startPlayback({
    session,
  }: {
    session: LoadSession | null;
  }): Promise<void> {
    this.logger.debug({
      message: 'play:called',
      currentTime: this.activeMedia.currentTime,
      paused: this.activeMedia.paused,
      readyState: this.activeMedia.readyState,
      src: this.activeMedia.src,
      media: this.activeMedia,
    });
    try {
      await this.audioEngine.play();
      this.logger.debug({
        message: 'play:resolved',
        currentTime: this.activeMedia.currentTime,
        paused: this.activeMedia.paused,
        readyState: this.activeMedia.readyState,
        src: this.activeMedia.src,
        media: this.activeMedia,
      });
    } catch (err) {
      this.logger.debug({ message: 'play:error', errorValue: err });
    }

    if (session && !this.isSessionActive({ session })) {
      return;
    }

    if (this.hasGraphicsTrack) {
      this.cdgPlayer.play();
    }
    this.applyState({ status: 'playing' });
  }

  /**
   * Pauses media playback and, when graphics exist, pauses CDG frame playback.
   */
  pause(): void {
    this.audioEngine.pause();
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.stop();
    }

    if (this.state.status !== 'error') {
      this.applyState({ status: 'paused' });
    }
  }

  /**
   * Stops playback and rewinds to beginning.
   */
  stop(): void {
    this.pause();
    this.audioEngine.stop();
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.reset().render();
    }
    this.applyState({
      status: this.state.trackId ? 'ready' : 'idle',
      currentTimeMs: 0,
    });
  }

  /**
   * Seeks by percentage of track duration and re-syncs CDG timing when graphics
   * are present.
   */
  seek({ percentage }: { percentage: number }): void {
    if (
      !Number.isFinite(this.activeMedia.duration) ||
      this.activeMedia.duration <= 0
    ) {
      return;
    }

    const clampedPercentage = clamp({
      value: percentage,
      min: MIN_SEEK_PERCENT,
      max: MAX_SEEK_PERCENT,
    });
    const targetSeconds = (clampedPercentage / 100) * this.activeMedia.duration;
    this.activeMedia.currentTime = targetSeconds;
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.sync({ ms: asMilliseconds({ seconds: targetSeconds }) });
    }
    this.applyState({
      currentTimeMs: asMilliseconds({ seconds: targetSeconds }),
    });
  }

  /**
   * Sets playback output volume.
   */
  setVolume({ value }: { value: number }): void {
    const nextVolume = clamp({
      value,
      min: MIN_VOLUME,
      max: MAX_VOLUME,
    });
    this.audioEngine.setVolume({ value: nextVolume });
    this.applyState({ volume: nextVolume });
  }

  /**
   * Backward-compatible alias for tempo adjustment.
   */
  setPlaybackRate({ value }: { value: number }): void {
    this.setTempo({ value });
  }

  /**
   * Sets tempo multiplier.
   */
  setTempo({ value }: { value: number }): void {
    const nextTempo = clamp({
      value,
      min: MIN_TEMPO,
      max: MAX_TEMPO,
    });
    this.audioEngine.setTempo({ value: nextTempo });
    this.applyState({ playbackRate: nextTempo });
  }

  /**
   * Sets key shift in semitones.
   */
  setPitchSemitones({ value }: { value: number }): void {
    const nextPitchSemitones = Math.round(
      clamp({
        value,
        min: MIN_PITCH_SEMITONES,
        max: MAX_PITCH_SEMITONES,
      }),
    );
    this.audioEngine.setPitchSemitones({ value: nextPitchSemitones });
    this.applyState({ pitchSemitones: nextPitchSemitones });
  }

  /**
   * Releases player resources and event listeners.
   *
   * Any in-flight load session is invalidated immediately; its late results are
   * discarded without dispatching `statechange` or `error`.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.logger.debug({ message: 'dispose:start' });
    this.disposed = true;

    const pendingSession = this.activeLoadSession;
    this.cancelLoadSession({ session: pendingSession, reason: 'disposed' });
    if (pendingSession) {
      // Release synchronously so no blob outlives teardown, even though the
      // in-flight load's catch handler will also run later.
      this.releaseSessionObjectUrl({ session: pendingSession });
    }
    this.activeLoadSession = null;

    this.stop();
    for (const media of [...this.boundMedia]) {
      this.unbindMediaListeners({ media });
    }
    this.boundMedia.clear();
    this.releaseObjectUrl();

    if (this.ownsLoader) {
      this.logger.debug({ message: 'dispose:loader' });
      this.loader.dispose();
    }

    this.logger.debug({ message: 'dispose:renderer' });
    this.renderer.dispose();
    this.logger.debug({ message: 'dispose:audioEngine' });
    for (const engine of new Set(this.audioEnginesByMedia.values())) {
      engine.dispose();
    }
    this.audioEnginesByMedia.clear();
    this.logger.debug({ message: 'dispose:done' });
  }

  private beginLoadSession(): LoadSession {
    this.cancelLoadSession({
      session: this.activeLoadSession,
      reason: 'superseded',
    });

    const session: LoadSession = {
      id: (this.loadSessionCounter += 1),
      cancelled: false,
      cancelReason: null,
      objectUrl: null,
      mediaForObjectUrl: null,
      controller: new AbortController(),
    };

    this.activeLoadSession = session;
    return session;
  }

  private cancelLoadSession({
    session,
    reason,
  }: {
    session: LoadSession | null;
    reason: PlayerLoadCancelledReason;
  }): void {
    if (!session || session.cancelled) {
      return;
    }

    session.cancelled = true;
    session.cancelReason = reason;
    session.controller.abort(new PlayerLoadCancelledError({ reason }));
  }

  private isSessionActive({ session }: { session: LoadSession }): boolean {
    return (
      !this.disposed && !session.cancelled && this.activeLoadSession === session
    );
  }

  /**
   * Combines the session's cancellation signal with any caller-provided signal.
   * `AbortSignal.any` is preferred; a manual bridge is used when unavailable.
   */
  private resolveLoadSignal({
    session,
    externalSignal,
  }: {
    session: LoadSession;
    externalSignal?: AbortSignal;
  }): AbortSignal {
    const sessionSignal = session.controller.signal;
    if (!externalSignal) {
      return sessionSignal;
    }

    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([sessionSignal, externalSignal]);
    }

    const bridged = new AbortController();
    const abort = (): void => bridged.abort();
    if (sessionSignal.aborted || externalSignal.aborted) {
      bridged.abort();
    } else {
      sessionSignal.addEventListener('abort', abort, { once: true });
      externalSignal.addEventListener('abort', abort, { once: true });
    }
    return bridged.signal;
  }

  private assertSessionActive({ session }: { session: LoadSession }): void {
    if (this.isSessionActive({ session })) {
      return;
    }

    throw new PlayerLoadCancelledError({
      reason:
        this.disposed || session.cancelReason === 'disposed'
          ? 'disposed'
          : 'superseded',
    });
  }

  /**
   * Attaches a loaded track to the player. All mutations are deferred to a
   * synchronous commit that only runs while `session` is still the current one,
   * so a superseded load can never overwrite player, CDG, or media-element
   * state.
   */
  private async attachLoadedTrack({
    loadedTrack,
    session,
  }: {
    loadedTrack: LoadedTrack;
    session: LoadSession;
  }): Promise<void> {
    this.assertSessionActive({ session });

    const resolvedMediaKind: LoadedTrackMediaKind =
      loadedTrack.mediaKind ?? 'audio';
    const resolvedMediaMimeType =
      loadedTrack.mediaMimeType ?? loadedTrack.audioMimeType;
    const nextMedia = this.resolveMediaElementForTrack({ loadedTrack });

    this.logger.debug({
      message: 'attach:start',
      sessionId: session.id,
      trackId: loadedTrack.trackId,
      mediaKind: resolvedMediaKind,
      mediaMimeType: resolvedMediaMimeType,
      hasGraphics: loadedTrack.hasGraphics,
      cdgBytes: loadedTrack.cdgBytes?.byteLength ?? 0,
      audioBytes: loadedTrack.audioBuffer.byteLength,
    });

    if (
      resolvedMediaKind === 'video' &&
      !canElementPlayMimeType({
        media: nextMedia,
        mimeType: resolvedMediaMimeType,
      })
    ) {
      throw new Error(
        `This browser cannot play ${resolvedMediaKind} format ${resolvedMediaMimeType}.`,
      );
    }

    const hasGraphicsTrack =
      loadedTrack.hasGraphics && loadedTrack.cdgBytes !== null;

    // Prepare CDG data without mutating the live player. The async path parses
    // into an isolated candidate; the sync path defers the live `load` call to
    // the synchronous commit so a superseded session can never switch the
    // on-screen instructions mid-attach.
    let cdgPayload: CdgCommitPayload = null;

    if (hasGraphicsTrack && loadedTrack.cdgBytes) {
      const corePlayer = this.cdgPlayer as CdgCorePlayerAsyncLoad;
      if (typeof corePlayer.loadAsync === 'function') {
        this.logger.debug({ message: 'attach:core-loadAsync' });
        const candidate = new CDGPlayer();
        await candidate.loadAsync({ data: loadedTrack.cdgBytes });
        cdgPayload = { kind: 'async', instructions: candidate.instructions };
        this.assertSessionActive({ session });
      } else {
        this.logger.debug({ message: 'attach:core-load-sync' });
        cdgPayload = { kind: 'sync', bytes: loadedTrack.cdgBytes };
      }
    }

    this.assertSessionActive({ session });

    const mediaBlob = new Blob([loadedTrack.audioBuffer], {
      type: resolvedMediaMimeType,
    });
    const objectUrl = URL.createObjectURL(mediaBlob);
    session.objectUrl = objectUrl;
    session.mediaForObjectUrl = nextMedia;

    nextMedia.src = objectUrl;
    nextMedia.load();

    this.logger.debug({
      message: 'attach:media-source-set',
      sessionId: session.id,
      mediaKind: resolvedMediaKind,
      objectUrl,
    });

    if (resolvedMediaKind === 'video') {
      await this.waitForMediaCanPlay({
        media: nextMedia,
        mediaKind: resolvedMediaKind,
        signal: session.controller.signal,
      });
      this.assertSessionActive({ session });
    }

    this.commitLoadedTrack({
      session,
      media: nextMedia,
      mediaKind: resolvedMediaKind,
      objectUrl,
      hasGraphicsTrack,
      cdgPayload,
    });

    this.logger.debug({
      message: 'attach:media-bound',
      sessionId: session.id,
      mediaKind: this.activeMediaKind,
      objectUrl: this.currentObjectUrl,
    });
  }

  /**
   * Synchronous commit of an attached track. Runs only for the active session.
   */
  private commitLoadedTrack({
    session,
    media,
    mediaKind,
    objectUrl,
    hasGraphicsTrack,
    cdgPayload,
  }: {
    session: LoadSession;
    media: HTMLMediaElement;
    mediaKind: LoadedTrackMediaKind;
    objectUrl: string;
    hasGraphicsTrack: boolean;
    cdgPayload: CdgCommitPayload;
  }): void {
    this.assertSessionActive({ session });

    if (this.activeMedia !== media) {
      this.unbindMediaListeners({ media: this.activeMedia });
      this.activeMedia = media;

      const cachedEngine = this.audioEnginesByMedia.get(this.activeMedia);
      if (cachedEngine) {
        this.audioEngine = cachedEngine;
        this.logger.debug({
          message: 'audioEngine:reused',
          mode: this.audioEngine.mode,
          media: this.activeMedia,
        });
      } else {
        this.logger.debug({
          message: 'audioEngine:create',
          media: this.activeMedia,
        });
        this.audioEngine = createAudioEngine({
          media: this.activeMedia,
          mode: this.audioEngineMode,
          debug: this.debug,
        });
        this.audioEnginesByMedia.set(this.activeMedia, this.audioEngine);
        this.logger.debug({
          message: 'audioEngine:created',
          mode: this.audioEngine.mode,
          media: this.activeMedia,
        });
      }

      this.logger.debug({
        message: 'attachLoadedTrack:active-media-switched',
        src: this.activeMedia.src,
        paused: this.activeMedia.paused,
        readyState: this.activeMedia.readyState,
        media: this.activeMedia,
      });

      this.bindMediaListeners({ media: this.activeMedia });
      this.logger.debug({
        message: 'bindMediaListeners',
        media: this.activeMedia,
      });
    }

    this.activeMediaKind = mediaKind;
    this.releaseObjectUrl();
    this.currentObjectUrl = objectUrl;
    session.objectUrl = null;
    session.mediaForObjectUrl = null;

    this.hasGraphicsTrack = hasGraphicsTrack;

    // Apply prepared CDG data, then reset/render, matching the original
    // per-track behavior for both sync and async load paths.
    if (cdgPayload?.kind === 'async') {
      this.cdgPlayer.instructions = cdgPayload.instructions;
    } else if (cdgPayload?.kind === 'sync') {
      this.cdgPlayer.load({ data: cdgPayload.bytes });
    }
    this.cdgPlayer.reset().render();

    if (this.activeMedia === this.audio && this.video) {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    }

    if (this.activeMedia === this.video) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
  }

  private releaseSessionObjectUrl({ session }: { session: LoadSession }): void {
    const objectUrl = session.objectUrl;
    if (!objectUrl) {
      return;
    }

    const media = session.mediaForObjectUrl;
    session.objectUrl = null;
    session.mediaForObjectUrl = null;

    // Only clear the element source if it still points at this session's blob;
    // a newer session may already own the element.
    if (media && media.getAttribute('src') === objectUrl) {
      media.removeAttribute('src');
      media.load();
    }

    URL.revokeObjectURL(objectUrl);
  }

  private releaseObjectUrl(): void {
    if (!this.currentObjectUrl) {
      return;
    }

    URL.revokeObjectURL(this.currentObjectUrl);
    this.currentObjectUrl = null;
  }

  private resolveMediaElementForTrack({
    loadedTrack,
  }: {
    loadedTrack: LoadedTrack;
  }): HTMLMediaElement {
    const resolvedMediaKind: LoadedTrackMediaKind =
      loadedTrack.mediaKind ?? 'audio';

    if (resolvedMediaKind === 'video') {
      if (!this.video) {
        throw new Error(
          'Loaded video media but no video element was provided to the player.',
        );
      }

      return this.video;
    }

    return this.audio;
  }

  private async waitForMediaCanPlay({
    media,
    mediaKind,
    signal,
  }: {
    media: HTMLMediaElement;
    mediaKind: LoadedTrackMediaKind;
    signal?: AbortSignal;
  }): Promise<void> {
    if (mediaKind === 'video' && media instanceof HTMLVideoElement) {
      await this.waitForVideoMetadata({
        video: media,
        ...(signal ? { signal } : {}),
      });
      if (media.videoWidth <= 0 || media.videoHeight <= 0) {
        throw new Error('Video track could not be decoded by this browser.');
      }
    }

    if (media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      return;
    }

    await this.waitForMediaEvent({
      media,
      events: ['canplay'],
      errorMessage: `Unable to load ${mediaKind} media in this browser.`,
      ...(signal ? { signal } : {}),
    });
  }

  private async waitForVideoMetadata({
    video,
    signal,
  }: {
    video: HTMLVideoElement;
    signal?: AbortSignal;
  }): Promise<void> {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      return;
    }

    await this.waitForMediaEvent({
      media: video,
      events: ['loadedmetadata'],
      errorMessage: 'Unable to read video metadata in this browser.',
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Waits for the first of `events`, rejecting on media `error` or abort.
   * Listeners are always removed by `cleanup`, so no per-attach handlers leak.
   */
  private async waitForMediaEvent({
    media,
    events,
    errorMessage,
    signal,
  }: {
    media: HTMLMediaElement;
    events: readonly string[];
    errorMessage: string;
    signal?: AbortSignal;
  }): Promise<void> {
    if (signal?.aborted) {
      throw new PlayerLoadCancelledError({
        reason: this.disposed ? 'disposed' : 'superseded',
      });
    }

    await new Promise<void>((resolve, reject) => {
      const onSuccess = (): void => {
        cleanup();
        resolve();
      };

      const onError = (): void => {
        cleanup();
        reject(new Error(errorMessage));
      };

      const onAbort = (): void => {
        cleanup();
        reject(
          new PlayerLoadCancelledError({
            reason: this.disposed ? 'disposed' : 'superseded',
          }),
        );
      };

      const cleanup = (): void => {
        for (const eventName of events) {
          media.removeEventListener(eventName, onSuccess);
        }
        media.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };

      for (const eventName of events) {
        media.addEventListener(eventName, onSuccess, { once: true });
      }
      media.addEventListener('error', onError, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private bindMediaListeners({ media }: { media: HTMLMediaElement }): void {
    if (this.boundMedia.has(media)) {
      this.logger.debug({ message: 'bindMediaListeners:already-bound', media });
      return;
    }

    this.boundMedia.add(media);
    this.logger.debug({ message: 'bindMediaListeners', media });
    media.addEventListener('timeupdate', this.handleTimeUpdate);
    media.addEventListener('play', this.handlePlay);
    media.addEventListener('pause', this.handlePause);
    media.addEventListener('ended', this.handleEnded);
    this.logger.debug({
      message: 'bindMediaListeners:attached',
      listeners: ['timeupdate', 'play', 'pause', 'ended'],
      media,
    });
  }

  private unbindMediaListeners({ media }: { media: HTMLMediaElement }): void {
    if (!this.boundMedia.has(media)) {
      this.logger.debug({ message: 'unbindMediaListeners:not-bound', media });
      return;
    }

    this.boundMedia.delete(media);
    this.logger.debug({ message: 'unbindMediaListeners', media });
    media.removeEventListener('timeupdate', this.handleTimeUpdate);
    media.removeEventListener('play', this.handlePlay);
    media.removeEventListener('pause', this.handlePause);
    media.removeEventListener('ended', this.handleEnded);
    this.logger.debug({
      message: 'unbindMediaListeners:detached',
      listeners: ['timeupdate', 'play', 'pause', 'ended'],
      media,
    });
  }

  private shouldUseWorkerLoader(): boolean {
    if (this.loadTransport === 'main-thread') {
      return false;
    }

    if (this.loadTransport === 'worker') {
      return true;
    }

    if (!this.ownsLoader) {
      return false;
    }

    return typeof Worker === 'function';
  }

  private shouldFallbackToMainThreadLoad({
    errorValue,
  }: {
    errorValue: unknown;
  }): boolean {
    if (this.loadTransport !== 'auto' || !this.ownsLoader) {
      return false;
    }

    if (!(errorValue instanceof LoaderError)) {
      return true;
    }

    const loaderError = errorValue as LoaderError;
    return loaderError.code === 'INTERNAL' || loaderError.code === 'ABORTED';
  }

  private applyState(nextStatePatch: Partial<PlayerState>): void {
    const previous = this.state;
    const next = { ...previous, ...nextStatePatch };
    this.state = next;

    // `statechange` is the primary external state notification contract.
    this.dispatchEvent(
      new CustomEvent<PlayerStateChangeDetail>('statechange', {
        detail: {
          previous,
          next,
        },
      }),
    );
  }

  private handleTimeUpdate = (): void => {
    const timeMs = asMilliseconds({ seconds: this.activeMedia.currentTime });
    const durationMs = asMilliseconds({ seconds: this.activeMedia.duration });
    // Audio timeline is always tracked; CDG sync is only needed when graphics exist.
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.sync({ ms: timeMs });
    }
    this.applyState({ currentTimeMs: timeMs, durationMs });
  };

  private handlePlay = (): void => {
    this.logger.debug({
      message: 'handlePlay',
      currentTime: this.activeMedia.currentTime,
      media: this.activeMedia,
    });
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.play();
    }
    this.applyState({ status: 'playing' });
  };

  private handlePause = (): void => {
    this.logger.debug({
      message: 'handlePause',
      currentTime: this.activeMedia.currentTime,
      media: this.activeMedia,
    });
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.stop();
    }
    if (this.state.status !== 'error' && this.state.status !== 'idle') {
      this.applyState({ status: 'paused' });
    }
  };

  private handleEnded = (): void => {
    this.logger.debug({
      message: 'handleEnded',
      currentTime: this.activeMedia.currentTime,
      media: this.activeMedia,
    });
    if (this.hasGraphicsTrack) {
      this.cdgPlayer.stop();
    }
    this.applyState({ status: 'ready', currentTimeMs: 0 });
  };
}

/**
 * Factory helper for constructing a CdgPlayer from named options.
 */
export const createPlayer = ({
  options,
}: {
  options: CdgPlayerOptions;
}): CdgPlayer => new CdgPlayer(options);
