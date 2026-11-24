// The two shared sends: Space (a convolution reverb with a synthesized impulse
// response) and Echo (a tempo-synced ping-pong delay). Both use native Web
// Audio nodes, which run in optimized C++.

import { ECHO_TIMES } from '../tuning.js';
import { ramp } from './fx.js';

const SMOOTH = 0.05;
// How long a faded-out convolver stays connected before it is replaced by an
// idle one. Exported for tests.
export const SLOT_RETIRE_MS = 600;
// Debounce while a size/tone knob is being dragged.
const SETTLE_MS = 120;

// True for an OfflineAudioContext: its currentTime advances only while
// rendering, so wall-clock setTimeout work would never line up with it.
function isOffline(ctx) {
	return typeof ctx.startRendering === 'function';
}

// Builds a stereo impulse response: early reflections, then decorrelated noise
// that decays and darkens over time.
function impulseResponse(ctx, size, tone) {
	const sr = ctx.sampleRate;
	const seconds = 1.1 + size * size * 5.4;
	const length = Math.round(seconds * sr);
	const buffer = ctx.createBuffer(2, length, sr);
	const decay = 6.9 / seconds;
	// High frequencies die faster than lows; tone sets how much faster.
	const startCutoff = 3500 + tone * 13000;
	const endCutoff = 500 + tone * 2500;
	let seed = 0x2f6b1;
	const rand = () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return (seed >>> 0) / 2147483648 - 1;
	};
	for (let ch = 0; ch < 2; ch++) {
		const data = buffer.getChannelData(ch);
		let lp = 0;
		const fade = Math.round(sr * 0.004);
		for (let i = 0; i < length; i++) {
			const t = i / sr;
			const cutoff = endCutoff + (startCutoff - endCutoff) * Math.exp(-t * 2.2);
			const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
			lp += (rand() - lp) * a;
			let env = Math.exp(-decay * t);
			if (i < fade) env *= i / fade;
			data[i] = lp * env;
		}
		// Early reflections, different per side.
		for (let k = 0; k < 9; k++) {
			const t = 0.007 + k * 0.0093 + (ch ? 0.0031 : 0) + rand() * 0.002;
			const idx = Math.round(t * sr);
			if (idx < length) data[idx] += rand() * 0.6 * Math.exp(-k * 0.25);
		}
	}
	// Equal energy for every size, so the space control changes length, not level.
	let energy = 0;
	for (let ch = 0; ch < 2; ch++) {
		const data = buffer.getChannelData(ch);
		for (let i = 0; i < length; i++) energy += data[i] * data[i];
	}
	const gain = 0.6 / Math.sqrt(energy / 2);
	for (let ch = 0; ch < 2; ch++) {
		const data = buffer.getChannelData(ch);
		for (let i = 0; i < length; i++) data[i] *= gain;
	}
	return buffer;
}

export class Space {
	constructor(ctx) {
		this.ctx = ctx;
		this.input = ctx.createGain();
		this.output = ctx.createGain();
		this.predelay = ctx.createDelay(0.2);
		this.predelay.delayTime.value = 0.018;
		this.highpass = ctx.createBiquadFilter();
		this.highpass.type = 'highpass';
		this.highpass.frequency.value = 140;
		this.input.connect(this.highpass).connect(this.predelay);
		// Two convolvers crossfade when the impulse response changes.
		this.slots = [0, 1].map(() => {
			const convolver = ctx.createConvolver();
			const gain = ctx.createGain();
			gain.gain.value = 0;
			this.predelay.connect(convolver).connect(gain).connect(this.output);
			return { convolver, gain };
		});
		this.active = 0;
		this.key = '';
		this.timer = 0;
		// Each slot carries its own retirement timer and a generation counter, so
		// a timer can only ever retire the exact convolver that was fading out
		// when it was scheduled — never a slot a later rebuild reactivated.
		for (const slot of this.slots) {
			slot.retire = 0;
			slot.gen = 0;
		}
	}

	set({ size, tone }) {
		const key = `${size.toFixed(2)}|${tone.toFixed(2)}`;
		if (key === this.key) return;
		this.key = key;
		clearTimeout(this.timer);
		if (isOffline(this.ctx)) {
			// Offline time does not advance on wall-clock timers: rebuild now,
			// synchronously, so stems render through the requested response.
			this.rebuild(size, tone);
			return;
		}
		// Rebuilding the response takes a few milliseconds; always wait for the
		// knob to settle, including the very first change.
		this.timer = setTimeout(() => this.rebuild(size, tone), SETTLE_MS);
	}

	// Cancels a slot's pending retirement, if any. Called before the slot is
	// reused: its previous convolver must not be replaced underneath a live
	// crossfade.
	cancelRetire(slot) {
		if (slot.retire) {
			clearTimeout(slot.retire);
			slot.retire = 0;
		}
	}

