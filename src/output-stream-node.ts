import type { MessageToProcessor, MessageToAudioNode } from './output-message'
import { PROCESSOR_NAME } from './constants'
import { StopEvent, UnderrunEvent } from './events'
import { BufferWriteStrategy } from './write-strategy/strategy'
import { FrameBufferContext } from '@ain1084/audio-frame-buffer'

/**
 * Stream state
 * Represents the different states of the stream.
 */
export type StreamState
  // Initial state where playback can start
  = | 'ready'
    // State where playback has started
    | 'started'
    // State where playback is stopping
    | 'stopping'
    // State where playback has stopped
    | 'stopped'

/**
 * OutputStreamNode class
 * This class extends AudioWorkletNode to handle audio processing.
 * It manages a buffer using a FrameBufferWriter instance and tracks the current frame position.
 */
export class OutputStreamNode extends AudioWorkletNode {
  private readonly _totalWriteFrames: BigUint64Array
  private readonly _totalReadFrames: BigUint64Array
  private readonly _strategy: BufferWriteStrategy
  private _state: StreamState = 'ready'
  private _stopPromise: Promise<void> | null = null
  private _stopResolve: (() => void) | null = null
  private _finalized = false

  /**
   * Creates an instance of OutputStreamNode.
   * @param baseAudioContext - The audio context to use.
   * @param bufferContext - The context for the audio frame buffer.
   * @param strategy - The strategy for writing to the buffer.
   */
  private constructor(
    baseAudioContext: BaseAudioContext,
    bufferContext: FrameBufferContext,
    strategy: BufferWriteStrategy,
  ) {
    super(baseAudioContext, PROCESSOR_NAME, {
      outputChannelCount: [bufferContext.samplesPerFrame],
      processorOptions: bufferContext,
    })
    this._strategy = strategy
    this._totalWriteFrames = bufferContext.totalWriteFrames
    this._totalReadFrames = bufferContext.totalReadFrames
    this.port.onmessage = this.handleMessage.bind(this)
  }

  /**
   * @internal
   * Creates an instance of OutputStreamNode.
   * @param audioContext - The audio context to use.
   * @param context - The context for the audio frame buffer.
   * @param strategy - The strategy for writing to the buffer.
   * @returns A promise that resolves to an instance of OutputStreamNode.
   */
  public static async create(audioContext: BaseAudioContext, context: FrameBufferContext, strategy: BufferWriteStrategy): Promise<OutputStreamNode> {
    const node = new OutputStreamNode(audioContext, context, strategy)
    let initialized = false
    try {
      initialized = await strategy.onInit(node)
    }
    catch (error) {
      node.abortInitialization()
      throw error
    }
    if (!initialized) {
      node.abortInitialization()
      throw new Error('Failed to onInit.')
    }
    return node
  }

  /**
   * Start playback.
   * The node must be connected before starting playback using connect() method.
   * Output samples must be written to the buffer before starting.
   * Playback can only be started once. Once stopped, it cannot be restarted.
   * @returns A boolean indicating whether the playback started successfully.
   */
  public start(): boolean {
    if (this.numberOfOutputs === 0) {
      throw new Error('Cannot start playback. Node is not connected.')
    }
    switch (this._state) {
      case 'ready':
        this._state = 'started'
        if (!this._strategy.onStart(this)) {
          this.stop(this.totalWriteFrames)
        }
        return true
      case 'started':
        return false
      default:
        throw new Error(`Cannot start playback. Current state: ${this._state}`)
    }
  }

  /**
   * Stop the node processing at a given frame position.
   * Returns a Promise that resolves when the node has completely stopped.
   * The node is disconnected once stopping is complete.
   * @param framePosition - The frame position at which to stop the processing, in frames.
   *                   If framePosition is 0 or if the current playback frame position has already passed the specified value,
   *                   the node will stop immediately.
   * @returns A promise that resolves when the node has stopped.
   */
  public stop(framePosition: bigint = BigInt(0)): Promise<void> {
    switch (this._state) {
      case 'started': {
        const message: MessageToProcessor = { type: 'stop', framePosition: framePosition }
        this._state = 'stopping'
        this.ensureStopPromise()
        this.port.postMessage(message)
        return this._stopPromise!
      }
      case 'ready':
        // The node never played, so its playback position is still 0.
        return this.finalize(this.totalReadFrames)
      case 'stopped':
        return this._stopPromise ?? Promise.resolve()
      case 'stopping':
        // Reuse the pending stop promise so that repeated calls do not dispatch StopEvent again.
        return this._stopPromise ?? Promise.resolve()
      default:
        throw new Error(`Cannot stop playback. Current state: ${this._state}`)
    }
  }

