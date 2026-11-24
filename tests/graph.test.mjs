// Concurrency and lifecycle tests for the insert chains (Strip) and the shared
// Space bus. No browser is available, so a small mock Web Audio graph records
// connections, disconnections, worklet ports, and timers; a virtual clock
// drives every setTimeout. Run with `node tests/graph.test.mjs`.

import { Strip, CHAIN_RETIRE_MS } from '../js/audio/engine.js';
import { Space, SLOT_RETIRE_MS } from '../js/audio/space.js';
import { effectDefaults } from '../js/instruments.js';

let failures = 0;
function check(ok, message) {
	if (!ok) {
		failures++;
		console.log(`  FAIL ${message}`);
	}
}

// --- Virtual clock -----------------------------------------------------------
let nowMs = 0;
const pendingTimers = new Map();
let timerId = 1;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms = 0) => {
	const id = timerId++;
	pendingTimers.set(id, { fn, at: nowMs + ms });
	return id;
};
globalThis.clearTimeout = (id) => {
	pendingTimers.delete(id);
};
// Runs every timer due within `ms` of virtual time, in firing order. Time only
// advances to a timer's actual due instant, so a 119 ms wait cannot run a timer
// scheduled for 120 ms.
function advance(ms) {
	const until = nowMs + ms;
	for (;;) {
		const due = [...pendingTimers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at);
		if (!due.length) break;
		const [id, t] = due[0];
		pendingTimers.delete(id);
		nowMs = t.at;
		t.fn();
	}
	nowMs = until;
}

// --- Mock Web Audio ----------------------------------------------------------
const registry = [];
let nodeSeq = 1;

class MockAudioParam {
	constructor(value = 0) {
		this.value = value;
		this.target = value;
		this.events = [];
	}
	setValueAtTime(v) {
		this.value = v;
		this.target = v;
		this.events.push(['setValue', v]);
		return this;
	}
	setTargetAtTime(v) {
		this.target = v;
		this.events.push(['target', v]);
		return this;
	}
	linearRampToValueAtTime(v) {
		this.target = v;
		this.events.push(['linear', v]);
		return this;
	}
	exponentialRampToValueAtTime(v) {
		this.target = v;
		this.events.push(['exponential', v]);
		return this;
	}
	cancelScheduledValues() {
		this.events.push(['cancel']);
		return this;
	}
}

class MockNode {
	constructor(ctx, type) {
		this.ctx = ctx;
		this.type = type;
		this.id = `${type}-${nodeSeq++}`;
		this.edgesOut = [];
		this.edgesIn = [];
		this.paramEdges = []; // edges whose destination is an AudioParam, not a node
		this.disconnectCount = 0;
		this.disposed = false;
		registry.push(this);
	}
	connect(dest, out = 0, inp = 0) {
		const edge = { dest, out, inp };
		if (dest instanceof MockAudioParam) {
			dest.inputs ||= [];
			dest.inputs.push({ src: this, out, inp });
			this.paramEdges.push(edge);
		} else {
			this.edgesOut.push(edge);
			(dest.edgesIn ||= []).push({ src: this, out, inp });
		}
		return dest;
	}
	// Faithful to Web Audio: a no-arg disconnect drops node outputs only;
	// connections to AudioParams stay until explicitly disconnected.
	disconnect(dest) {
		this.disconnectCount++;
		if (dest && dest instanceof MockAudioParam) {
			this.paramEdges = this.paramEdges.filter((e) => e.dest !== dest);
			dest.inputs = (dest.inputs || []).filter((x) => x.src !== this);
			return;
		}
		if (dest) {
			this.edgesOut = this.edgesOut.filter((e) => {
				if (e.dest !== dest) return true;
				if (dest.edgesIn) dest.edgesIn = dest.edgesIn.filter((x) => x.src !== this);
				return false;
			});
		} else {
			for (const e of this.edgesOut) {
				if (e.dest.edgesIn) e.dest.edgesIn = e.dest.edgesIn.filter((x) => x.src !== this);
			}
			this.edgesOut = [];
		}
	}
}

