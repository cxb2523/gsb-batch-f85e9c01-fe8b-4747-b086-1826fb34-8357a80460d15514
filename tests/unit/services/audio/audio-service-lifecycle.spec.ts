import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import EventFactory from "@/model/factories/event-factory";
import InstrumentFactory from "@/model/factories/instrument-factory";
import { ACTION_NOTE_ON } from "@/model/types/audio-event";
import type { EffluxAudioEvent } from "@/model/types/audio-event";
import type { Instrument } from "@/model/types/instrument";
import {
    prepareEnvironment, noteOn, noteOff, reset, getInternalState
} from "@/services/audio-service";
import { VOLUME } from "@/definitions/automatable-parameters";
import WaveTables from "@/services/audio/wave-tables";
import Config from "@/config";
import { createMockAudioContext, setContextCurrentTime } from "../../mocks";

// jsdom does not provide Web Audio node constructors, define lightweight placeholders
// so instanceof checks in the routing code resolve without throwing
beforeAll(() => {
    [ "GainNode", "BiquadFilterNode", "StereoPannerNode", "DelayNode",
      "WaveShaperNode", "ChannelSplitterNode", "ChannelMergerNode", "AnalyserNode" ]
        .forEach( name => {
            if ( typeof ( globalThis as Record<string, unknown> )[ name ] === "undefined" ) {
                ( globalThis as Record<string, unknown> )[ name ] = class {};
            }
        });
});

type MockSource = AudioScheduledSourceNode & Record<string, unknown> & {
    frequency: AudioParam,
    onended: (() => void) | null
};

/**
 * integration test driving the full noteOn / noteOff lifecycle of the
 * AudioService using a fully mocked AudioContext. The source nodes expose
 * an onended handler that is flushed manually to simulate the end of the
 * attack/sustain and release phases.
 */
