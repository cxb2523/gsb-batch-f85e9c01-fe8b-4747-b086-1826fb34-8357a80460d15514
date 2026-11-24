import { onMounted, onUnmounted, reactive, readonly } from 'vue'
import type { Ref } from 'vue'
import {
  createNativeAdapter,
  detectSourceType,
  enterFullscreen,
  exitFullscreen,
  getFullscreenElement,
} from '@vue-player/core'
import type { PlayerError, PlayerState, Track } from '@vue-player/core'

export interface PlayerControls {
  play: () => Promise<void>
  pause: () => void
  seek: (seconds: number) => void
  setVolume: (value: number) => void
  toggleMute: () => void
  setSpeed: (rate: number) => void
  setQuality: (value: number | 'auto') => void
  setTrack: (track: Track | null) => void
  toggleFullscreen: () => Promise<void>
  togglePiP: () => Promise<void>
  retry: () => void
}

const ERROR_MESSAGES: Record<number, string> = {
  1: 'Playback was aborted.',
  2: 'Network error — could not load the video.',
  3: 'The video format is not supported by your browser.',
  4: 'Video not found or format not supported.',
}

function makeDefaultState(): PlayerState {
  return {
    isPlaying: false,
    isPaused: true,
    isEnded: false,
    isLoading: false,
    isBuffering: false,
    currentTime: 0,
    duration: 0,
    buffered: 0,
    volume: 1,
    isMuted: false,
    isFullscreen: false,
    isPiP: false,
    isLive: false,
    currentQuality: 'auto',
    availableQualities: [],
    playbackRate: 1,
    currentTrack: null,
    availableTracks: [],
    error: null,
  }
}

