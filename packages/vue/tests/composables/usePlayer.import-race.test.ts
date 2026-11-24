import type { App } from 'vue'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref } from 'vue'

// Dedicated file for the dynamic-import race. hls.js is registered with
// vi.doMock (not vi.mock) so its async factory only runs when usePlayer first
// reaches `await import('hls.js')`, letting the test keep that promise
// pending while the user switches sources — a slow chunk load in miniature.
const gate = vi.hoisted(() => ({
  block: false,
  entered: false,
  resolve: () => {},
}))

class FakeHls {
  static Events = {
    MANIFEST_PARSED: 'MANIFEST_PARSED',
    LEVEL_SWITCHED: 'LEVEL_SWITCHED',
    ERROR: 'ERROR',
  }

  static isSupported(): boolean {
    return true
  }

  static instances: FakeHls[] = []

  levels: Array<{ height: number; bitrate: number }> = []
  currentLevel = -1
  nextLevel: number | undefined
  destroyed = false
  loadedSrc: string | null = null
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  constructor(public config: Record<string, unknown> = {}) {
    FakeHls.instances.push(this)
  }

  on(event: string, cb: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
  }

  loadSource(src: string) {
    this.loadedSrc = src
  }

  attachMedia() {}

  destroy() {
    this.destroyed = true
  }
}

const HLS_A = 'https://example.com/a.m3u8'
const HLS_B = 'https://example.com/b.m3u8'

function setupPlayer(usePlayer: Awaited<ReturnType<typeof loadUsePlayer>>) {
  const videoRef = ref<HTMLVideoElement | null>(null)
  let player: ReturnType<Awaited<ReturnType<typeof loadUsePlayer>>> | null = null

  const TestComponent = defineComponent({
    setup() {
      player = usePlayer(videoRef)
      return () => h('video', { ref: videoRef })
    },
  })

  const app: App = createApp(TestComponent)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)

  if (!player) {
    throw new Error('usePlayer did not initialize')
  }
  return { app, host, player }
}

async function loadUsePlayer() {
  vi.doMock('hls.js', async () => {
    if (gate.block) {
      gate.entered = true
      await new Promise<void>((resolve) => (gate.resolve = resolve))
    }
    return { default: FakeHls }
  })
  const mod = await import('../../src/composables/usePlayer')
  return mod.usePlayer
}

beforeEach(() => {
  gate.block = false
  gate.entered = false
  gate.resolve = () => {}
  FakeHls.instances = []
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.doUnmock('hls.js')
})

describe('usePlayer dynamic-import race', () => {
  it('resolves normally when the import is not blocked', async () => {
    const usePlayer = await loadUsePlayer()
    const { app, host, player } = setupPlayer(usePlayer)
    await player.loadSource(HLS_A)
    expect(FakeHls.instances).toHaveLength(1)
    expect(FakeHls.instances[0].loadedSrc).toBe(HLS_A)
    app.unmount()
    host.remove()
  })

  it('a stale session whose import resolves after a switch never builds an HLS instance', async () => {
    gate.block = true
    const usePlayer = await loadUsePlayer()
    const { app, host, player } = setupPlayer(usePlayer)

    // First load suspends inside `await import('hls.js')`
    const firstLoad = player.loadSource(HLS_A)
    await vi.waitFor(() => expect(gate.entered).toBe(true))
    expect(FakeHls.instances).toHaveLength(0)

    // User switches sources before the chunk arrives
    const secondLoad = player.loadSource(HLS_B)

    // Release the shared, gated import — both continuations now resume
    gate.block = false
    gate.resolve()
    await Promise.all([firstLoad, secondLoad])

    // The stale first session bails at its session check; only the current
    // (second) session may construct an instance and load its own source.
    expect(FakeHls.instances).toHaveLength(1)
    expect(FakeHls.instances[0].loadedSrc).toBe(HLS_B)
    expect(player.state.error).toBeNull()

    app.unmount()
    host.remove()
  })
})
