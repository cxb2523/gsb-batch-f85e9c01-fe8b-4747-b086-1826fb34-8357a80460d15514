import type { App } from 'vue'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { useThumbnails } from '../../src/composables/useThumbnails'

const VTT_BODY = `WEBVTT

00:00:00.000 --> 00:00:05.000
/thumbs.jpg#xywh=0,0,160,90
`

interface Deferred {
  promise: Promise<Response>
  resolve: (res: Response) => void
  reject: (err: unknown) => void
}

function deferred(): Deferred {
  let resolve!: (res: Response) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<Response>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function vttResponse(body = VTT_BODY): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/vtt' } })
}

function setupComposable(url: () => string | undefined) {
  let result: ReturnType<typeof useThumbnails> | null = null

  const TestComponent = defineComponent({
    setup() {
      result = useThumbnails(url)
      return () => h('div')
    },
  })

  const app: App = createApp(TestComponent)
  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)

  if (!result) {
    throw new Error('useThumbnails did not initialize')
  }
  return { app, host, result }
}

describe('useThumbnails', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof fetch

  beforeEach(() => {
    fetchMock = vi.fn()
    originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    document.body.innerHTML = ''
  })

  it('starts empty and never fetches without a thumbnails URL', async () => {
    const url = ref<string | undefined>(undefined)
    const { result } = setupComposable(() => url.value)

    expect(result.thumbnailCues.value).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('loads and parses VTT cues for the current URL', async () => {
    fetchMock.mockResolvedValue(vttResponse())
    const url = ref<string | undefined>('https://example.com/thumbs.vtt')
    const { result } = setupComposable(() => url.value)

    await vi.waitFor(() => expect(result.thumbnailCues.value).toHaveLength(1))
    const cue = result.thumbnailCues.value[0]
    expect(cue).toMatchObject({ start: 0, end: 5, x: 0, y: 0, w: 160, h: 90 })
    expect(cue.url).toBe('https://example.com/thumbs.jpg')
  })

  it('a slow earlier response cannot overwrite a newer request', async () => {
    const first = deferred()
    const second = deferred()
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    const url = ref<string | undefined>('https://example.com/old.vtt')
    const { result } = setupComposable(() => url.value)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    url.value = 'https://example.com/new.vtt'
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    // The newer request resolves first
    second.resolve(vttResponse(VTT_BODY.replace('thumbs.jpg', 'new-thumbs.jpg')))
    await vi.waitFor(() => expect(result.thumbnailCues.value).toHaveLength(1))
    expect(result.thumbnailCues.value[0].url).toBe('https://example.com/new-thumbs.jpg')

    // Now the stale first request resolves — it must be ignored
    first.resolve(vttResponse(VTT_BODY.replace('thumbs.jpg', 'old-thumbs.jpg')))
    await Promise.resolve()
    expect(result.thumbnailCues.value[0].url).toBe('https://example.com/new-thumbs.jpg')

    // The superseded request was aborted
    const firstSignal = fetchMock.mock.calls[0][1]?.signal as AbortSignal
    expect(firstSignal.aborted).toBe(true)
  })

  it('aborts and invalidates in-flight requests on unmount', async () => {
    const pending = deferred()
    fetchMock.mockReturnValue(pending.promise)

    const url = ref<string | undefined>('https://example.com/thumbs.vtt')
    const { app, host, result } = setupComposable(() => url.value)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const signal = fetchMock.mock.calls[0][1]?.signal as AbortSignal

    app.unmount()
    host.remove()
    expect(signal.aborted).toBe(true)

    // Resolving after unmount must not write any cues
    pending.resolve(vttResponse())
    await Promise.resolve()
    expect(result.thumbnailCues.value).toEqual([])
  })

  it('clears cues when the thumbnails URL is removed', async () => {
    fetchMock.mockResolvedValue(vttResponse())
    const url = ref<string | undefined>('https://example.com/thumbs.vtt')
    const { result } = setupComposable(() => url.value)

    await vi.waitFor(() => expect(result.thumbnailCues.value).toHaveLength(1))

    url.value = undefined
    await nextTick()
    expect(result.thumbnailCues.value).toEqual([])
  })

  it('treats a failed response as empty cues without throwing', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }))
    const url = ref<string | undefined>('https://example.com/missing.vtt')
    const { result } = setupComposable(() => url.value)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(result.thumbnailCues.value).toEqual([])
  })
})
