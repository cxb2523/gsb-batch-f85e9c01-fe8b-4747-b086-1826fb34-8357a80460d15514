import { find } from 'lodash'

// Single source of truth for LIVE voices on this client.
// The array identity is stable for the whole page lifetime so any code that
// captured `window.tones` keeps observing the same collection. We mutate it
// in place (push/splice/length=0) and additionally maintain a soundId map.
export const tones = []
export const tonesBySoundId = new Map()

if (typeof window !== 'undefined') {
  window.tones = tones
  window.tonesBySoundId = tonesBySoundId
}

export let getToneEntry = soundId => {
  if (!soundId) return null
  return tonesBySoundId.get(soundId) || find(tones, { soundId }) || null
}

export let indexOfEntry = entry => tones.indexOf(entry)

export let addEntry = entry => {
  if (!entry || !entry.soundId) return entry
  // hard invariant: at most one live voice per soundId
  let existing = tonesBySoundId.get(entry.soundId)
  if (existing) {
    let i = tones.indexOf(existing)
    if (i >= 0) tones.splice(i, 1)
  }
  tones.push(entry)
  tonesBySoundId.set(entry.soundId, entry)
  return entry
}

export let removeEntry = soundId => {
  let entry = tonesBySoundId.get(soundId) || find(tones, { soundId })
  if (!entry) return null
  let i = tones.indexOf(entry)
  if (i >= 0) tones.splice(i, 1)
  tonesBySoundId.delete(soundId)
  return entry
}

export let clearRegistry = () => {
  let all = tones.slice()
  tones.length = 0
  tonesBySoundId.clear()
  return all
}
