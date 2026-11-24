import type { App } from 'vue'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, ref } from 'vue'

import { usePlayer } from '../../src/composables/usePlayer'

// ─── Controllable hls.js stub ───
interface FakeEvent {
  fatal?: boolean
  level?: number
  response?: { code?: number }
}

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
  attached: HTMLVideoElement | null = null
  loadedSrc: string | null = null
  private listeners = new Map<string, Array<(event: string, data: FakeEvent) => void>>()

  constructor(public config: Record<string, unknown> = {}) {
    FakeHls.instances.push(this)
  }

  on(event: string, cb: (event: string, data: FakeEvent) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(cb)
    this.listeners.set(event, list)
  }

  emit(event: string, data: FakeEvent = {}) {
    // Deliberately keep listeners after destroy() so tests can prove the
    // session guard rejects late callbacks rather than relying on teardown.
    this.listeners.get(event)?.forEach((cb) => cb(event, data))
  }

  loadSource(src: string) {
    this.loadedSrc = src
  }

  attachMedia(video: HTMLVideoElement) {
    this.attached = video
  }

  destroy() {
    this.destroyed = true
  }
}

vi.mock('hls.js', () => ({ default: FakeHls }))

function setupPlayer() {
  const videoRef = ref<HTMLVideoElement | null>(null)
  let player: ReturnType<typeof usePlayer> | null = null

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
  return {
    app,
    host,
    video: videoRef.value!,
    player,
  }
}

const HLS_A = 'https://example.com/a.m3u8'
const HLS_B = 'https://example.com/b.m3u8'

