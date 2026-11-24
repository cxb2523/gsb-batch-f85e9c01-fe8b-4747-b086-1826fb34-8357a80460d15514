import type { BufferWriteStrategy } from './strategy'
import type { FillerFrameBufferContext } from '../filler-frame-buffer-context'
import { FrameBufferWriter } from '@ain1084/audio-frame-buffer'
import type { FrameBufferFiller } from '../frame-buffer-filler'
import type { OutputStreamNode } from '../output-stream-node'

/**
 * PlayContext class
 * Manages the buffer filling process using a timer.
 */
class PlayContext {
  private _timerId: number = 0
  private readonly _node: OutputStreamNode
  private readonly _writer: FrameBufferWriter
  private readonly _filler: FrameBufferFiller

  /**
   * Creates an instance of PlayContext.
   * @param node - The OutputStreamNode instance.
   * @param writer - The FrameBufferWriter instance.
   * @param filler - The FrameBufferFiller instance.
   * @param fillInterval - The interval in milliseconds for filling the buffer.
   */
  constructor(node: OutputStreamNode, writer: FrameBufferWriter, filler: FrameBufferFiller, fillInterval: number) {
    this._node = node
    this._writer = writer
    this._filler = filler
    this._timerId = window.setInterval(() => this.onTick(), fillInterval)
  }

  /**
   * Runs a single fill step.
   * Every terminal outcome (filler returned false, filler threw, or the node is no
   * longer playing) goes through the same cleanup path so no timer is left behind.
   */
  private onTick(): void {
    if (!this._timerId) {
      return
    }
    if (!this._node.isStart) {
      this.cleanup()
      return
    }
    try {
      if (!this._filler.fill(this._writer)) {
        this.cleanup()
        void this._node.stop(this._writer.totalFrames)
      }
    }
    catch {
      this.cleanup()
      void this._node.stop()
    }
  }

  /**
   * Cleans up the timer.
   */
  public cleanup() {
    if (this._timerId) {
      window.clearInterval(this._timerId)
      this._timerId = 0
    }
  }
}

/**
 * TimedBufferWriteStrategy class
 * Implements the BufferWriteStrategy interface using a timer to manage buffer filling.
 */
export class TimedBufferWriteStrategy implements BufferWriteStrategy {
  private readonly _writer: FrameBufferWriter
  private readonly _filler: FrameBufferFiller
  private readonly _interval: number
  private readonly _isContinuePlayback: boolean
  private _context: PlayContext | null = null

  /**
   * Creates an instance of TimedBufferWriteStrategy.
   * @param bufferContext - The configuration for the filler frame buffer.
   * @param filler - The FrameBufferFiller instance.
   */
  constructor(bufferContext: FillerFrameBufferContext, filler: FrameBufferFiller) {
    this._writer = new FrameBufferWriter(bufferContext)
    this._filler = filler
    this._interval = bufferContext.fillInterval
    this._isContinuePlayback = this._filler.fill(this._writer)
  }

  /**
   * Initializes the strategy.
   * @returns A promise that resolves to true when initialization is complete.
   */
  async onInit(/* node: OutputStreamNode */): Promise<boolean> {
    return true
  }

  /**
   * Starts the strategy.
   * @param node - The OutputStreamNode instance.
   * @returns A boolean indicating whether the strategy started successfully.
   */
  onStart(node: OutputStreamNode): boolean {
    if (this._context) {
      throw new Error('Invalid state: context is not null.')
    }
    if (!this._isContinuePlayback) {
      return false
    }
    this._context = new PlayContext(node, this._writer, this._filler, this._interval)
    return true
  }

  /**
   * Stops the strategy.
   * This is idempotent so that repeated stop requests do not leave a timer behind.
   */
  onStopped(): void {
    this._context?.cleanup()
    this._context = null
  }
}