class MockGain extends MockNode {
	constructor(ctx) {
		super(ctx, 'gain');
		this.gain = new MockAudioParam(1);
	}
}
class MockBiquad extends MockNode {
	constructor(ctx) {
		super(ctx, 'biquad');
		this.frequency = new MockAudioParam(350);
		this.Q = new MockAudioParam(1);
		this.detune = new MockAudioParam(0);
		this.type = 'lowpass';
	}
}
class MockOscillator extends MockNode {
	constructor(ctx) {
		super(ctx, 'oscillator');
		this.frequency = new MockAudioParam(440);
		this.detune = new MockAudioParam(0);
		this.started = false;
		this.stopped = false;
	}
	start() {
		this.started = true;
	}
	stop() {
		this.stopped = true;
	}
}
class MockDelay extends MockNode {
	constructor(ctx) {
		super(ctx, 'delay');
		this.delayTime = new MockAudioParam(0);
	}
}
class MockStereoPanner extends MockNode {
	constructor(ctx) {
		super(ctx, 'panner');
		this.pan = new MockAudioParam(0);
	}
}
class MockWaveShaper extends MockNode {
	constructor(ctx) {
		super(ctx, 'waveshaper');
		this.curve = null;
		this.oversample = 'none';
	}
}
class MockConvolver extends MockNode {
	constructor(ctx) {
		super(ctx, 'convolver');
		this.buffer = null;
	}
}
class MockMerger extends MockNode {
	constructor(ctx) {
		super(ctx, 'merger');
	}
}
class MockSplitter extends MockNode {
	constructor(ctx) {
		super(ctx, 'splitter');
	}
}

// fx.js builds worklet effects through the global AudioWorkletNode constructor.
class MockWorkletNode extends MockNode {
	constructor(ctx, name, options = {}) {
		super(ctx, `worklet:${name}`);
		this.name = name;
		this.processorOptions = options.processorOptions || {};
		this.messages = [];
		this.portClosed = false;
		const self = this;
		this.port = {
			postMessage(m) {
				if (self.portClosed) throw new Error('postMessage on a closed port');
				self.messages.push(m);
			},
			close() {
				self.portClosed = true;
			},
		};
	}
}
globalThis.AudioWorkletNode = MockWorkletNode;

function makeContext({ offline = false, currentTime = 2 } = {}) {
	const ctx = {
		sampleRate: 8000,
		currentTime,
		destination: new MockGain(null),
		createGain: () => new MockGain(ctx),
		createBiquadFilter: () => new MockBiquad(ctx),
		createOscillator: () => new MockOscillator(ctx),
		createDelay: () => new MockDelay(ctx),
		createStereoPanner: () => new MockStereoPanner(ctx),
		createWaveShaper: () => new MockWaveShaper(ctx),
		createConvolver: () => new MockConvolver(ctx),
		createChannelMerger: () => new MockMerger(ctx),
		createChannelSplitter: () => new MockSplitter(ctx),
		createBuffer(channels, length) {
			const data = Array.from({ length: channels }, () => new Float32Array(length));
			return {
				numberOfChannels: channels,
				length,
				channels: data,
				getChannelData: (ch) => data[ch],
			};
		},
	};
	if (offline) {
		ctx.startRendering = () => Promise.resolve({});
		ctx.suspend = () => Promise.resolve();
		ctx.resume = () => Promise.resolve();
		ctx.audioWorklet = { addModule: () => Promise.resolve() };
	}
	return ctx;
}

// Direct edge and reachability checks over the mock graph.
function hasEdge(src, dest) {
	return src.edgesOut.some((e) => e.dest === dest);
}
function hasPath(src, dest) {
	const seen = new Set();
	const stack = [src];
	while (stack.length) {
		const node = stack.pop();
		if (node === dest) return true;
		if (seen.has(node)) continue;
		seen.add(node);
		for (const e of node.edgesOut || []) stack.push(e.dest);
	}
	return false;
}
const workletNodes = () => registry.filter((n) => n.type.startsWith('worklet:'));
const connectedBufferedConvolvers = (space) =>
	space.slots.filter((s) => s.convolver.buffer && s.convolver.edgesOut.length > 0).length;

function fxOf(type, patch = {}) {
	return { type, on: true, params: { ...effectDefaults(type), ...patch } };
}

