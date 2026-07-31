/**
 * The renderer harness: the real `<Player/>`, mounted, with two seams scripted.
 *
 * The layer this exists for is the one `npm test` could not see — *which* store
 * action the Player's effects decide to call (`advance(true)`, `sleepNow()`,
 * `prewarm()`) in response to media-element events. `handoff.test.ts` starts
 * where that decision ends: it calls those actions directly, against the real
 * scheduler. Two bugs lived in the gap and shipped past a green suite
 * (docs/playback.md § "Two things Chromium does around `ended`").
 *
 * Two things are scripted; everything between them is production code:
 *
 * 1. **The media elements.** happy-dom supplies DOM globals so `react-dom` can
 *    mount the real component, but its `<video>` is an inert stub — so `paused`,
 *    `ended`, `play()` and `pause()` are replaced below with the orderings
 *    measured in the real app. `VideoSurface` itself is *not* mocked: the rule
 *    that events are forwarded only while a surface is active is half of what
 *    the decision reads, and a fake would have to restate it. It takes its
 *    plain-`src` branch here (happy-dom has no `MediaSource`); the pump that
 *    branch skips is DOM-free and pinned by `mse.test.ts`.
 * 2. **The preload bridge** (`fixtures.tsx`), at the same `RerunApi` seam
 *    `handoff.test.ts` fakes.
 *
 * Tests never hand-fire raw events. They speak the vocabulary this module
 * exports, so the ordering Chromium was measured to produce lives in exactly one
 * place. If Chromium turns out to do something new, measure it live with
 * `scripts/soak.mjs --eval`, record it in `docs/playback.md`, then teach it here.
 */

import { act } from 'react'
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { RerunApi } from '@shared/ipc.js'
import type { AppSettings, NowPlaying } from '@shared/types.js'
import { DEFAULT_SETTINGS } from '@shared/types.js'
import Player from '../../src/renderer/src/screens/Player.js'
import { useStore } from '../../src/renderer/src/store.js'
import { CHANNEL_ID, scriptedBridge, type BridgeCall } from './fixtures.js'

