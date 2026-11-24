import type { BufferWriteStrategy } from './strategy'
import type { FillerFrameBufferContext } from '../filler-frame-buffer-context'
import type { MessageToStrategy, MessageToWorker } from './worker/message'
import type { OutputStreamNode } from '../output-stream-node'

/**
 * Maximum time to wait for the worker to acknowledge a stop request.
 * The worker normally answers immediately; this guard only prevents the main thread
 * from waiting forever if the worker is unresponsive or has already died.
 */
const STOP_ACKNOWLEDGEMENT_TIMEOUT_MS = 1000

/**
 * Parameters for creating a PlayContext.
 * @property node - The OutputStreamNode instance.
 * @property context - The FillerFrameBufferContext instance.
 * @property workerConstructor - The constructor for the Worker.
 * @property fillerParam - The parameters for the FrameBufferFiller.
 */
type PlayerContextParams<FillerParams> = Readonly<{
  node: OutputStreamNode
  context: FillerFrameBufferContext
  workerConstructor: new () => Worker
  fillerParam: FillerParams
}>

/**
 * PlayContext class
 * Manages the buffer filling process within a web worker.
 */
class Context<FillerParams> {
  private readonly _node: OutputStreamNode
  private readonly _bufferContext: FillerFrameBufferContext
  private readonly _fillerParam: FillerParams
  private readonly _worker: Worker
  private _stopPromise: Promise<void> | null = null
  private _resolveStop: (() => void) | null = null
  private _stopTimerId: number = 0
  private _terminated = false

  /**
   * Creates an instance of PlayContext.
   * @param params - The parameters for the PlayContext.
   */
  private constructor(params: PlayerContextParams<FillerParams>) {
    this._node = params.node
    this._bufferContext = params.context
    this._worker = new params.workerConstructor()
    this._fillerParam = params.fillerParam
    this._worker.onmessage = this.handleWorkerMessage.bind(this)
  }

  /**
   * Creates and initializes an instance of PlayContext.
   * @param params - The parameters for the PlayContext.
   * @returns A promise that resolves to an instance of PlayContext.
   * @throws Error - If the worker was stopped before initialization completed.
   */
  public static async create<FillerParams>(params: PlayerContextParams<FillerParams>) {
    const instance = new Context(params)
    if (!(await instance.init())) {
      instance.finish()
      throw new Error('Worker was stopped before initialization completed.')
    }
    return instance
  }

  /**
   * Handles messages from the worker.
   * @param ev - The message event from the worker.
   */
  private handleWorkerMessage(ev: MessageEvent<MessageToStrategy>): void {
    switch (ev.data.type) {
      case 'stop':
        void this._node.stop(ev.data.stopFrames)
        break
      case 'stop-done':
        this.finish()
        break
      default:
        break
    }
  }

