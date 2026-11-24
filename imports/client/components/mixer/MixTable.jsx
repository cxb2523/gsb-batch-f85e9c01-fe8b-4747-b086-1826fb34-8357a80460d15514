import React from 'react';

import { each, isNumber, find } from 'lodash';
import styled from 'styled-components';

import { Meteor } from 'meteor/meteor'

import Knob from './knob/Knob';
import { updateParamsInCode } from '../code/updateParamsInCode';
import { applyKnobToLiveTone } from '../player/tones';

export default class MixTable extends React.Component {
  constructor(props){
    super(props)
    // Synchronous cache of the latest knob values per sound, updated before
    // any DDP/minimongo round-trip so an immediate Save always reads fresh.
    this.latestParams = {}
  }

  // Knob interaction:
  //  1. apply the value synchronously to the LIVE tone on this client
  //  2. persist it to the meteor `tones` collection (client stub updates
  //     minimongo immediately, so save can read the fresh value at once)
  changeValue = (tone, index, name, value) => {
    if (!tone || !tone._id || !tone.options || !tone.options.vars) return

    applyKnobToLiveTone(tone.soundId, name, index, value)

    let vars = tone.options.vars.map((v, i) => {
      let next = v.slice()
      if (i === index || (name && v[0] === name)) {
        let holder = Object.assign({}, next[1], { persistedValue: value })
        if (typeof next[0] === 'string') holder[next[0]] = value
        next[1] = holder
      }
      return next
    })

    // merge by param name so rapid edits to different knobs cannot overwrite
    // each other through a stale render closure
    if (!this.latestParams[tone.soundId]) this.latestParams[tone.soundId] = {}
    let v = tone.options.vars[index] || []
    this.latestParams[tone.soundId][name || index] = { name: v[0] || name, value, step: v[4] }

    Meteor.call('tones.update', { _id: tone._id, options: { vars } })
  }

  saveParamsTone = tone => {
    if (!tone) return
    let cache = this.latestParams[tone.soundId]
    let explicitParams = cache ? Object.keys(cache).map(k => cache[k]) : null
    updateParamsInCode(tone.soundId, tone._id, explicitParams)
  }

  knobValue = v => {
    if (!v || !v[1]) return undefined
    if (isNumber(v[1].persistedValue)) return v[1].persistedValue
    if (isNumber(v[1][v[0]])) return v[1][v[0]]
    return undefined
  }

	render() {
		return (
      <Table>
        {this.props.tones.map(tone => (
          <SoundMixer key={tone.soundId} data-sound-id={tone.soundId}>
            <SoundName>{tone.name}</SoundName>
            <div>
               {(tone.options && tone.options.vars) && tone.options.vars.map((v,i) =>
                  <Knob
                    key={`${tone.soundId}-${v[0] || i}`}
                    name={v[0]}
                    val={this.knobValue(v)}
                    min={v[2]}
                    max={v[3]}
                    step={v[4]}
                    initVal={v[5]}
                    onValueChange={this.changeValue.bind(this, tone, i, v[0])} />
               )}
            </div>
            <SaveButton
              data-sound-id={tone.soundId}
              onClick={this.saveParamsTone.bind(this, tone)}>save</SaveButton>
          </SoundMixer>
          )
        )}
        <Clear></Clear>
      </Table>
    )
  }
}

//
// CSS
//

const Table = styled.div`

`;

const Clear = styled.div`
  clear: both;
`;

const SoundName = styled.div`
  padding: 10px;
  background: #dfdfdf;
  text-align: center;
`;

const SaveButton = styled.div`
  display: inline-block;
  padding: 6px 14px;
  margin: 6px;
  background: #444;
  color: #fff;
  cursor: pointer;
  user-select: none;
`;

const SoundMixer = styled.div`
  background: #f3f3f3;
  max-width: 50%;
  margin: 5px;
  float: left;
`;