beforeEach(() => {
  FakeHls.instances = []
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('usePlayer session lifecycle', () => {
  it('resets tracks, qualities and buffering when switching sources', async () => {
    const { app, host, player } = setupPlayer()
    const { state, controls, loadSource } = player

    await loadSource(HLS_A)
    const hlsA = FakeHls.instances[0]
    hlsA.levels = [
      { height: 720, bitrate: 1000 },
      { height: 1080, bitrate: 2000 },
    ]
    hlsA.emit(FakeHls.Events.MANIFEST_PARSED)
    controls.setTrack({ src: '/en.vtt', label: 'EN', language: 'en' })
    state.isBuffering = true

    await loadSource('https://example.com/movie.mp4')

    expect(state.availableQualities).toEqual([])
    expect(state.currentQuality).toBe('auto')
    expect(state.currentTrack).toBeNull()
    expect(state.availableTracks).toEqual([])
    expect(state.isBuffering).toBe(false)
    expect(state.error).toBeNull()
    expect(hlsA.destroyed).toBe(true)

    app.unmount()
    host.remove()
  })

  it('destroys the replaced HLS instance and never the new one on fast switch', async () => {
    const { app, host, player } = setupPlayer()
    const { loadSource } = player

    await loadSource(HLS_A)
    const hlsA = FakeHls.instances[0]

    await loadSource(HLS_B)
    const hlsB = FakeHls.instances[1]

    expect(hlsA.destroyed).toBe(true)
    expect(hlsB.destroyed).toBe(false)
    expect(FakeHls.instances).toHaveLength(2)

    // A late MANIFEST_PARSED from the dead session must not pollute new state
    hlsA.levels = [{ height: 360, bitrate: 500 }]
    hlsA.emit(FakeHls.Events.MANIFEST_PARSED)
    expect(player.state.availableQualities).toEqual([])
    expect(hlsB.destroyed).toBe(false)

    // The new session's manifest still works
    hlsB.levels = [{ height: 480, bitrate: 800 }]
    hlsB.emit(FakeHls.Events.MANIFEST_PARSED)
    expect(player.state.availableQualities.map((q) => q.value)).toEqual([480])

    app.unmount()
    host.remove()
  })

  it('ignores fatal ERROR from a superseded session and does not destroy the new instance', async () => {
    const { app, host, player } = setupPlayer()
    const { loadSource } = player

    await loadSource(HLS_A)
    const hlsA = FakeHls.instances[0]
    await loadSource(HLS_B)
    const hlsB = FakeHls.instances[1]

    hlsA.emit(FakeHls.Events.ERROR, { fatal: true, response: { code: 404 } })

    expect(player.state.error).toBeNull()
    expect(hlsB.destroyed).toBe(false)

    app.unmount()
    host.remove()
  })

  it('ignores LEVEL_SWITCHED from a superseded session', async () => {
    const { app, host, player } = setupPlayer()
    const { loadSource } = player

    await loadSource(HLS_A)
    const hlsA = FakeHls.instances[0]
    await loadSource(HLS_B)

    // A late level switch from the dead session must not touch current state
    hlsA.levels = [{ height: 360, bitrate: 1 }]
    hlsA.emit(FakeHls.Events.LEVEL_SWITCHED, { level: 0 })

    expect(player.state.currentQuality).toBe('auto')

    app.unmount()
    host.remove()
  })

  it('unmount destroys the active HLS instance and invalidates late callbacks', async () => {
    const { app, host, player } = setupPlayer()
    const { loadSource } = player

    await loadSource(HLS_A)
    const hlsA = FakeHls.instances[0]
    app.unmount()
    host.remove()

    expect(hlsA.destroyed).toBe(true)

    // After unmount a late manifest cannot write back into state
    hlsA.levels = [{ height: 720, bitrate: 1 }]
    hlsA.emit(FakeHls.Events.MANIFEST_PARSED)
    expect(player.state.availableQualities).toEqual([])
  })
})

describe('usePlayer quality selection', () => {
  it('remembers a quality chosen before MANIFEST_PARSED and applies it by height', async () => {
    const { app, host, player } = setupPlayer()
    const { state, controls, loadSource } = player

    await loadSource(HLS_A)
    const hls = FakeHls.instances[0]

    controls.setQuality(1080)
    expect(state.currentQuality).toBe(1080)
    expect(state.availableQualities).toEqual([])

    hls.levels = [
      { height: 720, bitrate: 1000 },
      { height: 1080, bitrate: 2000 },
    ]
    hls.emit(FakeHls.Events.MANIFEST_PARSED)

    expect(hls.nextLevel).toBe(1)
    expect(state.currentQuality).toBe(1080)
    expect(state.availableQualities.map((q) => q.value)).toEqual([1080, 720])

    app.unmount()
    host.remove()
  })

  it('falls back to auto when a pending quality is absent from the parsed manifest', async () => {
    const { app, host, player } = setupPlayer()
    const { state, controls, loadSource } = player

    await loadSource(HLS_A)
    const hls = FakeHls.instances[0]

    controls.setQuality(2160)
    hls.levels = [{ height: 720, bitrate: 1000 }]
    hls.emit(FakeHls.Events.MANIFEST_PARSED)

    expect(hls.currentLevel).toBe(-1)
    expect(state.currentQuality).toBe('auto')

    app.unmount()
    host.remove()
  })

  it('keeps a manually selected quality when LEVEL_SWITCHED fires', async () => {
    const { app, host, player } = setupPlayer()
    const { state, controls, loadSource } = player

    await loadSource(HLS_A)
    const hls = FakeHls.instances[0]
    hls.levels = [
      { height: 720, bitrate: 1000 },
      { height: 1080, bitrate: 2000 },
    ]
    hls.emit(FakeHls.Events.MANIFEST_PARSED)

    controls.setQuality(720)
    expect(hls.nextLevel).toBe(0)
    expect(state.currentQuality).toBe(720)

    // LEVEL_SWITCHED must never flip a manual pick back to 'auto'. While the
    // switch is in flight hls.js may report another level; once the requested
    // nextLevel applies its height is confirmed as the current selection.
    hls.emit(FakeHls.Events.LEVEL_SWITCHED, { level: 1 })
    expect(state.currentQuality).not.toBe('auto')

    hls.emit(FakeHls.Events.LEVEL_SWITCHED, { level: 0 })
    expect(state.currentQuality).toBe(720)

    app.unmount()
    host.remove()
  })

  it('only an explicit auto selection re-enables ABR', async () => {
    const { app, host, player } = setupPlayer()
    const { state, controls, loadSource } = player

    await loadSource(HLS_A)
    const hls = FakeHls.instances[0]
    hls.levels = [{ height: 720, bitrate: 1000 }]
    hls.emit(FakeHls.Events.MANIFEST_PARSED)

    controls.setQuality(720)
    expect(state.currentQuality).toBe(720)

    controls.setQuality('auto')
    expect(hls.currentLevel).toBe(-1)
    expect(state.currentQuality).toBe('auto')

    app.unmount()
    host.remove()
  })

  it('clears availableQualities and restores auto on a fatal ERROR', async () => {
    const { app, host, player } = setupPlayer()
    const { state, controls, loadSource } = player

    await loadSource(HLS_A)
    const hls = FakeHls.instances[0]
    hls.levels = [{ height: 720, bitrate: 1000 }]
    hls.emit(FakeHls.Events.MANIFEST_PARSED)
    controls.setQuality(720)

    hls.emit(FakeHls.Events.ERROR, { fatal: true, response: { code: 404 } })

    expect(state.availableQualities).toEqual([])
    expect(state.currentQuality).toBe('auto')
    expect(state.error).toMatchObject({ code: 404, type: 'network' })
    expect(hls.destroyed).toBe(true)

    app.unmount()
    host.remove()
  })

  it('falls back to auto when selecting a height missing from a parsed manifest', async () => {
    const { app, host, player } = setupPlayer()
    const { state, controls, loadSource } = player

    await loadSource(HLS_A)
    const hls = FakeHls.instances[0]
    hls.levels = [{ height: 720, bitrate: 1000 }]
    hls.emit(FakeHls.Events.MANIFEST_PARSED)

    controls.setQuality(1080)
    expect(hls.currentLevel).toBe(-1)
    expect(state.currentQuality).toBe('auto')

    app.unmount()
    host.remove()
  })
})
