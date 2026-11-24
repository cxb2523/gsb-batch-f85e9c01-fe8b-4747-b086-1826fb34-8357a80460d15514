import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import { omit } from 'lodash';

export const Tones = new Mongo.Collection('tones');

// Methods are registered on BOTH client and server on purpose: the client
// stub applies writes to minimongo immediately so a follow-up save reads the
// fresh knob values without waiting for the DDP round-trip. The server
// definitions below remain authoritative.
Meteor.methods({
  'tones.insert'(tone) {
    return Tones.insert(tone);
  },

  'tones.removeFromSoundId'(soundId) {
    return Tones.remove({ soundId: soundId });
  },

  'tones.removeAll'() {
    return Tones.remove({});
  },

  'tones.update'(tone) {
    if (!tone || !tone._id) return
    let set = omit(tone, ['_id'])
    return Tones.update(tone._id, { $set: set })
  }
});

if (Meteor.isServer) {
  Meteor.publish('tones', () => Tones.find())
}
