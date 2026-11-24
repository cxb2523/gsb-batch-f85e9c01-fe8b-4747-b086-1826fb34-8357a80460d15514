import { Meteor } from 'meteor/meteor'

import { evalCode } from '../code/evalCode';
import {
  stopTone,
  startTone,
  persistTone,
  disposeEntry,
  initTonesModifiers,
} from './tones';
import { tones, getToneEntry, addEntry, removeEntry } from './registry';

// Re-export the stable registry for any historical importer of `tones`.
export { tones }

// Per-sound generation token. Every lifecycle transition bumps the token so
// any stale scheduled callback from an older generation can detect it lost.
const generations = new Map()

export let nextGeneration = soundId => {
  let g = (generations.get(soundId) || 0) + 1
  generations.set(soundId, g)
  return g
}

export let currentGeneration = soundId => generations.get(soundId) || 0

// Tear down the live voice of ONE sound:
// stop + dispose its tone/elements, drop it from the registry and remove
// every matching doc from the meteor `tones` collection (mixer UI).
// Accepts either a sound document or a raw soundId string.
export let removeSound = soundOrId => {
  let soundId = typeof soundOrId === 'string' ? soundOrId : soundOrId && soundOrId._id
  if (!soundId) return { status: 'err', body: 'removeSound: missing soundId' }

  nextGeneration(soundId)

  // removeEntry gives us the exact registered instance even if callers
  // previously reassigned window.tones somewhere.
  let entry = removeEntry(soundId)
  if (entry) disposeEntry(entry)

  // Always reconcile the meteor collection, even when no live entry existed
  // here (e.g. stale/duplicate docs left by an earlier bug or another tab).
  Meteor.call('tones.removeFromSoundId', soundId)

  return { status: 'ok' }
}

// Evaluate (or re-evaluate) exactly ONE sound and register its voice.
// Any previous voice for the same soundId is fully torn down first, so the
// registry can never contain duplicates for one sound.
export let updateSound = (sound, props) => {
  if (!sound || !sound._id) return { status: 'err', body: 'updateSound: invalid sound' }

  let soundId = sound._id
  let generation = nextGeneration(soundId)

  // synchronous teardown of the previous generation for this sound only
  let oldEntry = removeEntry(soundId)
  if (oldEntry) disposeEntry(oldEntry)
  Meteor.call('tones.removeFromSoundId', soundId)

  // muted (or removed from song): everything for this sound is gone
  if (sound.muted) return { status: 'ok', muted: true }

  let result = evalCode(sound.code)
  if (result.status === 'err') return result

  let body = result.body
  let entry = {
    soundId: sound._id,
    name: sound.name,
    tone: body.c,
    elementsToDispose: body.e || [],
    options: body.o || { vars: [] },
    generation,
  }

  // A newer transition happened while evaluating? eval is synchronous so this
  // only guards against future refactors becoming async.
  if (currentGeneration(soundId) !== generation) return { status: 'ok', superseded: true }

  initTonesModifiers(entry.options.vars)

  // register BEFORE starting so rapid toggles always find the current entry
  addEntry(entry)

  startTone(entry.tone)

  persistTone(entry)

  return { status: 'ok' }
}

export { getToneEntry }
