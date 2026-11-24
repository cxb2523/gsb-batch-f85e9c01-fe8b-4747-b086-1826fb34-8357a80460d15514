import Tone from 'tone';
import { Meteor } from 'meteor/meteor'

import { Tones } from '/imports/api/tones';
import { each, find, isNumber } from 'lodash';

import { getToneEntry } from './registry';
import { readVarValue, writeVarValue, initTonesModifiers, snapshotVars } from '../code/paramVars';

Meteor.subscribe('tones');

export { initTonesModifiers }

export let getToneType = tone => {
  if (typeof tone === 'number') return 'transport-event'
  else if (tone && typeof tone === 'object') return 'loop'

  return false
}

// Clear a single Tone.Transport scheduled id. Safe to call with anything.
// Only ids currently registered with the Transport are touched, so unrelated
// numeric config values in elementsToDispose are left alone.
export let clearTransportEvent = id => {
  if (typeof id !== 'number') return false
  try {
    let scheduled = Tone.Transport._scheduledEvents
    if (scheduled && !Object.prototype.hasOwnProperty.call(scheduled, id.toString())) return false
    Tone.Transport.clear(id)
  } catch (e) { console.warn('Transport.clear failed:', e && e.message) }
  return true
}

// Stop a voice immediately. Loop-like objects get stop(), scheduled event ids
// get cleared. Everything is guarded so a broken/half-built voice can never
// block removal of the registry entry.
export let stopTone = tone => {
  if (tone === null || tone === undefined) return
  let type = getToneType(tone)

  if (type === 'transport-event') {
    clearTransportEvent(tone)
    return
  }

  if (type === 'loop') {
    try {
      if (typeof tone.stop === 'function') tone.stop(0)
    } catch (e) {
      try { tone.stop && tone.stop() } catch (e2) { /* already stopped */ }
    }
    // Some Tone versions keep an internal transport event id on the object.
    if (isNumber(tone._eventId)) clearTransportEvent(tone._eventId)
  }
}

export let startTone = tone => {
  let type = getToneType(tone)
  if (type !== 'loop') return

  try {
    // do not double-start a loop that the evaluated code already started
    if (tone.state === 'started') return
  } catch (e) { /* state unsupported, just try to start */ }

  try {
    tone.start('+0.05')
  } catch (e) {
    try { tone.start(0) } catch (e2) { console.warn('startTone failed:', e2 && e2.message) }
  }
}

// Dispose one element produced by the evaluated code.
// - number  -> a Tone.Transport event id, clear it so it stops firing
// - object with dispose() -> Tone node, dispose it
// - array   -> recurse (e.g. nested collections)
export let disposeElement = (el, seen) => {
  if (el === null || el === undefined) return
  if (typeof el === 'number') { clearTransportEvent(el); return }
  if (typeof el !== 'object' && typeof el !== 'function') return

  seen = seen || new Set()
  if (seen.has(el)) return
  seen.add(el)

  if (Array.isArray(el)) {
    el.forEach(x => disposeElement(x, seen))
    return
  }

  if (typeof el.dispose === 'function') {
    try { el.dispose() } catch (e) { console.log('error when dispose() :' + (e && e.message)) }
  }
}

// Stop + release a whole registry entry exactly once.
export let disposeEntry = entry => {
  if (!entry || entry.__disposed) return
  entry.__disposed = true

  stopTone(entry.tone)
  disposeElement(entry.tone)

  if (entry.elementsToDispose) {
    let list = Array.isArray(entry.elementsToDispose) ? entry.elementsToDispose : [entry.elementsToDispose]
    let seen = new Set()
    each(list, e => disposeElement(e, seen))
  }
}

// Persist a serializable representation of the voice to the meteor
// `tones` collection (which drives the mixer UI on every client).
export let persistTone = toneEntry => {
  if (!toneEntry) return false

  let doc = {
    soundId: toneEntry.soundId,
    name: toneEntry.name,
    createdAt: new Date(),
    options: { vars: snapshotVars(toneEntry.options && toneEntry.options.vars) }
  }

  // remember the client-side method call so callers/tests can observe it
  toneEntry.lastPersist = doc
  return Meteor.call('tones.insert', doc)
}

// Apply one persisted var descriptor to the matching LIVE var of a voice.
// Matching by name first, index second prevents cross-voice/cross-param
// corruption when arrays shift.
export let applyVarSnapshotToEntry = (entry, snapshotVar, index) => {
  if (!entry || !entry.options || !entry.options.vars || !snapshotVar) return false
  let liveVars = entry.options.vars
  let name = snapshotVar[0]
  let value = snapshotVar[1] && (
    isNumber(snapshotVar[1].persistedValue)
      ? snapshotVar[1].persistedValue
      : snapshotVar[1][name]
  )
  if (!isNumber(value)) return false

  let target = find(liveVars, v => v && v[0] === name)
  if (!target && liveVars[index]) target = liveVars[index]
  if (!target) return false

  return writeVarValue(target, value)
}

// Apply a knob value immediately to the live audio voice on THIS client.
export let applyKnobToLiveTone = (soundId, varName, index, value) => {
  let entry = getToneEntry(soundId)
  if (!entry || !entry.options || !entry.options.vars) return false
  let v = find(entry.options.vars, x => x && x[0] === varName)
  if (!v && isNumber(index)) v = entry.options.vars[index]
  return v ? writeVarValue(v, value) : false
}

// Keep the live audio engine in sync with `tones` collection changes made by
// other clients / mixer screens. Registered at most once per page lifetime.
let observeHandle = null
export let observeTones = () => {
  if (observeHandle) return observeHandle

  observeHandle = Tones.find().observeChanges({
    changed: function (id, field) {
      let doc = Tones.findOne(id)
      if (!doc) return

      let entry = getToneEntry(doc.soundId)
      if (!entry) return // voice lives on another client; nothing live to update here

      let vars = field && field.options && field.options.vars
      if (!vars && doc.options && doc.options.vars) vars = doc.options.vars

      each(vars, (v, i) => applyVarSnapshotToEntry(entry, v, i))
    }
  })

  return observeHandle
}
