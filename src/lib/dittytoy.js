"use strict";

import workerCode from './ditty-worker.js?raw';
import workletCodeURL from './ditty-worklet.js?url';

function getWorkerURL(releaseMode) {
    const blob = new Blob([workerCode], {type: 'application/javascript'});
    return URL.createObjectURL(blob);
}

function getAudioWorkletURL() {
    return workletCodeURL;
}

/**
 * Merges a volume update into the remembered volume, keeping the most recent
 * value per target. Master volume and per-loop volumes are independent.
 */
function mergeVolume(prev, update) {
    const next = {
        ...(prev || {}),
    };
    if (!update || typeof update !== 'object') return next;
    if (update.master && typeof update.master === 'object') {
        next.master = {...(prev && prev.master), ...update.master};
    }
    if (Array.isArray(update.loops)) {
        const byName = new Map((prev && Array.isArray(prev.loops) ? prev.loops : [])
            .filter(l => l && l.name != null)
            .map(l => [l.name, {...l}]));
        update.loops.forEach(l => {
            if (!l || l.name == null) return;
            byName.set(l.name, {...byName.get(l.name), ...l});
        });
        next.loops = [...byName.values()];
    }
    return next;
}

export const LOOP_OPERATOR_SYNTH = 0;
export const LOOP_OPERATOR_OPTION = 1;

export const BUFFER_LENGTH = 128 * 5;
export const NUM_BUFFERS = 4;

export const RUN_AS_WORKER = 0;
export const RUN_AS_INLINE = 1;

export const NODE_TYPE_LOOP = 0;
export const NODE_TYPE_INLINE = 1;
export const NODE_TYPE_FILTER = 2;
export const NODE_TYPE_OUT = 3;

export const MSG_INIT = 0;
export const MSG_RESET = 1;
export const MSG_LOG = 2;
export const MSG_ERROR = 3;
export const MSG_ANALYZE_STRUCTURE = 4;
export const MSG_WORKLET_READY = 5;
export const MSG_UPDATE = 6;
export const MSG_NOTE_PLAYED = 7;
export const MSG_SET_AMP = 8;
export const MSG_SET_VARS = 9;
export const MSG_PLAY = 10;
export const MSG_STOP = 11;
export const MSG_PAUSE = 12;
export const MSG_RESUME = 13;


/*! unmute-ios-audio. MIT License. Feross Aboukhadijeh <https://feross.org/opensource> */
const USER_ACTIVATION_EVENTS = [
    'auxclick',
    'click',
    'contextmenu',
    'dblclick',
    'keydown',
    'keyup',
    'mousedown',
    'mouseup',
    'touchend'
]

function unmuteIosAudio() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;

    function isMobileSafari() {
        return navigator.userAgent.match(/(iPod|iPhone|iPad)/) && navigator.userAgent.match(/AppleWebKit/);
    }

    if (!isMobileSafari()) return new Promise((resolve, reject) => reject());

    // state can be 'blocked', 'pending', 'allowed'
    let htmlAudioState = 'blocked';
    let webAudioState = 'blocked';

    let audio;
    let context;
    let source;

    const sampleRate = (new AudioContext()).sampleRate;
    const silentAudioFile = createSilentAudioFile(sampleRate);

    // Return a seven samples long 8 bit mono WAVE file
    function createSilentAudioFile(sampleRate) {
        const arrayBuffer = new ArrayBuffer(10);
        const dataView = new DataView(arrayBuffer);

        dataView.setUint32(0, sampleRate, true);
        dataView.setUint32(4, sampleRate, true);
        dataView.setUint16(8, 1, true);

        const missingCharacters =
            window.btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
                .slice(0, 13);

        return `data:audio/wav;base64,UklGRisAAABXQVZFZm10IBAAAAABAAEA${missingCharacters}AgAZGF0YQcAAACAgICAgICAAAA=`;
    }

    function handleUserActivation(resolve, reject, e) {
        if (webAudioState === 'blocked') {
            webAudioState = 'pending'
            createWebAudio();
        }
        if (htmlAudioState === 'blocked') {
            htmlAudioState = 'pending'
            Promise.all([createHtmlAudio(), context.resume()])
                .then(() => resolve())
                .catch(err => reject(err));
        }
    }

    function createHtmlAudio() {
        audio = document.createElement('audio');

        audio.setAttribute('x-webkit-airplay', 'deny'); // Disable the iOS control center media widget
        audio.preload = 'auto';
        audio.loop = true;
        audio.src = silentAudioFile;
        audio.load();

        return audio.play().then(
            () => {
                htmlAudioState = 'allowed';
                maybeCleanup();
            },
            () => {
                htmlAudioState = 'blocked';

                audio.pause();
                audio.removeAttribute('src');
                audio.load();
                audio = null;
            }
        )
    }

    function createWebAudio() {
        context = new AudioContext();

        source = context.createBufferSource();
        source.buffer = context.createBuffer(1, 1, 22050); // .045 msec of silence
        source.connect(context.destination);
        source.start();

        if (context.state === 'running') {
            webAudioState = 'allowed';
            maybeCleanup();
            return true;
        } else {
            webAudioState = 'blocked';

            source.disconnect(context.destination);
            source = null;

            context.close();
            context = null;
            return false;
        }
    }

    function maybeCleanup() {
        if (htmlAudioState !== 'allowed' || webAudioState !== 'allowed') return;

        USER_ACTIVATION_EVENTS.forEach(eventName => {
            window.removeEventListener(
                eventName, handleUserActivation, {capture: true, passive: true}
            );
        });
    }

    return new Promise((resolve, reject) => {
        USER_ACTIVATION_EVENTS.forEach(eventName => {
            window.addEventListener(
                eventName, handleUserActivation.bind(null, resolve, reject), {capture: true, passive: true}
            );
        });
    });
}

