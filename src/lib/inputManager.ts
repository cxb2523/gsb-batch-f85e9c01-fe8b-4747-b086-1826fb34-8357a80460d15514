import { CODE_TO_GAME_KEY } from './keyMap.ts';

/**
 * A source is whoever is holding a key down. Keyboard presses use the single
 * source `'keyboard'`; every finger uses its own `'touch:<identifier>'` source.
 * Keeping the sources separate is what makes it possible to know when a key is
 * *really* released: only the last source letting go counts.
 */
export type InputSource = string;

export const KEYBOARD_SOURCE: InputSource = 'keyboard';
export const TOUCH_SOURCE_PREFIX = 'touch:';

export function touchSource(identifier: number): InputSource {
  return `${TOUCH_SOURCE_PREFIX}${identifier}`;
}

export type InputListener = (code: string, pressed: boolean) => void;

/**
 * The single owner of "which keys are currently held".
 *
 * Every input path (physical keyboard, touch overlay, programmatic) must funnel
 * through this manager. Listeners are only notified on real transitions:
 *  - `pressed === true` when the first source presses a key
 *  - `pressed === false` when the last source releases it
 *
 * This guarantees a note can never be stuck because one of several holders
 * released "its" copy while another holder is still pressing.
 */
export class InputManager {
  private readonly sourcesByCode = new Map<string, Set<InputSource>>();
  private readonly listeners = new Set<InputListener>();

  /** Adds `source` as a holder of `code`. Returns true on a fresh press. */
  press(code: string, source: InputSource): boolean {
    if (!CODE_TO_GAME_KEY[code]) return false;

    let sources = this.sourcesByCode.get(code);
    if (sources?.has(source)) return false;

    if (!sources) {
      sources = new Set<InputSource>();
      this.sourcesByCode.set(code, sources);
    }

    const wasInactive = sources.size === 0;
    sources.add(source);

    if (wasInactive) {
      this.emit(code, true);
    }
    return wasInactive;
  }

  /** Removes `source` as a holder of `code`. Returns true when fully released. */
  release(code: string, source: InputSource): boolean {
    const sources = this.sourcesByCode.get(code);
    if (!sources || !sources.delete(source)) return false;

    if (sources.size === 0) {
      this.sourcesByCode.delete(code);
      this.emit(code, false);
      return true;
    }
    return false;
  }

  /** Releases every key held by `source` (e.g. window blur, unmount). */
  releaseSource(source: InputSource): void {
    this.releaseWhere((activeSource) => activeSource === source);
  }

  /** Releases every key held by a source whose name starts with `prefix`. */
  releaseSourcePrefix(prefix: string): void {
    this.releaseWhere((activeSource) => activeSource.startsWith(prefix));
  }

  private releaseWhere(predicate: (source: InputSource) => boolean): void {
    const releasedCodes: string[] = [];
    for (const [code, sources] of this.sourcesByCode) {
      let removed = false;
      for (const source of Array.from(sources)) {
        if (predicate(source)) {
          sources.delete(source);
          removed = true;
        }
      }
      if (removed && sources.size === 0) {
        this.sourcesByCode.delete(code);
        releasedCodes.push(code);
      }
    }
    for (const code of releasedCodes) {
      this.emit(code, false);
    }
  }

  /**
   * Forgets every source and notifies listeners that all keys were released.
   * Used when leaving the game screen, finishing a level or restarting, so the
   * next level always starts from a clean state.
   */
  reset(): void {
    if (this.sourcesByCode.size === 0) return;

    const codes = Array.from(this.sourcesByCode.keys());
    this.sourcesByCode.clear();
    for (const code of codes) {
      this.emit(code, false);
    }
  }

  isPressed(code: string): boolean {
    const sources = this.sourcesByCode.get(code);
    return sources !== undefined && sources.size > 0;
  }

  getActiveCodes(): string[] {
    return Array.from(this.sourcesByCode.keys());
  }

  getSourcesForCode(code: string): InputSource[] {
    return Array.from(this.sourcesByCode.get(code) ?? []);
  }

  subscribe(listener: InputListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(code: string, pressed: boolean): void {
    // Copy so a listener may unsubscribe/reset while being notified.
    for (const listener of Array.from(this.listeners)) {
      listener(code, pressed);
    }
  }
}

export const inputManager = new InputManager();
