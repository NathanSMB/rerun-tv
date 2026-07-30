/**
 * One `<video>` element and, when it needs one, one MSE pump (plan §7,
 * docs/stall-fix-plan.html phase 2).
 *
 * This is the only DOM-touching half of the MediaSource work: `new MediaSource()`,
 * `fetch`, object URLs, and the teardown order that keeps them from leaking. All
 * the logic worth testing lives in `mse.ts`, which is deliberately DOM-free.
 *
 * Three source shapes go through here, and the component picks per source:
 *
 * - **direct** — a real file behind range requests. Plain `src`, native seeking,
 *   no pump. Chromium's progressive loader is *correct* for a seekable file; the
 *   bug it causes only exists against an unseekable pipe.
 * - **remux / transcode** — an open-ended ffmpeg pipe. `MediaSource` plus a pump,
 *   so the app owns read pace and the connection is never abandoned.
 * - **fallen back** — a pipe whose bytes defeated `parseInitSegment` (an exotic
 *   remuxed codec). Reverts to plain `src` for that episode only. Behaviour is
 *   then exactly what it was before phase 2: worse, but not broken.
 *
 * Two elements of this are stacked by `Player.tsx` for the gapless handoff, which
 * is why the standby's read policy is a prop and `promote()` is on the handle
 * rather than being decided in here.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, SyntheticEvent } from 'react'
import type { PlaybackPath } from '@shared/types.js'
import {
  DEFAULT_BUFFER_POLICY,
  STANDBY_BUFFER_POLICY,
  startPump,
  type Pump
} from './mse.js'

/** What to play. `key` changes exactly when a fresh stream must be opened. */
export interface VideoSource {
  /** Identity of this stream: `<episodeId>@<offset>`, bumped by a seek. */
  key: string
  url: string
  playbackPath: PlaybackPath
  /**
   * The MSE timeline's length: episode runtime *minus the seek offset*, because
   * an `-ss` seek restarts the pipe's timestamps at zero.
   */
  durationS: number
}

export interface VideoSurfaceHandle {
  /** The live element, for play/pause/volume/currentTime. Null before mount. */
  readonly element: HTMLVideoElement | null
  /** Raise a standby pump to the full read targets. No-op without a pump. */
  promote(): void
}

export interface VideoSurfaceProps {
  source: VideoSource | null
  /** The element on screen and driving the OSD. The standby passes false. */
  active: boolean
  /** Buffer only a few seconds. Set on the standby until it is promoted. */
  standby?: boolean
  /**
   * Bumped to re-open the same stream from scratch — what Retry does. Separate
   * from `source.key` because the source hasn't changed.
   */
  generation?: number
  /** Written into the handle so the parent can drive the element. */
  handleRef?: { current: VideoSurfaceHandle | null }
  className?: string

  /** A real failure: the request died, or the source buffer rejected the data. */
  onStreamError?(): void

  // Media element events. Forwarded only while `active`, so a hidden standby's
  // `timeupdate` can never move the OSD and its `ended` can never advance the
  // channel.
  onLoadStart?(): void
  onLoadedMetadata?(video: HTMLVideoElement): void
  onLoadedData?(): void
  onTimeUpdate?(currentTime: number): void
  onPlay?(): void
  onPause?(): void
  onEnded?(): void
  onError?(): void
}

/** Chromium fires `sourceopen` once the element has attached the object URL. */
function whenSourceOpen(mediaSource: MediaSource, signal: AbortSignal): Promise<void> {
  if (mediaSource.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      mediaSource.removeEventListener('sourceopen', onOpen)
      signal.removeEventListener('abort', onAbort)
    }
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onAbort = (): void => {
      cleanup()
      const err = new Error('aborted')
      err.name = 'AbortError'
      reject(err)
    }
    mediaSource.addEventListener('sourceopen', onOpen)
    signal.addEventListener('abort', onAbort)
  })
}

/**
 * The stream server answers a failure as `text/plain` carrying ffmpeg's own
 * stderr — worth surfacing rather than replacing with "network error".
 */
async function describeFailure(response: Response): Promise<string> {
  let detail = ''
  try {
    detail = (await response.text()).trim()
  } catch {
    /* A body we cannot read tells us nothing; the status still does. */
  }
  return detail === '' ? `stream request failed (${response.status})` : detail
}