	// Replaces the slot's convolver with a fresh, disconnected idle one. Runs
	// only from a timer whose generation token still matches, so an active
	// convolver is never retired.
	retireSlot(slot, token) {
		slot.retire = 0;
		if (slot.gen !== token) return;
		if (this.slots[this.active] === slot && slot.convolver.buffer) return;
		slot.convolver.disconnect();
		slot.convolver = this.ctx.createConvolver();
		this.predelay.connect(slot.convolver).connect(slot.gain);
	}

	rebuild(size, tone) {
		const nextIndex = 1 - this.active;
		const next = this.slots[nextIndex];
		const old = this.slots[this.active];
		// The slot we are about to take over may still have a retirement pending
		// from an earlier fade-out; cancel it so its new convolver survives.
		this.cancelRetire(next);
		next.gen++;
		next.convolver.buffer = impulseResponse(this.ctx, size, tone);
		const now = this.ctx.currentTime;
		ramp(next.gain.gain, 1, this.ctx, SMOOTH * 2);
		ramp(old.gain.gain, 0, this.ctx, SMOOTH * 2);
		this.active = nextIndex;
		if (this.ctx.currentTime < 0.001 || isOffline(this.ctx)) {
			// No real-time clock to wait on: the old slot is already silent, so
			// idle it immediately and keep exactly one convolver running.
			this.cancelRetire(old);
			old.gen++;
			this.retireSlot(old, old.gen);
			return;
		}
		// Once faded out, the old convolver is replaced by an idle one, so only
		// one convolution runs at a time. The captured token binds this timer to
		// the convolver being retired: if the slot is reused before 600 ms, its
		// bumped generation makes the callback a no-op.
		this.cancelRetire(old);
		const token = old.gen;
		old.retire = setTimeout(() => this.retireSlot(old, token), SLOT_RETIRE_MS);
	}

	// Sets the response at once, for offline rendering and the initial build.
	prepare({ size, tone }) {
		clearTimeout(this.timer);
		for (const slot of this.slots) this.cancelRetire(slot);
		this.key = `${size.toFixed(2)}|${tone.toFixed(2)}`;
		this.slots[0].convolver.buffer = impulseResponse(this.ctx, size, tone);
		this.slots[0].gain.gain.value = 1;
		this.slots[0].gen++;
		this.active = 0;
		// Slot 1 must stay silent and idle, with no buffered response running.
		const idle = this.slots[1];
		idle.gen++;
		idle.gain.gain.value = 0;
		if (idle.convolver.buffer) this.retireSlot(idle, idle.gen);
	}
}

export class Echo {
	constructor(ctx) {
		this.ctx = ctx;
		this.input = ctx.createGain();
		this.output = ctx.createGain();
		this.left = ctx.createDelay(4);
		this.right = ctx.createDelay(4);
		this.feedbackL = ctx.createGain();
		this.feedbackR = ctx.createGain();
		this.toneL = ctx.createBiquadFilter();
		this.toneR = ctx.createBiquadFilter();
		for (const f of [this.toneL, this.toneR]) {
			f.type = 'lowpass';
			f.Q.value = 0.5;
		}
		this.lowcut = ctx.createBiquadFilter();
		this.lowcut.type = 'highpass';
		this.lowcut.frequency.value = 180;
		const merger = ctx.createChannelMerger(2);
		// Mono in, then bounce between the sides.
		this.input.connect(this.lowcut).connect(this.left);
		this.left.connect(this.toneL).connect(this.feedbackL).connect(this.right);
		this.right.connect(this.toneR).connect(this.feedbackR).connect(this.left);
		this.left.connect(merger, 0, 0);
		this.right.connect(merger, 0, 1);
		merger.connect(this.output);
		// Gentle tape wobble at 48/256 Hz.
		this.wobble = ctx.createOscillator();
		this.wobble.frequency.value = 0.1875;
		this.wobbleDepth = ctx.createGain();
		this.wobbleDepth.gain.value = 0.0012;
		this.wobble.connect(this.wobbleDepth);
		this.wobbleDepth.connect(this.left.delayTime);
		this.wobbleDepth.connect(this.right.delayTime);
		this.wobble.start();
	}

	set({ time, feedback, tone }, bpm) {
		const ctx = this.ctx;
		const beats = ECHO_TIMES[time]?.beats ?? 0.5;
		const seconds = Math.min(3.9, (beats * 60) / bpm);
		ramp(this.left.delayTime, seconds, ctx, SMOOTH);
		ramp(this.right.delayTime, seconds, ctx, SMOOTH);
		ramp(this.feedbackL.gain, feedback, ctx, SMOOTH);
		ramp(this.feedbackR.gain, feedback, ctx, SMOOTH);
		const cutoff = 900 * 2 ** (tone * 4);
		ramp(this.toneL.frequency, cutoff, ctx, SMOOTH);
		ramp(this.toneR.frequency, cutoff, ctx, SMOOTH);
	}
}
