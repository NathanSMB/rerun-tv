/**
 * The dial number, as it appears on a guide row.
 *
 * A tiny mono `CH` label sitting on top of a big display-face, zero-padded
 * number — the mockup's `.ch-num`. It is deliberately dumb: the Channel Editor
 * reuses it at a larger size by passing a class, and the selected guide row
 * turns the `CH` label amber purely through CSS (`.ch-row.sel .ch-num small`).
 *
 * The styles live in `screens/Guide.css`, which the app always loads, because
 * that is where the mockup groups them.
 */

import type { JSX } from 'react'

export interface ChannelNumberProps {
  /** The dial number. Padded to two digits; wider numbers are left alone. */
  number: number
  className?: string
}

export default function ChannelNumber({ number, className }: ChannelNumberProps): JSX.Element {
  return (
    <div className={className ? `ch-num ${className}` : 'ch-num'}>
      <small>CH</small>
      {String(number).padStart(2, '0')}
    </div>
  )
}
