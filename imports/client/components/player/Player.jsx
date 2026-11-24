import { withTracker } from 'meteor/react-meteor-data';
import { Meteor } from 'meteor/meteor'

import React from 'react';

import Tone from 'tone';

import styled from 'styled-components';

import { updateSound, removeSound } from './sounds';
import { soundsWatcher } from './soundsWatcher';
import { observeTones } from './tones';

export default class Player extends React.Component {

  constructor(props){
    super(props)
    this.state = {
      codeErrors: false
    }
  }

  componentDidMount () {
    // clean all the meteor collection replication of the window.tones object
    Meteor.call('tones.removeAll')

    Tone.Transport.start('+0.1')
    Tone.Transport.loopEnd = '2m'
    Tone.Transport.loop = true
    window.Tone = Tone

    if (Tone.context) Tone.context.latencyHint = "interactive"

    observeTones()

    // Sounds may already be present on first mount (cached minimongo data or
    // a derived parent list populated on the first render), in which case
    // componentWillReceiveProps never sees an "added" transition.
    this.runWatcher([], this.props.sounds)
  }

  // initializeSounds
  componentWillReceiveProps(nextProps) {
    this.runWatcher(this.props.sounds, nextProps.sounds)
  }

  runWatcher (prevSounds, nextSounds) {
    soundsWatcher({
      array1: nextSounds,
      array2: prevSounds,
      added: s => {
        updateSound(s)
      },
      updated: s => {
        let result = updateSound(s)
        result && result.status === 'err'
          ? this.setState({ codeErrors: result.body })
          : this.setState({ codeErrors: false })
      },
      deleted: s => {
        removeSound(s)
      },
      nothing: (s, p) => console.log('nothing', p)
    })
  }

  componentWillUnmount () {
    Tone.Transport.stop()
  }

	render() {
    let errors = this.state.codeErrors ? this.state.codeErrors : 'no synthax error'

		return (
      <div>
        <Result error={this.state.codeErrors}> {errors} </Result>
      </div>

    )
  }
}

const Result = styled.p`
  color: ${props => props.error ? 'red' : 'green'};
`;
