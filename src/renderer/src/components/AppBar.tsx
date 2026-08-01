/**
 * The app bar: wordmark, screen navigation, and the live scan pill.
 *
 * Present on every screen except the Player, which is deliberately full-bleed.
 * The bar itself is a drag region for the frameless window (see `.appbar` in
 * `global.css`); its buttons opt back out, so clicks still land.
 *
 * The scan pill is the app's only ambient status surface. It answers "is the
 * library alright?" without the user going looking, and clicking it jumps to
 * the Library screen where the answer can actually be acted on — matching the
 * mockup's note. Priority of what it reports, most urgent first: scan error,
 * scan running, scan paused, no library at all, unmatched files waiting, all
 * clear.
 */

import type { JSX } from 'react'
import type { Screen } from '../store.js'
import { useStore } from '../store.js'
import headerIcon from '../assets/header-icon.png'

const NAV: ReadonlyArray<{ screen: Screen; label: string }> = [
  { screen: 'guide', label: 'Guide' },
  { screen: 'library', label: 'Library' },
  { screen: 'settings', label: 'Settings' }
]

interface Pill {
  text: string
  /** `warn` paints the dot amber; `ok` leaves it signal-green. */
  tone: 'ok' | 'warn'
  /** Whether to render the status dot at all. */
  dot: boolean
}

const n = (value: number): string => value.toLocaleString()

export default function AppBar(): JSX.Element {
  const screen = useStore((s) => s.screen)
  const scan = useStore((s) => s.scan)
  const library = useStore((s) => s.library)
  const navigate = useStore((s) => s.navigate)

  const totalEpisodes = library?.totalEpisodes ?? 0
  const unmatched = library?.unmatched.length ?? 0

  let pill: Pill
  if (scan.error) {
    pill = { text: 'SCAN FAILED · OPEN LIBRARY', tone: 'warn', dot: true }
  } else if (scan.state === 'scanning') {
    pill = { text: `SCANNING · ${n(scan.done)} / ${n(scan.total)}`, tone: 'ok', dot: true }
  } else if (scan.state === 'paused') {
    pill = { text: `SCAN PAUSED · ${n(scan.done)} / ${n(scan.total)}`, tone: 'warn', dot: true }
  } else if (totalEpisodes === 0) {
    pill = { text: 'NO LIBRARY · ADD A FOLDER', tone: 'warn', dot: false }
  } else if (unmatched > 0) {
    pill = {
      text: `${n(unmatched)} UNMATCHED · ${n(totalEpisodes)} EPISODES`,
      tone: 'warn',
      dot: true
    }
  } else {
    pill = { text: `LIBRARY OK · ${n(totalEpisodes)} EPISODES`, tone: 'ok', dot: true }
  }

  return (
    <header className="appbar">
      <span className="wordmark">
        <img className="wordmark-icon" src={headerIcon} alt="" aria-hidden="true" />
        RERUN <span>TV</span>
      </span>

      <nav className="appnav" aria-label="Screens">
        {NAV.map((item) => (
          <button
            key={item.screen}
            type="button"
            className={screen === item.screen ? 'on' : undefined}
            aria-current={screen === item.screen ? 'page' : undefined}
            onClick={() => navigate(item.screen)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <button
        type="button"
        className="scanpill"
        title="Open the Library"
        onClick={() => navigate('library')}
      >
        {pill.dot && <span className={pill.tone === 'warn' ? 'live warn' : 'live'} aria-hidden="true" />}
        <span aria-live="polite">{pill.text}</span>
      </button>
    </header>
  )
}
