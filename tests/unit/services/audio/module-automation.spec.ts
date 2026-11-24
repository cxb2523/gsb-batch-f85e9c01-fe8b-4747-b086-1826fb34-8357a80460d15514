import { describe, it, expect, beforeEach, vi } from "vitest";
import EventFactory from "@/model/factories/event-factory";
import { ACTION_NOTE_ON } from "@/model/types/audio-event";
import type { EffluxAudioEvent } from "@/model/types/audio-event";
import type { EventVoice } from "@/model/types/event-voice";
import {
    applyModuleParamChange, clearGlideStateForEvent, clearAllGlideStates
} from "@/services/audio/module-automation";
import { VOLUME, PITCH_UP, PITCH_DOWN } from "@/definitions/automatable-parameters";
import {
    createMockAudioContext, createMockAudioParam, createMockSourceNode, setContextCurrentTime
} from "../../mocks";
import type { Instrument } from "@/model/types/instrument";

const createEvent = ( id: number, props?: Partial<EffluxAudioEvent> ): EffluxAudioEvent => ({
    ...EventFactory.create( 0, "C", 3, ACTION_NOTE_ON ),
    id,
    seq: { playing: true, startMeasure: 0, startMeasureOffset: 0, length: 1, mpLength: 1 },
    ...props
});

const createVoice = ( eventId: number ): { voice: EventVoice, gainParam: AudioParam, freqParam: AudioParam, generator: any } => {
    const gainParam = createMockAudioParam( 1 );
    const freqParam = createMockAudioParam( 440 );
    const generator = createMockSourceNode({ frequency: freqParam });
    const voice: EventVoice = {
        generator: generator as unknown as OscillatorNode,
        gain: { gain: gainParam } as unknown as GainNode,
        outputNode: { gain: createMockAudioParam( 1 ) } as unknown as GainNode,
        frequency: 440,
        vo: {} as EventVoice[ "vo" ],
        eventId
    };
    return { voice, gainParam, freqParam, generator };
};

const createInstrumentModules = () => ({
    panner: { pan: createMockAudioParam(), disconnect: vi.fn(), connect: vi.fn() },
    overdrive: { overdriveEnabled: false, overdrive: { disconnect: vi.fn(), connect: vi.fn() } },
    eq: { eqEnabled: false, output: { disconnect: vi.fn(), connect: vi.fn() } },
    filter: { filterEnabled: false, filter: { disconnect: vi.fn(), connect: vi.fn() } },
    delay: { delayEnabled: false, delay: { output: { disconnect: vi.fn(), connect: vi.fn() } } },
    analyser: { disconnect: vi.fn(), connect: vi.fn() },
    voices: [] as unknown[][],
    output: { disconnect: vi.fn(), connect: vi.fn() }
});

