/**
 * The app shell.
 *
 * There is no router: the store's `screen` field *is* the router, so navigation
 * is a plain state change and the back-stack question never comes up (this is a
 * lean-back TV app, not a website).
 *
 * Three responsibilities, and nothing else:
 *
 *  1. Kick off `init()` once, and hold a "tuning in" slate until `ready`.
 *  2. Give the Player the whole window — no app bar, no scroll container —
 *     while every other screen gets the shared chrome.
 *  3. Catch a screen's render error so a bad channel row can't turn the whole
 *     window white. The boundary is keyed by screen, so simply navigating
 *     elsewhere clears the crash.
 *
 * The one wrinkle is picture-in-picture. While the channel is floating in a PiP
 * window the viewer can go and browse, and the Player has to *stay mounted* —
 * unmounting it would drop the `<video>` elements the window is playing and kill
 * the ffmpeg pipes behind them. So the Player is rendered from a fixed slot in
 * the tree whichever screen is showing, and merely goes off-stage (`floating`)
 * when it is not the one being looked at. Keeping the slot fixed is what makes
 * React treat the navigation as a prop change rather than a remount; moving it,
 * or wrapping it conditionally, would restart every stream on the way to the
 * guide.
 */

import { Component, useEffect, useState } from 'react'
import type { CSSProperties, ErrorInfo, JSX, ReactNode } from 'react'
import AppBar from './components/AppBar.js'
import Blackout from './screens/Blackout.js'
import Guide from './screens/Guide.js'
import ChannelEditor from './screens/ChannelEditor.js'
import Library from './screens/Library.js'
import Player from './screens/Player.js'
import Settings from './screens/Settings.js'
import type { Screen } from './store.js'
import { useStore } from './store.js'

/**
 * `init()` subscribes to main-process push events, which must not happen twice.
 * React 19's StrictMode runs effects twice in development, so the guard lives at
 * module scope rather than in a ref.
 */
let initStarted = false

const centered: CSSProperties = {
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center'
}

const padded: CSSProperties = { padding: '48px 28px', overflowY: 'auto' }

const pre: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '12px',
  color: 'var(--danger)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  margin: '12px 0 18px'
}

const actions: CSSProperties = { display: 'flex', gap: '10px' }

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

interface BoundaryProps {
  children: ReactNode
}

interface BoundaryState {
  error: Error | null
}

class ScreenErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[rerun] screen crashed:', error, info.componentStack)
  }

  private retry = (): void => {
    this.setState({ error: null })
  }

  private backToGuide = (): void => {
    this.setState({ error: null })
    useStore.getState().navigate('guide')
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div style={padded}>
        <div className="empty">
          <b>This screen dropped out.</b>
          Something in the interface failed to render. Your library and channels are
          untouched — the rest of the app still works.
          <pre style={pre}>{error.message || String(error)}</pre>
          <div style={actions}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={this.retry}>
              Try again
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={this.backToGuide}>
              Back to the guide
            </button>
          </div>
        </div>
      </div>
    )
  }
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function screenFor(screen: Exclude<Screen, 'player' | 'blackout'>): JSX.Element {
  switch (screen) {
    case 'channels':
      return <ChannelEditor />
    case 'library':
      return <Library />
    case 'settings':
      return <Settings />
    case 'guide':
    default:
      return <Guide />
  }
}

export default function App(): JSX.Element {
  const ready = useStore((s) => s.ready)
  const screen = useStore((s) => s.screen)
  const pipActive = useStore((s) => s.pipActive)
  const [bootError, setBootError] = useState<Error | null>(null)

  useEffect(() => {
    if (initStarted) return
    initStarted = true
    useStore
      .getState()
      .init()
      .catch((err: unknown) => {
        console.error('[rerun] init failed:', err)
        setBootError(err instanceof Error ? err : new Error(String(err)))
      })
  }, [])

  if (bootError) {
    return (
      <div className="app-shell" style={padded}>
        <div className="empty">
          <b>Rerun TV couldn&rsquo;t start.</b>
          The renderer reached the main process but something went wrong while loading
          your library. Restarting the app usually clears it.
          <pre style={pre}>{bootError.message}</pre>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="app-shell" style={centered} aria-busy="true">
        <div>
          <div className="wordmark" style={{ fontSize: '26px' }}>
            RERUN <span>TV</span>
          </div>
          <p className="caption" style={{ marginTop: '10px' }}>
            Tuning in&hellip;
          </p>
        </div>
      </div>
    )
  }

  // The blackout takes the window for the opposite reason a player does: an app
  // bar is a light source, and this screen exists to emit nothing. It is checked
  // first because it outranks a floating window — the sleep timer wins.
  if (screen === 'blackout') {
    return (
      <ScreenErrorBoundary key="blackout">
        <Blackout />
      </ScreenErrorBoundary>
    )
  }

  const watching = screen === 'player'
  // Mounted but off-stage: the channel plays on in a PiP window while the viewer
  // browses. See the file header for why this slot must not move.
  const keepPlayerAlive = pipActive && !watching

  return (
    <>
      {(watching || keepPlayerAlive) && (
        <ScreenErrorBoundary key="player">
          <Player floating={!watching} />
        </ScreenErrorBoundary>
      )}
      {/*
        The Player owns the entire window when it is the screen: full-bleed
        video, no chrome around it, so fullscreen handoffs never have to escape a
        layout wrapper.
      */}
      {!watching && (
        <div className="app-shell">
          <AppBar />
          <main className="app-scroll">
            <ScreenErrorBoundary key={screen}>{screenFor(screen)}</ScreenErrorBoundary>
          </main>
        </div>
      )}
    </>
  )
}