unmuteIosAudio().then(() => {
}).catch(() => {
});


class EventDispatcher {
    constructor() {
        this.events = {};
    }

    addListener(event, callback) {
        this.events[event]?.push(callback) || (this.events[event] = [callback]);
    }

    removeListener(event, callback) {
        this.events[event] = this.events[event]?.filter(listener => listener !== callback) || false;
    }

    dispatch(event, data) {
        this.events[event]?.forEach((listener) => listener(data));
        return this;
    }
}


export class Dittytoy extends EventDispatcher {
    constructor() {
        super();

        this._workerData = [];
        this._volumeWorkers = [];
        this._structure = {};
        this._code = '';

        this._context = null;
        this._source = null;
        this._worklet = null;

        // Volume / input parameters set by the user. Kept here so values set
        // before play or while stopped survive the next playback run.
        this._volume = {};
        this._inputParameters = [];

        // Single source of truth for the playback lifecycle:
        // 'stopped' | 'playing' | 'paused'
        this._state = 'stopped';

        this.paused = true;
        this.stopped = true;

        // Serializes all public lifecycle calls (compile/play/stop/pause/resume)
        // so concurrent calls can't create duplicate resources or interleave
        // state transitions.
        this._queue = Promise.resolve();
    }

    /**
     * Runs `task` after every previously enqueued lifecycle operation has
     * settled. The queue keeps running even if a previous task rejected.
     */
    _enqueue(task) {
        const result = this._queue.then(task, task);
        this._queue = result.then(() => undefined, () => undefined);
        return result;
    }

    _setState(state) {
        this._state = state;
        this.paused = state !== 'playing';
        this.stopped = state === 'stopped';
    }

    /**
     * Combines the caller-supplied input parameters with those remembered from
     * earlier setInputParameters() calls; explicit values win.
     */
    _mergeInputParameters(vars) {
        const provided = Array.isArray(vars) ? vars : [];
        if (this._inputParameters.length === 0) return provided;

        const byKey = new Map(this._inputParameters.map(p => [p.key, p]));
        provided.forEach(kv => {
            if (kv && kv.key != null) byKey.set(kv.key, kv);
        });
        return [...byKey.values()];
    }

    postMessage(data, transfer = []) {
        this.postMessageToWorklet(data, transfer);
        this.postMessageToWorkers(data, transfer);
    }

    postMessageToWorklet(data, transfer = []) {
        if (this._worklet && this._worklet.port) {
            try {
                this._worklet.port.postMessage(data, transfer);
            } catch (e) {
                // The worklet may be in a transient state while the audio
                // graph is being (re)built; never let a status update throw.
            }
        }
    }

    postMessageToWorkers(data, transfer = []) {
        this._workerData.forEach(workerData => {
            if (workerData.terminated) return;
            try {
                workerData.worker.postMessage(data, transfer);
            } catch (e) {
                // Ignore messages to workers that were just released.
            }
        });
    }

