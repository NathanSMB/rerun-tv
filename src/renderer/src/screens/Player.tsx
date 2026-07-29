/**
 * Screen 02 — the Player (plan §7).
 *
 * Full-bleed video with an OSD layer that rises on mouse move or key press and
 * fades after `settings.osdHideAfterS` seconds of idle.
 *
 * Two decisions in here are load-bearing and non-obvious:
 *
 * 1. **Fullscreen is requested on the stage wrapper, never on the `<video>`.**
 *    The wrapper holds both the video and the OSD, so an episode handoff — which
 *    is just a `src` swap on the video inside it — cannot take the fullscreen
 *    element away with it. Requesting fullscreen on the video itself would drop
 *    out of fullscreen on every auto-advance, and would also hide our OSD behind
 *    Chromium's native controls.
 *
 * 2. **Seeking is done by loading a new URL, not by setting `currentTime`.**
 *    The remux and transcode paths (plan §6) are open-ended ffmpeg pipes with no
 *    byte ranges and no known length, so the browser cannot seek them. The
 *    stream server's contract is `/stream/<id>?t=<seconds>`: it restarts ffmpeg
 *    at `-ss`. Because the fresh stream then reports `currentTime` from zero, we
 *    keep the requested position in `seekOffset` and render
 *    `seekOffset + video.currentTime` everywhere a position is shown. Only the
 *    `direct` path — a real file served with range requests — seeks natively.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, KeyboardEvent, PointerEvent } from 'react'
import { formatDuration } from '@shared/playback.js'
import { useStore } from '../store.js'
import './Player.css'

/** Seconds of remaining runtime that trigger the "up next" toast (plan §6). */
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
// Player
// ---------------------------------------------------------------------------

export default function Player(): JSX.Element | null {
  const nowPlaying = useStore((s) => s.nowPlaying)
  const upNext = useStore((s) => s.upNext)
  const volume = useStore((s) => s.volume)
  const muted = useStore((s) => s.muted)
  const osdHideAfterS = useStore((s) => s.settings.osdHideAfterS)
  const prewarmNext = useStore((s) => s.settings.prewarmNext)
  const advance = useStore((s) => s.advance)
  const leavePlayer = useStore((s) => s.leavePlayer)
  const setVolume = useStore((s) => s.setVolume)
  const toggleMute = useStore((s) => s.toggleMute)

  const stageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const episodeId = nowPlaying?.episode.id ?? null
  const streamUrl = nowPlaying?.streamUrl ?? ''
  const totalS = nowPlaying?.episode.durationS ?? 0

  /**
   * The source actually rendered, plus the offset it was started at. Both are
   * replaced atomically by a seek, and reset together whenever the episode
   * changes — an offset left over from the previous episode would poison every
   * timecode on screen.
   */
  const [source, setSource] = useState({ episodeId, url: streamUrl, offset: 0 })
  if (source.episodeId !== episodeId) {
    // Adjusting state during render (rather than in an effect) so the `<video>`
    // never commits one frame still pointing at the previous episode's stream.
    setSource({ episodeId, url: streamUrl, offset: 0 })
  }

  const [videoTime, setVideoTime] = useState(0)
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

  const lastActivityRef = useRef(0)
  const advancingRef = useRef(false)
  const seekTimerRef = useRef<number | null>(null)
  /** Set while a load is in flight so a URL-seek resumes playback on its own. */
  const wantsPlayRef = useRef(true)
  /** Timestamp of the last browser-initiated fullscreen exit — see the Esc map. */
  const leftFullscreenAtRef = useRef(0)

  const position = scrubPreview ?? source.offset + videoTime
  const remainingS = totalS - position
  const chromeVisible = osdVisible || failed
  const showBanner = bannerFlash || chromeVisible
  const showToast =
    prewarmNext && upNext != null && !failed && remainingS <= UP_NEXT_WINDOW_S && remainingS > 0

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
    const id = window.setTimeout(() => setBannerFlash(false), BANNER_MS)
    return () => window.clearTimeout(id)
  }, [episodeId])

  // ---- volume -------------------------------------------------------------

  /**
   * The store owns volume/mute (it persists them); the media element is a
   * mirror of it, re-applied after every source swap because a fresh load
   * resets nothing but is cheap to re-assert.
   */
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volume
    video.muted = muted
  }, [volume, muted, source.url])

  // ---- transport ----------------------------------------------------------

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      wantsPlayRef.current = true
      void video.play().catch(() => setFailed(true))
    } else {
      wantsPlayRef.current = false
      video.pause()
    }
  }, [])

  /**
   * Perform the seek. `direct` files are real files behind range requests, so
   * `currentTime` works; everything else is a pipe and must be re-requested at
   * `?t=`, carrying the offset forward for display.
   */
  const performSeek = useCallback(
    (seconds: number) => {
      const video = videoRef.current
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
      wantsPlayRef.current = true
      setVideoTime(0)
      setScrubPreview(null)
      setSource({
        episodeId: nowPlaying.episode.id,
        url: `${base}${sep}t=${Math.floor(target)}`,
        offset: Math.floor(target)
      })
    },
    [nowPlaying, totalS]
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

  const retry = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    setFailed(false)
    wantsPlayRef.current = true
    video.load()
  }, [])

  // ---- fullscreen ---------------------------------------------------------

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    } else {
      // The stage, never the video — see the file header.
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
  }, [reveal, togglePlay, skip, toggleFullscreen, toggleMute, setVolume, leavePlayer, volume])

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

  return (
    <div
      ref={stageRef}
      className={`stage${chromeVisible ? '' : ' idle'}`}
      onMouseMove={reveal}
      onPointerDown={reveal}
    >
      <video
        ref={videoRef}
        className="video"
        src={source.url}
        autoPlay
        playsInline
        preload="auto"
        onLoadStart={() => setVideoTime(0)}
        onLoadedMetadata={() => {
          const video = videoRef.current
          if (video && wantsPlayRef.current) void video.play().catch(() => undefined)
        }}
        onLoadedData={() => setFailed(false)}
        onTimeUpdate={(e) => setVideoTime(e.currentTarget.currentTime)}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onEnded={handleEnded}
        onError={() => setFailed(true)}
      />

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

          <div className="kbd-hints" aria-hidden="true">
            <span>
              <kbd>Space</kbd>pause
            </span>
            <span>
              <kbd>→</kbd>skip
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
