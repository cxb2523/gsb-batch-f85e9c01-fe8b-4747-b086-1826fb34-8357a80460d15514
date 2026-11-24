import { jest } from '@jest/globals';
import { PlaybackManager } from '../src/ts/instagram/playbackManager';
import { VideoPlayer } from '../src/ts/instagram/videoPlayer';

// A minimal PlaybackManager that records all callbacks.
export class FakePlaybackManager implements PlaybackManager {
    public notifyVideoPlay = jest.fn();
    public notifyVideoVolumeChange = jest.fn();
    public notifyVideoPlaybackSpeedChange = jest.fn();
}

export interface FakeVideoDom {
    root: HTMLDivElement;
    video: HTMLVideoElement;
}

// Builds a minimal Instagram-like DOM structure: a root player element containing a video.
export function createFakeVideoDom(): FakeVideoDom {
    const root = document.createElement('div');
    root.classList.add('polaris-player');

    const video = document.createElement('video');
    // jsdom reports a media element without sources as paused; make volume deterministic.
    video.volume = 1;
    video.muted = false;

    root.appendChild(video);
    document.body.appendChild(root);

    return { root, video };
}

// Creates a VideoPlayer bound to the fake DOM.
export function createPlayer(
    dom: FakeVideoDom,
    manager?: PlaybackManager
): VideoPlayer {
    const player = new VideoPlayer(manager ?? new FakePlaybackManager());
    player.videoElementRef = new WeakRef(dom.video);
    player.videoRootElementRef = new WeakRef(dom.root);
    return player;
}

// Dispatches an event on the video element.
export function emit(video: HTMLVideoElement, type: string): boolean {
    return video.dispatchEvent(new Event(type));
}
