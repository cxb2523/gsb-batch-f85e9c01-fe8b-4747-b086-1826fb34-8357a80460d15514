import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { check } from 'meteor/check';
import {random, each, filter} from 'lodash';

import {Songs} from './songs';
import {Tones} from './tones';

export const Sounds = new Mongo.Collection('sounds');

if (!Meteor.isServer) return false

Meteor.publish('sounds', () => Sounds.find())

Meteor.methods({
  'sounds.insert'(code) {

    check(code, String);

    let soundId = Sounds.insert({
      'name': `sound-${random(10000)}`,
      'tags': ``,
      'selected': false,
      'muted': false,
      'code': code,
      'createdAt': new Date()
    });

    // Acceptance flow creates sounds that should immediately belong to the
    // selected song so the player builds their voice. If no song is selected,
    // select the most recent song (or create a default one) and add it there.
    try {
      let targetSong = Songs.findOne({ selected: true })
      if (!targetSong) targetSong = Songs.findOne({}, { sort: { createdAt: -1 } })

      if (!targetSong) {
        let songId = Songs.insert({
          name: `song-${random(10000)}`,
          selected: true,
          selectedSound: false,
          sounds: [soundId],
          createdAt: new Date()
        })
        Songs.update({ _id: { $ne: songId } }, { $set: { selected: false } }, { multi: true })
      } else {
        Songs.update(targetSong._id, { $set: { selected: true }, $addToSet: { sounds: soundId } })
        Songs.update({ _id: { $ne: targetSong._id }, selected: true }, { $set: { selected: false } }, { multi: true })
      }
    } catch (e) {
      console.warn('sounds.insert auto-add to song failed:', e && e.message)
    }

    return soundId;
  },
  'sounds.remove'(soundId) {
    check(soundId, String);

    Sounds.remove(soundId);

    // Referential integrity: never leave mixer tone docs for a deleted sound,
    // no matter which client/page initiated the deletion.
    Tones.remove({ soundId: soundId });

    // Clean orphan sounds id in songs
    Meteor.call('songs.cleanSoundsSongs')
  },
  'sounds.clone'(soundId) {
    check(soundId, String);
    let sound = Sounds.findOne(soundId)
    Sounds.insert({
      'name': `${sound.name}-clone`,
      'tags': sound.tags,
      'selected': sound.selected,
      'muted': sound.muted,
      'code': sound.code,
      'createdAt': new Date()
    });
  },
  //
  // UPDATERS
  //
  'sounds.select'(soundId) {
    check(soundId, String);

    Sounds.update({ selected: true }, { $set: { selected: false } })
    Sounds.update(soundId, { $set: { selected: true } })
  },
  'sounds.toggleMute'(soundId) {
    check(soundId, String);
    let sound = Sounds.findOne(soundId)
    Sounds.update(soundId, { $set: { muted: !sound.muted } })
  },
  'sounds.updateCode'(soundId, code) {
    check(soundId, String);
    Sounds.update(soundId, { $set: { code: code } })
  },
  'sounds.updateName'(soundId, name) {
    check(soundId, String);
    Sounds.update(soundId, { $set: { name: name } })
  },
  'sounds.updateTags'(soundId, tags) {
    check(soundId, String);
    Sounds.update(soundId, { $set: { tags: tags } })
  }
});