    postMessageToVolumeWorkers(data, transfer = []) {
        this.postMessageToWorklet(data, transfer);
        this._volumeWorkers.forEach(worker => {
            try {
                worker.postMessage(data, transfer);
            } catch (e) {
                // Ignore messages to workers that were just released.
            }
        });
    }

    setVolume(amp) {
        if (amp == null) return;

        // Remember the requested volume so a value set while stopped/paused is
        // applied to the next playback run (workers are released on stop, and
        // the worklet's AudioBus is reset, so the message alone would be lost).
        this._volume = mergeVolume(this._volume, amp);

        this.postMessageToVolumeWorkers({type: MSG_SET_AMP, amp});
    }

    setInputParameters(vars) {
        if (!Array.isArray(vars)) return;

        // Same as setVolume: keep the values for the next playback run. Values
        // are merged by key, with the most recent call winning.
        vars.forEach(kv => {
            if (!kv || kv.key == null) return;
            const existing = this._inputParameters.filter(p => p.key !== kv.key);
            existing.push({key: kv.key, value: kv.value});
            this._inputParameters = existing;
        });

        this.postMessageToWorkers({type: MSG_SET_VARS, vars});
    }

    log(message, line = -1) {
        return this.dispatch(MSG_LOG, {message, line});
    }

    logClear() {
        return this.dispatch(MSG_RESET);
    }

    error(message, e) {
        return this.dispatch(MSG_ERROR, {message, ...e});
    }

    enableAudioVisualizer(context, source) {
        return this.dispatch(MSG_WORKLET_READY, {context, source});
    }

    onmessage(e) {
        return this.dispatch(e.data.type, e.data);
    }

    async stop() {
        return this._enqueue(() => this._stopInternal());
    }

    async pause() {
        return this._enqueue(() => this._pauseInternal());
    }

    async resume(vars = [], amp = {}, releaseMode = false) {
        return this._enqueue(() => this._resumeInternal(vars, amp, releaseMode));
    }

    /**
     * Stops playback, mutes the audio graph, and releases the Workers that
     * belong to the current playback run. The AudioContext and worklet node
     * are kept alive so later plays don't have to recreate them.
     */
    async _stopInternal() {
        if (this._state === 'stopped') {
            // Already stopped: make sure no stale workers linger, but don't
            // dispatch an event because nothing actually changed.
            this._releaseWorkers();
            return;
        }

        this.log('[STOP]');

        // Silence the worklet first: reset clears its internal buffer, beat
        // counters and AudioBus state, and suspending guarantees the render
        // thread has stopped producing audio before we report the stop.
        this.postMessageToWorklet({type: MSG_RESET});
        if (this._context && this._context.state === 'running') {
            try {
                await this._context.suspend();
            } catch (e) {
                this.error(e.message, e);
            }
        }

        this._releaseWorkers();
        this._setState('stopped');

        this.dispatch(MSG_STOP);
    }

    async _pauseInternal() {
        if (this._state !== 'playing') {
            // Pausing a stopped or already paused synth is a no-op; no event.
            return;
        }

        this.log('[PAUSE]');

        if (this._context && this._context.state === 'running') {
            try {
                await this._context.suspend();
            } catch (e) {
                this.error(e.message, e);
            }
        }

        this._setState('paused');
        this.dispatch(MSG_PAUSE);
    }

    async _resumeInternal(vars = [], amp = {}, releaseMode = false) {
        if (this._state === 'stopped') {
            // Resume from a full stop behaves like a fresh play (the original
            // API semantics); play() will emit MSG_PLAY for the transition.
            return this._playInternal(vars, amp, releaseMode);
        }

        if (this._state !== 'paused') {
            // Already playing: nothing to resume, and no state changed.
            return;
        }

        this.log('[RESUME]');

        if (this._context) {
            try {
                await this._context.resume();
            } catch (e) {
                this.error(e.message, e);
            }
        }

        this._setState('playing');
        this.dispatch(MSG_RESUME);
    }

    _releaseWorkers() {
        if (this._workerData.length > 0 || this._volumeWorkers.length > 0) {
            this.log('[TERMINATE WORKERS]');
        }
        this._workerData.forEach(workerData => {
            workerData.terminated = true;

            // Drop our handlers and the channel ports before terminating so no
            // closure keeps a handle to the released worker or its ports.
            try {
                workerData.worker.onmessage = null;
            } catch (e) {
            }
            try {
                workerData.worker.terminate();
            } catch (e) {
                // Worker was already terminated.
            }
            try {
                workerData.channel.port1.close();
            } catch (e) {
            }
            try {
                workerData.channel.port2.close();
            } catch (e) {
            }
        });
        this._workerData = [];
        this._volumeWorkers = [];
    }

