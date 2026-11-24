import {random} from 'lodash';
import React from 'react';
import dedent from 'dedent-js';

import { Meteor } from 'meteor/meteor'

let notes = ['A2','B2','C3','D3','E3','F3','G3']

import * as css from '/imports/client/components/css/styles.js'

export default class AddSound extends React.Component {

  constructor(props){
    super(props)
  }

  createSound = () => {
    let note = notes[random(notes.length - 1)]
    let codeDefault = dedent(`
      let filter = new Tone.Filter(1200, 'lowpass').toMaster();
      let synth = new Tone.Synth({
        oscillator: { type: 'square' },
        envelope: { attack: 0.02, decay: 0.2, sustain: 0.3, release: 0.8 }
      }).connect(filter);
      let c = new Tone.Loop(time => {
        synth.triggerAttackRelease('${note}', '8n', time);
      }, '4n');
      let o = {
        vars: [
          ['cutoff', filter.frequency, 100, 6000, 1, 1200],
          ['attack', synth.envelope, 0.001, 0.5, 0.001, 0.02]
        ]
      };
    `)

    Meteor.call('sounds.insert', codeDefault);
  }

  render() {
    return (
      <css.Button onClick={this.createSound}>
        addSound
      </css.Button>
    )
  }
}
