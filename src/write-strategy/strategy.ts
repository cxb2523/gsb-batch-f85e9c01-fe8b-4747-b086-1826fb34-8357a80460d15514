import type { OutputStreamNode } from '../output-stream-node'

/**
 * BufferWriteStrategy interface
 * Defines the methods for buffer writing strategies.
 */
export interface BufferWriteStrategy {
  /**
   * Initializes the strategy.
   * @param node - The OutputStreamNode instance.
   * @returns A promise that resolves to true when initialization is complete.
   */
  onInit(node: OutputStreamNode): Promise<boolean>

  /**
   * Starts the strategy.
   * @param node - The OutputStreamNode instance.
   * @returns A boolean indicating whether the strategy started successfully.
   */
  onStart(node: OutputStreamNode): boolean

  /**
   * Stops the strategy and releases everything it owns (timers, workers, ports).
   * Implementations must be idempotent: calling this more than once must not throw.
   * When a promise is returned, the node waits for it before completing the stop.
   */
  onStopped(): void | Promise<void>
}
