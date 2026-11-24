import { vi } from "vitest";
import type { Store } from "vuex";
import { MP3 } from "@/definitions/file-types";
import { type Sample, PlaybackType } from "@/model/types/sample";
import type { EffluxState } from "@/store";
import { createEditorState } from "@/store/modules/editor-module";
import { createHistoryState } from "@/store/modules/history-module";
import { createInstrumentState } from "@/store/modules/instrument-module";
import { createMidiState } from "@/store/modules/midi-module";
import { createSampleState } from "@/store/modules/sample-module";
import { createSelectionState } from "@/store/modules/selection-module";
import { createSequencerState } from "@/store/modules/sequencer-module";
import { createSettingsState } from "@/store/modules/settings-module";
import { createSongState } from "@/store/modules/song-module";

export const mockAudioContext: BaseAudioContext = {
    sampleRate: 44100,
    currentTime: 0
} as BaseAudioContext;

export const setContextCurrentTime = ( context: BaseAudioContext, currentTime = 0 ): void => {
    // @ts-expect-error read only property in actual implementation
    context.currentTime = currentTime;
};

export const mockGainNode: GainNode = {
    gain: {
        cancelScheduledValues: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        setValueAtTime: vi.fn()
    }
} as unknown as GainNode;

/**
 * creates a controllable mock of an AudioParam, keeping a local "value" property
 * while recording all scheduling calls so tests can assert automation lifecycles
 */
export const createMockAudioParam = ( value = 0 ): AudioParam => ({
    value,
    cancelScheduledValues: vi.fn(),
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
    cancelAndHoldAtTime: vi.fn(),
}) as unknown as AudioParam;

/**
 * creates a generic mock AudioNode whose connect/disconnect calls are recorded.
 * Optional AudioParams (e.g. gain, frequency, pan, playbackRate, delayTime) can
 * be supplied via the params argument
 */
export const createMockAudioNode = ( params: Record<string, AudioParam> = {} ): AudioNode & Record<string, unknown> => {
    const node = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        ...params
    };
    return node as unknown as AudioNode & Record<string, unknown>;
};

/**
 * creates a mock of an AudioScheduledSourceNode (e.g. an OscillatorNode /
 * AudioBufferSourceNode) with a manually invokable "onended" handler so tests can
 * deterministically simulate the end of a nodes playback / release phase
 */
export const createMockSourceNode = ( params: Record<string, AudioParam> = {} ): AudioScheduledSourceNode & Record<string, unknown> => ({
    ...createMockAudioNode( params ),
    start: vi.fn(),
    stop: vi.fn(),
    // legacy WebAudio fallback names used when no standards compliant AudioContext is feature detected
    noteOn: vi.fn(),
    noteOff: vi.fn(),
    onended: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
});

/**
 * creates a mock AudioContext providing all factory methods the AudioService
 * pipeline uses. The created source nodes are tracked in "sources" and expose an
 * onended handler allowing tests to flush the release-phase callbacks
 */
export const createMockAudioContext = (): BaseAudioContext & { sources: Array<AudioScheduledSourceNode & Record<string, unknown>> } => {
    const sources: Array<AudioScheduledSourceNode & Record<string, unknown>> = [];
    const context = {
        sampleRate: 44100,
        currentTime: 0,
        destination: createMockAudioNode(),
        sources,
        createGain: () => createMockAudioNode({ gain: createMockAudioParam( 1 ) }),
        // legacy WebAudio fallback name used when no standards compliant AudioContext is feature detected
        createGainNode: function() { return this.createGain(); },
        createBiquadFilter: () => createMockAudioNode({
            frequency: createMockAudioParam(),
            Q: createMockAudioParam(),
            gain: createMockAudioParam(),
            type: "" as unknown as AudioParam
        }),
        createOscillator: () => {
            const node = createMockSourceNode({ frequency: createMockAudioParam() });
            node.setPeriodicWave = vi.fn();
            sources.push( node );
            return node;
        },
        createBufferSource: () => {
            const node = createMockSourceNode({ playbackRate: createMockAudioParam( 1 ) });
            node.buffer = null;
            node.loop = false;
            sources.push( node );
            return node;
        },
        createBuffer: ( numberOfChannels: number, length: number, sampleRate: number ): AudioBuffer => ({
            numberOfChannels, length, sampleRate, duration: length / sampleRate,
            getChannelData: () => new Float32Array( length ),
            copyFromChannel: vi.fn(),
            copyToChannel: vi.fn()
        }) as unknown as AudioBuffer,
        createStereoPanner: () => createMockAudioNode({ pan: createMockAudioParam() }),
        createWaveShaper: () => createMockAudioNode({ curve: null }),
        createDelay: () => createMockAudioNode({ delayTime: createMockAudioParam( 1 ) }),
        createChannelSplitter: () => createMockAudioNode(),
        createChannelMerger: () => createMockAudioNode(),
        createAnalyser: () => createMockAudioNode(),
        createPeriodicWave: vi.fn((): PeriodicWave => ({}) as PeriodicWave),
        createDynamicsCompressor: () => createMockAudioNode({
            threshold: createMockAudioParam(),
            knee: createMockAudioParam(),
            ratio: createMockAudioParam(),
            attack: createMockAudioParam(),
            release: createMockAudioParam()
        })
    };
    return context as unknown as BaseAudioContext & { sources: Array<AudioScheduledSourceNode & Record<string, unknown>> };
};

export const createMockOscillatorNode = (): OscillatorNode => ({
    disconnect: vi.fn(),
} as unknown as OscillatorNode );

export const mockAudioBuffer: AudioBuffer = {
    sampleRate: 44100,
    length: 132300,
    duration: 3,
    numberOfChannels: 1
} as AudioBuffer;

export const createSample = ( sampleName: string, optId?: string, type = PlaybackType.REPITCHED ): Sample => ({
    id         : optId ?? `s{Math.ceil( Math.random() * 100 )}`,
    name       : sampleName,
    source     : "base64;",
    buffer     : mockAudioBuffer,
    rangeStart : 0,
    rangeEnd   : mockAudioBuffer.duration,
    rate       : mockAudioBuffer.sampleRate,
    duration   : mockAudioBuffer.duration,
    loop       : true,
    pitch      : null,
    slices     : [],
    optimized  : false,
    type,
});

export const createSampleSourceBlob = ( type = MP3, size = 512000 ) => {
    return new Blob([ new Uint8Array( size ) ], { type });
};

export const createState = ( props?: Partial<EffluxState> ): EffluxState => ({
    menuOpened: false,
    blindActive: false,
    helpTopic: "general",
    loadingStates: [], // wether one or more long running operations are running
    windowSize: { width: 800, height: 600 },
    dialog: null,
    notifications: [],
    modal: null,
    mobileMode: null,
    supportsTouch: false,
    dropboxConnected: false,
    mediaConnected: false,
    applicationFocused: true,
    editor: createEditorState(),
    history: createHistoryState(),
    instrument: createInstrumentState(),
    midi: createMidiState(),
    sample: createSampleState(),
    selection: createSelectionState(),
    sequencer: createSequencerState(),
    settings: createSettingsState(),
    song: createSongState(),
    ...props
});

export const createMockStore = ( props?: Partial<EffluxState> ): Store<EffluxState> => ({
    state: createState( props ),
    getters: {
        t: vi.fn(), // vue-i18n
    },
    commit: vi.fn(),
    dispatch: vi.fn(),
}) as unknown as Store<EffluxState>;