// --- Strip tests -------------------------------------------------------------
console.log('Strip: insert chain rebuilds');
{
	const ctx = makeContext({ currentTime: 2 });
	const master = ctx.createGain();
	const song = new MockNode(ctx, 'song');
	const space = { input: ctx.createGain() };
	const echo = { input: ctx.createGain() };
	const strip = new Strip(ctx, master, space, echo, song, 0);

	// 1. The permanent junction reaches the master from the very start.
	check(hasPath(strip.input, master), 'initial graph reaches master');
	check(hasEdge(strip.input, strip.chain.in), 'input wired to initial chain');
	check(hasEdge(strip.chain.out, strip.tail), 'initial chain reaches tail');
	check(hasPath(strip.tail, strip.duck), 'tail reaches duck');

	// 2. A rebuild crossfades: both chains wired during the fade, old one retires.
	const emptyChain = strip.chain;
	strip.setEffects([fxOf('tremolo')], 120);
	const firstChain = strip.chain;
	check(firstChain !== emptyChain, 'rebuild produced a new chain');
	check(hasEdge(strip.input, firstChain.in) && hasEdge(firstChain.out, strip.tail), 'new chain is live');
	check(hasEdge(emptyChain.out, strip.tail) && hasEdge(strip.input, emptyChain.in), 'old chain still sounds during fade');
	check(hasPath(strip.input, strip.duck), 'signal never drops during rebuild');
	check(firstChain.out.gain.target === 1 && emptyChain.out.gain.target === 0, 'crossfade gains scheduled');
	advance(CHAIN_RETIRE_MS + 10);
	check(!hasEdge(emptyChain.out, strip.tail) && !hasEdge(strip.input, emptyChain.in), 'old chain unwired after fade');
	check(emptyChain.in.edgesOut.length === 0 && emptyChain.out.edgesOut.length === 0, 'retired chain junction nodes disconnected');

	// A second rebuild retires the tremolo chain: its LFO must be stopped.
	strip.setEffects([fxOf('drive')], 120);
	advance(CHAIN_RETIRE_MS + 10);
	check(registry.filter((n) => n.type === 'oscillator' && n.stopped).length >= 1, 'retired native effect oscillator stopped');
	check(firstChain.in.edgesOut.length === 0 && firstChain.out.edgesOut.length === 0, 'tremolo chain fully disconnected at retirement');
	check(pendingTimers.size === 0, 'retirement timers do not leak');

	// 3. Rapid toggling: many rebuilds and parameter changes in a row.
	const sequence = [];
	for (let k = 0; k < 30; k++) {
		if (k % 3 === 0) sequence.push([fxOf('pump', { depth: 0.2 + (k % 5) * 0.1 })]);
		else if (k % 3 === 1) sequence.push([fxOf('pump'), fxOf('tremolo', { depth: k / 40 })]);
		else sequence.push([]);
		strip.setEffects(sequence[k], 100 + k);
		check(hasPath(strip.input, strip.duck), `input reaches duck on iteration ${k}`);
		check(strip.chain.out.edgesIn.length > 0, `chain output stays connected on iteration ${k}`);
	}
	// While fades are pending, every chain still wired into the graph is intact:
	// no disconnected/destroyed node appears as a connected source or destination.
	for (const node of registry) {
		if (node.disposed || node.portClosed) {
			check(node.edgesOut.length === 0 && node.edgesIn.length === 0, `destroyed node ${node.id} still connected`);
		}
	}
	advance(CHAIN_RETIRE_MS * 4);
	check(pendingTimers.size === 0, 'all retirement timers fired after rapid rebuilds');
	for (const node of registry) {
		if (node.disposed || node.portClosed) {
			check(node.edgesOut.length === 0 && node.edgesIn.length === 0, `released node ${node.id} still connected after settle`);
		}
	}
	// Only the active chain's worklet nodes may still have open ports.
	const activePorts = strip.chain.effects.map((e) => e.effect.input).filter((n) => n instanceof MockWorkletNode);
	for (const wn of workletNodes()) {
		const isActive = activePorts.includes(wn);
		check(wn.portClosed === !isActive, `worklet ${wn.id} port state wrong (active=${isActive}, closed=${wn.portClosed})`);
		check(wn.portClosed || (wn.edgesIn.length > 0 && wn.edgesOut.length > 0), `active worklet ${wn.id} not fully wired`);
	}
	check(hasPath(strip.input, strip.duck), 'final graph intact after rapid rebuilds');

	// 4. A fresh effect gets current params and BPM immediately, before any later set().
	strip.setEffects([fxOf('pump', { depth: 0.77 }), fxOf('tremolo', { rate: '1/4', depth: 0.4, mode: 'volume' })], 140);
	const pump = strip.chain.effects.find((e) => e.effect.input instanceof MockWorkletNode).effect;
	check(pump.input.processorOptions.params.depth === 0.77, 'worklet effect built with current params');
	check(pump.input.messages.length === 1 && pump.input.messages[0].params.depth === 0.77, 'current params posted to the new worklet immediately');
	// Tremolo LFO rate for 1/4 at 140 BPM is 140/60; read the live target.
	const lfoTargets = registry
		.filter((n) => n.type === 'oscillator' && !n.stopped)
		.map((n) => n.frequency.target);
	check(lfoTargets.some((v) => Math.abs(v - 140 / 60) < 1e-9), `tremolo got current BPM immediately (targets ${lfoTargets.join(',')})`);
	// Parameter-only changes post to the existing node, no rebuild.
	const chainBefore = strip.chain;
	strip.setEffects([fxOf('pump', { depth: 0.31 }), fxOf('tremolo', { rate: '1/4', depth: 0.4, mode: 'volume' })], 140);
	check(strip.chain === chainBefore, 'parameter change does not rebuild the chain');
	check(pump.input.messages.some((m) => m.params && m.params.depth === 0.31), 'changed params pushed to worklet');

	// 5. A build failure leaves the previous chain fully in place.
	const goodChain = strip.chain;
	const realWorklet = globalThis.AudioWorkletNode;
	let throwsLeft = 1;
	globalThis.AudioWorkletNode = class extends MockWorkletNode {
		constructor(c, name, opts) {
			if (throwsLeft-- > 0) throw new Error('simulated worklet failure');
			super(c, name, opts);
		}
	};
	let threw = false;
	try {
		strip.setEffects([fxOf('resonator'), fxOf('pump')], 120);
	} catch (err) {
		threw = true;
		check(/simulated/.test(err.message), 'build error propagates');
	}
	globalThis.AudioWorkletNode = realWorklet;
	check(threw, 'a failed rebuild reports the error');
	check(strip.chain === goodChain, 'failed rebuild keeps the old chain active');
	check(hasPath(strip.input, strip.duck), 'old chain still carries audio after failed rebuild');
	check(hasEdge(strip.input, goodChain.in) && hasEdge(goodChain.out, strip.tail), 'old chain wiring untouched after failure');
	// The partial chain's junction gains never reached the live graph.
	check(registry.filter((n) => n.type === 'gain' && n.edgesIn.length === 0 && n.edgesOut.length === 0).length >= 2, 'partial chain junctions were never connected');
	advance(CHAIN_RETIRE_MS * 2);
	check(hasPath(strip.input, strip.duck), 'graph still healthy after failed rebuild settles');

	// 6. clear() swaps to an empty chain without dropping the junction.
	strip.clear();
	check(hasPath(strip.input, strip.duck), 'clear keeps input connected through empty chain');
	check(strip.chain.effects.length === 0, 'clear leaves no effects');
	advance(CHAIN_RETIRE_MS * 2);
}

