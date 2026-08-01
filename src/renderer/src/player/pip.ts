/**
 * Picture-in-picture — the session controller (docs/pip-plan.html §5).
 *
 * ## Why this module exists
 *
 * PiP is a property of one `<video>` element, and this player deliberately has
 * two of them (`Player.tsx`): the surface on air and a standby buffering the next
 * episode. A handoff is a *swap* between them, so a floating window that is
 * pinned to an element would close at every episode boundary — the same failure
 * `requestFullscreen()` on the stage wrapper exists to avoid, arriving in the one
 * place where there is no wrapper to target.
 *
 * The fix is to move the session with the swap, and that is only possible because
 * of a fact measured against this Electron build rather than assumed:
 *
 * > **While a PiP session exists, another element may take it over without user
 * > activation.** A *fresh* entry needs a gesture and throws `NotAllowedError`
 * > without one.
 *
 * Which yields the invariant this whole machine is built to keep:
 * **never exit before requesting.** Exiting first ends the session, and with no
 * live session the gesture-free window is gone — the picture could not come back
 * until the viewer pressed something.
 *
 * ## The sharp edge
 *
 * A transfer fires `leavepictureinpicture` **on the old element**. Measured
 * ordering: `enterpictureinpicture:a`, `leavepictureinpicture:a`,
 * `enterpictureinpicture:b`. Read naively that middle event is indistinguishable
 * from the viewer closing the floating window, and reading it that way would haul
 * the picture back inline in the middle of every gapless handoff.
 *
 * So the machine has a `requesting` phase that knows a request is in flight and
 * which slot is *holding* the session while it is: a `left` arriving there is the
 * artifact, and it is swallowed. This is the same shape as `wantsPlayRef` in
 * `Player.tsx` distinguishing a human pause from Chromium pausing an element —
 * the event alone does not carry intent, so the state around it has to.
 *
 * ## Why it is DOM-free
 *
 * Same reason as `mse.ts`: none of the above can be tested in jsdom or happy-dom,
 * which have no PiP APIs at all. Everything here is events in, commands out, so
 * `tests/pip.test.ts` can drive every ordering — including the ones that only
 * happen when a request and a swap race — in Node. The four commands are executed
 * in `Player.tsx`, which is the only place that touches
 * `requestPictureInPicture()`, and is covered by the renderer harness.
 */

/**
 * Which surface, as the Player numbers them. Opaque on purpose: this module has
 * no opinion about how many surfaces there are or what they are called.
 */
export type PipSlot = string

export type PipEvent =
  /** The OSD button or <kbd>P</kbd>, carrying the surface on air right now. */
  | { type: 'toggle'; slot: PipSlot }
  /** A handoff promoted `slot`. The session has to follow it. */
  | { type: 'swapped'; slot: PipSlot }
  /** `requestPictureInPicture()` resolved. */
  | { type: 'entered'; slot: PipSlot }
  /** `requestPictureInPicture()` rejected — no gesture, or the element is gone. */
  | { type: 'failed' }
  /** A `leavepictureinpicture` event. May be a transfer artifact; see the header. */
  | { type: 'left'; slot: PipSlot }
  /** The player is going away: unmounted, blacked out, or the stream died. */
  | { type: 'teardown' }

export type PipCommand =
  /** Open a session. Only legal inside a user gesture. */
  | { type: 'enter'; slot: PipSlot }
  /** Move the existing session to another element. Needs no gesture. */
  | { type: 'transfer'; slot: PipSlot }
  | { type: 'exit' }
  /**
   * The session has ended and the picture belongs on screen again — which, while
   * the viewer is off browsing the guide with the video floating, also means
   * navigating back to the player.
   */
  | { type: 'returnInline' }

export type PipState =
  | { phase: 'idle' }
  | {
      phase: 'requesting'
      /** The slot we asked for. */
      slot: PipSlot
      /** The slot holding the session meanwhile — null for a fresh entry. */
      held: PipSlot | null
      /** A swap that landed mid-request, to be honoured once this one settles. */
      queued: PipSlot | null
      /** The held session has already reported `left`: the transfer artifact. */
      orphaned: boolean
    }
  | { phase: 'active'; slot: PipSlot }
  /** We asked to exit and are waiting for the `leavepictureinpicture` to confirm. */
  | { phase: 'closing'; slot: PipSlot }

export const PIP_IDLE: PipState = { phase: 'idle' }

export interface PipStep {
  state: PipState
  command: PipCommand | null
}

/** Is the floating window up, or about to be? What the OSD button reflects. */
export function isFloating(state: PipState): boolean {
  return state.phase === 'active' || state.phase === 'requesting'
}

/** The slot the session is on (or heading to), for tests and diagnostics. */
export function floatingSlot(state: PipState): PipSlot | null {
  if (state.phase === 'active') return state.slot
  if (state.phase === 'requesting') return state.slot
  return null
}

const step = (state: PipState, command: PipCommand | null = null): PipStep => ({ state, command })