declare global {
  /** React's `act` refuses to run without this, and it is set per environment. */
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

/**
 * The pristine store actions, captured before anything wraps them, so a test
 * that instruments the store cannot leave a wrapper around a wrapper for the
 * next one.
 */
const REAL = useStore.getState()

/** How many quiet passes `settle` runs before it declares the world at rest. */
const SETTLE_PASSES = 8

const macrotask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

// ---------------------------------------------------------------------------
// The measured media model
// ---------------------------------------------------------------------------

interface MediaState {
  paused: boolean
  ended: boolean
  /** Resolvers for `play()` calls the harness has not let take effect yet. */
  pending: Array<() => void>
  /** The `src` this element has already reported as loaded. */
  loaded: string | null
}

const media = new WeakMap<HTMLMediaElement, MediaState>()

function mediaState(el: HTMLMediaElement): MediaState {
  let state = media.get(el)
  if (!state) {
    state = { paused: true, ended: false, pending: [], loaded: null }
    media.set(el, state)
  }
  return state
}

let installed = false

/**
 * Replace happy-dom's inert media element with the model measured in Chromium.
 *
 * The handoff that motivated this harness warns about exactly this: a fake that
 * fires `ended` without a preceding `pause` would happily pass the broken code.
 * So the two properties the Player reads — `paused` and `ended` — are backed by
 * state the *scenario vocabulary* drives, never by anything happy-dom decides.
 */
function installMediaModel(): void {
  if (installed) return
  installed = true
  const proto = HTMLMediaElement.prototype

  Object.defineProperty(proto, 'paused', {
    configurable: true,
    get(this: HTMLMediaElement): boolean {
      return mediaState(this).paused
    }
  })

  Object.defineProperty(proto, 'ended', {
    configurable: true,
    get(this: HTMLMediaElement): boolean {
      return mediaState(this).ended
    }
  })

  /**
   * `play()` resolves on a later task and only fires `play` when it does. That
   * delay is not incidental: it is what leaves a promoted standby paused across
   * at least one effect pass, which is the window bug 2 lived in.
   */
  proto.play = function (this: HTMLMediaElement): Promise<void> {
    return new Promise<void>((resolve) => {
      mediaState(this).pending.push(resolve)
    })
  }

  /** Synchronous, as Chromium's is: the flag flips and `pause` fires with it. */
  proto.pause = function (this: HTMLMediaElement): void {
    const state = mediaState(this)
    if (state.paused) return
    state.paused = true
    this.dispatchEvent(new Event('pause'))
  }

  /** `VideoSurface.detach()` calls this; resetting the element is what it means. */
  proto.load = function (this: HTMLMediaElement): void {
    mediaState(this).loaded = null
  }
}

/** Both surfaces, in DOM order: slot `a`, then slot `b`. */
function videos(): HTMLVideoElement[] {
  return Array.from(document.querySelectorAll('video'))
}

/**
 * A stream that has opened: fresh timestamps, paused at zero, and the load
 * events that follow. `VideoSurface` forwards only the active surface's, which
 * is how a standby buffers without touching the OSD.
 */
function openStreams(): void {
  for (const el of videos()) {
    const state = mediaState(el)
    const src = el.getAttribute('src')
    if (src === null || src === state.loaded) continue
    state.loaded = src
    state.paused = true
    state.ended = false
    // A `play()` issued against the stream we just replaced never fires `play`.
    for (const resolve of state.pending.splice(0)) resolve()
    el.currentTime = 0
    el.dispatchEvent(new Event('loadstart'))
    el.dispatchEvent(new Event('loadedmetadata'))
    el.dispatchEvent(new Event('loadeddata'))
  }
}

/** Let outstanding `play()` calls take effect — a task after they were asked for. */
function letPlaysTake(): void {
  for (const el of videos()) {
    const state = mediaState(el)
    if (state.pending.length === 0) continue
    const waiting = state.pending.splice(0)
    if (state.paused) {
      state.paused = false
      state.ended = false
      el.dispatchEvent(new Event('play'))
    }
    for (const resolve of waiting) resolve()
  }
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/**
 * The screen switch, as `App.tsx` makes it: the Player owns the window while
 * `screen === 'player'` and is unmounted the moment it doesn't — which is what
 * a blackout looks like from in here. The other screens are not this layer's
 * business, so they are not mounted.
 */
function Shell(): JSX.Element | null {
  const screen = useStore((s) => s.screen)
  return screen === 'player' ? <Player /> : null
}

type StoreState = ReturnType<typeof useStore.getState>

export interface Scenario {
  /** Every bridge call the store made, in order. */
  readonly calls: BridgeCall[]
  /**
   * Which store action the Player's effects chose, in order — the whole point
   * of this layer.
   *
   * The bridge log cannot answer this on its own. `prewarm()` carries its own
   * authoritative sleep guard and returns *before* it reaches the bridge, so a
   * Player that asked for a prewarm it should not have would leave no trace
   * there at all. These wrappers run the real action underneath.
   */
  readonly actions: string[]
  state(): StoreState
  /** Run everything in flight to a standstill: loads, plays, store transitions. */
  settle(): Promise<void>
  /** The surface on air. Throws once the Player has left the screen. */
  activeVideo(): HTMLVideoElement

  // ---- the scenario vocabulary ----
  /** The countdown reaching its deadline, right now. */
  expireSleep(minutes?: number): Promise<void>
  /** Arm or (with null) cancel the timer, the way the OSD button does. */
  armSleep(minutes: number | null): Promise<void>
  /** T−30s: reserve the next pick into the standby surface. */
  prewarm(): Promise<void>
  /** A human asking to pause — the OSD button, the only thing that means it. */
  viewerPause(): Promise<void>
  viewerPlay(): Promise<void>
  /** Move the playhead: how a test enters the up-next window. */
  at(seconds: number): Promise<void>
  /** The `pause` Chromium fires immediately before `ended`. */
  pauseForEnd(): Promise<void>
  /** The `ended` that follows it, stopping *inside* the promotion window. */
  ended(): Promise<void>
  /** Both of the above, then settle: an episode running out. */
  endEpisode(): Promise<void>
  unmount(): Promise<void>
}

/**
 * Mount the Player against `deck` and tune in, leaving the first episode on air.
 *
 * Every scenario starts here, and the store is reset per call the same way
 * `handoff.test.ts` resets it: module-level state in the store is the one thing
 * that can bleed between tests.
 */
export async function openPlayer(
  deck: NowPlaying[],
  settings: Partial<AppSettings> = {}
): Promise<Scenario> {
  installMediaModel()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const bridge = scriptedBridge(deck)
  ;(globalThis as { rerun?: RerunApi }).rerun = bridge.api

  const actions: string[] = []
  useStore.setState({
    screen: 'guide',
    nowPlaying: null,
    upNext: null,
    pendingNext: null,
    sleepUntil: null,
    sleepMinutes: null,
    channels: [],
    volume: DEFAULT_SETTINGS.volume,
    muted: DEFAULT_SETTINGS.muted,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    advance: async (completed) => {
      actions.push(`advance(${completed})`)
      await REAL.advance(completed)
    },
    prewarm: async () => {
      actions.push('prewarm')
      await REAL.prewarm()
    },
    sleepNow: async () => {
      actions.push('sleepNow')
      await REAL.sleepNow()
    },
    leavePlayer: async () => {
      actions.push('leavePlayer')
      await REAL.leavePlayer()
    }
  })

  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)

  await act(async () => {
    root.render(<Shell />)
  })

  const settle = async (): Promise<void> => {
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      await act(async () => {
        // Plays first: a `play()` asked for during this pass must not also be
        // granted in it, or the transient-pause window would never be open.
        letPlaysTake()
        openStreams()
        await macrotask()
      })
    }
  }

  const activeVideo = (): HTMLVideoElement => {
    const el = videos().find((video) => video.classList.contains('is-active'))
    if (!el) throw new Error('no active video surface is mounted')
    return el
  }

  const button = (label: string): HTMLElement => {
    const el = document.querySelector<HTMLElement>(`button[aria-label="${label}"]`)
    if (!el) throw new Error(`no button labelled "${label}" is on screen`)
    return el
  }

  const click = async (label: string): Promise<void> => {
    const el = button(label)
    await act(async () => {
      el.click()
      await macrotask()
    })
    await settle()
  }

  /**
   * Measured in the real app: `pause` fires immediately before `ended`, same
   * millisecond, with the element's `ended` **already true**
   * (docs/playback.md § "Two things Chromium does around `ended`"). Chromium
   * queues the two as separate tasks, so React flushes effects in between —
   * and that gap is where bug 1 lived. Hence its own `act`.
   */
  const pauseForEndOn = async (el: HTMLVideoElement): Promise<void> => {
    await act(async () => {
      const state = mediaState(el)
      state.ended = true
      state.paused = true
      el.dispatchEvent(new Event('pause'))
      await macrotask()
    })
  }

  /**
   * The `ended` event, and the store transition it starts — but *not* the
   * `play()` that follows a promotion. Stopping here leaves the stage in the
   * handoff window: the newly active element on screen, paused, `ended` false.
   */
  const endedOn = async (el: HTMLVideoElement): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new Event('ended'))
      await macrotask()
    })
    for (let pass = 0; pass < 3; pass++) {
      await act(async () => {
        await macrotask()
      })
    }
  }

  /**
   * Both, on the element that was on air when the episode started running out.
   * Resolving it once matters: a Player that mistakenly tears the screen down on
   * the `pause` still gets its `ended` — Chromium fires it either way — so the
   * failure reads as the wrong decision rather than as a missing surface.
   */
  const endEpisode = async (): Promise<void> => {
    const el = activeVideo()
    await pauseForEndOn(el)
    await endedOn(el)
    await settle()
  }

  await act(async () => {
    await useStore.getState().tune(CHANNEL_ID)
  })
  await settle()

  return {
    calls: bridge.calls,
    actions,
    state: () => useStore.getState(),
    settle,
    activeVideo,

    /**
     * Expiry is a `Date.now()` comparison against `sleepUntil` (store.ts), so a
     * deadline already in the past *is* the crossing — no fake timers needed.
     * The Player repaints `nowMs` the moment `sleepUntil` changes, which is the
     * same one-second tick that crosses the deadline in the real app.
     */
    expireSleep: async (minutes = 30) => {
      await act(async () => {
        useStore.setState({ sleepUntil: Date.now() - 1000, sleepMinutes: minutes })
        await macrotask()
      })
    },

    armSleep: async (minutes) => {
      await act(async () => {
        useStore.getState().armSleep(minutes)
        await macrotask()
      })
      await settle()
    },

    // The real action, not the instrumented one: `actions` records what the
    // *Player* chose, and a prewarm the harness asked for is not that.
    prewarm: async () => {
      await act(async () => {
        await REAL.prewarm()
      })
      await settle()
    },

    viewerPause: () => click('Pause'),
    viewerPlay: () => click('Play'),

    at: async (seconds) => {
      const el = activeVideo()
      await act(async () => {
        el.currentTime = seconds
        el.dispatchEvent(new Event('timeupdate'))
        await macrotask()
      })
      await settle()
    },

    pauseForEnd: () => pauseForEndOn(activeVideo()),
    ended: () => endedOn(activeVideo()),
    endEpisode,

    // Unmounting is what clears the banner timeout and the countdown interval:
    // both are owned by effects, so nothing else has to know about them.
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }
}
