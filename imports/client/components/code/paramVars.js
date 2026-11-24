import { isNumber, isFinite, round } from 'lodash'

// A knob var descriptor has the shape:
//   [NAME, TARGET, MIN, MAX, STEP, INIT]
// TARGET can be:
//   - a Tone.Param / Signal (numeric .value)
//   - an owner object whose TARGET[NAME] is a number (e.g. envelope.attack)
//   - an owner object whose TARGET[NAME] is itself a Param/Signal
// The helpers below are the single source of truth for reading/writing the
// current value of a var so knobs, the live audio engine and code write-back
// can never disagree or drift across voices.

export let isValidVarValue = value => isNumber(value) && isFinite(value)

export let readVarValue = v => {
  if (!v) return undefined
  let name = v[0]
  let target = v[1]
  if (target == null) return undefined

  // canonical mirror always wins when present (set by knob/save flows)
  if (isValidVarValue(target.persistedValue)) return target.persistedValue

  let named = target[name]
  if (isValidVarValue(named)) return named
  if (named && isValidVarValue(named.value)) return named.value
  if (isValidVarValue(target.value)) return target.value
  return undefined
}

export let writeVarValue = (v, value) => {
  if (!v || !v[1] || !isValidVarValue(value)) return false
  let name = v[0]
  let target = v[1]
  let named = target[name]

  if (named && typeof named === 'object' && isValidVarValue(named.value)) {
    // e.g. ['volume', synth] -> synth.volume.value
    named.value = value
  } else if (isValidVarValue(named)) {
    // e.g. ['attack', synth.envelope] -> synth.envelope.attack
    target[name] = value
  } else if (isValidVarValue(target.value)) {
    // e.g. ['frequency', filter.frequency] -> Signal.value
    target.value = value
  } else if (named && typeof named === 'object' && 'value' in named) {
    named.value = value
  } else {
    // last resort: own named property
    try { target[name] = value } catch (e) { /* read-only */ }
  }

  // keep a canonical mirror so reactive docs / save read the same number
  try { target.persistedValue = value } catch (e) { /* read-only */ }
  return true
}

// Apply the INIT value (6th element) of every var once, at voice creation.
export let initTonesModifiers = vars => {
  if (!vars) return
  vars.forEach(v => {
    if (v instanceof Array && isValidVarValue(v[5])) {
      writeVarValue(v, round(v[5], 6))
    }
  })
}

// Build a Meteor/EJSON-safe snapshot of vars for the mixer collection.
// The live TARGET object (v[1]) is replaced by a plain holder that carries
// the current numeric value under both supported historical access paths
// (.persistedValue and holder[NAME]).
export let snapshotVars = vars => (vars || []).map(v => {
  let name = v[0]
  let value = readVarValue(v)
  if (!isValidVarValue(value) && isValidVarValue(v[5])) value = v[5]
  let holder = { persistedValue: value }
  if (typeof name === 'string') holder[name] = value
  return [name, holder, v[2], v[3], v[4], v[5]]
})

// Format a knob value for source code without float noise / "-0".
export let formatCodeNumber = (value, step) => {
  let n = Number(value)
  if (!isFinite(n)) return '0'
  if (Object.is(n, -0)) n = 0
  let decimals = 0
  if (isNumber(step)) {
    let s = `${step}`.split('.')[1]
    decimals = s ? s.length : 0
  }
  let str = decimals > 0 ? n.toFixed(decimals) : `${Math.round(n)}`
  // strip trailing zeros introduced by toFixed while keeping one decimal if needed
  if (decimals > 0 && str.indexOf('.') !== -1) {
    str = str.replace(/0+$/, '').replace(/\.$/, '')
  }
  return str
}