    terminateWorkers() {
        this._releaseWorkers();
    }

    setupWorkers(structure, code, vars = {}, amp = {}, releaseMode = true) {
        this.log('[CREATE WORKERS]');

        // find all workers

        const workers = [...structure.loops, ...structure.filters.filter(filter => filter.runAs === RUN_AS_WORKER)];

        workers.forEach(data => {
            const workerData = {...data};

            // create a worker for each loop
            const worker = new Worker(getWorkerURL(releaseMode));

            worker.addEventListener('error', (e) => {
                this.error(e.message, this.formatErrorCode(e));
                this.stop().then(() => {
                    worker.terminate();
                });
            });

            worker.onmessage = (m) => {
                const type = m.data.type;

                if (type === MSG_ERROR) {
                    this.error(m.data.message, this.formatErrorCode(m.data));
                    this.stop().then(() => {
                        worker.terminate();
                    });
                } else if (type !== MSG_INIT) {
                    this.onmessage(m);
                }
            };

            workerData.buffers = Array.from({length: NUM_BUFFERS}, (k, i) => ({
                data: new Float32Array(BUFFER_LENGTH * 2), index: i
            }));
            workerData.worker = worker;
            workerData.channel = new MessageChannel();

            this._workerData.push(workerData);
        });

        // initialize all workers
        this._workerData.forEach(data => {
            data.in = this._workerData.filter(w => w.out.nodeType === data.nodeType && w.out.name === data.name).map(n => ({
                name: n.name, nodeType: n.nodeType, port: n.channel.port2
            }));
            data.worker.postMessage({
                type: MSG_INIT,
                vars: vars,
                amp: amp,
                port: data.channel.port1,
                name: data.name,
                nodeType: data.nodeType,
                runAs: data.runAs,
                buffers: data.buffers,
                in: data.in,
                code,
            }, [data.channel.port1, ...data.buffers.map(b => b.data.buffer), ...data.in.map(i => i.port)]);
        });

        this._volumeWorkers = this._workerData.filter(w => w.in.length > 0 && w.in.filter(i => i.nodeType === NODE_TYPE_LOOP).length > 0).map(worker => worker.worker);
    }

    formatErrorCode(e) {
        const m = e.message;
        return {
            data: Object.assign(e, {
                success: false,
                toString: () => m + "\n" + Object.keys(e.e).map(
                    (a) => {
                        if (this[a] == null || typeof this[a] === "object") return;
                        return a + ": \t" + this[a]
                    }, e.e).filter(Boolean).join("\n")
            })
        };
    }

    async compile(code) {
        return this._enqueue(() => this._compileInternal(code));
    }