describe( "module automation", () => {
    beforeEach(() => {
        clearAllGlideStates();
        vi.clearAllMocks();
    });

    it( "should not schedule any automation when the event has no mp", () => {
        const audioContext = createMockAudioContext();
        setContextCurrentTime( audioContext, 1 );
        const { voice, gainParam } = createVoice( 1 );
        const event = createEvent( 1 ); // no mp
        delete event.mp;

        applyModuleParamChange(
            audioContext, event, createInstrumentModules() as never,
            {} as Instrument, [ [ voice ] ], 1, {} as AudioNode
        );

        expect( gainParam.cancelScheduledValues ).not.toHaveBeenCalled();
        expect( gainParam.setValueAtTime ).not.toHaveBeenCalled();
        expect( gainParam.linearRampToValueAtTime ).not.toHaveBeenCalled();
    });

    it( "should apply an instant VOLUME automation without gliding onto the voices of its own event only", () => {
        const audioContext = createMockAudioContext();
        const { voice: firstVoice, gainParam: firstGain } = createVoice( 1 );
        const { gainParam: secondGain } = createVoice( 2 );
        const event = createEvent( 1, { mp: EventFactory.createModuleParam( VOLUME, 50, false ) });

        // noteOn only passes the voice list owned by the triggered event (see AudioService.noteOn)
        applyModuleParamChange(
            audioContext, event, createInstrumentModules() as never,
            {} as Instrument, [ [ firstVoice ] ], 2, {} as AudioNode
        );

        expect( firstGain.cancelScheduledValues ).toHaveBeenCalledWith( 2 );
        expect( firstGain.setValueAtTime ).toHaveBeenCalledWith( 0.5, 2 );
        expect( firstGain.linearRampToValueAtTime ).not.toHaveBeenCalled();

        // a voice list not passed in by the triggering event must remain untouched entirely
        expect( secondGain.cancelScheduledValues ).not.toHaveBeenCalled();
        expect( secondGain.setValueAtTime ).not.toHaveBeenCalled();
    });

    it( "should isolate glide state per event id so a retriggered note does not inherit the gliding marker", () => {
        const audioContext = createMockAudioContext();
        const { voice: oldVoice, gainParam: oldGain } = createVoice( 1 );
        const { voice: newVoice, gainParam: newGain } = createVoice( 2 );
        const oldEvent = createEvent( 1, { mp: EventFactory.createModuleParam( VOLUME, 25, true ) });
        const newEvent = createEvent( 2, { mp: EventFactory.createModuleParam( VOLUME, 75, true ) });
        const modules = createInstrumentModules() as never;

        // old event starts a glide : cancels scheduled values, anchors at current value and ramps
        applyModuleParamChange( audioContext, oldEvent, modules, {} as Instrument, [ [ oldVoice ] ], 0, {} as AudioNode );
        expect( oldGain.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
        expect( oldGain.setValueAtTime ).toHaveBeenCalledWith( 1, 0 );
        expect( oldGain.linearRampToValueAtTime ).toHaveBeenCalledWith( 0.25, 1 );

        // a repeated automation for the same gliding event must not cancel its scheduled values
        applyModuleParamChange( audioContext, oldEvent, modules, {} as Instrument, [ [ oldVoice ] ], 0.5, {} as AudioNode );
        expect( oldGain.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );

        // the retriggered event gets its own glide lifecycle : it cancels and anchors anew,
        // regardless of the previous event still being in its glide / release phase
        applyModuleParamChange( audioContext, newEvent, modules, {} as Instrument, [ [ newVoice ] ], 1, {} as AudioNode );
        expect( newGain.cancelScheduledValues ).toHaveBeenCalledWith( 1 );
        expect( newGain.setValueAtTime ).toHaveBeenCalledWith( 1, 1 );
        expect( newGain.linearRampToValueAtTime ).toHaveBeenCalledWith( 0.75, 2 );

        // clearing the old event must not affect the new event's glide state, a second
        // automation for the new event still must not cancel its scheduled values
        clearGlideStateForEvent( 1 );
        applyModuleParamChange( audioContext, newEvent, modules, {} as Instrument, [ [ newVoice ] ], 1.5, {} as AudioNode );
        expect( newGain.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
    });

    it( "should not let an old events cancelScheduledValues wipe the new events scheduled pitch glide", () => {
        const audioContext = createMockAudioContext();
        const { voice: oldVoice, freqParam: oldFreq } = createVoice( 1 );
        const { voice: newVoice, freqParam: newFreq } = createVoice( 2 );
        const modules = createInstrumentModules() as never;

        const oldEvent = createEvent( 1, { mp: EventFactory.createModuleParam( PITCH_UP, 50, true ) });
        const newEvent = createEvent( 2, { mp: EventFactory.createModuleParam( PITCH_DOWN, 25, true ) });

        applyModuleParamChange( audioContext, oldEvent, modules, {} as Instrument, [ [ oldVoice ] ], 0, {} as AudioNode );
        applyModuleParamChange( audioContext, newEvent, modules, {} as Instrument, [ [ newVoice ] ], 1, {} as AudioNode );

        // both events schedule onto their own generator frequency and neither cancels the other
        expect( oldFreq.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
        expect( oldFreq.linearRampToValueAtTime ).toHaveBeenCalledTimes( 1 );
        expect( newFreq.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
        expect( newFreq.linearRampToValueAtTime ).toHaveBeenCalledTimes( 1 );

        // an additional glide step for the still-releasing old event only affects the old param
        applyModuleParamChange( audioContext, oldEvent, modules, {} as Instrument, [ [ oldVoice ] ], 2, {} as AudioNode );
        expect( oldFreq.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
        expect( newFreq.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
        expect( newFreq.linearRampToValueAtTime ).toHaveBeenCalledTimes( 1 );
    });

    it( "should track VOLUME and PITCH glides independently for the same event", () => {
        const audioContext = createMockAudioContext();
        const { voice, gainParam, freqParam } = createVoice( 1 );
        const modules = createInstrumentModules() as never;

        const volumeEvent = createEvent( 1, { mp: EventFactory.createModuleParam( VOLUME, 50, true ) });
        const pitchEvent  = createEvent( 1, { mp: EventFactory.createModuleParam( PITCH_UP, 50, true ) });

        applyModuleParamChange( audioContext, volumeEvent, modules, {} as Instrument, [ [ voice ] ], 0, {} as AudioNode );
        applyModuleParamChange( audioContext, pitchEvent, modules, {} as Instrument, [ [ voice ] ], 0, {} as AudioNode );

        // the pitch glide is a different AudioParam and therefore gets its own first-glide cancellation
        expect( gainParam.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
        expect( freqParam.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );

        // repeating either glide keeps both params anchored (no additional cancellations)
        applyModuleParamChange( audioContext, volumeEvent, modules, {} as Instrument, [ [ voice ] ], 0.5, {} as AudioNode );
        applyModuleParamChange( audioContext, pitchEvent, modules, {} as Instrument, [ [ voice ] ], 0.5, {} as AudioNode );
        expect( gainParam.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
        expect( freqParam.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
    });
});
