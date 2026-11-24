import { SOUND_EVENTS, type SoundEvent } from './types';

/** Registry for recorded audio that may replace a synthesized event later (for example music or
 * SFX delivered by the user's API). Nothing is registered and nothing is fetched by default:
 * every event plays its synth version until `register()` is called, and a registered sample that
 * has not finished loading (or failed to load) falls back to the synth too. */

export interface SampleOptions {
  /** Linear gain multiplier (default 1). */
  gain?: number;
  /** Random playback-rate spread, e.g. 0.05 = +/-5 percent, to vary repeated sounds. */
  rateJitter?: number;
  /** Loop the sample (used by `music.loop`). */
  loop?: boolean;
}

interface Entry { url: string; options: SampleOptions; state: 'idle' | 'loading' | 'ready' | 'failed'; buffer?: AudioBuffer }

export class SampleBank {
  private readonly entries = new Map<SoundEvent, Entry>();
  /** Bumped by `invalidate()` so a decode that finishes after a context swap is discarded. */
  private epoch = 0;

  register(event: SoundEvent, url: string, options: SampleOptions = {}): void {
    if (!(SOUND_EVENTS as readonly string[]).includes(event)) throw new Error(`Unknown sound event: ${event}`);
    this.entries.set(event, { url, options, state: 'idle' });
  }
  unregister(event: SoundEvent): void { this.entries.delete(event); }
  has(event: SoundEvent): boolean { return this.entries.has(event); }
  registered(): SoundEvent[] { return [...this.entries.keys()]; }
  url(event: SoundEvent): string | undefined { return this.entries.get(event)?.url; }
  /** True once the sample is decoded and will be used instead of the synth. */
  ready(event: SoundEvent): boolean { return this.entries.get(event)?.state === 'ready'; }

  /** Decoded AudioBuffers belong to the context that decoded them, so a new (or torn-down)
   * context invalidates them. Registrations survive; the samples re-decode lazily on next play,
   * falling back to the synth until then. */
  invalidate(): void {
    this.epoch++;
    for (const entry of this.entries.values()) {
      entry.state = 'idle';
      entry.buffer = undefined;
    }
  }

  /** Fetch and decode registered samples. Called explicitly; never automatic. */
  async preload(context: BaseAudioContext, events: readonly SoundEvent[] = this.registered()): Promise<void> {
    await Promise.all(events.map(event => this.load(context, event)));
  }

  private async load(context: BaseAudioContext, event: SoundEvent): Promise<void> {
    const entry = this.entries.get(event);
    if (!entry || entry.state === 'loading' || entry.state === 'ready') return;
    const epoch = this.epoch;
    entry.state = 'loading';
    try {
      const response = await fetch(entry.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      if (epoch !== this.epoch) return; // context swapped while decoding: drop this buffer
      entry.buffer = buffer;
      entry.state = 'ready';
    } catch {
      if (epoch === this.epoch) entry.state = 'failed';
    }
  }

  /** Play a registered sample through `destination`. Returns false (caller uses the synth) when
   * there is no ready sample; an idle one starts loading in the background for next time. */
  play(context: BaseAudioContext, destination: AudioNode, event: SoundEvent, volume = 1): AudioBufferSourceNode | null {
    const entry = this.entries.get(event);
    if (!entry) return null;
    if (entry.state === 'idle') { void this.load(context, event); return null; }
    if (entry.state !== 'ready' || !entry.buffer) return null;
    const source = context.createBufferSource();
    source.buffer = entry.buffer;
    source.loop = !!entry.options.loop;
    const jitter = entry.options.rateJitter ?? 0;
    if (jitter) source.playbackRate.value = 1 + (Math.random() * 2 - 1) * jitter;
    const gain = context.createGain();
    gain.gain.value = (entry.options.gain ?? 1) * volume;
    source.connect(gain).connect(destination);
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    source.start();
    return source;
  }
}
