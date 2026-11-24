// Base class for video controller elements like buttons and bars
import { CustomVideoController } from '../customVideoController';
import { VideoPlayer } from '../../videoPlayer';

export abstract class VideoControllerElement {
    // The parent video controller
    private videoController?: CustomVideoController;

    // Shortcut to the video player
    protected get videoPlayer(): VideoPlayer | undefined {
        return this.videoController?.videoPlayer;
    }

    // Shortcut to the video element
    protected get videoElement(): HTMLVideoElement | undefined {
        return this.videoController?.videoElement;
    }

    public constructor(videoController: CustomVideoController) {
        this.videoController = videoController;
    }

    // Creates the controller element
    public create(parentElement: HTMLElement) {
        this.onCreate(parentElement);
        this.onAfterCreate();
        this.updateControl();
    }

    // Abstract creation method
    protected abstract onCreate(parentElement: HTMLElement): void;

    // Abstract method for after creation
    protected abstract onAfterCreate(): void;

    // Removes the created element again
    public abstract remove(): void;

    // Updates the control element
    protected abstract updateControl(): void;

    // Changes the visibility of the control
    public abstract setVisibility(visible: boolean): void;

    // #region Events

    public onPlay() {}
    public onPause() {}
    public onTimeUpdate() {}
    public onVolumeChange() {}
    public onPlaybackSpeedChange() {}
    public onFullscreenChange() {}
    public onPictureInPictureChange() {}

    // #endregion Events
}

export abstract class VideoControllerElementBase<
    TElement extends HTMLElement,
> extends VideoControllerElement {
    protected element?: TElement;

    // Called right after onCreate.
    override onAfterCreate(): void {
        if (!this.element) return;
        this.registerHooks(this.element);
    }

    // Removes the created element again
    public override remove() {
        if (!this.element) return;
        this.unregisterHooks(this.element);
        this.element.remove();
    }

    // Changes the visibility of the text.
    public override setVisibility(visible: boolean) {
        if (!this.element) return;
        this.element.style.display = visible ? 'block' : 'none';
    }

    // #region Hooks

    // Hooks must be defined before creation
    public pointerenter?: (ev: PointerEvent) => void;
    public pointerleave?: (ev: PointerEvent) => void;

    // The actual wrapper listeners registered on the element. Keeping references makes sure they
    // can be removed again with the exact same function.
    private pointerenterListener?: (ev: PointerEvent) => void;
    private pointerleaveListener?: (ev: PointerEvent) => void;

    private registerHooks(element: TElement) {
        if (this.pointerenter) {
            this.pointerenterListener = (ev) => this.pointerenter?.(ev);
            element.addEventListener('pointerenter', this.pointerenterListener);
        }

        if (this.pointerleave) {
            this.pointerleaveListener = (ev) => this.pointerleave?.(ev);
            element.addEventListener('pointerleave', this.pointerleaveListener);
        }
    }

    private unregisterHooks(element: TElement) {
        if (this.pointerenterListener) {
            element.removeEventListener(
                'pointerenter',
                this.pointerenterListener
            );
            this.pointerenterListener = undefined;
        }

        if (this.pointerleaveListener) {
            element.removeEventListener(
                'pointerleave',
                this.pointerleaveListener
            );
            this.pointerleaveListener = undefined;
        }
    }

    // #endregion Hooks
}
