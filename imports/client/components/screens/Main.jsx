import { withTracker } from 'meteor/react-meteor-data';
import { Meteor } from 'meteor/meteor'
import { Sounds } from '/imports/api/sounds.js';
import { Songs } from '/imports/api/songs.js';

import React from 'react';
import { find } from 'lodash';

import AddSound from '../sound/AddSound.jsx';
import Sound from '../sound/Sound.jsx';

import AddSong from '../AddSong.jsx';
import Song from '../Song.jsx';

import Bpm from '../Bpm.jsx';
import Editor from '../editor/Editor.jsx';
import Player from '../player/Player.jsx';
import Explorer from '../explorer/Explorer.jsx';
// import Explorer from '../explorer/Explorer2.jsx';

// import styled from 'styled-components';
import * as css from '/imports/client/components/css/styles.js'

export class MainScreen extends React.Component {

  constructor(props){
    super(props)
    this.state = {
      codeErrors: false
    }
  }

  // Song sounds are derived during render from the reactive Sounds cache.
  // withTracker above depends on Sounds.find(), so any sound change (mute,
  // code, delete) re-renders this screen and Player receives a fresh list.
  getSongSounds () {
    let selectedSong = find(this.props.songs, {selected: true})
    if (!selectedSong || !selectedSong.sounds) return []
    return selectedSong.sounds
      .map(id => Sounds.findOne(id))
      .filter(sound => !!sound)
  }

	render() {
    let songSounds = this.getSongSounds()

		return (
      <div className="MainsScreen">
        <css.Panel w={23}>
          <Bpm />
          <p> SOUNDS SONG </p>
          <ul>
            {songSounds.map(sound => {
                return <Sound key={`${sound._id}-songSound`} sound={sound} type="songSound"/>
              }
            )}
          </ul>

          <p> SONGS </p>
          <ul>
            {this.props.songs.map(song =>
              <Song key={song._id} song={song} />
            )}
          </ul>
          <AddSong />
        </css.Panel>

        <css.Panel w={48}>
          <Editor
            sound={this.props.selectedSound} />

          <Player sounds={songSounds} />
        </css.Panel>

        <css.Panel w={23}>
          <Explorer />
          <AddSound />
        </css.Panel>
      </div>
    )
  }
}

//
// DATA CONTAINER (METEOR)
//

export default withTracker(props => {
  Meteor.subscribe('sounds');
  Meteor.subscribe('songs');
  return {
    sounds: Sounds.find({}, { sort: { createdAt: -1 } }).fetch(),
    songs: Songs.find({}, { sort: { createdAt: -1 } }).fetch(),
    selectedSound: Sounds.findOne({selected: true})
  };
})(MainScreen);