describe( "AudioService voice lifecycle", () => {
    let context: ReturnType<typeof createMockAudioContext>;
    let instrument: Instrument;
    const baselinePoolSize = Config.INSTRUMENT_AMOUNT * 2; // see createModules() in audio-service
    const instrumentIndex = 0;
    const oscillatorIndex = 0;

    const createEvent = ( props?: Partial<EffluxAudioEvent> ): EffluxAudioEvent => ({
        ...EventFactory.create( instrumentIndex, "C", 3, ACTION_NOTE_ON ),
        seq: { playing: true, startMeasure: 0, startMeasureOffset: 0, length: 1, mpLength: 1 },
        ...props
    });

    /**
     * flush the onended handlers of all sources that have one attached, simulating
     * the AudioContext ending playback of those nodes (e.g. at release completion)
     */
    const flushEndedSources = (): void => {
        const pending = ( context.sources as MockSource[] )
            .filter( source => typeof source.onended === "function" );
        pending.forEach( source => {
            const handler = source.onended;
            source.onended = null;
            handler?.();
        });
    };

    const pool = () => getInternalState().instrumentModulesList[ instrumentIndex ].voices[ oscillatorIndex ];
    const playingEvents = () => getInternalState().playingEventVoices[ instrumentIndex ];

    beforeEach(() => {
        context = createMockAudioContext();
        setContextCurrentTime( context, 0 );
        prepareEnvironment( context, WaveTables );

        instrument = InstrumentFactory.create( instrumentIndex );
        instrument.oscillators.forEach(( oscillator, index ) => {
            oscillator.enabled = index === oscillatorIndex;
            oscillator.adsr = { attack: 0, decay: 0, sustain: 0.75, release: 0.5 };
            oscillator.pitch.range = 0;
        });
    });

    afterEach(() => {
        reset( true );
        vi.clearAllMocks();
    });

    it( "should return triggered voices to the pool and clear the playing event after release", () => {
        const event = createEvent();

        noteOn( event, instrument, new Map(), 0 );

        expect( event.id ).toBeGreaterThan( 0 );
        expect( pool() ).toHaveLength( baselinePoolSize - 1 );
        expect( playingEvents()[ event.id ]).toBeDefined();

        noteOff( event, 1 );

        // the release has not ended yet, the voice remains reserved and the event stays registered
        expect( pool() ).toHaveLength( baselinePoolSize - 1 );
        expect( playingEvents()[ event.id ]).toBeDefined();

        flushEndedSources();

        // release completed : voice returned to the pool, playing event entry removed
        expect( pool() ).toHaveLength( baselinePoolSize );
        expect( playingEvents() ).toEqual({});
    });

    it( "should not reuse the releasing voice on retrigger and return it to the pool after release", () => {
        const event = createEvent();

        noteOn( event, instrument, new Map(), 0 );
        const firstId = event.id;
        expect( pool() ).toHaveLength( baselinePoolSize - 1 );

        // retrigger the same event while the first note is still sounding: noteOn forces a noteOff
        // (release tail starts) and assigns a fresh event id with an independent pooled voice
        setContextCurrentTime( context, 0.5 );
        noteOn( event, instrument, new Map(), 0.5 );
        const secondId = event.id;

        expect( secondId ).not.toBe( firstId );
        expect( pool() ).toHaveLength( baselinePoolSize - 2 );
        expect( Object.keys( playingEvents())).toEqual(
            expect.arrayContaining([ String( firstId ), String( secondId ) ])
        );

        // only the first (releasing) source ends now: the retriggered note must keep playing
        const activeSources = ( context.sources as MockSource[] )
            .filter( source => typeof source.onended === "function" );
        expect( activeSources ).toHaveLength( 2 );
        activeSources[ 0 ].onended!();
        activeSources[ 0 ].onended = null;

        expect( pool() ).toHaveLength( baselinePoolSize - 1 );
        expect( playingEvents()[ firstId ]).toBeUndefined();
        expect( playingEvents()[ secondId ]).toBeDefined();

        // complete the retriggered note through noteOff and its release
        noteOff( event, 1.5 );
        flushEndedSources();

        expect( pool() ).toHaveLength( baselinePoolSize );
        expect( playingEvents() ).toEqual({});
    });

    it( "should isolate glide automation per event id so the old note cannot cancel the new note's glide", () => {
        const event = createEvent({ mp: EventFactory.createModuleParam( VOLUME, 50, true ) });

        noteOn( event, instrument, new Map(), 0 );
        const firstId = event.id;
        const firstVoice = playingEvents()[ firstId ][ 0 ];
        const firstGain = firstVoice.gain.gain as unknown as {
            cancelScheduledValues: ReturnType<typeof vi.fn>,
            linearRampToValueAtTime: ReturnType<typeof vi.fn>
        };

        expect( firstGain.cancelScheduledValues ).toHaveBeenCalledWith( 0 );
        expect( firstGain.linearRampToValueAtTime ).toHaveBeenCalledTimes( 1 );
        const firstCancellations = firstGain.cancelScheduledValues.mock.calls.length;

        // retrigger with its own VOLUME glide while the first note is still in its release phase
        setContextCurrentTime( context, 0.5 );
        noteOn( event, instrument, new Map(), 0.5 );
        const secondId = event.id;
        const secondVoice = playingEvents()[ secondId ][ 0 ];
        const secondGain = secondVoice.gain.gain as unknown as {
            cancelScheduledValues: ReturnType<typeof vi.fn>,
            linearRampToValueAtTime: ReturnType<typeof vi.fn>
        };

        // the new note owns independent gain nodes and schedules its own glide; the old note's
        // scheduled automation must not have been cancelled by the retrigger
        expect( secondGain ).not.toBe( firstGain );
        expect( secondGain.cancelScheduledValues ).toHaveBeenCalledWith( 0.5 );
        expect( secondGain.linearRampToValueAtTime ).toHaveBeenCalledTimes( 1 );
        expect( firstGain.cancelScheduledValues.mock.calls.length ).toBe( firstCancellations );

        // snapshot the new note's scheduling state after its noteOn; ending the old note's
        // release must not add any (automation) cancellations or ramps onto the new note's param
        const secondCancellationsBeforeReleaseEnd = secondGain.cancelScheduledValues.mock.calls.length;
        const secondRampsBeforeReleaseEnd = secondGain.linearRampToValueAtTime.mock.calls.length;

        const releasingSource = ( context.sources as MockSource[] ).find( source => source.onended );
        releasingSource!.onended!();
        releasingSource!.onended = null;

        expect( secondGain.cancelScheduledValues.mock.calls.length ).toBe( secondCancellationsBeforeReleaseEnd );
        expect( secondGain.linearRampToValueAtTime.mock.calls.length ).toBe( secondRampsBeforeReleaseEnd );
        expect( playingEvents()[ firstId ]).toBeUndefined();
        expect( playingEvents()[ secondId ]).toBeDefined();

        noteOff( event, 1.5 );
        flushEndedSources();
        expect( playingEvents() ).toEqual({});
    });

    it( "should not create any automation scheduling for events without mp", () => {
        const event = createEvent();
        delete event.mp;

        noteOn( event, instrument, new Map(), 0 );

        const voice = playingEvents()[ event.id ][ 0 ];
        const gain = voice.gain.gain as unknown as { linearRampToValueAtTime: ReturnType<typeof vi.fn> };
        const frequency = ( voice.generator as unknown as MockSource ).frequency as unknown as {
            linearRampToValueAtTime: ReturnType<typeof vi.fn>
        };

        // the voice gain (VOLUME) and generator frequency (PITCH) must have no automation scheduled;
        // only the ADSR amp envelope operates on the separate output node
        expect( gain.linearRampToValueAtTime ).not.toHaveBeenCalled();
        expect( frequency.linearRampToValueAtTime ).not.toHaveBeenCalled();

        noteOff( event, 1 );
        flushEndedSources();
        expect( playingEvents() ).toEqual({});
        expect( pool() ).toHaveLength( baselinePoolSize );
    });

    it( "should return early from noteOff without side effects when no voice list is registered", () => {
        const event = createEvent();
        // noteOn was never invoked, assign an id for which no voice list exists
        event.id = 999;

        expect(() => noteOff( event, 1 )).not.toThrow();
        expect( playingEvents() ).toEqual({});
        expect( pool() ).toHaveLength( baselinePoolSize );
    });

    it( "should keep the pool and playingEventVoices at baseline across repeated looped retriggers", () => {
        for ( let i = 0; i < 24; ++i ) {
            const event = createEvent();
            noteOn( event, instrument, new Map(), i );
            noteOff( event, i + 0.25 );
            flushEndedSources();
            expect( playingEvents() ).toEqual({});
            expect( pool() ).toHaveLength( baselinePoolSize );
        }
    });
});
