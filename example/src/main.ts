import { StopEvent, StreamNodeFactory,
  type OutputStreamNode,
} from '@ain1084/audio-worklet-stream'
import worker from './worker?worker'
import type { FillerParameters } from './sine-wave-frame-buffer-filler'
import { SineWaveFrameBufferFiller } from './sine-wave-frame-buffer-filler'
import { SineWaveGenerator } from './sine-wave-generator'

/**
 * Number of start/stop cycles performed by the stress test command.
 */
const STRESS_TEST_CYCLES = 6

/**
 * Playback duration in milliseconds for each stress test cycle.
 */
const STRESS_TEST_PLAYBACK_MS = 300

class Main {
  private audioContext: AudioContext | null = null
  private factory: StreamNodeFactory | null = null
  private streamNode: OutputStreamNode | null = null
  private readonly outputDiv: Element
  private busy = false

  constructor() {
    this.outputDiv = document.getElementById('output')!

    this.addCommand('startManualButton', async (factory) => {
      const frequencies = [440]
      const sampleRate = factory.audioContext.sampleRate
      const generators = frequencies.map((frequency) => {
        return new SineWaveGenerator({ frequency, sampleRate })
      })
      const frameBufferSize = factory.audioContext.sampleRate
      const [node, writer] = await factory.createManualBufferNode({
        channelCount: frequencies.length, frameCount: frameBufferSize })
      writer.write((segment) => {
        for (let i = 0; i < segment.frameCount; ++i) {
          generators.forEach((generator, channelIndex) => {
            segment.set(i, channelIndex, generator.nextValue() * 0.3)
          })
        }
        return segment.frameCount
      })
      return node
    })

    this.addCommand('startTimerButton', async (factory) => {
      const frequencies = [440]
      return factory.createTimedBufferNode(
        new SineWaveFrameBufferFiller(
          { sampleRate: factory.audioContext.sampleRate, frequencies },
        ),
        { channelCount: frequencies.length },
      )
    })

    this.addCommand('startWorkerButton', async (factory) => {
      return this.createWorkerNode(factory)
    })

    const stopButton = document.getElementById('stopButton')!
    stopButton.addEventListener('click', () => {
      void this.stopCurrentNode()
    })

    const stressButton = document.getElementById('stressButton')
    stressButton?.addEventListener('click', () => {
      void this.runStressTest()
    })
  }

  /**
   * Creates a worker-backed node using the example sine wave filler.
   * @param factory - The stream node factory.
   * @returns A new OutputStreamNode.
   */
  private createWorkerNode(factory: StreamNodeFactory): Promise<OutputStreamNode> {
    const frequencies = [440, 431]
    return factory.createWorkerBufferNode<FillerParameters>(
      worker,
      { channelCount: frequencies.length,
        fillerParams: { sampleRate: factory.audioContext.sampleRate, frequencies },
      },
    )
  }

  /**
   * Registers a button command. Commands are serialized so that rapid clicks
   * cannot start a new stream while the previous one is still stopping.
   * @param id - The id of the button element.
   * @param commandProc - The command to execute.
   */
  private addCommand(id: string, commandProc: (factory: StreamNodeFactory) => Promise<OutputStreamNode>) {
    document.getElementById(id)!.addEventListener('click', () => {
      void this.runCommand(commandProc)
    })
  }

  /**
   * Stops the current stream (if any), creates a new node and starts playback.
   * @param commandProc - The command that creates the node.
   */
  private async runCommand(commandProc: (factory: StreamNodeFactory) => Promise<OutputStreamNode>): Promise<void> {
    if (this.busy) {
      return
    }
    this.busy = true
    try {
      await this.stopCurrentNode()
      const factory = await this.prepareStreamFactory()
      const node = await commandProc(factory)
      this.startStreamNode(node)
    }
    catch (error) {
      this.outputDiv.textContent = `Error: ${error}`
    }
    finally {
      this.busy = false
    }
  }

  /**
   * Runs several start/stop cycles back to back, alternating between the timed and
   * worker strategies. This verifies that no fill timer, worker or audio node is left
   * running once a cycle has stopped.
   */
  private async runStressTest(): Promise<void> {
    if (this.busy) {
      return
    }
    this.busy = true
    try {
      await this.stopCurrentNode()
      const factory = await this.prepareStreamFactory()
      const sampleRate = factory.audioContext.sampleRate
      for (let cycle = 1; cycle <= STRESS_TEST_CYCLES; ++cycle) {
        const frequencies = [440]
        let node: OutputStreamNode
        if (cycle % 2 === 0) {
          node = await this.createWorkerNode(factory)
        }
        else {
          node = await factory.createTimedBufferNode(
            new SineWaveFrameBufferFiller({ sampleRate, frequencies }),
            { channelCount: frequencies.length },
          )
        }
        this.startStreamNode(node)
        this.outputDiv.textContent = `Cycle ${cycle}/${STRESS_TEST_CYCLES} started`
        await Main.delay(STRESS_TEST_PLAYBACK_MS)
        await node.stop()
        this.outputDiv.textContent = `Cycle ${cycle}/${STRESS_TEST_CYCLES} stopped`
        await Main.delay(STRESS_TEST_PLAYBACK_MS)
      }
      this.outputDiv.textContent = `Completed ${STRESS_TEST_CYCLES} start/stop cycles`
    }
    catch (error) {
      this.outputDiv.textContent = `Error: ${error}`
    }
    finally {
      this.busy = false
    }
  }

  /**
   * Resolves after the given delay.
   * @param milliseconds - The delay in milliseconds.
   * @returns A promise that resolves after the delay.
   */
  private static delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds)
    })
  }

  /**
   * Reuses a single AudioContext and factory for every stream.
   * Creating a new AudioContext for each stream would leave the old contexts running.
   * @returns The shared StreamNodeFactory.
   */
  private async prepareStreamFactory(): Promise<StreamNodeFactory> {
    if (!this.factory) {
      const audioContext = new AudioContext()
      this.audioContext = audioContext
      this.factory = await StreamNodeFactory.create(audioContext)
    }
    return this.factory
  }

  /**
   * Stops and releases the current stream node, if any.
   * The stop promise resolves only after all strategy resources have been released.
   */
  private async stopCurrentNode(): Promise<void> {
    const node = this.streamNode
    this.streamNode = null
    if (!node) {
      return
    }
    await node.stop()
  }

  /**
   * Connects the node and starts playback.
   * @param node - The node to start.
   */
  private startStreamNode(node: OutputStreamNode): void {
    this.streamNode = node
    node.addEventListener(StopEvent.type, (ev) => {
      if (this.streamNode === node) {
        this.streamNode = null
      }
      this.outputDiv.textContent = `Stopped (${ev.stoppedAtFrame} frames)`
    }, { once: true })
    void this.audioContext?.resume()
    node.connect(node.context.destination)
    node.start()
    this.outputDiv.textContent = 'Started'
  }
}

export default new Main()