/**
 * The whole machine: pure, total, and the only place PiP intent is decided.
 *
 * Unknown event/phase pairs fall through to "no change, no command" rather than
 * throwing. Chromium emits PiP events we did not ask for (a window closed by the
 * OS, a session Chromium moved itself), and a media UI that crashes on an
 * unexpected event is worse than one that ignores it.
 */
export function reducePip(state: PipState, event: PipEvent): PipStep {
  if (event.type === 'teardown') {
    // The one event every phase answers the same way: stop, and ask for the exit
    // only if there is (or may be) something to close. Deliberately *not*
    // `returnInline` — the player is going away, and steering navigation back to
    // it is precisely what a blackout must not do.
    if (state.phase === 'idle' || state.phase === 'closing') return step(PIP_IDLE)
    return step(PIP_IDLE, { type: 'exit' })
  }

  switch (state.phase) {
    case 'idle':
      if (event.type === 'toggle') {
        return step(
          { phase: 'requesting', slot: event.slot, held: null, queued: null, orphaned: false },
          { type: 'enter', slot: event.slot }
        )
      }
      // A handoff with nothing floating is none of our business, and a stray
      // `left` after teardown lands here too.
      return step(state)

    case 'requesting':
      switch (event.type) {
        case 'entered': {
          // A swap that landed while we were asking is honoured now, as a
          // transfer — the session it moves is the one that just opened, so no
          // gesture is needed and the invariant holds.
          if (state.queued !== null && state.queued !== state.slot) {
            return step(
              {
                phase: 'requesting',
                slot: state.queued,
                held: state.slot,
                queued: null,
                orphaned: false
              },
              { type: 'transfer', slot: state.queued }
            )
          }
          return step({ phase: 'active', slot: state.slot })
        }
        case 'failed': {
          // A transfer that failed with the old session still alive is a
          // non-event: the picture is floating, just on the element it was on.
          if (state.held !== null && !state.orphaned) {
            return step({ phase: 'active', slot: state.held })
          }
          // It failed *and* the old session is gone (or there never was one).
          // Only the first case has a picture to bring home.
          return step(PIP_IDLE, state.orphaned ? { type: 'returnInline' } : null)
        }
        case 'left':
          // The sharp edge (see the header). Swallowed: `entered` or `failed`
          // decides what this transfer actually did.
          return step({ ...state, orphaned: true })
        case 'swapped':
          // Already asking for that slot — nothing to queue.
          if (event.slot === state.slot) return step({ ...state, queued: null })
          return step({ ...state, queued: event.slot })
        default:
          // `toggle` included: a second press inside the request window is the
          // viewer being impatient, not a change of mind.
          return step(state)
      }

    case 'active':
      switch (event.type) {
        case 'toggle':
          return step({ phase: 'closing', slot: state.slot }, { type: 'exit' })
        case 'swapped': {
          if (event.slot === state.slot) return step(state)
          return step(
            {
              phase: 'requesting',
              slot: event.slot,
              held: state.slot,
              queued: null,
              orphaned: false
            },
            { type: 'transfer', slot: event.slot }
          )
        }
        case 'left':
          // A slot that is not showing the picture cannot have lost it: this is
          // a transfer's artifact arriving late. Chromium was measured firing it
          // *before* the transfer resolves — which the `requesting` phase above
          // absorbs — but nothing in the spec fixes that order, and the cost of
          // believing a stale one here is the floating window closing itself in
          // the middle of every handoff.
          if (event.slot !== state.slot) return step(state)
          // On the slot that holds the session it is real: the ✕, "back to tab",
          // or the OS closing the window. All three mean the same thing.
          return step(PIP_IDLE, { type: 'returnInline' })
        case 'entered':
          // Chromium reporting a session on an element we did not ask about.
          // Believe it rather than losing track of where the picture is.
          return step({ phase: 'active', slot: event.slot })
        default:
          return step(state)
      }

    case 'closing':
      switch (event.type) {
        case 'left':
          // Same rule as `active`: only the slot that held the session can end it.
          if (event.slot !== state.slot) return step(state)
          return step(PIP_IDLE, { type: 'returnInline' })
        case 'toggle':
          // Pressing P again before the exit confirmed. Asking for a fresh
          // session is safe — this arrives inside a gesture — and it is the only
          // way out if the confirming event never comes.
          return step(
            { phase: 'requesting', slot: event.slot, held: null, queued: null, orphaned: false },
            { type: 'enter', slot: event.slot }
          )
        default:
          return step(state)
      }
  }
}

export interface PipMachine {
  readonly state: PipState
  /** Feed one event; run the command it returns, if any. */
  send(event: PipEvent): PipCommand | null
}

/** The stateful wrapper the Player keeps in a ref. All logic is in `reducePip`. */
export function createPipMachine(initial: PipState = PIP_IDLE): PipMachine {
  let current = initial
  return {
    get state(): PipState {
      return current
    },
    send(event: PipEvent): PipCommand | null {
      const next = reducePip(current, event)
      current = next.state
      return next.command
    }
  }
}
