import {
    describe,
    it,
    expect,
    beforeEach,
    afterEach,
    jest,
} from '@jest/globals';
import { VideoDetector } from '../src/ts/instagram/videoDetector';
import { ReactTag } from '../src/ts/react/reactTag';
import { ReactFlags } from '../src/ts/react/reactFlags';
import { Settings } from '../src/ts/shared/settings';
import { VideoControlMode } from '../src/ts/shared/videoControlMode';

// Full resource/locale fixtures so a real controller can be built in jsdom.
const resourceUrls = {
    images: {
        play: '',
        pause: '',
        fullscreenEnter: '',
        fullscreenExit: '',
        speakerOn: '',
        speakerOff: '',
        pictureInPictureEnter: '',
        pictureInPictureExit: '',
        playbackSpeed: '',
        download: '',
    },
    sounds: { silence: '' },
};
const localeTexts = {
    playTooltip: '',
    pauseTooltip: '',
    muteTooltip: '',
    unmuteTooltip: '',
    playbackSpeedTooltip: '',
    enterFullscreenTooltip: '',
    leaveFullscreenTooltip: '',
    enterPictureInPictureTooltip: '',
    leavePictureInPictureTooltip: '',
    downloadTooltip: '',
};

interface FakeFiberTree {
    polarisFiber: any;
    videoFiber: any;
    polarisRoot: HTMLElement;
    video: HTMLVideoElement;
}

// Builds the minimal fiber tree the detector traversal expects:
// PolarisVideo (class) -> video (host component) backed by real DOM nodes.
function createFiberTree(): FakeFiberTree {
    const polarisRoot = document.createElement('div');
    const video = document.createElement('video');
    polarisRoot.appendChild(video);
    document.body.appendChild(polarisRoot);

    const PolarisVideo = function PolarisVideo() {} as any;
    PolarisVideo.displayName = 'PolarisVideo';

    const polarisFiber: any = {
        tag: ReactTag.ClassComponent,
        type: PolarisVideo,
        stateNode: polarisRoot,
        subtreeFlags: ReactFlags.Update,
        alternate: null,
        return: undefined,
        child: undefined,
        sibling: undefined,
    };
    const videoFiber: any = {
        tag: ReactTag.HostComponent,
        type: 'video',
        stateNode: video,
        return: polarisFiber,
        alternate: null,
        child: undefined,
        sibling: undefined,
    };
    polarisFiber.child = videoFiber;

    return { polarisFiber, videoFiber, polarisRoot, video };
}

describe('VideoDetector delayed mount / unmount', () => {
    let detector: VideoDetector | undefined;

    beforeEach(() => {
        jest.useFakeTimers();
        document.body.innerHTML = '';
        Settings.shared.applyChanges({
            videoControlMode: VideoControlMode.custom,
        });
        // Start every test with a clean React devtools hook so detectors never chain.
        delete (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
        detector = undefined;
    });

    afterEach(() => {
        detector?.destroy();
        detector = undefined;
        delete (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
        jest.useRealTimers();
    });

    async function initDetector(): Promise<{
        detector: VideoDetector;
        hook: any;
    }> {
        detector = new VideoDetector();
        await detector.init();
        window.dispatchEvent(
            new MessageEvent('message', {
                data: {
                    type: 'vci-initialized',
                    resourceUrls,
                    localeTexts,
                },
            })
        );
        return {
            detector,
            hook: (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__,
        };
    }

    it('does not attach when the video unmounts inside the 100ms delay window', async () => {
        const { detector: d, hook } = await initDetector();
        const tree = createFiberTree();

        hook.onCommitFiberRoot(1, { current: tree.polarisFiber });

        // Nothing attached during the waiting window and no registered player yet.
        expect(tree.polarisRoot.querySelectorAll('.ivc-controls').length).toBe(
            0
        );
        expect((d as any).videoPlayers).toHaveLength(0);
        expect((d as any).pendingAttachTimeouts.size).toBe(1);

        // React reports the video unmounting before the timer elapsed.
        hook.onCommitFiberUnmount(1, tree.videoFiber);
        expect((d as any).pendingAttachTimeouts.size).toBe(0);

        // Let the original delay (and anything queued) flush.
        jest.advanceTimersByTime(500);

        expect(tree.polarisRoot.querySelectorAll('.ivc-controls').length).toBe(
            0
        );
        expect((d as any).videoPlayers).toHaveLength(0);
        expect((d as any).pendingAttachTimeouts.size).toBe(0);
    });

    it('does not attach to a detached node even without the unmount hook', async () => {
        const { detector: d, hook } = await initDetector();
        const tree = createFiberTree();

        hook.onCommitFiberRoot(1, { current: tree.polarisFiber });
        expect((d as any).pendingAttachTimeouts.size).toBe(1);

        // The DOM node is removed (isConnected becomes false) but no fiber unmount fired yet.
        tree.polarisRoot.remove();

        jest.advanceTimersByTime(VideoDetector.ATTACH_DELAY_MS + 50);

        expect(tree.polarisRoot.querySelectorAll('.ivc-controls').length).toBe(
            0
        );
        expect((d as any).videoPlayers).toHaveLength(0);
    });

    it('attaches after the delay and unmount removes controls and registry entry', async () => {
        const { detector: d, hook } = await initDetector();
        const tree = createFiberTree();

        hook.onCommitFiberRoot(1, { current: tree.polarisFiber });
        jest.advanceTimersByTime(VideoDetector.ATTACH_DELAY_MS);

        expect(tree.polarisRoot.querySelectorAll('.ivc-controls').length).toBe(
            1
        );
        expect((d as any).videoPlayers).toHaveLength(1);

        hook.onCommitFiberUnmount(1, tree.videoFiber);

        expect(tree.polarisRoot.querySelectorAll('.ivc-controls').length).toBe(
            0
        );
        expect((d as any).videoPlayers).toHaveLength(0);
    });

    it('coalesces repeated commits into one pending attach and one control', async () => {
        const { detector: d, hook } = await initDetector();
        const tree = createFiberTree();

        hook.onCommitFiberRoot(1, { current: tree.polarisFiber });
        hook.onCommitFiberRoot(1, { current: tree.polarisFiber });
        hook.onCommitFiberRoot(1, { current: tree.polarisFiber });

        // Repeated commits for the same element replace the pending timer.
        expect((d as any).pendingAttachTimeouts.size).toBe(1);

        jest.advanceTimersByTime(VideoDetector.ATTACH_DELAY_MS + 50);

        expect(tree.polarisRoot.querySelectorAll('.ivc-controls').length).toBe(
            1
        );
        expect((d as any).videoPlayers).toHaveLength(1);
    });

    it('unmount after several rapid re-commits still cancels the pending attach', async () => {
        const { detector: d, hook } = await initDetector();
        const tree = createFiberTree();

        for (let i = 0; i < 5; i++) {
            hook.onCommitFiberRoot(1, { current: tree.polarisFiber });
        }
        hook.onCommitFiberUnmount(1, tree.videoFiber);

        jest.advanceTimersByTime(500);

        expect(tree.polarisRoot.querySelectorAll('.ivc-controls').length).toBe(
            0
        );
        expect((d as any).videoPlayers).toHaveLength(0);
        expect((d as any).pendingAttachTimeouts.size).toBe(0);
    });
});