    async _compileInternal(code) {
        await this._stopInternal();
        this._releaseWorkers();

        this.logClear().log('Analyze code...', 0);

        return new Promise((resolve, reject) => {
            const worker = new Worker(getWorkerURL(false));
            let settled = false;

            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                worker.terminate();
                fn(value);
            };

            worker.addEventListener('error', (e) => { // error while compiling code
                this.error(e.message, this.formatErrorCode(e));
                this.log('Unable to analyze code', 1);

                finish(reject, this.formatErrorCode(e));
            });

            worker.addEventListener('message', (e) => {
                const structure = e.data.structure;

                if (!structure) {
                    // Not the analysis result (e.g. a log emitted while the
                    // code was being evaluated) - just forward the event.
                    this.onmessage(e);
                    return;
                }

                if (Object.values(structure.loops).length <= 0) {
                    // add loop to code
                    structure.loops.push({
                        name: 'loop_0', nodeType: NODE_TYPE_LOOP, runAs: RUN_AS_WORKER, out: {nodeType: NODE_TYPE_OUT}
                    });
                    code = `loop(()=>{${code};\n},{name:'loop_0',sync:1e10});`;
                }
                this._structure = structure;
                this._code = code;

                this.onmessage(e);

                finish(resolve, e);
            });

            worker.postMessage({type: MSG_ANALYZE_STRUCTURE, code});
        });
    }

    /**
     * Lazily creates the AudioContext / worklet graph. The graph is reused for
     * the entire lifetime of the Dittytoy instance so repeated play/stop
     * cycles never create a second AudioContext or AudioWorkletNode.
     * Returns true when the graph is ready.
     */
    async _ensureAudioGraph() {
        if (this._context && this._worklet) {
            return true;
        }

        const sampleRate = 44100;
        const AudioContext = window.AudioContext || window.webkitAudioContext;

        if (!AudioContext) {
            this.error('Web Audio API is not supported in this browser');
            return false;
        }

        let context = null;
        try {
            context = new AudioContext({sampleRate: sampleRate});

            const source = context.createBufferSource();
            source.buffer = context.createBuffer(2, sampleRate, sampleRate);
            source.loop = true;

            await context.audioWorklet.addModule(getAudioWorkletURL());

            const worklet = new AudioWorkletNode(context, `ditty-worklet`, {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [2]
            });

            worklet.onerror = (e) => this.error(e.message, e);

            source.connect(worklet).connect(context.destination);
            source.start();

            worklet.port.onmessage = (e) => this.onmessage(e);

            this._context = context;
            this._source = source;
            this._worklet = worklet;

            this.enableAudioVisualizer(this._context, this._worklet);
            return true;
        } catch (e) {
            // Never leave a half-initialized graph behind - a later play()
            // must be able to try again from a clean slate.
            if (this._worklet) {
                try {
                    this._worklet.disconnect();
                } catch (_) {
                }
                this._worklet = null;
            }
            if (this._source) {
                try {
                    this._source.stop();
                    this._source.disconnect();
                } catch (_) {
                }
                this._source = null;
            }
            if (context) {
                try {
                    context.close();
                } catch (_) {
                }
            }
            this._context = null;

            this.error(e && e.message ? e.message : e, e);
            return false;
        }
    }

    async play(vars = [], amp = {}, releaseMode = false) {
        return this._enqueue(() => this._playInternal(vars, amp, releaseMode));
    }

    async _playInternal(vars = [], amp = {}, releaseMode = false) {
        if (!this._code || !this._structure || !Array.isArray(this._structure.loops)) {
            // Nothing compiled yet: playing would only create orphan workers.
            return;
        }

        const previousState = this._state;

        // A play always starts a fresh run: release the workers of a previous
        // run (if any) and reset the worklet transport before wiring new ones.
        this._releaseWorkers();
        this.postMessageToWorklet({type: MSG_RESET});

        if (!await this._ensureAudioGraph()) {
            // Could not build the audio graph: there is no sound, so make sure
            // the advertised state matches reality (and report the change if
            // we were previously playing or paused).
            if (this._state !== 'stopped') {
                this._setState('stopped');
                this.dispatch(MSG_STOP);
            }
            return;
        }

        this.log('[PLAY]');

        const structure = this._structure;
        const code = this._code;

        // Fold in volume / input parameters set while stopped or paused so the
        // values requested by the user are in effect for this playback run.
        const playVars = this._mergeInputParameters(vars);
        const playAmp = mergeVolume(this._volume, amp);

        // Only forward per-loop volumes for loops this ditty actually has, so
        // volumes remembered from previously played ditties don't accumulate.
        if (Array.isArray(playAmp.loops) && Array.isArray(structure.loops)) {
            const names = new Set(structure.loops.map(l => l.name));
            playAmp.loops = playAmp.loops.filter(l => names.has(l.name));
        }

        try {
            this.setupWorkers(structure, code, playVars, playAmp, releaseMode);

            const out = this._workerData.filter(workerData => workerData.out.nodeType === NODE_TYPE_OUT);

            this.postMessageToWorklet({
                type: MSG_INIT, in: out.map(w => ({name: w.name, nodeType: w.nodeType, port: w.channel.port2})
                ), state: structure, vars: playVars, amp: playAmp,
            }, out.map(w => w.channel.port2));
        } catch (e) {
            // Creating or wiring workers failed: nothing is producing audio,
            // so release whatever was created and report an honest state.
            this.error(e && e.message ? e.message : e, e);
            this._releaseWorkers();
            this.postMessageToWorklet({type: MSG_RESET});
            if (this._state !== 'stopped') {
                this._setState('stopped');
                this.dispatch(MSG_STOP);
            }
            return;
        }

        if (this._context.state !== 'running') {
            try {
                await this._context.resume();
            } catch (e) {
                this.error(e.message, e);
            }
        }

        this._setState('playing');

        // Only report a play transition when the state actually changed.
        if (previousState !== 'playing') {
            this.dispatch(MSG_PLAY);
        }
    }
}
