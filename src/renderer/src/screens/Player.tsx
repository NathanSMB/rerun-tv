/**
 * Screen 02 — the Player (plan §7).
 *
 * Full-bleed video with an OSD layer that rises on mouse move or key press and
 * fades after `settings.osdHideAfterS` seconds of idle.
 *
 * Four decisions in here are load-bearing and non-obvious:
 *
 * 1. **Fullscreen is requested on the stage wrapper, never on a `<video>`.**
 *    The wrapper holds both videos and the OSD, so an episode handoff — which
 *    swaps which element is on top — cannot take the fullscreen element away with
 *    it. Requesting fullscreen on a video would drop out of fullscreen on every
 *    auto-advance, and would also hide our OSD behind Chromium's native controls.
 *
 * 2. **Seeking is done by loading a new URL, not by setting `currentTime`.**
 *    The remux and transcode paths (plan §6) are open-ended ffmpeg pipes with no
 *    byte ranges and no known length, so the browser cannot seek them. The
 *    stream server's contract is `/stream/<id>?t=<seconds>`: it restarts ffmpeg
 *    at `-ss`. Because the fresh stream then reports `currentTime` from zero, we
 *    keep the requested position in the slot's `offset` and render
 *    `offset + videoTime` everywhere a position is shown. Only the `direct` path
 *    — a real file served with range requests — seeks natively.
 *
 * 3. **The pipes are played through MediaSource, not through `src`.**
 *    See `player/mse.ts`. Handing an unseekable pipe to Chromium's progressive
 *    loader is what produced the minute-long freezes; the pump owns read pace so
 *    the connection is never abandoned. That lives entirely in `VideoSurface`,
 *    which this screen treats as "a `<video>` that knows how to play our URLs".
 *
 * 4. **There are two video elements, and a handoff is a swap, not a load.**
 *    Thirty seconds before the end of an episode the store commits the next pick
 *    and this screen starts buffering it in a hidden standby surface. On `ended`
 *    the store promotes that pick, the stage flips which surface is on top, and
 *    the already-buffered element simply starts playing — no tune-in latency, no
 *    black frame. With `prewarmNext` off nothing is prewarmed and the second
 *    surface stays empty, which is exactly the single-element behaviour.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, KeyboardEvent, PointerEvent } from 'react'
import { formatDuration } from '@shared/playback.js'
import type { NowPlaying } from '@shared/types.js'
import VideoSurface, {
  type VideoSource,
  type VideoSurfaceHandle
} from '../player/VideoSurface.js'
import { endsPlayableUnit, useStore } from '../store.js'
import './Player.css'

/**
 * Seconds of remaining runtime that trigger the "up next" toast *and* the
 * prewarm (plan §6). One window, deliberately: the toast is the user-visible
 * promise that the next episode is ready, and now it actually is.
 */
const UP_NEXT_WINDOW_S = 30

/** How long the channel banner stays up after a tune-in or a handoff. */
const BANNER_MS = 4000

/** Volume step for the ↑/↓ keys. */
const VOLUME_STEP = 0.05

/**
 * Coalescing window for seeks. Holding an arrow key on the scrub bar would
 * otherwise kill and restart ffmpeg once per repeat; we only commit once the
 * user stops moving.
 */
const SEEK_COMMIT_MS = 250

/** Mouse-move reveals are throttled so a moving pointer doesn't re-render 60×/s. */
const ACTIVITY_THROTTLE_MS = 150

/**
 * Sleep-timer durations the OSD button cycles through, in minutes.
 *
 * The first press arms `settings.sleepTimerDefaultMin`; each press after that
 * moves to the next preset above the armed value, and past the last one the
 * timer switches off. TV convention, and it means the common case — "give me
 * the usual" — is one press.
 */
const SLEEP_PRESETS = [15, 30, 45, 60, 90, 120]

const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, value))

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