// --- Offline (stem render) Strip tests ---------------------------------------
console.log('Strip: offline rebuilds near currentTime = 0');
{
	const ctx = makeContext({ offline: true, currentTime: 0 });
	const master = ctx.createGain();
	const song = new MockNode(ctx, 'song');
	const strip = new Strip(ctx, master, null, null, song, 3);
	const chainsSeen = [];
	for (let k = 0; k < 12; k++) {
		const fx = k % 2 ? [fxOf('pump', { depth: k / 20 }), fxOf('tremolo')] : [fxOf('lofi')];
		strip.setEffects(fx, 96);
		chainsSeen.push(strip.chain);
		check(hasPath(strip.input, strip.duck), `offline graph intact on iteration ${k}`);
	}
	check(pendingTimers.size === 0, 'offline rebuilds schedule no wall-clock timers');
	// Every superseded chain was disposed synchronously: its worklet ports closed
	// and its nodes disconnected, so an offline render cannot leak processors.
	const previous = new Set(chainsSeen.slice(0, -1));
	for (const chain of previous) {
		check(chain.in.edgesOut.length === 0 && chain.out.edgesOut.length === 0, 'offline old chain junction disconnected');
		for (const entry of chain.effects) {
			const node = entry.effect.input;
			if (node instanceof MockWorkletNode) check(node.portClosed, 'offline removed worklet port closed');
		}
	}
	const active = strip.chain;
	check(active.effects.length === 2, 'final offline chain has both effects');
	const pump = active.effects.find((e) => e.effect.input instanceof MockWorkletNode).effect;
	check(pump.input.processorOptions.type === 'pump', 'offline worklet built with its type');
	// Exact values (not ramps) before the first sample.
	check(active.out.gain.value === 1, 'offline chain gain set exactly, not ramped');
	const lfo = registry.filter((n) => n.type === 'oscillator' && !n.stopped).pop();
	check(Math.abs(lfo.frequency.target - 96 / 60 / 0.5) < 1e-9 || Math.abs(lfo.frequency.value - 96 / 60 / 0.5) < 1e-9, 'offline tremolo rate derived from current BPM');
}

