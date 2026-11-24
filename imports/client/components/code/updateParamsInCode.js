import { Meteor } from 'meteor/meteor';

import { Tones } from '/imports/api/tones';
import { Sounds } from '/imports/api/sounds';
import { getToneEntry } from '../player/registry';
import { readVarValue } from './paramVars';
import { rewriteParamsInCode } from './codeRewriter';

Meteor.subscribe('tones');
Meteor.subscribe('sounds');

export { rewriteParamsInCode }

// Resolve the authoritative current value for every var of a voice.
// Priority:
//   1. the LIVE tone registry on this client (knobs act on it immediately)
//   2. the meteor `tones` doc (mixer-only clients / other screens)
// Returns [{name, value, step}] in the order of the tone doc vars.
export let resolveParamValues = (soundId, toneId) => {
  let liveEntry = getToneEntry(soundId)
  let liveVars = liveEntry && liveEntry.options && liveEntry.options.vars

  let tone = null
  if (toneId) tone = Tones.findOne(toneId)
  if (!tone) tone = Tones.findOne({ soundId })

  let docVars = tone && tone.options && tone.options.vars
  let sourceLength = (liveVars || docVars || []).length

  let params = []
  for (let i = 0; i < sourceLength; i++) {
    let sourceVar = (liveVars && liveVars[i]) || (docVars && docVars[i])
    if (!sourceVar) continue
    let name = sourceVar[0]
    let value

    if (liveVars && liveVars[i]) value = readVarValue(liveVars[i])

    if ((typeof value !== 'number' || !isFinite(value)) && docVars && docVars[i]) {
      let dv = docVars[i]
      value = dv[1] && (typeof dv[1].persistedValue === 'number'
        ? dv[1].persistedValue
        : dv[1][name])
    }

    if (typeof value !== 'number' || !isFinite(value)) value = sourceVar[5]

    let step = docVars && docVars[i] ? docVars[i][4] : sourceVar[4]
    params.push({ name, value, step })
  }

  return params
}

// Persist the current mixer/knob values of one sound back into its own code.
// Only that sound's document is read and updated. Returns the new code.
// `explicitParams` (optional) is a synchronous [{name,value,step}] cache from
// the mixer so an immediate Save cannot race the minimongo/DDP update.
export let updateParamsInCode = (soundId, toneId, explicitParams) => {
  let sound = Sounds.findOne(soundId)
  if (!sound) {
    console.warn('updateParamsInCode: sound not found', soundId)
    return null
  }

  let params = resolveParamValues(soundId, toneId)

  // synchronous mixer cache wins per param name (instant knob -> Save race)
  if (explicitParams && explicitParams.length) {
    let overrides = {}
    explicitParams.forEach(p => { if (p && p.name) overrides[p.name] = p })
    params = params.map(p => overrides[p.name] ? Object.assign({}, p, overrides[p.name]) : p)
    explicitParams.forEach(p => {
      if (p && p.name && !params.some(x => x.name === p.name)) params.push(p)
    })
  }

  let newCode = rewriteParamsInCode(sound.code, params)

  if (newCode === sound.code) {
    console.log('updateParamsInCode: nothing to update for', soundId)
  }

  Meteor.call('sounds.updateCode', soundId, newCode)
  return newCode
}