export function usePlayer(videoRef: Ref<HTMLVideoElement | null>) {
  const state = reactive<PlayerState>(makeDefaultState())

  let nativeAdapter: ReturnType<typeof createNativeAdapter> | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hlsInstance: any = null
  let lastSrc = ''

  // ─── Session lifecycle ───
  // Every loadSource() gets a unique, monotonically increasing id. All async
  // work (dynamic hls.js import, MANIFEST_PARSED / LEVEL_SWITCHED / ERROR
  // callbacks) captures its own id and only touches state while it is still the
  // current session. A superseded session destroys its own Hls instance and
  // never the instance that belongs to the newer session.
  let activeSessionId = 0
  const hlsBySession = new Map<number, any>()
  let manifestParsed = false
  // A concrete quality chosen before the manifest finished parsing; applied
  // once MANIFEST_PARSED fires (with an auto fallback if it no longer exists).
  let pendingQuality: number | null = null

  function clearVideo() {
    const video = videoRef.value
    if (!video) return
    video.pause()
    video.removeAttribute('src')
    video.load()
  }

  function destroyHls(sessionId: number, hls: any) {
    hlsBySession.delete(sessionId)
    if (hlsInstance === hls) hlsInstance = null
    hls.destroy()
  }

  function destroyAdapters() {
    nativeAdapter?.destroy()
    nativeAdapter = null
    hlsBySession.forEach((hls, sessionId) => destroyHls(sessionId, hls))
    hlsBySession.clear()
    hlsInstance = null
    // Always clear video element between source switches
    clearVideo()
  }

  function syncFromVideo(video: HTMLVideoElement) {
    state.isPlaying = !video.paused && !video.ended
    state.isPaused = video.paused
    state.isEnded = video.ended
    state.currentTime = video.currentTime
    state.duration = Number.isFinite(video.duration) ? video.duration : 0
    state.volume = video.volume
    state.isMuted = video.muted
    state.playbackRate = video.playbackRate
    state.isLive = video.duration === Infinity
    if (video.buffered.length > 0) {
      state.buffered = video.buffered.end(video.buffered.length - 1)
    }
  }

  async function loadSource(src: string) {
    const video = videoRef.value
    if (!video) return

    // Begin a new session: any previously pending async work is now stale and
    // must destroy its own resources instead of touching this state.
    const sessionId = ++activeSessionId
    lastSrc = src
    destroyAdapters()
    manifestParsed = false
    pendingQuality = null

    state.error = null
    state.isLoading = true
    state.isBuffering = false
    state.currentTime = 0
    state.duration = 0
    state.buffered = 0
    state.isLive = false
    state.availableQualities = []
    state.currentQuality = 'auto'
    state.currentTrack = null
    state.availableTracks = []

    const type = detectSourceType(src)

    if (type !== 'hls') {
      nativeAdapter = createNativeAdapter(video)
      nativeAdapter.load(src)
      return
    }

    try {
      const { default: Hls } = await import('hls.js')

      // The dynamic import may resolve after the user already switched away.
      if (sessionId !== activeSessionId) {
        return
      }

      if (!Hls.isSupported()) {
        // Safari — native HLS support
        video.src = src
        return
      }

      const hls = new Hls({ enableWorker: true })
      hlsBySession.set(sessionId, hls)
      hlsInstance = hls

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (sessionId !== activeSessionId) {
          // Stale manifest: clean up this replaced instance, never the new one.
          destroyHls(sessionId, hls)
          return
        }

        const seen = new Set<number>()
        state.availableQualities = (hls.levels as any[])
          .map((level, i) => ({
            value: level.height as number,
            label: level.height ? `${level.height}p` : `Level ${i}`,
            bitrate: level.bitrate as number,
          }))
          .filter((q) => {
            if (seen.has(q.value)) return false
            seen.add(q.value)
            return true
          })
          .sort((a, b) => b.value - a.value)

        manifestParsed = true

        // Honor a quality the user picked while the manifest was still loading.
        if (pendingQuality !== null) {
          const wanted = pendingQuality
          const idx = (hls.levels as any[]).findIndex((l) => l.height === wanted)
          if (idx !== -1) {
            hls.nextLevel = idx
            state.currentQuality = wanted
          } else {
            // Requested level no longer exists — follow ABR instead.
            hls.currentLevel = -1
            state.currentQuality = 'auto'
          }
          pendingQuality = null
        } else {
          state.currentQuality = 'auto'
        }
      })

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        if (sessionId !== activeSessionId) {
          return
        }
        // Auto mode: keep following ABR and never overwrite the user's choice.
        if (state.currentQuality === 'auto') return
        const level = (hls.levels as any[])[data.level]
        if (level && level.height !== state.currentQuality) {
          // nextLevel has fully applied — confirm the manually selected height
          state.currentQuality = level.height
        }
      })

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (sessionId !== activeSessionId) {
          // A replaced session must only tear down its own instance.
          destroyHls(sessionId, hls)
          return
        }
        if (!data.fatal) return
        const code = (data as any).response?.code ?? 0
        const isNotFound = code === 404
        state.error = {
          code,
          message: isNotFound
            ? 'Stream not found (404).'
            : 'Failed to load the stream. Check the URL or try again.',
          type: 'network',
        }
        state.isLoading = false
        state.isBuffering = false
        // Fatal error: drop the quality list and return to auto, as required.
        state.availableQualities = []
        state.currentQuality = 'auto'
        pendingQuality = null
        destroyHls(sessionId, hls)
      })

      hls.loadSource(src)
      hls.attachMedia(video)
    } catch {
      if (sessionId !== activeSessionId) {
        return
      }
      state.error = { code: 0, message: 'Failed to initialize HLS player.', type: 'source' }
      state.isLoading = false
    }
  }

  function onFullscreenChange() {
    state.isFullscreen = !!document.fullscreenElement
  }

  function applyTrackModes(video: HTMLVideoElement) {
    const track = state.currentTrack
    Array.from(video.querySelectorAll<HTMLTrackElement>('track')).forEach((el) => {
      const t = el.track
      const isActive = track !== null && t.language === track.language && t.label === track.label
      t.mode = isActive ? 'hidden' : 'disabled'
    })
  }

  function attachListeners(video: HTMLVideoElement) {
    video.addEventListener('loadstart', () => {
      state.isLoading = true
      state.error = null
    })
    video.addEventListener('loadedmetadata', () => {
      syncFromVideo(video)
    })
    video.addEventListener('canplay', () => {
      state.isLoading = false
    })
    video.addEventListener('waiting', () => {
      state.isBuffering = true
    })
    video.addEventListener('playing', () => {
      state.isBuffering = false
      syncFromVideo(video)
    })
    video.addEventListener('play', () => syncFromVideo(video))
    video.addEventListener('pause', () => {
      state.isBuffering = false
      syncFromVideo(video)
    })
    video.addEventListener('ended', () => syncFromVideo(video))
    video.addEventListener('timeupdate', () => syncFromVideo(video))
    video.addEventListener('volumechange', () => syncFromVideo(video))
    video.addEventListener('durationchange', () => syncFromVideo(video))
    video.addEventListener('progress', () => syncFromVideo(video))
    video.addEventListener('ratechange', () => {
      state.playbackRate = video.playbackRate
    })
    video.addEventListener('error', () => {
      const err = video.error
      if (!err) return
      const typeMap: Record<number, PlayerError['type']> = {
        [MediaError.MEDIA_ERR_NETWORK]: 'network',
        [MediaError.MEDIA_ERR_DECODE]: 'decode',
        [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: 'source',
      }
      state.error = {
        code: err.code,
        message: ERROR_MESSAGES[err.code] ?? err.message ?? 'Unknown playback error.',
        type: typeMap[err.code] ?? 'unknown',
      }
      state.isLoading = false
      state.isBuffering = false
    })

    video.addEventListener('enterpictureinpicture', () => {
      state.isPiP = true
    })
    video.addEventListener('leavepictureinpicture', () => {
      state.isPiP = false
    })

    // Fullscreen must be observed on document — the player element is not <video>
    document.addEventListener('fullscreenchange', onFullscreenChange)
  }

  const controls: PlayerControls = {
    async play() {
      await videoRef.value?.play()
    },
    pause() {
      videoRef.value?.pause()
    },
    seek(seconds) {
      const video = videoRef.value
      if (!video || !state.duration) return
      video.currentTime = Math.max(0, Math.min(state.duration, seconds))
    },
    setVolume(value) {
      const video = videoRef.value
      if (!video) return
      video.volume = Math.max(0, Math.min(1, value))
      if (video.muted && value > 0) video.muted = false
    },
    toggleMute() {
      if (videoRef.value) videoRef.value.muted = !videoRef.value.muted
    },
    setSpeed(rate) {
      if (videoRef.value) videoRef.value.playbackRate = rate
    },
    setQuality(value) {
      if (value === 'auto') {
        // Only an explicit auto selection re-enables ABR.
        pendingQuality = null
        if (hlsInstance) hlsInstance.currentLevel = -1
        state.currentQuality = 'auto'
        return
      }

      if (!manifestParsed) {
        // Manifest not ready yet: remember the choice and apply it (or fall
        // back to auto) from MANIFEST_PARSED.
        pendingQuality = value
        state.currentQuality = value
        return
      }

      if (!hlsInstance) return
      const idx = (hlsInstance.levels as any[]).findIndex((l) => l.height === value)
      if (idx === -1) {
        // Level unavailable on this stream — stay on ABR and sync the UI.
        hlsInstance.currentLevel = -1
        state.currentQuality = 'auto'
        return
      }
      // nextLevel switches at the next segment boundary — no buffer flush, no freeze
      hlsInstance.nextLevel = idx
      state.currentQuality = value
    },
    setTrack(track) {
      state.currentTrack = track
      const video = videoRef.value
      if (video) applyTrackModes(video)
    },
    async toggleFullscreen() {
      const video = videoRef.value
      const el = video?.closest<HTMLElement>('.vp-player')
      if (!el) return
      if (getFullscreenElement()) {
        await exitFullscreen()
      } else if ('requestFullscreen' in el || 'webkitRequestFullscreen' in el) {
        await enterFullscreen(el)
      } else {
        // iOS Safari: only supports fullscreen on the video element itself
        const iosVideo = video as HTMLVideoElement & { webkitEnterFullscreen?: () => void }
        iosVideo.webkitEnterFullscreen?.()
      }
    },
    async togglePiP() {
      const video = videoRef.value
      if (!video) return
      if (document.pictureInPictureElement) await document.exitPictureInPicture()
      else await video.requestPictureInPicture()
    },
    retry() {
      if (lastSrc) loadSource(lastSrc)
    },
  }

  onMounted(() => {
    const video = videoRef.value
    if (!video) return
    attachListeners(video)
    syncFromVideo(video)
  })

  onUnmounted(() => {
    // Invalidate every session so late callbacks become no-ops.
    activeSessionId++
    destroyAdapters()
    document.removeEventListener('fullscreenchange', onFullscreenChange)
  })

  return { state: readonly(state), controls, loadSource }
}