// --- Live worklet port lifecycle and tempo-only updates ----------------------
console.log('Strip: worklet ports and tempo updates');
{
	const ctx = makeContext({ currentTime: 2 });
	const master = ctx.createGain();
	const song = new MockNode(ctx, 'song');
	const strip = new Strip(ctx, master, null, null, song, 1);
	const nodesAtStart = registry.length;

	// Ten rapid worklet-effect rebuilds without advancing the clock: every
	// superseded worklet node is still connected (its fade runs later) but its
	// port must be closed only at retirement, never while it is active.
	const fxList = [];
	for (let k = 0; k < 10; k++) {
		fxList.push([fxOf(k % 2 ? 'resonator' : 'shifter', { mix: 0.1 * k })]);
		strip.setEffects(fxList[k], 110);
		const activeNode = strip.chain.effects[0].effect.input;
		check(!activeNode.portClosed, 'active worklet port stays open mid-burst');
		check(activeNode.edgesIn.length > 0 && activeNode.edgesOut.length > 0, 'active worklet stays wired mid-burst');
	}
	// During the burst nothing is retired yet; after the fade window, every old
	// worklet port is closed and only the current node remains open.
	advance(CHAIN_RETIRE_MS * 3);
	const blockWorklets = registry.slice(nodesAtStart).filter((n) => n instanceof MockWorkletNode && n.name === 'seeker-fx');
	const open = blockWorklets.filter((n) => !n.portClosed);
	const activeWorklets = strip.chain.effects.map((e) => e.effect.input).filter((n) => n instanceof MockWorkletNode);
	check(open.length === activeWorklets.length, 'only active worklet ports stay open after burst settles');
	check(open.every((n) => activeWorklets.includes(n)), 'every open worklet belongs to the active chain');
	check(open.every((n) => n.edgesIn.length > 0 && n.edgesOut.length > 0), 'open worklet ports belong to wired nodes');
	check(blockWorklets.filter((n) => n.portClosed).every((n) => n.edgesOut.length === 0), 'closed worklet nodes are fully disconnected');

	// A tempo-only update reaches a surviving native effect without rebuilding.
	strip.setEffects([fxOf('tremolo', { rate: '1/8' })], 120);
	advance(CHAIN_RETIRE_MS);
	const tempoChain = strip.chain;
	strip.tempo(173);
	check(strip.chain === tempoChain, 'tempo() does not rebuild the chain');
	const rates = registry.filter((n) => n.type === 'oscillator' && !n.stopped).map((n) => n.frequency.target);
	// 1/8 note tremolo at 173 BPM: 173/60/0.5 Hz.
	check(rates.some((v) => Math.abs(v - 173 / 60 / 0.5) < 1e-9), `tempo update retunes the tremolo LFO (${rates.join(',')})`);
	// A setEffects call with identical fx but a new BPM also retunes it.
	strip.setEffects([fxOf('tremolo', { rate: '1/8' })], 88);
	const rates2 = registry.filter((n) => n.type === 'oscillator' && !n.stopped).map((n) => n.frequency.target);
	check(rates2.some((v) => Math.abs(v - 88 / 60 / 0.5) < 1e-9), 'setEffects propagates a BPM change to an unchanged chain');
	advance(CHAIN_RETIRE_MS * 2);
}

