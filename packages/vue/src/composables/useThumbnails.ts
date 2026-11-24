import type { ThumbnailCue } from '@vue-player/core'
import type { MaybeRefOrGetter } from 'vue'
import { parseThumbnailVtt } from '@vue-player/core'
import { onBeforeUnmount, ref, toValue, watch } from 'vue'

/**
 * Loads thumbnail VTT cues for a reactive URL while guaranteeing that:
 * - a slow, earlier request can never overwrite the result of a newer request;
 * - every in-flight request is aborted when the URL changes again or the
 *   component unmounts, so nothing can write back after teardown.
 */
export function useThumbnails(urlSource: MaybeRefOrGetter<string | undefined>) {
  const thumbnailCues = ref<ThumbnailCue[]>([])

  // Monotonic token of the latest request; stale responses check it before writing.
  let activeRequestId = 0
  let activeController: AbortController | null = null

  async function loadThumbnails(url: string | undefined) {
    const requestId = ++activeRequestId
    activeController?.abort()
    activeController = null

    if (!url) {
      thumbnailCues.value = []
      return
    }

    const controller = new AbortController()
    activeController = controller
    const cues = await parseThumbnailVtt(url, controller.signal)

    // A newer request (or unmount) superseded this one — drop its result.
    if (requestId !== activeRequestId || controller.signal.aborted) {
      return
    }
    thumbnailCues.value = cues
    activeController = null
  }

  watch(
    () => toValue(urlSource),
    (url) => loadThumbnails(url),
    { immediate: true },
  )

  onBeforeUnmount(() => {
    // Invalidate every in-flight request so it can never touch state again.
    activeRequestId++
    activeController?.abort()
    activeController = null
  })

  return { thumbnailCues }
}
