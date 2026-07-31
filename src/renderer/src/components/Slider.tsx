/**
 * The one slider widget in the app.
 *
 * Three things ride on it — the scrub bar, the volume track and the sleep dial —
 * and they are deliberately the same control, because they share the one
 * property that makes a slider hard: **preview and commit are separate events**.
 * The scrub bar's commit restarts an ffmpeg process and the sleep dial's moves a
 * deadline, so the fill must follow the finger at 60fps while the expensive part
 * happens once, on release.
 *
 * It lives here rather than in the Player because it carries no styling of its
 * own: the caller passes the class, and the track, `.fill` and `.knob` are
 * dressed by whichever stylesheet owns that class.
 */

import { useEffect, useRef } from 'react'
import type { JSX, KeyboardEvent, PointerEvent, ReactNode } from 'react'

const clamp = (value: number, max: number): number => Math.min(max, Math.max(0, value))

export interface SliderProps {
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
  /** The scrub bar and the sleep dial carry a knob; the volume track doesn't. */
  knob?: boolean
  /** Larger jump for PageUp/PageDown. Defaults to five steps. */
  pageStep?: number
  /**
   * What ↑/↓ move by, when that should differ from ←/→. The sleep dial wants a
   * coarse vertical (±30 min) against a fine horizontal (±5); everything else
   * treats the two axes as the same control and leaves this unset.
   */
  verticalStep?: number
  /**
   * Take focus on mount, so a panel that opens around a slider is arrow-operable
   * without a tab press. Only the sleep dial uses it — the OSD's sliders must
   * not steal focus from the video every time the chrome reveals.
   */
  takeFocus?: boolean
  /** Rendered inside the track, under the fill — the sleep dial's tick marks. */
  children?: ReactNode
}

/**
 * A real `role="slider"` widget: focusable, arrow-key operable, and draggable
 * with pointer capture so the drag survives the pointer leaving the 4px track.
 */
export default function Slider({
  className,
  label,
  value,
  max,
  step,
  ariaValueText,
  onPreview,
  onCommit,
  onDragChange,
  knob = false,
  pageStep,
  verticalStep,
  takeFocus = false,
  children
}: SliderProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  useEffect(() => {
    if (takeFocus) trackRef.current?.focus({ preventScroll: true })
  }, [takeFocus])

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
    const big = pageStep ?? step * 5
    const vertical = verticalStep ?? step
    let next: number
    switch (e.key) {
      case 'ArrowLeft':
        next = value - step
        break
      case 'ArrowRight':
        next = value + step
        break
      case 'ArrowDown':
        next = value - vertical
        break
      case 'ArrowUp':
        next = value + vertical
        break
      case 'PageDown':
        next = value - big
        break
      case 'PageUp':
        next = value + big
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
      {children}
      <div className="fill" style={{ right: `${100 - pct}%` }} />
      {knob && <div className="knob" style={{ left: `${pct}%` }} aria-hidden="true" />}
    </div>
  )
}
