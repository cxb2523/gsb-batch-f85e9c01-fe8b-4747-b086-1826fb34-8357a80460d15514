import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseThumbnailVtt, parseVttText } from '../../src/utils/parseThumbnailVtt'

const VTT_BODY = `WEBVTT

00:00:00.000 --> 00:00:05.000
/thumbs.jpg#xywh=0,0,160,90

00:00:10.000 --> 00:00:15.000
/thumbs2.jpg
`

describe('parseVttText', () => {
  it('parses cues with sprite fragments and resolves relative URLs', () => {
    const cues = parseVttText(VTT_BODY, 'https://example.com/thumbnails/storyboard.vtt')
    expect(cues).toHaveLength(2)
    expect(cues[0]).toMatchObject({
      start: 0,
      end: 5,
      url: 'https://example.com/thumbs.jpg',
      x: 0,
      y: 0,
      w: 160,
      h: 90,
    })
    expect(cues[1]).toMatchObject({
      start: 10,
      end: 15,
      url: 'https://example.com/thumbs2.jpg',
    })
  })
})

describe('parseThumbnailVtt', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('passes an AbortSignal through to fetch', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
      return new Response(VTT_BODY, { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const cues = await parseThumbnailVtt(
      'https://example.com/thumbs.vtt',
      new AbortController().signal,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cues).toHaveLength(2)
  })

  it('returns an empty list when the request is aborted', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const pending = parseThumbnailVtt('https://example.com/thumbs.vtt', controller.signal)
    controller.abort()

    await expect(pending).resolves.toEqual([])
  })

  it('works without a signal (backward compatible)', async () => {
    const fetchMock = vi.fn(async () => new Response(VTT_BODY, { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const cues = await parseThumbnailVtt('https://example.com/thumbs.vtt')
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/thumbs.vtt', undefined)
    expect(cues).toHaveLength(2)
  })
})