export default function VideoSurface({
  source,
  active,
  standby = false,
  generation = 0,
  handleRef,
  className,
  onStreamError,
  onLoadStart,
  onLoadedMetadata,
  onLoadedData,
  onTimeUpdate,
  onPlay,
  onPause,
  onEnded,
  onError
}: VideoSurfaceProps): JSX.Element {
  /**
   * The element as *state*, not a ref: the pump lifecycle is an effect and has to
   * re-run when the element itself appears, which a ref assignment would not
   * announce.
   */
  const [element, setElement] = useState<HTMLVideoElement | null>(null)

  /**
   * The source key whose pump gave up on parsing. Keyed rather than a boolean so
   * one exotic episode cannot condemn the next one to the plain-`src` path.
   */
  const [fallbackKey, setFallbackKey] = useState<string | null>(null)

  const pumpRef = useRef<Pump | null>(null)
  /** False from the first moment of teardown, so an abort's `error` is ignored. */
  const liveRef = useRef(false)
  /**
   * Read once, when a pump is created. Excluded from the effect's dependencies on
   * purpose: promotion must raise the read targets of the *running* pump, not
   * tear it down and lose the buffer the standby exists to have built.
   */
  const standbyRef = useRef(standby)
  standbyRef.current = standby

  const key = source?.key ?? null
  const fellBack = key !== null && fallbackKey === key
  const usesPump =
    source !== null && source.playbackPath !== 'direct' && !fellBack && supportsMse()

  /**
   * `promote` reads `pumpRef` when called rather than when the handle was built,
   * so a swap can promote a pump that was created after this effect ran.
   */
  useEffect(() => {
    const ref = handleRef
    if (!ref) return
    ref.current = {
      element,
      promote: () => pumpRef.current?.promote()
    }
    return () => {
      ref.current = null
    }
  }, [handleRef, element])

  useEffect(() => {
    if (!element || !source) return
    liveRef.current = true

    // ---- plain src: the direct path, and the parser's fallback --------------
    if (!usesPump) {
      element.src = source.url
      return () => {
        liveRef.current = false
        detach(element)
      }
    }

    // ---- MediaSource: the ffmpeg pipes -------------------------------------
    const controller = new AbortController()
    const mediaSource = new MediaSource()
    const objectUrl = URL.createObjectURL(mediaSource)
    element.src = objectUrl

    const pump = startPump({
      openReader: async () => {
        // In parallel: the element attaching the source, and ffmpeg starting.
        // Serialising them would add a frame of latency to every tune-in.
        const [response] = await Promise.all([
          fetch(source.url, { signal: controller.signal, cache: 'no-store' }),
          whenSourceOpen(mediaSource, controller.signal)
        ])
        if (!response.ok || !response.body) throw new Error(await describeFailure(response))
        return response.body.getReader()
      },
      mediaSource,
      clock: element,
      durationS: source.durationS,
      signal: controller.signal,
      policy: standbyRef.current ? STANDBY_BUFFER_POLICY : DEFAULT_BUFFER_POLICY,
      promotedPolicy: DEFAULT_BUFFER_POLICY,
      onFallback: (reason) => {
        console.warn(`[player] ${source.url}: ${reason} — falling back to plain playback`)
        setFallbackKey(source.key)
      },
      onError: (error) => {
        console.error(`[player] ${source.url}: ${error.message}`)
        onStreamError?.()
      }
    })
    pumpRef.current = pump

    return () => {
      liveRef.current = false
      pumpRef.current = null
      pump.stop()
      controller.abort()
      // Order matters: drop the element's reference to the blob *before* revoking
      // it, or Chromium holds the MediaSource alive against a URL that is gone.
      detach(element)
      URL.revokeObjectURL(objectUrl)
    }
    // `standby` is deliberately absent — see `standbyRef`. `onStreamError` is a
    // stable callback from the Player and re-creating the pump for it would
    // restart ffmpeg on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [element, usesPump, source?.key, source?.url, generation])

  /**
   * A hidden standby is silent. Set imperatively rather than as a `muted` prop so
   * the Player's volume effect — which runs after this one, being the parent — is
   * unambiguously the owner for whichever surface is on air.
   */
  useEffect(() => {
    if (element) element.muted = standby
  }, [element, standby])

  // ---- event plumbing ------------------------------------------------------

  const forward = useCallback(
    (handler: (() => void) | undefined) => () => {
      if (active) handler?.()
    },
    [active]
  )

  const handleError = useCallback(() => {
    // Detaching a source fires `error` on some Chromium builds. That is teardown,
    // not a broken episode, and showing the failure card for it would be a lie.
    if (!liveRef.current || !active) return
    onError?.()
  }, [active, onError])

  /**
   * A standby that started playing would burn through the episode it is meant to
   * be holding at the top. There is no `autoPlay` on either element for exactly
   * this reason — the Player starts the one on air explicitly, on
   * `loadedmetadata` and on a swap — but Chromium can also begin playback on its
   * own once a `SourceBuffer` has data, so refuse it here too.
   */
  const handlePlay = useCallback(() => {
    if (standby) {
      element?.pause()
      return
    }
    if (active) onPlay?.()
  }, [standby, active, element, onPlay])

  return (
    <video
      ref={setElement}
      className={className}
      playsInline
      preload="auto"
      onLoadStart={forward(onLoadStart)}
      onLoadedMetadata={(event: SyntheticEvent<HTMLVideoElement>) => {
        if (active) onLoadedMetadata?.(event.currentTarget)
      }}
      onLoadedData={forward(onLoadedData)}
      onTimeUpdate={(event: SyntheticEvent<HTMLVideoElement>) => {
        if (active) onTimeUpdate?.(event.currentTarget.currentTime)
      }}
      onPlay={handlePlay}
      onPause={forward(onPause)}
      onEnded={forward(onEnded)}
      onError={handleError}
    />
  )
}

/** MSE is present in every Electron build we ship; the guard is for safety, not portability. */
function supportsMse(): boolean {
  return typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function'
}

/**
 * Stop the element pulling on a source we are done with. `removeAttribute` plus
 * `load()` is the documented way to make Chromium release the connection; just
 * setting `src = ''` resolves against the page URL and starts a doomed request.
 */
function detach(video: HTMLVideoElement): void {
  video.removeAttribute('src')
  try {
    video.load()
  } catch {
    /* An element already being torn down by React has nothing to reset. */
  }
}
