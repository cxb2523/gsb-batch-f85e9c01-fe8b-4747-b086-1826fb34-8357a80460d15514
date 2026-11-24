import { describe, it, expect, beforeEach, vi } from "vitest";
import OscillatorTypes from "@/definitions/oscillator-types";
import InstrumentFactory from "@/model/factories/instrument-factory";
import type { InstrumentOscillator } from "@/model/types/instrument";
import ADSR from "@/services/audio/adsr-module";
import { mockGainNode, createMockAudioParam } from "../../mocks";

describe( "ADSR", () => {

    // mock AudioGainNode

    const output = { ...mockGainNode };

    const createOscillator = ( props?: Partial<InstrumentOscillator> ): InstrumentOscillator => ({
        ...InstrumentFactory.createOscillator( true ),
        ...props
    });

    // attack envelopes

    it( "should allow notes to playback at full volume instantly for most waveforms at 0 attack", () => {
        const oscillator = createOscillator({
            adsr: {
                attack: 0,
                decay: 0,
                sustain: .75,
                release: 0
            }
        });
        const WAVEFORMS = [
            OscillatorTypes.SAW, OscillatorTypes.SQUARE, OscillatorTypes.NOISE, OscillatorTypes.CUSTOM
        ];
        WAVEFORMS.forEach( waveform => {
            oscillator.waveform = waveform;

            const startTime    = 2;
            const expectedTime = startTime; // 0 attack value implies instant-max volume

            ADSR.applyAmpEnvelope( oscillator, output, startTime );
            expect( output.gain.linearRampToValueAtTime ).toHaveBeenCalledWith( 1.0, expectedTime );
        });
    });

    it( "should have a short fade-in for certain waveforms with 0 attack to prevent popping", () => {
        const oscillator = createOscillator({
            adsr: {
                attack: 0,
                decay: 0,
                sustain: .75,
                release: 0
            }
        });
        const WAVEFORMS = [ OscillatorTypes.SINE, OscillatorTypes.TRIANGLE ];

        WAVEFORMS.forEach( waveform => {

            oscillator.waveform = waveform;

            const startTime    = 2;
            const expectedTime = startTime + 0.002; // these waveforms have a slight fade in to prevent popping

            ADSR.applyAmpEnvelope( oscillator, output, startTime );
            expect( output.gain.linearRampToValueAtTime ).toHaveBeenCalledWith( 1.0, expectedTime );
        });
    });

    it( "should delay full volume for a positive attack range", () => {
        const oscillator = createOscillator({
            adsr: {
                attack: .89,
                decay: 0,
                sustain: .75,
                release: 0
            }
        });
        // all waveforms are now treated equally
        const WAVEFORMS = [
            OscillatorTypes.SAW, OscillatorTypes.SQUARE, OscillatorTypes.NOISE, OscillatorTypes.CUSTOM,
            OscillatorTypes.SINE, OscillatorTypes.TRIANGLE
        ];

        WAVEFORMS.forEach( waveform => {

            oscillator.waveform = waveform;

            const startTime    = 2;
            const expectedTime = startTime + oscillator.adsr.attack;

            ADSR.applyAmpEnvelope( oscillator, output, startTime );
            expect(output.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1.0, expectedTime);
        });
    });

    // release envelopes

    it( "should allow notes to instantly stop playing for most waveforms at 0 release", () => {
        const oscillator = createOscillator({
            adsr: {
                attack: 0,
                decay: 0,
                sustain: .75,
                release: 0
            }
        });
        const WAVEFORMS = [
            OscillatorTypes.SAW, OscillatorTypes.SQUARE, OscillatorTypes.NOISE, OscillatorTypes.CUSTOM
        ];
        WAVEFORMS.forEach( waveform => {

            oscillator.waveform = waveform;

            const startTime    = 2;
            const expectedTime = startTime; // 0 attack value implies instant-max volume

            ADSR.applyAmpRelease( oscillator, output, startTime );
            expect(output.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1.0, expectedTime);
        });
    });

    it( "should have a short fade-out for certain waveforms at 0 release to prevent popping", () => {
        const oscillator = createOscillator({
            adsr: {
                attack: 0,
                decay: 0,
                sustain: .75,
                release: 0
            }
        });
        const WAVEFORMS = [ OscillatorTypes.SINE, OscillatorTypes.TRIANGLE ];

        WAVEFORMS.forEach( waveform  => {
            oscillator.waveform = waveform;

            const startTime    = 2;
            const expectedTime = startTime + 0.002; // these waveforms have a slight fade out to prevent popping

            ADSR.applyAmpRelease( oscillator, output, startTime );
            expect(output.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1.0, expectedTime);
        });
    });

    it( "should delay killing playback for a positive release range", () => {
        const oscillator = createOscillator({
            adsr: {
                attack: 0,
                decay: 0,
                sustain: .75,
                release: .89
            }
        });
        // all waveforms are now treated equally
        const WAVEFORMS = [
            OscillatorTypes.SAW, OscillatorTypes.SQUARE, OscillatorTypes.NOISE,
            OscillatorTypes.CUSTOM, OscillatorTypes.SINE, OscillatorTypes.TRIANGLE
        ];

        WAVEFORMS.forEach( waveform => {
            oscillator.waveform = waveform;

            const startTime    = 2;
            const expectedTime = startTime + oscillator.adsr.release;

            ADSR.applyAmpRelease( oscillator, output, startTime );
            expect(output.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1.0, expectedTime);
        });
    });

    // retrigger lifecycle : envelope nodes are owned per event and releases of a replaced
    // note must never cancel or alter the scheduled envelopes of the retriggered note

    describe( "when retriggering notes", () => {
        const createMockEnvelopeNode = () => ({
            gain: createMockAudioParam( 1 )
        }) as unknown as GainNode;

        beforeEach(() => {
            vi.clearAllMocks();
        });

        it( "should schedule the attack envelope independently for each retriggered note on its own gain node", () => {
            const oscillator = createOscillator({
                adsr: { attack: 0.1, decay: 0.2, sustain: .5, release: .5 }
            });
            const firstEnvelope  = createMockEnvelopeNode();
            const secondEnvelope = createMockEnvelopeNode();

            ADSR.applyAmpEnvelope( oscillator, firstEnvelope, 0 );
            ADSR.applyAmpEnvelope( oscillator, secondEnvelope, 1 );

            expect( firstEnvelope.gain.cancelScheduledValues ).toHaveBeenCalledWith( 0 );
            expect( secondEnvelope.gain.cancelScheduledValues ).toHaveBeenCalledWith( 1 );
            // neither note cancels scheduling on the other note's envelope
            expect( firstEnvelope.gain.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
            expect( secondEnvelope.gain.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
            expect( secondEnvelope.gain.linearRampToValueAtTime ).toHaveBeenCalledWith( 1.0, 1.1 );
        });

        it( "should apply the release envelope onto the releasing note only without touching the retriggered note", () => {
            const oscillator = createOscillator({
                adsr: { attack: 0, decay: 0, sustain: .75, release: .4 }
            });
            const oldEnvelope = createMockEnvelopeNode();
            const newEnvelope = createMockEnvelopeNode();

            // both notes are active, the old one starts its release while the new one attacks
            ADSR.applyAmpEnvelope( oscillator, newEnvelope, 1 );
            ADSR.applyAmpRelease( oscillator, oldEnvelope, 1 );

            expect( oldEnvelope.gain.cancelScheduledValues ).toHaveBeenCalledWith( 1 );
            expect( oldEnvelope.gain.linearRampToValueAtTime ).toHaveBeenCalledWith( 0, 1.4 );

            // the new note's scheduled attack/decay ramps remain untouched by the old note's release
            expect( newEnvelope.gain.cancelScheduledValues ).toHaveBeenCalledTimes( 1 );
            expect( newEnvelope.gain.cancelScheduledValues ).toHaveBeenCalledWith( 1 );
            expect( newEnvelope.gain.linearRampToValueAtTime ).toHaveBeenCalledWith( 1.0, 1 );
        });

        it( "should use the pop-prevention minimum release duration for SINE and TRIANGLE at zero release", () => {
            const oscillator = createOscillator({
                adsr: { attack: 0, decay: 0, sustain: .75, release: 0 },
                waveform: OscillatorTypes.SINE
            });
            const envelope = createMockEnvelopeNode();

            ADSR.applyAmpRelease( oscillator, envelope, 3 );

            expect( envelope.gain.linearRampToValueAtTime ).toHaveBeenCalledWith( 0, 3.002 );
        });
    });
});
