import {
    describe,
    it,
    expect,
    beforeEach,
    afterEach,
    jest,
} from '@jest/globals';
import { VideoPlayer } from '../src/ts/instagram/videoPlayer';
import { Settings } from '../src/ts/shared/settings';
import { VideoControlMode } from '../src/ts/shared/videoControlMode';
import { CustomVideoController } from '../src/ts/instagram/controller/customVideoController';
import {
    createFakeVideoDom,
    createPlayer,
    emit,
    FakePlaybackManager,
    FakeVideoDom,
} from './helpers';

describe('VideoPlayer lifecycle', () => {
    let dom: FakeVideoDom;
    let players: VideoPlayer[];

    function setup(manager?: FakePlaybackManager): VideoPlayer {
        const player = createPlayer(dom, manager);
        players.push(player);
        return player;
    }

    beforeEach(() => {
        document.body.innerHTML = '';
        dom = createFakeVideoDom();
        players = [];
        Settings.shared.applyChanges({
            videoControlMode: VideoControlMode.custom,
            autoHideControlBar: false,
        });
        jest.restoreAllMocks();
    });

    afterEach(() => {
        // Detach every player so document-level listeners do not leak between tests.
        for (const player of players) player.detach();
        players = [];
        jest.restoreAllMocks();
    });

    it('attaches exactly one set of controls', () => {
        const player = setup();
        player.attach();

        expect(dom.root.querySelectorAll('.ivc-controls').length).toBe(1);
        expect(dom.root.querySelectorAll('.ivc-controls-content').length).toBe(
            1
        );
        expect(player.isAttached).toBe(true);
    });

    it('attach() is idempotent and never creates duplicate controls/listeners', () => {
        const manager = new FakePlaybackManager();
        const player = setup(manager);

        player.attach();
        player.attach();
        player.attach();

        expect(dom.root.querySelectorAll('.ivc-controls').length).toBe(1);

        emit(dom.video, 'play');
        expect(manager.notifyVideoPlay).toHaveBeenCalledTimes(1);
    });

    it('rebuilds controls on control-mode change and keeps a single control root', () => {
        const player = setup();
        player.attach();
        expect(dom.root.querySelectorAll('.ivc-controls').length).toBe(1);

        // Switch to native.
        Settings.shared.videoControlMode = VideoControlMode.native;
        player.updateControlMode();

        expect(dom.root.querySelectorAll('.ivc-controls').length).toBe(1);
        // The native controller does not render the custom content row.
        expect(dom.root.querySelectorAll('.ivc-controls-content').length).toBe(
            0
        );

        // Switch back to custom.
        Settings.shared.videoControlMode = VideoControlMode.custom;
        player.updateControlMode();

        expect(dom.root.querySelectorAll('.ivc-controls').length).toBe(1);
        expect(dom.root.querySelectorAll('.ivc-controls-content').length).toBe(
            1
        );
    });

    it('drives the new controller with every media event after a rebuild', () => {
        const onPlay = jest.spyOn(CustomVideoController.prototype, 'onPlay');
        const onPause = jest.spyOn(CustomVideoController.prototype, 'onPause');
        const onTimeUpdate = jest.spyOn(
            CustomVideoController.prototype,
            'onTimeUpdate'
        );
        const onVolumeChange = jest.spyOn(
            CustomVideoController.prototype,
            'onVolumeChange'
        );
        const onRateChange = jest.spyOn(
            CustomVideoController.prototype,
            'onPlaybackSpeedChange'
        );
        const onFullscreenChange = jest.spyOn(
            CustomVideoController.prototype,
            'onFullscreenChange'
        );
        const onPipChange = jest.spyOn(
            CustomVideoController.prototype,
            'onPictureInPictureChange'
        );

        const manager = new FakePlaybackManager();
        const player = setup(manager);
        player.attach();

        // Rebuild the UI (the reported regression).
        player.updateControlMode();
        expect(dom.root.querySelectorAll('.ivc-controls').length).toBe(1);

        emit(dom.video, 'play');
        emit(dom.video, 'pause');
        emit(dom.video, 'timeupdate');
        emit(dom.video, 'volumechange');
        emit(dom.video, 'ratechange');
        document.dispatchEvent(new Event('fullscreenchange'));
        emit(dom.video, 'enterpictureinpicture');

        expect(onPlay).toHaveBeenCalledTimes(1);
        expect(onPause).toHaveBeenCalledTimes(1);
        expect(onTimeUpdate).toHaveBeenCalledTimes(1);
        expect(onVolumeChange).toHaveBeenCalledTimes(1);
        expect(onRateChange).toHaveBeenCalledTimes(1);
        expect(onFullscreenChange).toHaveBeenCalledTimes(1);
        expect(onPipChange).toHaveBeenCalledTimes(1);

        // Playback manager is still wired to the same player.
        expect(manager.notifyVideoPlay).toHaveBeenCalledTimes(1);
    });

    it('volume bar follows video volume changes after a rebuild', () => {
        const player = setup();
        player.attach();
        player.updateControlMode();

        const progress = dom.root.querySelector(
            '.ivc-volume-bar .ivc-control-bar-progress'
        ) as HTMLElement | null;
        expect(progress).not.toBeNull();

        dom.video.volume = 0.4;
        emit(dom.video, 'volumechange');

        expect(progress?.style.width).toBe('40%');

        dom.video.volume = 0.8;
        emit(dom.video, 'volumechange');
        expect(progress?.style.width).toBe('80%');
    });

    it('detach() removes the controls and silences all events', () => {
        const manager = new FakePlaybackManager();
        const player = setup(manager);
        player.attach();

        player.detach();

        expect(dom.root.querySelectorAll('.ivc-controls').length).toBe(0);
        expect(player.isAttached).toBe(false);

        emit(dom.video, 'play');
        emit(dom.video, 'pause');
        emit(dom.video, 'timeupdate');
        emit(dom.video, 'volumechange');
        emit(dom.video, 'ratechange');
        document.dispatchEvent(new Event('fullscreenchange'));
        emit(dom.video, 'enterpictureinpicture');

        expect(manager.notifyVideoPlay).not.toHaveBeenCalled();
        expect(manager.notifyVideoVolumeChange).not.toHaveBeenCalled();
        expect(manager.notifyVideoPlaybackSpeedChange).not.toHaveBeenCalled();
    });

    it('detach() is idempotent and tolerates being called repeatedly', () => {
        const manager = new FakePlaybackManager();
        const player = setup(manager);
        player.attach();

        expect(() => {
            player.detach();
            player.detach();
            player.detach();
        }).not.toThrow();

        expect(dom.root.querySelectorAll('.ivc-controls').length).toBe(0);

        emit(dom.video, 'play');
        expect(manager.notifyVideoPlay).not.toHaveBeenCalled();
    });

    it('runs listener and controller cleanup exactly once even for repeated detach()', () => {
        const player = setup();
        player.attach();

        const removeListener = jest.spyOn(dom.video, 'removeEventListener');
        const docRemoveListener = jest.spyOn(document, 'removeEventListener');
        const controller = (player as any).videoController;
        const removeControl = jest.spyOn(controller, 'remove');

        player.detach();
        player.detach();
        player.detach();

        const playRemovals = removeListener.mock.calls.filter(
            (c) => c[0] === 'play'
        ).length;
        expect(playRemovals).toBe(1);

        const fsRemovals = docRemoveListener.mock.calls.filter(
            (c) => c[0] === 'fullscreenchange'
        ).length;
        expect(fsRemovals).toBe(1);

        expect(removeControl).toHaveBeenCalledTimes(1);
        expect((player as any).videoController).toBeUndefined();
    });

    it('detach() is safe before the first attach', () => {
        const player = setup();
        expect(() => player.detach()).not.toThrow();
        expect(player.isAttached).toBe(false);
    });

    it('balances every video/document listener across attach and detach', () => {
        const videoAdd = jest.spyOn(dom.video, 'addEventListener');
        const videoRemove = jest.spyOn(dom.video, 'removeEventListener');
        const docAdd = jest.spyOn(document, 'addEventListener');
        const docRemove = jest.spyOn(document, 'removeEventListener');

        const player = setup();
        player.attach();
        player.detach();

        const videoTypes = [
            'play',
            'pause',
            'ended',
            'timeupdate',
            'volumechange',
            'ratechange',
            'enterpictureinpicture',
            'leavepictureinpicture',
            'click',
        ];
        for (const type of videoTypes) {
            const added = videoAdd.mock.calls.filter(
                (c) => c[0] === type
            ).length;
            const removed = videoRemove.mock.calls.filter(
                (c) => c[0] === type
            ).length;
            expect(removed).toBe(added);
        }

        const fsAdded = docAdd.mock.calls.filter(
            (c) => c[0] === 'fullscreenchange'
        ).length;
        const fsRemoved = docRemove.mock.calls.filter(
            (c) => c[0] === 'fullscreenchange'
        ).length;
        expect(fsRemoved).toBe(fsAdded);
        expect(fsAdded).toBeGreaterThan(0);
    });

    it('survives many rapid rebuilds with exactly one wired controller', () => {
        const manager = new FakePlaybackManager();
        const player = setup(manager);
        player.attach();

        for (let i = 0; i < 20; i++) {
            Settings.shared.applyChanges({
                videoControlMode:
                    i % 2 === 0
                        ? VideoControlMode.native
                        : VideoControlMode.custom,
            });
            player.updateControlMode();
        }
        // End on custom because the last iteration (i = 19) selected custom.
        Settings.shared.videoControlMode = VideoControlMode.custom;
        player.updateControlMode();

        expect(dom.root.querySelectorAll('.ivc-controls').length).toBe(1);
        expect(dom.root.querySelectorAll('.ivc-controls-content').length).toBe(
            1
        );

        emit(dom.video, 'play');
        expect(manager.notifyVideoPlay).toHaveBeenCalledTimes(1);
    });
});