  /**
   * Handles incoming messages from the audio processor.
   * @param event - The message event from the processor.
   */
  private handleMessage(event: MessageEvent<MessageToAudioNode>): void {
    switch (event.data.type) {
      case 'stop':
        void this.finalize(event.data.totalProcessedFrames)
        break
      case 'underrun':
        this.dispatchEvent(new UnderrunEvent(event.data.underrunFrameCount))
        break
      default:
        throw new Error(`Unexpected event value: ${event.data}`)
    }
  }

  /**
   * Ensures that a single stop promise exists for this node.
   */
  private ensureStopPromise(): void {
    if (!this._stopPromise) {
      this._stopPromise = new Promise<void>((resolve) => {
        this._stopResolve = resolve
      })
    }
  }

  /**
   * Releases the node after a failed initialization.
   * The node never started and never played, so no {@link StopEvent} is dispatched;
   * only the acquired resources are released.
   */
  private abortInitialization(): void {
    if (this._finalized) {
      return
    }
    this._finalized = true
    this._state = 'stopped'
    this.port.onmessage = null
    try {
      void Promise.resolve(this._strategy.onStopped()).catch(() => {
        // Ignore teardown errors.
      })
    }
    catch {
      // Ignore teardown errors.
    }
    try {
      this.disconnect()
    }
    catch {
      // The node may already be disconnected.
    }
    this.port.close()
  }

  /**
   * Performs the one-time teardown of the node and settles the stop promise.
   * This releases the strategy resources (timers, workers, ...), disconnects the node,
   * closes the port and dispatches {@link StopEvent} exactly once,
   * no matter which path led here.
   * Any subsequent invocation is a no-op that returns the same promise.
   * @param stoppedAtFrame - The frame position reported by the StopEvent.
   * @returns A promise that resolves when the teardown is complete.
   */
  private finalize(stoppedAtFrame: bigint): Promise<void> {
    this.ensureStopPromise()
    if (this._finalized) {
      return this._stopPromise!
    }
    this._finalized = true
    this._state = 'stopped'
    this.port.onmessage = null

    const complete = () => {
      try {
        this.disconnect()
      }
      catch {
        // The node may already be disconnected.
      }
      this.port.close()
      const resolve = this._stopResolve
      this._stopResolve = null
      this.dispatchEvent(new StopEvent(stoppedAtFrame))
      resolve?.()
    }

    let teardown: void | Promise<void>
    try {
      teardown = this._strategy.onStopped()
    }
    catch {
      // Teardown errors must not prevent the node from reaching the stopped state.
      teardown = undefined
    }

    if (teardown && typeof teardown.then === 'function') {
      // A strategy with asynchronous teardown finishes the stop once it settles.
      void teardown
        .catch(() => {
          // Ignore teardown errors.
        })
        .then(complete)
    }
    else {
      complete()
    }

    return this._stopPromise!
  }

  /**
   * Checks if playback has started.
   * @returns A boolean indicating if playback has started.
   */
  public get isStart(): boolean {
    return this._state === 'started'
  }

  /**
   * Get the current frame position since the start of playback.
   * The position is in frames and increases by 1 for each frame.
   * It represents the total number of frames processed by the AudioWorkletProcessor.
   * - AudioWorkletProcessor has read this total number of frames from the buffer.
   *   It closely indicates the playback position in frames.
   * - totalReadFrames will never exceed the number of frames written to the buffer,
   *   ensuring it is always less than or equal to totalWriteFrames.
   * - The difference between totalWriteFrames and totalReadFrames represents the delay
   *   in samples before playback (excluding processing beyond the AudioNode).
   * @returns The current frame position as a bigint.
   */
  public get totalReadFrames(): bigint {
    return Atomics.load(this._totalReadFrames, 0)
  }

  /**
   * Get the total number of frames written to the buffer.
   * This reflects the total frames written by the BufferWriteStrategy.
   * Note: The method of writing to the buffer is implemented by the BufferWriteStrategy.
   * The OutputStreamNode itself does not modify this value.
   * @returns The total number of frames written as a bigint.
   */
  public get totalWriteFrames(): bigint {
    return Atomics.load(this._totalWriteFrames, 0)
  }
}
