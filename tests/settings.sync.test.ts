import {
    describe,
    it,
    expect,
    beforeEach,
    afterEach,
    jest,
} from '@jest/globals';
import { VideoDetector } from '../src/ts/instagram/videoDetector';
import { Settings } from '../src/ts/shared/settings';
import { VideoControlMode } from '../src/ts/shared/videoControlMode';
import { createFakeVideoDom, createPlayer } from './helpers';

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

function storeSettingsCalls(postMessage: jest.Mock): unknown[] {
    return postMessage.mock.calls.filter(
        (call) =>
            (call[0] as { type?: string } | undefined)?.type ===
            'vci-store-settings'
    );
}

describe('Settings round-trip sync', () => {
    let detector: VideoDetector | undefined;

    beforeEach(() => {
        document.body.innerHTML = '';
        Settings.shared.applyChanges({
            videoControlMode: VideoControlMode.custom,
            showFullscreenButton: true,
        });
        detector = undefined;
    });

    afterEach(() => {
        detector?.destroy();
        detector = undefined;
    });

    async function initDetector(): Promise<{
        detector: VideoDetector;
        postMessage: jest.Mock;
        source: MessageEventSource;
    }> {
        detector = new VideoDetector();
        await detector.init();

        const postMessage = jest.fn();
        const source = { postMessage } as unknown as MessageEventSource;

        window.dispatchEvent(
            new MessageEvent('message', {
                data: {
                    type: 'vci-initialized',
                    resourceUrls,
                    localeTexts,
                },
                source,
            } as MessageEventInit)
        );

        return { detector, postMessage, source };
    }

    function pushExtensionSettings(data: Record<string, unknown>) {
        window.dispatchEvent(
            new MessageEvent('message', {
                data: { type: 'vci-settings', data },
            })
        );
    }

    it('syncs a control-mode change to every registered player without echoing it back', async () => {
        const { detector: d, postMessage } = await initDetector();

        const playerA = {
            updateControlMode: jest.fn(),
            detach: jest.fn(),
        };
        const playerB = {
            updateControlMode: jest.fn(),
            detach: jest.fn(),
        };
        (d as any).videoPlayers.push(playerA, playerB);

        postMessage.mockClear();

        // Extension pushes a new control mode.
        pushExtensionSettings({
            videoControlMode: VideoControlMode.native,
        });

        expect(Settings.shared.videoControlMode).toBe(VideoControlMode.native);
        expect(playerA.updateControlMode).toHaveBeenCalledTimes(1);
        expect(playerB.updateControlMode).toHaveBeenCalledTimes(1);

        // The extension-originated value must not be stored/posted back.
        expect(storeSettingsCalls(postMessage)).toHaveLength(0);
    });

    it('syncs regular control settings to every registered player without echo', async () => {
        const { detector: d, postMessage } = await initDetector();

        const playerA = {
            updateControlSetting: jest.fn(),
            detach: jest.fn(),
        };
        const playerB = {
            updateControlSetting: jest.fn(),
            detach: jest.fn(),
        };
        (d as any).videoPlayers.push(playerA, playerB);

        postMessage.mockClear();

        pushExtensionSettings({ showFullscreenButton: false });

        expect(Settings.shared.showFullscreenButton).toBe(false);
        expect(playerA.updateControlSetting).toHaveBeenCalledTimes(1);
        expect(playerB.updateControlSetting).toHaveBeenCalledTimes(1);
        expect(storeSettingsCalls(postMessage)).toHaveLength(0);
    });

    it('still reports local setting changes so the extension can persist them', async () => {
        const { postMessage } = await initDetector();
        postMessage.mockClear();

        // A local/page-side change (not flagged as extension-applied) is reported once.
        Settings.shared.videoControlMode = VideoControlMode.native;

        const storeCalls = storeSettingsCalls(postMessage);
        expect(storeCalls).toHaveLength(1);
        expect(
            (storeCalls[0] as unknown[])[0] as {
                data: { videoControlMode: VideoControlMode };
            }
        ).toMatchObject({
            type: 'vci-store-settings',
            data: { videoControlMode: VideoControlMode.native },
        });
    });

    it('rebuilds all real registered players when the control mode changes', async () => {
        const { detector: d } = await initDetector();

        const domA = createFakeVideoDom();
        const domB = createFakeVideoDom();
        const playerA = createPlayer(domA, d);
        const playerB = createPlayer(domB, d);
        playerA.attach();
        playerB.attach();
        (d as any).videoPlayers.push(playerA, playerB);

        // Extension switches everyone to native.
        pushExtensionSettings({
            videoControlMode: VideoControlMode.native,
        });

        for (const dom of [domA, domB]) {
            expect(dom.root.querySelectorAll('.ivc-controls').length).toBe(1);
            expect(
                dom.root.querySelectorAll('.ivc-controls-content').length
            ).toBe(0);
        }

        // Extension switches everyone back to custom.
        pushExtensionSettings({
            videoControlMode: VideoControlMode.custom,
        });

        for (const dom of [domA, domB]) {
            expect(dom.root.querySelectorAll('.ivc-controls').length).toBe(1);
            expect(
                dom.root.querySelectorAll('.ivc-controls-content').length
            ).toBe(1);
        }

        playerA.detach();
        playerB.detach();
    });

    it('does not echo a rapid burst of extension settings', async () => {
        const { detector: d, postMessage } = await initDetector();
        const player = {
            updateControlMode: jest.fn(),
            detach: jest.fn(),
        };
        (d as any).videoPlayers.push(player);
        postMessage.mockClear();

        // Rapid alternating mode pushes.
        for (let i = 0; i < 6; i++) {
            pushExtensionSettings({
                videoControlMode:
                    i % 2 === 0
                        ? VideoControlMode.native
                        : VideoControlMode.custom,
            });
        }

        expect(storeSettingsCalls(postMessage)).toHaveLength(0);
        // Every effective change rebuilt the player.
        expect(player.updateControlMode.mock.calls.length).toBeGreaterThan(0);
    });
});
