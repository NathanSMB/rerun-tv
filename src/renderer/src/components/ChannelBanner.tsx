/**
 * The channel banner — the recurring signature of the whole app.
 *
 * It shows up in the guide's preview panel, on tune-in, and on every episode
 * handoff. The layout is fixed by the mockup: an amber display-face dial number,
 * the show title in the body face, and one amber-mono line that is "the
 * broadcast talking" — `S04E11 · DATA'S DAY · 44 MIN`.
 *
 * Every segment of that mono line is optional: pass only what you know and the
 * separators collapse. That is why the Player can render a banner during a
 * handoff before the next episode's title is resolved without it looking broken.
 *
 * All classes (`.banner`, `.b-num`, `.b-show`, `.b-ep`) already exist in
 * `styles/global.css`; positioning is the caller's job via `className`.
 */

import type { JSX } from 'react'

export interface ChannelBannerProps {
  /** Dial number, rendered zero-padded to two digits. */
  number: number
  showTitle: string
  /** `S04E11`, or `S01E03-E04` for a double. */
  code: string
  /**
   * The episode's own title. Uppercased into the mono line, as in the mockup's
   * `S04E11 · DATA'S DAY · 44 MIN`. Optional: omit it and the segment vanishes.
   */
  episodeTitle?: string | null
  /** Runtime in seconds; rendered as rounded minutes. */
  durationS?: number
  className?: string
}

export default function ChannelBanner({
  number,
  showTitle,
  code,
  episodeTitle,
  durationS,
  className
}: ChannelBannerProps): JSX.Element {
  const segments: string[] = []
  if (code) segments.push(code)
  if (episodeTitle) segments.push(episodeTitle.toUpperCase())
  if (durationS && durationS > 0) segments.push(`${Math.max(1, Math.round(durationS / 60))} MIN`)

  return (
    <div className={className ? `banner ${className}` : 'banner'}>
      <span className="b-num">{String(number).padStart(2, '0')}</span>
      <span>
        <span className="b-show">{showTitle}</span>
        {segments.length > 0 && (
          <>
            <br />
            <span className="b-ep">{segments.join(' · ')}</span>
          </>
        )}
      </span>
    </div>
  )
}