interface SliderProps {
  className: string
  label: string
  /** Current value, in the same unit as `max`. `min` is always 0 here. */
  value: number
  max: number
  step: number
  ariaValueText: string
  /** Fires continuously while dragging or on each key press — cheap preview. */
  onPreview(value: number): void
  /** Fires when the gesture ends — the expensive action (a real seek). */
  onCommit(value: number): void
  onDragChange?(dragging: boolean): void
  /** The scrub bar carries the mockup's amber knob; the volume track doesn't. */
  knob?: boolean
}

/**
 * A real `role="slider"` widget: focusable, arrow-key operable, and draggable
 * with pointer capture so the drag survives the pointer leaving the 4px track.
 *
 * Preview and commit are split because the scrub bar's commit restarts an
 * ffmpeg process — we want the fill to follow the finger at 60fps but the seek
 * to happen once.
 */
function Slider({
  className,
  label,
  value,
  max,
  step,
  ariaValueText,
  onPreview,
  onCommit,
  onDragChange,
  knob = false
}: SliderProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const valueAtX = (clientX: number): number => {
    const el = trackRef.current
    if (!el) return value
    const rect = el.getBoundingClientRect()
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    return clamp(ratio, 1) * max
  }

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    trackRef.current?.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    onDragChange?.(true)
    onPreview(valueAtX(e.clientX))
  }

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    onPreview(valueAtX(e.clientX))
  }

  const endDrag = (e: PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    onDragChange?.(false)
    onCommit(valueAtX(e.clientX))
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    let next: number
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = value - step
        break
      case 'ArrowRight':
      case 'ArrowUp':
        next = value + step
        break
      case 'PageDown':
        next = value - step * 5
        break
      case 'PageUp':
        next = value + step * 5
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = max
        break
      default:
        return
    }
    // Stops the window-level map from also reading this arrow as skip/volume.
    e.preventDefault()
    e.stopPropagation()
    const clamped = clamp(next, max)
    onPreview(clamped)
    onCommit(clamped)
  }

  const pct = max > 0 ? clamp(value / max, 1) * 100 : 0

  return (
    <div
      ref={trackRef}
      className={className}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      aria-valuetext={ariaValueText}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    >
      <div className="fill" style={{ right: `${100 - pct}%` }} />
      {knob && <div className="knob" style={{ left: `${pct}%` }} aria-hidden="true" />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/** Which of the two surfaces we mean. */
type SlotId = 'a' | 'b'

/** What one surface is playing, plus the display offset a URL-seek left behind. */
interface Slot {
  episodeId: number
  url: string
  /** Seconds the stream was started at; added to `currentTime` for display. */
  offset: number
  source: VideoSource
}

interface StageState {
  active: SlotId
  a: Slot | null
  b: Slot | null
  /** Per-slot reload counter: Retry re-opens one stream without touching the other. */
  generation: { a: number; b: number }
}

const other = (slot: SlotId): SlotId => (slot === 'a' ? 'b' : 'a')

function slotFor(playing: NowPlaying, offset = 0, url?: string): Slot {
  const streamUrl = url ?? playing.streamUrl
  return {
    episodeId: playing.episode.id,
    url: streamUrl,
    offset,
    source: {
      // Identity of the stream, not of the episode: a seek must open a new one.
      key: `${playing.episode.id}@${offset}`,
      url: streamUrl,
      playbackPath: playing.episode.playbackPath,
      // What is left of the episode from where this stream starts — the pipe's
      // own timestamps restart at zero after an `-ss` seek.
      durationS: Math.max(1, playing.episode.durationS - offset)
    }
  }
}

function writeSlot(stage: StageState, slot: SlotId, value: Slot | null): StageState {
  return slot === 'a' ? { ...stage, a: value } : { ...stage, b: value }
}

const EMPTY_STAGE: StageState = { active: 'a', a: null, b: null, generation: { a: 0, b: 0 } }

/**
 * Fold a new `nowPlaying` into the stage.
 *
 * The important branch is the first one: when the standby already holds the
 * episode the store just promoted, the handoff is a *flip* — the element keeps
 * its buffer and its ffmpeg, and playback starts on the next frame. Anything
 * else is an ordinary load into the active surface, which also discards a
 * standby that is now stale (a skip mid-prewarm, say).
 */
function reconcile(stage: StageState, playing: NowPlaying | null): StageState {
  if (playing === null) return { ...EMPTY_STAGE, active: stage.active, generation: stage.generation }

  const standbySlot = other(stage.active)
  const standby = stage[standbySlot]
  if (standby !== null && standby.episodeId === playing.episode.id) {
    return writeSlot({ ...stage, active: standbySlot }, stage.active, null)
  }
  return writeSlot(writeSlot(stage, stage.active, slotFor(playing)), standbySlot, null)
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export default function Player(): JSX.Element | null {
  const nowPlaying = useStore((s) => s.nowPlaying)
  const pendingNext = useStore((s) => s.pendingNext)
  const upNext = useStore((s) => s.upNext)
  const volume = useStore((s) => s.volume)
  const muted = useStore((s) => s.muted)
  const osdHideAfterS = useStore((s) => s.settings.osdHideAfterS)
  const prewarmNext = useStore((s) => s.settings.prewarmNext)
  const sleepDefaultMin = useStore((s) => s.settings.sleepTimerDefaultMin)
  const sleepUntil = useStore((s) => s.sleepUntil)
  const sleepMinutes = useStore((s) => s.sleepMinutes)
  const advance = useStore((s) => s.advance)
  const prewarm = useStore((s) => s.prewarm)
  const leavePlayer = useStore((s) => s.leavePlayer)
  const armSleep = useStore((s) => s.armSleep)
  const sleepNow = useStore((s) => s.sleepNow)
  const setVolume = useStore((s) => s.setVolume)
  const toggleMute = useStore((s) => s.toggleMute)

  const stageRef = useRef<HTMLDivElement>(null)
  const surfaceA = useRef<VideoSurfaceHandle | null>(null)
  const surfaceB = useRef<VideoSurfaceHandle | null>(null)

  const episodeId = nowPlaying?.episode.id ?? null
  const totalS = nowPlaying?.episode.durationS ?? 0

  const [stage, setStage] = useState<StageState>(() => reconcile(EMPTY_STAGE, nowPlaying))
  const [videoTime, setVideoTime] = useState(0)

  if ((stage[stage.active]?.episodeId ?? null) !== episodeId) {
    // Adjusting state during render (rather than in an effect) so no surface ever
    // commits a frame still pointing at the previous episode's stream. A promoted
    // standby is paused at zero, so the timecode resets with it.
    setStage(reconcile(stage, nowPlaying))
    setVideoTime(0)
  }

  const activeSlot = stage[stage.active]
  const standbySlot = stage[other(stage.active)]

  const [scrubPreview, setScrubPreview] = useState<number | null>(null)
  const [paused, setPaused] = useState(false)
  const [failed, setFailed] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  const [osdVisible, setOsdVisible] = useState(true)
  const [bannerFlash, setBannerFlash] = useState(true)
  const [osdHovered, setOsdHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  /** Bumped on any user activity; restarts the idle timer effect below. */
  const [activity, setActivity] = useState(0)
  /**
   * Wall clock, repainted once a second *only while the sleep timer is armed*.
   *
   * The countdown chip is the only thing that needs it. Expiry itself is never
   * read from this value — see the store's `sleepUntil`.
   */
  const [nowMs, setNowMs] = useState(() => Date.now())

  const lastActivityRef = useRef(0)
  const advancingRef = useRef(false)
  const seekTimerRef = useRef<number | null>(null)
  /** Set while a load is in flight so a URL-seek resumes playback on its own. */
  const wantsPlayRef = useRef(true)
  /** Timestamp of the last browser-initiated fullscreen exit — see the Esc map. */
  const leftFullscreenAtRef = useRef(0)
  /** The episode we have already asked to prewarm after, so we ask exactly once. */
  const prewarmedAfterRef = useRef<number | null>(null)

  const offset = activeSlot?.offset ?? 0
  const position = scrubPreview ?? offset + videoTime
  const remainingS = totalS - position
  const chromeVisible = osdVisible || failed
  const showBanner = bannerFlash || chromeVisible
  const inUpNextWindow = remainingS <= UP_NEXT_WINDOW_S && remainingS > 0

  // ---- sleep timer --------------------------------------------------------

  const sleepExpired = sleepUntil !== null && nowMs >= sleepUntil
  const endsUnit = endsPlayableUnit(nowPlaying)
  /**
   * The timer has fired *and* this episode finishes its playable unit, so
   * nothing more will be picked on this channel: no prewarm, and no "up next".
   * Mid-arc this is false — the remaining parts still play, and the store's arc
   * lock is what supplies them.
   */
  const sleepPending = sleepExpired && endsUnit

  const showToast = prewarmNext && upNext != null && !failed && inUpNextWindow && !sleepPending

  /** The element on air. Everything transport-related goes through this. */
  const activeVideo = useCallback((): HTMLVideoElement | null => {
    const handle = stage.active === 'a' ? surfaceA.current : surfaceB.current
    return handle?.element ?? null
  }, [stage.active])

  // ---- OSD visibility -----------------------------------------------------

  const reveal = useCallback(() => {
    setOsdVisible(true)
    const now = Date.now()
    if (now - lastActivityRef.current < ACTIVITY_THROTTLE_MS) return
    lastActivityRef.current = now
    setActivity((n) => n + 1)
  }, [])

  /**
   * The idle timer. It is deliberately expressed as an effect keyed on every
   * reason the OSD should stay up, so "keep it visible while paused / while the
   * pointer is on the OSD / while dragging the scrub bar" needs no bookkeeping:
   * those states simply cancel the timeout.
   */
  useEffect(() => {
    if (!osdVisible || paused || osdHovered || dragging || failed) return
    const id = window.setTimeout(
      () => setOsdVisible(false),
      Math.max(1, osdHideAfterS) * 1000
    )
    return () => window.clearTimeout(id)
  }, [osdVisible, paused, osdHovered, dragging, failed, osdHideAfterS, activity])

  /** Banner: shown on tune-in and on every episode handoff, then fades. */
  useEffect(() => {
    if (episodeId == null) return
    setBannerFlash(true)
    setFailed(false)
    wantsPlayRef.current = true
    prewarmedAfterRef.current = null
    const id = window.setTimeout(() => setBannerFlash(false), BANNER_MS)
    return () => window.clearTimeout(id)
  }, [episodeId])

  // ---- prewarm and handoff ------------------------------------------------

  /**
   * T−30s: ask the store to commit the next pick and start its encoder. Keyed on
   * the *boolean* window rather than on `remainingS`, so this fires once per
   * episode instead of four times a second, and guarded by episode id so a seek
   * back into the window cannot ask twice.
   */
  useEffect(() => {
    if (!prewarmNext || !inUpNextWindow || failed) return
    // Nothing follows this episode, so committing a pick for it would spend a
    // schedule step we'd only have to release again at the boundary. The ref is
    // deliberately left unset: cancelling the timer re-runs this effect, and the
    // prewarm then fires late but still inside the window, so a change of mind
    // doesn't cost the gapless handoff.
    if (sleepPending) return
    if (episodeId == null || prewarmedAfterRef.current === episodeId) return
    prewarmedAfterRef.current = episodeId
    void prewarm()
  }, [prewarmNext, inUpNextWindow, failed, sleepPending, episodeId, prewarm])

  /** The countdown chip's clock. Runs only while something is counting down. */
  useEffect(() => {
    if (sleepUntil === null) return
    setNowMs(Date.now())
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [sleepUntil])

  /**
   * Expiry while paused.
   *
   * Waiting for the unit to finish assumes something is playing towards its end.
   * Paused, nothing is, and a viewer who paused and did not come back is the
   * exact case the timer is for — so this is the one path that stops mid-episode.
   *
   * It keys on `wantsPlayRef` rather than on `paused`, and that distinction is
   * load-bearing — `paused` is true during several moments that are not a viewer
   * pausing, both of which were caught only by running the real app:
   *
   * 1. **Chromium fires `pause` immediately before `ended`** (measured: same
   *    millisecond, with the element's `ended` already true). Keying on `paused`
   *    lost the race against `handleEnded` at the close of every episode, and an
   *    episode watched to the end was logged `completed: false` — a stop, not a
   *    watch, which is what a shuffle bag reads.
   * 2. **A promoted standby is paused for an instant.** So a timer that expired
   *    mid-arc stopped at the handoff into the next part — precisely the thing
   *    the unit boundary exists to prevent. A seek's reload has the same shape.
   *
   * `wantsPlayRef` is false only where a human asked for it: `togglePlay`. Every
   * transient pause above leaves it true, and so leaves the timer waiting for a
   * boundary, which is the whole contract.
   */
  useEffect(() => {
    if (!sleepExpired || !paused || failed) return
    if (wantsPlayRef.current) return
    void sleepNow()
  }, [sleepExpired, paused, failed, sleepNow])

  /** Mirror the store's pending pick into the standby surface, and drop it when it goes. */
  useEffect(() => {
    setStage((current) => {
      const slot = other(current.active)
      const clear = current[slot] === null ? current : writeSlot(current, slot, null)
      if (pendingNext === null) return clear

      /**
       * A channel whose lineup has exactly one playable unit picks the episode it
       * is already playing. There is nothing to prewarm — and worse, the standby
       * would request the same stream URL on the same channel, which is the same
       * encoder slot, and taking that slot would kill the stream on screen. The
       * handoff for this case is an ordinary reload, which costs tune-in latency
       * on a channel with one episode in it. Fine.
       */
      if (pendingNext.episode.id === current[current.active]?.episodeId) return clear

      if (current[slot]?.episodeId === pendingNext.episode.id) return current
      return writeSlot(current, slot, slotFor(pendingNext))
    })
  }, [pendingNext])

  /**
   * The swap itself. Runs when `stage.active` changes — i.e. after a promotion —
   * and is what turns a buffered standby into the picture: raise its pump to the
   * full read targets, re-assert volume (it was muted while hidden), and play.
   */
  useEffect(() => {
    const handle = stage.active === 'a' ? surfaceA.current : surfaceB.current
    const video = handle?.element
    if (!video) return
    handle.promote()
    // The standby was muted while hidden; it is the picture now.
    applyVolume(video)
    if (wantsPlayRef.current && video.paused) void video.play().catch(() => undefined)
    // Keyed on the swap alone: `applyVolume` changing is the volume effect's job,
    // and re-running this on it would fight the transport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.active])

  // ---- volume -------------------------------------------------------------

  /**
   * The store owns volume/mute (it persists them); the element on air is a
   * mirror of it. Applied here when the *store* changes, and again from
   * `loadedmetadata` when a fresh element arrives — an effect cannot cover that
   * second case, because a surface's element appears through a ref callback and
   * none of this effect's dependencies change when it does.
   */
  const applyVolume = useCallback(
    (video: HTMLVideoElement) => {
      video.volume = volume
      video.muted = muted
    },
    [volume, muted]
  )

  useEffect(() => {
    const video = activeVideo()
    if (video) applyVolume(video)
  }, [applyVolume, activeVideo, activeSlot?.source.key])

  // ---- transport ----------------------------------------------------------

  const togglePlay = useCallback(() => {
    const video = activeVideo()
    if (!video) return
    if (video.paused) {
      wantsPlayRef.current = true
      void video.play().catch(() => setFailed(true))
    } else {
      wantsPlayRef.current = false
      video.pause()
    }
  }, [activeVideo])

  /**
   * Perform the seek. `direct` files are real files behind range requests, so
   * `currentTime` works; everything else is a pipe and must be re-requested at
   * `?t=`, carrying the offset forward for display.
   */
  const performSeek = useCallback(
    (seconds: number) => {
      const video = activeVideo()
      if (!video || !nowPlaying) return
      const target = clamp(seconds, Math.max(0, totalS - 1))

      if (nowPlaying.episode.playbackPath === 'direct') {
        // Range requests: the browser can do this itself, and the offset for a
        // direct source is always 0, so the displayed position needs no fixup.
        setScrubPreview(null)
        setVideoTime(target)
        video.currentTime = target
        return
      }

      const base = nowPlaying.streamUrl
      const sep = base.includes('?') ? '&' : '?'
      const at = Math.floor(target)
      wantsPlayRef.current = true
      setVideoTime(0)
      setScrubPreview(null)
      setStage((current) =>
        writeSlot(current, current.active, slotFor(nowPlaying, at, `${base}${sep}t=${at}`))
      )
    },
    [activeVideo, nowPlaying, totalS]
  )

  const commitSeek = useCallback(
    (seconds: number) => {
      if (seekTimerRef.current !== null) window.clearTimeout(seekTimerRef.current)
      seekTimerRef.current = window.setTimeout(() => {
        seekTimerRef.current = null
        performSeek(seconds)
      }, SEEK_COMMIT_MS)
    },
    [performSeek]
  )

  useEffect(
    () => () => {
      if (seekTimerRef.current !== null) window.clearTimeout(seekTimerRef.current)
    },
    []
  )

  /**
   * `ended` can fire more than once around a source swap, and a leaned-on skip
   * key would queue several advances — the ref makes both one-shot until the
   * scheduler has answered.
   */
  const runAdvance = useCallback(
    (completed: boolean) => {
      if (advancingRef.current) return
      advancingRef.current = true
      void advance(completed).finally(() => {
        advancingRef.current = false
      })
    },
    [advance]
  )

  const skip = useCallback(() => runAdvance(false), [runAdvance])
  const handleEnded = useCallback(() => runAdvance(true), [runAdvance])

  /** Off → the default → each preset above it → off again. */
  const cycleSleep = useCallback(() => {
    if (sleepMinutes === null) return armSleep(sleepDefaultMin)
    armSleep(SLEEP_PRESETS.find((minutes) => minutes > sleepMinutes) ?? null)
  }, [sleepMinutes, sleepDefaultMin, armSleep])

  /** Re-open the active surface's stream from scratch, standby untouched. */
  const retry = useCallback(() => {
    setFailed(false)
    wantsPlayRef.current = true
    setStage((current) => ({
      ...current,
      generation: {
        ...current.generation,
        [current.active]: current.generation[current.active] + 1
      }
    }))
  }, [])

  // ---- fullscreen ---------------------------------------------------------

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    } else {
      // The stage, never a video — see the file header.
      void stageRef.current?.requestFullscreen().catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    const onChange = (): void => {
      const isFs = document.fullscreenElement != null
      setFullscreen(isFs)
      if (!isFs) leftFullscreenAtRef.current = Date.now()
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      // Leaving the player must not strand the window in fullscreen.
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    }
  }, [])

  // ---- keyboard map -------------------------------------------------------

  /**
   * Bound on `window` for the lifetime of the screen. Keystrokes are ignored
   * when a text field or one of our sliders has focus, so the scrub bar's own
   * ←/→ never doubles as "skip episode".
   */
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (
        target?.closest('input, textarea, select, [contenteditable="true"], [role="slider"]') !=
        null
      ) {
        reveal()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return

      reveal()

      switch (e.key) {
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowUp':
          e.preventDefault()
          setVolume(Math.min(1, volume + VOLUME_STEP))
          break
        case 'ArrowDown':
          e.preventDefault()
          setVolume(Math.max(0, volume - VOLUME_STEP))
          break
        case 'ArrowRight':
          e.preventDefault()
          skip()
          break
        case 'f':
        case 'F':
          e.preventDefault()
          toggleFullscreen()
          break
        case 'm':
        case 'M':
          e.preventDefault()
          toggleMute()
          break
        case 's':
        case 'S':
          e.preventDefault()
          cycleSleep()
          break
        case 'Escape':
          // Chromium swallows Esc to leave fullscreen, so by the time we see
          // one we are usually already out. Either way the first Esc only ever
          // exits fullscreen; the second one leaves the player.
          if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => undefined)
          } else if (Date.now() - leftFullscreenAtRef.current > 400) {
            void leavePlayer()
          }
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    reveal,
    togglePlay,
    skip,
    toggleFullscreen,
    toggleMute,
    cycleSleep,
    setVolume,
    leavePlayer,
    volume
  ])

  if (!nowPlaying) return null

  const { episode, arc, channelNumber } = nowPlaying
  const dial = String(channelNumber).padStart(2, '0')
  const episodeLine = [
    episode.code,
    (episode.title ?? episode.showTitle).toUpperCase(),
    arc ? `PART ${arc.partIndex} OF ${arc.partCount}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  const volumePct = Math.round((muted ? 0 : volume) * 100)

  /**
   * What the sleep chip says. Once the deadline has passed the countdown is
   * meaningless — what the viewer needs to know is *where* it will stop, which
   * mid-arc is the end of the arc rather than the end of this episode.
   */
  const sleepLabel = ((): string | null => {
    if (sleepUntil === null) return null
    if (!sleepExpired) return formatDuration((sleepUntil - nowMs) / 1000)
    if (endsUnit) return 'after this episode'
    return `after part ${arc?.partCount ?? '?'}`
  })()

  /**
   * Both surfaces are always mounted, so promoting one is a class change rather
   * than a mount — a mount would throw away the buffer the standby exists to
   * have built. The inactive one is `opacity: 0` rather than `display: none`, so
   * Chromium keeps its decoder warm.
   */
  const surface = (slot: SlotId): JSX.Element => {
    const isActive = stage.active === slot
    return (
      <VideoSurface
        key={slot}
        source={stage[slot]?.source ?? null}
        active={isActive}
        standby={!isActive}
        generation={stage.generation[slot]}
        handleRef={slot === 'a' ? surfaceA : surfaceB}
        className={`video${isActive ? ' is-active' : ''}`}
        onStreamError={() => setFailed(true)}
        onLoadStart={() => setVideoTime(0)}
        onLoadedMetadata={(video) => {
          applyVolume(video)
          if (wantsPlayRef.current) void video.play().catch(() => undefined)
        }}
        onLoadedData={() => setFailed(false)}
        onTimeUpdate={setVideoTime}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onEnded={handleEnded}
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <div
      ref={stageRef}
      className={`stage${chromeVisible ? '' : ' idle'}`}
      onMouseMove={reveal}
      onPointerDown={reveal}
    >
      {surface('a')}
      {surface('b')}

      <div className={`banner${showBanner ? '' : ' is-hidden'}`}>
        <span className="b-num">{dial}</span>
        <span>
          <span className="b-show">{episode.showTitle}</span>
          <br />
          <span className="b-ep">{episodeLine}</span>
        </span>
      </div>

      <span className={`onair${chromeVisible ? '' : ' is-hidden'}`}>
        <span className="live" />
        ON AIR
      </span>

      {showToast && upNext && (
        <div className="toast" role="status">
          Up next on CH {dial} · <b>{upNext.showTitle}</b> <code>{upNext.code}</code>
          {upNext.title ? ` “${upNext.title}”` : ''}
          {standbySlot !== null && <span className="toast-ready"> · ready</span>}
        </div>
      )}

      {failed && (
        <div className="player-error" role="alert">
          <div className="pe-title">Can&rsquo;t play this episode</div>
          <div className="pe-sub">
            {episode.showTitle} · {episode.code}
            {episode.title ? ` · ${episode.title}` : ''}
          </div>
          <div className="pe-hint">
            The stream stopped or never started. Retry, or skip to the next pick on this
            channel.
          </div>
          <div className="pe-actions">
            <button type="button" className="btn btn-tune" onClick={retry}>
              Retry
            </button>
            <button type="button" className="btn btn-ghost" onClick={skip}>
              Skip
            </button>
          </div>
        </div>
      )}

      <div
        className={`osd${chromeVisible ? '' : ' is-hidden'}`}
        onPointerEnter={() => setOsdHovered(true)}
        onPointerLeave={() => setOsdHovered(false)}
      >
        <Slider
          className="scrub"
          label="Seek"
          value={clamp(position, Math.max(totalS, 1))}
          max={Math.max(totalS, 1)}
          step={10}
          ariaValueText={`${formatDuration(position)} of ${formatDuration(totalS)}`}
          onPreview={setScrubPreview}
          onCommit={commitSeek}
          onDragChange={setDragging}
          knob
        />

        <div className="osd-row">
          <button
            type="button"
            className="osd-btn primary"
            aria-label={paused ? 'Play' : 'Pause'}
            onClick={togglePlay}
          >
            {paused ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
              </svg>
            )}
          </button>

          <button
            type="button"
            className="osd-btn"
            aria-label="Skip to next episode"
            onClick={skip}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 5l8 7-8 7V5zm10 0h2v14h-2z" />
            </svg>
          </button>

          <div className="vol">
            <button
              type="button"
              className="osd-btn"
              aria-label={muted ? 'Unmute' : 'Mute'}
              aria-pressed={muted}
              onClick={toggleMute}
            >
              {muted ? (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4.3 3L3 4.3 7.7 9H4v6h4l5 4v-6.7l3.2 3.2c-.5.4-1.1.7-1.7.9v2.1c1.2-.3 2.2-.8 3.1-1.5l2.1 2.1 1.3-1.3L4.3 3zM13 5L10.9 7.1 13 9.2V5zm3.5 7c0 .3 0 .5-.1.8l1.6 1.6c.3-.7.5-1.5.5-2.4 0-2.6-1.7-4.8-4-5.6v2.1c1.2.6 2 1.9 2 3.5z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a3.5 3.5 0 0 0-2-3.15v6.3a3.5 3.5 0 0 0 2-3.15z" />
                </svg>
              )}
            </button>
            <Slider
              className="vol-track"
              label="Volume"
              value={volumePct}
              max={100}
              step={5}
              ariaValueText={muted ? 'Muted' : `${volumePct}%`}
              onPreview={(v) => setVolume(v / 100)}
              onCommit={(v) => setVolume(v / 100)}
            />
          </div>

          <button
            type="button"
            className={`osd-btn sleep${sleepUntil !== null ? ' is-armed' : ''}`}
            aria-label={
              sleepUntil === null
                ? 'Set sleep timer'
                : sleepExpired
                  ? `Sleep timer finished — stopping ${sleepLabel}. Press to change`
                  : `Sleep timer: ${sleepLabel} left. Press to change`
            }
            aria-pressed={sleepUntil !== null}
            onClick={cycleSleep}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9zm0 2.2A5.2 5.2 0 0 0 18.8 12 7 7 0 0 1 12 18.8 6.8 6.8 0 0 1 12 5.2z" />
            </svg>
          </button>

          {sleepLabel !== null && (
            <span className={`sleep-chip${sleepExpired ? ' is-due' : ''}`} role="status">
              {sleepExpired ? 'Sleeps ' : ''}
              {sleepLabel}
            </span>
          )}

          <div className="kbd-hints" aria-hidden="true">
            <span>
              <kbd>Space</kbd>pause
            </span>
            <span>
              <kbd>→</kbd>skip
            </span>
            <span>
              <kbd>S</kbd>sleep
            </span>
            <span>
              <kbd>F</kbd>fullscreen
            </span>
            <span>
              <kbd>Esc</kbd>guide
            </span>
          </div>

          <span className="timecode">
            <b>{formatDuration(position)}</b> / {formatDuration(totalS)}
          </span>

          <button
            type="button"
            className="osd-btn"
            aria-label="Toggle fullscreen"
            aria-pressed={fullscreen}
            onClick={toggleFullscreen}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 5h5v2H7v3H5V5zm9 0h5v5h-2V7h-3V5zM5 14h2v3h3v2H5v-5zm12 0h2v5h-5v-2h3v-3z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
