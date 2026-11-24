import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { VideoDetector } from '../src/ts/instagram/videoDetector';
import { Settings } from '../src/ts/shared/settings';
import { VideoControlMode } from '../src/ts/shared/videoControlMode';
import {
    createFakeVideoDom,
    createPlayer,
    emit,
    FakeVideoDom,
} from './helpers';
import { VideoPlayer } from '../src/ts/instagram/videoPlayer';

describe('Cross-video volume / mute / speed sync', () => {
    let detector: VideoDetector;
    let domA: FakeVideoDom;
    let domB: FakeVideoDom;
    let playerA: VideoPlayer;
    let playerB: VideoPlayer;

    beforeEach(() => {
        document.body.innerHTML = '';
        Settings.shared.applyChanges({
            videoControlMode: VideoControlMode.custom,
        });

        detector = new VideoDetector();
        domA = createFakeVideoDom();
        domB = createFakeVideoDom();

        playerA = createPlayer(domA, detector);
        playerB = createPlayer(domB, detector);
        playerA.attach();
        playerB.attach();

        // Register both players with the playback manager.
        (detector as any).videoPlayers.push(playerA, playerB);
        (detector as any).lastPlaybackMuted = false;
    });

    afterEach(() => {
        playerA.detach();
        playerB.detach();
        detector.destroy();
    });

    it('syncs volume and mute across all videos', () => {
        // User changes volume on A.
        domA.video.volume = 0.55;
        domA.video.muted = false;
        emit(domA.video, 'volumechange');

        expect(domB.video.volume).toBeCloseTo(0.55, 5);
        expect(domB.video.muted).toBe(false);

        // User mutes A.
        domA.video.muted = true;
        emit(domA.video, 'volumechange');

        expect(domB.video.muted).toBe(true);

        // User unmutes and changes volume again.
        domA.video.muted = false;
        domA.video.volume = 0.8;
        emit(domA.video, 'volumechange');

        expect(domB.video.muted).toBe(false);
        expect(domB.video.volume).toBeCloseTo(0.8, 5);
    });

    it('syncs playback speed across all videos', () => {
        domA.video.playbackRate = 1.75;
        emit(domA.video, 'ratechange');

        expect(domB.video.playbackRate).toBeCloseTo(1.75, 5);

        domB.video.playbackRate = 2.5;
        emit(domB.video, 'ratechange');

        // Changing B propagates back to A.
        expect(domA.video.playbackRate).toBeCloseTo(2.5, 5);
    });

    it('keeps syncing after the controls are rebuilt', () => {
        // Rebuild both players (control-mode switch lifecycle).
        playerA.updateControlMode();
        playerB.updateControlMode();
        expect(domA.root.querySelectorAll('.ivc-controls').length).toBe(1);
        expect(domB.root.querySelectorAll('.ivc-controls').length).toBe(1);

        domA.video.volume = 0.35;
        domA.video.muted = false;
        emit(domA.video, 'volumechange');

        expect(domB.video.volume).toBeCloseTo(0.35, 5);
        expect(domB.video.muted).toBe(false);

        domA.video.playbackRate = 2.25;
        emit(domA.video, 'ratechange');

        expect(domB.video.playbackRate).toBeCloseTo(2.25, 5);

        // Events still reach the rebuilt controller UI without throwing.
        expect(() => {
            emit(domA.video, 'play');
            emit(domA.video, 'timeupdate');
            emit(domA.video, 'volumechange');
        }).not.toThrow();
    });
});
