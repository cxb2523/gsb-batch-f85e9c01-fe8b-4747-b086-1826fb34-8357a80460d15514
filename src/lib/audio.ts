import * as Tone from 'tone';
import { GAME_KEYS } from './keyMap';

let polySynth: Tone.PolySynth | null = null;
let reverb: Tone.Reverb | null = null;
let audioInitialized = false;
let initPromise: Promise<boolean> | null = null;

const KEYS = GAME_KEYS.map((gameKey) => gameKey.note);

export const scales = {
  'C Major Chord': ['C2', 'E2', 'G2', 'A2', 'C3', 'G3', 'A3', 'C4', 'E4'],
  'C Major Scale': ['C2', 'D2', 'E2', 'F2', 'G2', 'A2', 'B2', 'C3', 'D3'],
  'Pentatonic':    ['C2', 'D2', 'E2', 'G2', 'A2', 'C3', 'D3', 'E3', 'G3'],
  'Harmonic Minor':['C2', 'D2', 'Eb2', 'F2', 'G2', 'Ab2', 'B2', 'C3', 'D3'],
  'Blues':         ['C2', 'Eb2', 'F2', 'F#2', 'G2', 'Bb2', 'C3', 'Eb3', 'F3'],
};

export type ScaleName = keyof typeof scales;

let currentScale: Record<string, string> = {};

function buildScaleMap(scaleName: ScaleName): Record<string, string> {
  const notes = scales[scaleName];
  const scaleMap: Record<string, string> = {};
  KEYS.forEach((key, index) => {
    scaleMap[key] = notes[index];
  });
  return scaleMap;
}

currentScale = buildScaleMap('C Major Scale');

/**
 * Keys the player is currently holding, mapped to the note they sound.
 *
 * Intents are recorded here even before the (asynchronous) audio context is
 * ready, so a press that happens during initialization is replayed instead of
 * being dropped. A release that arrives before initialization simply removes
 * the intent, so no orphan note ever starts.
 */
const heldKeys = new Map<string, string>();

function countHeldNote(note: string): number {
  let count = 0;
  for (const heldNote of heldKeys.values()) {
    if (heldNote === note) count += 1;
  }
  return count;
}

function attackAllHeldNotes() {
  if (!audioInitialized || !polySynth) return;
  const attackedNotes = new Set<string>();
  for (const note of heldKeys.values()) {
    if (attackedNotes.has(note)) continue;
    attackedNotes.add(note);
    polySynth.triggerAttack(note, Tone.now());
  }
}

async function initializeAudio(): Promise<boolean> {
  if (audioInitialized) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      await Tone.start();
      if (!audioInitialized) {
        reverb = new Tone.Reverb(0.7).toDestination();
        polySynth = new Tone.PolySynth(Tone.Synth, {
          volume: 10,
        }).connect(reverb);
        audioInitialized = true;
        // Anything pressed while the context was warming up now gets its note.
        attackAllHeldNotes();
        console.log('Audio context started and initialized.');
      }
      return true;
    } catch (error) {
      // Audio is best-effort: never let an initialization failure reject into
      // the input handlers. A later key press will retry.
      console.error('Failed to initialize audio:', error);
      return false;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

export const audioManager = {
  start: initializeAudio,
  setScale: (scaleName: ScaleName) => {
    currentScale = buildScaleMap(scaleName);
  },
  setCustomScale: (notes: string[]) => {
    const scaleMap: Record<string, string> = {};
    KEYS.forEach((key, index) => {
      scaleMap[key] = notes[index];
    });
    currentScale = scaleMap;
  },
  playNote: (key: string) => {
    const note = currentScale[key];
    if (!note || heldKeys.has(key)) return;

    const alreadySounding = countHeldNote(note) > 0;
    heldKeys.set(key, note);

    if (!audioInitialized) {
      // Remember the intent and make sure initialization is underway. The note
      // is triggered once the context becomes ready.
      void initializeAudio();
      return;
    }

    if (polySynth && !alreadySounding) {
      polySynth.triggerAttack(note, Tone.now());
    }
  },
  releaseNote: (key: string) => {
    const note = heldKeys.get(key);
    if (note === undefined) return;

    heldKeys.delete(key);

    if (audioInitialized && polySynth && countHeldNote(note) === 0) {
      polySynth.triggerRelease(note, Tone.now());
    }
  },
  releaseAll: () => {
    heldKeys.clear();
    if (audioInitialized && polySynth) {
      polySynth.releaseAll();
    }
  },
  /** Keys currently held (i.e. notes that should be sounding). */
  getHeldKeys: (): string[] => Array.from(heldKeys.keys()),
  isInitialized: () => audioInitialized,
};