// --- Space tests -------------------------------------------------------------
console.log('Space: convolver crossfade and retirement');
{
	const ctx = makeContext({ currentTime: 2 });
	const space = new Space(ctx);
	check(space.slots.length === 2 && space.slots.every((s) => s.convolver.buffer === null), 'Space starts with two idle convolvers');

	// First set debounces while the knob settles.
	space.set({ size: 0.4, tone: 0.4 });
	check(space.slots.every((s) => !s.convolver.buffer), 'no rebuild before the settle delay');
	advance(119);
	check(space.slots.every((s) => !s.convolver.buffer), 'still debounced at 119 ms');
	advance(1);
	const activeAfterFirst = space.active;
	check(space.slots[activeAfterFirst].convolver.buffer !== null, 'rebuild after the settle delay');
	check(connectedBufferedConvolvers(space) === 1, 'first rebuild runs one convolver');

	// A second rebuild crossfades: two convolvers briefly, then the old one idles.
	space.set({ size: 0.6, tone: 0.2 });
	advance(120);
	const a = space.active;
	const b = 1 - a;
	check(space.slots[a].convolver.buffer && space.slots[b].convolver.buffer, 'both convolvers buffered during crossfade');
	check(space.slots[a].gain.gain.target === 1 && space.slots[b].gain.gain.target === 0, 'crossfade gains scheduled');
	advance(SLOT_RETIRE_MS - 5);
	check(space.slots[b].convolver.buffer !== null, 'old convolver kept until its retirement fires');
	advance(10);
	check(space.slots[b].convolver.buffer === null, 'old convolver replaced by an idle one');
	check(space.slots[a].convolver.buffer !== null, 'active convolver survives retirement');
	check(connectedBufferedConvolvers(space) === 1, 'exactly one convolver running after settle');
	check(pendingTimers.size === 0, 'no retirement timer left behind');

	// Rapid dragging: rebuilds keep reusing both slots; every pending retirement
	// is bound to the slot it was scheduled for and cancelled on reuse.
	for (let k = 0; k < 25; k++) {
		space.set({ size: (k % 7) / 7, tone: ((k * 3) % 5) / 5 });
		advance(60); // rebuilds every ~120 ms, always before a 600 ms retirement
	}
	advance(120); // let the final debounced rebuild fire
	const activeSlot = space.slots[space.active];
	check(activeSlot.convolver.buffer !== null, 'active slot holds the final response');
	// Invariants while timers may still be pending:
	for (const slot of space.slots) {
		if (slot === activeSlot) {
			check(!slot.retire, 'active slot has no retirement pending');
		} else {
			check(slot.convolver.buffer === null || slot.retire, 'inactive slot is idle or still within its fade window');
		}
	}
	advance(SLOT_RETIRE_MS + 20);
	check(connectedBufferedConvolvers(space) === 1, 'one convolver running after a fast drag settles');
	check(space.slots[1 - space.active].convolver.buffer === null, 'non-active slot fully idled');
	check(pendingTimers.size === 0, 'all slot timers resolved');

	// Slot reuse before retirement must never retire the in-use convolver.
	space.set({ size: 0.1, tone: 0.9 });
	advance(120);
	const s1 = space.active;
	space.set({ size: 0.9, tone: 0.1 });
	advance(120);
	const s2 = space.active;
	check(s1 !== s2, 'rebuild alternates slots');
	const activeConvolver = space.slots[s2].convolver;
	advance(100); // less than the 600 ms retirement
	space.set({ size: 0.5, tone: 0.5 });
	advance(120);
	check(space.slots[s2].convolver === activeConvolver && activeConvolver.buffer !== null, 'reactivated convolver not retired under it');
	advance(SLOT_RETIRE_MS + 20);
	check(connectedBufferedConvolvers(space) === 1, 'still one convolver after slot ping-pong');
}