  /**
   * Initializes the PlayContext by sending the 'init' message to the worker.
   * Resolves with false when the worker acknowledged a stop before initialization
   * completed, so the caller does not wait for a message that will never arrive.
   * @returns A promise that resolves to true when initialization is complete.
   */
  private init(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const message: MessageToWorker<FillerParams> = {
        type: 'init',
        config: this._bufferContext,
        fillerParams: this._fillerParam,
      }
      const listener = (ev: MessageEvent<MessageToStrategy>) => {
        if (ev.data.type === 'init-done') {
          this._worker.removeEventListener('message', listener)
          resolve(true)
        }
        else if (ev.data.type === 'stop-done') {
          this._worker.removeEventListener('message', listener)
          resolve(false)
        }
      }
      this._worker.addEventListener('message', listener)
      this._worker.postMessage(message)
    })
  }

  /**
   * Starts the buffer filling process by sending the 'start' message to the worker.
   */
  public start() {
    if (this._terminated) {
      return
    }
    const message: MessageToWorker<FillerParams> = {
      type: 'start',
    }
    this._worker.postMessage(message)
  }

  /**
   * Stops the worker: requests a stop, waits for the worker acknowledgement,
   * then terminates it. Repeated calls reuse the same promise and never throw.
   * A worker that is already fully initialized answers the stop request directly;
   * the acknowledgement is always resolved through {@link finish}, so a late
   * message after termination cannot settle the promise twice.
   */
  public stopped(): Promise<void> {
    if (this._stopPromise) {
      return this._stopPromise
    }
    this._stopPromise = new Promise<void>((resolve) => {
      this._resolveStop = resolve
      if (this._terminated) {
        resolve()
        return
      }
      const message: MessageToWorker<FillerParams> = { type: 'stop' }
      this._worker.postMessage(message)
      this._stopTimerId = window.setTimeout(() => this.finish(), STOP_ACKNOWLEDGEMENT_TIMEOUT_MS)
    })
    return this._stopPromise
  }

  /**
   * Terminates the worker and settles the stop promise.
   * This is idempotent so that a late acknowledgement after termination is harmless.
   */
  private finish(): void {
    if (this._terminated) {
      return
    }
    this._terminated = true
    if (this._stopTimerId) {
      window.clearTimeout(this._stopTimerId)
      this._stopTimerId = 0
    }
    this._worker.onmessage = null
    this._worker.terminate()
    const resolve = this._resolveStop
    this._resolveStop = null
    resolve?.()
  }
}

/**
 * WorkerBufferWriteStrategy class
 * Implements the BufferWriteStrategy interface using a web worker to manage buffer filling.
 */
export class WorkerBufferWriteStrategy<FillerParam> implements BufferWriteStrategy {
  private readonly _createPlayContext: (node: OutputStreamNode) => Promise<Context<FillerParam>>
  private _context: Context<FillerParam> | null = null
  private _contextPromise: Promise<Context<FillerParam>> | null = null
  private _stopped = false

  /**
   * Creates an instance of WorkerBufferWriteStrategy.
   * @param bufferContext - The context for the filler frame buffer.
   * @param workerConstructor - The constructor for the Worker.
   * @param fillerParam - The parameters for the FrameBufferFiller.
   */
  constructor(bufferContext: FillerFrameBufferContext, workerConstructor: new () => Worker, fillerParam: FillerParam) {
    this._createPlayContext = (node: OutputStreamNode) => Context.create<FillerParam>({ node, context: bufferContext, workerConstructor, fillerParam })
  }

  /**
   * Initializes the strategy.
   * When the strategy is stopped before initialization completes, the worker is
   * terminated and this method reports failure instead of leaving it running.
   * @param node - The OutputStreamNode instance.
   * @returns A promise that resolves to true when initialization is complete.
   */
  async onInit(node: OutputStreamNode): Promise<boolean> {
    if (this._stopped) {
      return false
    }
    const contextPromise = this._createPlayContext(node)
    this._contextPromise = contextPromise
    let context: Context<FillerParam>
    try {
      context = await contextPromise
    }
    catch (error) {
      if (this._stopped) {
        return false
      }
      throw error
    }
    if (this._stopped) {
      // A stop request arrived while the worker was still initializing.
      await context.stopped()
      return false
    }
    this._context = context
    return true
  }

  /**
   * Starts the strategy.
   * @param node - The OutputStreamNode instance.
   * @returns A boolean indicating whether the strategy started successfully.
   */
  onStart(/* node: OutputStreamNode */): boolean {
    if (!this._context) {
      throw new Error('Invalid state: context is null.')
    }
    this._context.start()
    return true
  }

  /**
   * Stops the strategy by stopping and terminating its worker.
   * This is idempotent and also covers a stop requested while initialization
   * is still in flight: the pending worker is stopped as soon as it is ready.
   */
  async onStopped(): Promise<void> {
    this._stopped = true
    const context = this._context
    this._context = null
    if (context) {
      await context.stopped()
      return
    }
    const pending = this._contextPromise
    if (!pending) {
      return
    }
    try {
      const pendingContext = await pending
      await pendingContext.stopped()
    }
    catch {
      // The pending initialization failed on its own; nothing is left to release.
    }
  }
}