// --- Space offline and prepare -----------------------------------------------
console.log('Space: offline set() and prepare()');
{
	const ctx = makeContext({ offline: true, currentTime: 0 });
	const space = new Space(ctx);
	for (let k = 0; k < 8; k++) {
		space.set({ size: k / 8, tone: 1 - k / 8 });
		check(space.slots[space.active].convolver.buffer !== null, `offline rebuild ${k} applies immediately`);
		check(pendingTimers.size === 0, `offline rebuild ${k} uses no timers`);
		check(connectedBufferedConvolvers(space) === 1, `offline rebuild ${k} leaves one convolver`);
	}
	space.prepare({ size: 0.33, tone: 0.66 });
	check(space.active === 0 && space.slots[0].convolver.buffer !== null, 'prepare loads slot 0');
	check(space.slots[0].gain.gain.value === 1 && space.slots[1].gain.gain.value === 0, 'prepare gains are exact');
	check(space.slots[1].convolver.buffer === null, 'prepare idles slot 1');
	check(pendingTimers.size === 0, 'prepare leaves no timers');
}
{
	// prepare() during a live crossfade cancels the pending retirement.
	const ctx = makeContext({ currentTime: 3 });
	const space = new Space(ctx);
	space.set({ size: 0.7, tone: 0.7 });
	advance(120);
	space.set({ size: 0.2, tone: 0.2 });
	advance(120);
	check(space.slots.some((s) => s.retire), 'a retirement is pending');
	space.prepare({ size: 0.5, tone: 0.5 });
	check(pendingTimers.size === 0, 'live prepare cancels pending retirements');
	check(space.slots[0].convolver.buffer !== null && space.slots[1].convolver.buffer === null, 'live prepare leaves one convolver');
}

// --- Stem-render wiring (mirrors js/audio/stems.js) --------------------------
console.log('offline stems: shared returns plus per-layer strips');
{
	const ctx = makeContext({ offline: true, currentTime: 0 });
	const space = new Space(ctx);
	const echo = { input: ctx.createGain(), output: ctx.createGain() };
	space.prepare({ size: 0.6, tone: 0.4 });
	const song = new MockNode(ctx, 'song');
	const strips = [];
	for (let i = 0; i < 3; i++) {
		const out = ctx.createGain();
		const strip = new Strip(ctx, out, space, echo, song, i);
		strip.setMix({ volume: 0.8, pan: 0, space: 0.3, echo: 0.2, sidechain: 0 }, true, 1);
		strip.setEffects(
			[
				{ type: 'filter', on: i % 2 === 0, params: effectDefaults('filter') },
				{ type: 'pump', on: true, params: { ...effectDefaults('pump'), rate: '1/4' } },
				{ type: 'tremolo', on: i === 2, params: effectDefaults('tremolo') },
			],
			128,
		);
		strips.push(strip);
	}
	// Every strip reaches its own output and the shared Space/Echo inputs, with
	// no wall-clock timers and no dangling junction.
	for (const strip of strips) {
		check(hasPath(strip.input, strip.duck), 'stem strip input reaches its duck');
		check(hasPath(strip.panner, space.input), 'stem strip sends to Space');
		check(hasPath(strip.panner, echo.input), 'stem strip sends to Echo');
		check(pendingTimers.size === 0, 'stem strips schedule no timers at t=0');
	}
	// A second setEffects mid-"render" on an offline context still cannot create
	// timers or leak the first chain's worklet ports.
	const before = workletNodes().length;
	strips[0].setEffects([fxOf('lofi', { crush: 0.5 })], 128);
	check(workletNodes().length === before + 1, 'rebuild adds exactly one worklet node');
	check(pendingTimers.size === 0, 'offline mid-render rebuild uses no timers');
	const retired = strips[0].retiring;
	check(retired.length === 0, 'offline superseded chains are disposed, not retired');
	// Space remains a single convolver throughout the offline render.
	check(connectedBufferedConvolvers(space) === 1, 'offline Space keeps one convolver');
}

// --- Global teardown ---------------------------------------------------------
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
