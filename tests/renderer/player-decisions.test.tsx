/** @vitest-environment happy-dom */
/**
 * Which store action the Player's effects pick.
 *
 * This is the class of bug this layer exists for: an effect fed by media-element
 * events choosing the wrong transition, and producing silently wrong *data*
 * rather than anything visible on screen. Two of them shipped past a fully green
 * suite during the sleep timer, because `handoff.test.ts` starts one step later
 * — it calls `advance()` and `sleepNow()` directly, and the bug was in which of
 * the two the Player asked for.
 *
 * The trap both fell into is one fact: **`paused === true` does not mean a
 * viewer pressed pause.** Chromium pauses an element at the close of every
 * episode, and a promoted standby is paused until `play()` takes. So the Player
 * keys its paused branch on `wantsPlayRef` — cleared only in `togglePlay` —
 * rather than on the flag (`Player.tsx`, "Expiry while paused").
 *
 * Each case below states the mutation that must turn it red. A harness whose
 * tests cannot fail on the original bugs is decoration.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { openPlayer, type Scenario } from './harness.js'
import { arcDeck, EPISODE_DURATION_S, reportedEnds, standaloneDeck } from './fixtures.js'

let player: Scenario | null = null

async function open(...args: Parameters<typeof openPlayer>): Promise<Scenario> {
  player = await openPlayer(...args)
  return player
}

afterEach(async () => {
  await player?.unmount()
  player = null
})

describe('the walking skeleton', () => {
  it('puts the first episode of the deck on air', async () => {
    const deck = standaloneDeck(3)
    const sc = await open(deck)

    expect(sc.state().screen).toBe('player')
    expect(sc.state().nowPlaying?.episode.id).toBe(deck[0].episode.id)
    // The element on air is genuinely playing: `loadedmetadata` reached the
    // Player, which asked for `play()`, and it took.
    expect(sc.activeVideo().paused).toBe(false)
  })
})

/**
 * Bug 1. With the timer expired, the `pause` Chromium fires immediately before
 * `ended` — with the element's `ended` already true — must not be read as a
 * viewer pausing. Read that way, `sleepNow()` won the race against `handleEnded`
 * and an episode watched to the end was logged `completed: false`: a stop, not a
 * watch, and exactly the flag a shuffle bag reads to avoid repeats.
 */
describe('the close of an episode', () => {
  it('advances rather than sleeping when the pause is Chromium ending the episode', async () => {
    const deck = standaloneDeck(3)
    const sc = await open(deck)
    await sc.expireSleep()

    await sc.endEpisode()

    // The whole assertion: one action, and it is the one that logs a watch.
    expect(sc.actions).toEqual(['advance(true)'])
    expect(reportedEnds(sc.calls)).toEqual([{ episodeId: deck[0].episode.id, completed: true }])
    // The timer still lands where it should — at the boundary, not before it.
    expect(sc.state().screen).toBe('blackout')
    expect(sc.state().nowPlaying).toBeNull()
    expect(sc.state().sleepUntil).toBeNull()
  })
})

/**
 * Bug 2. A gapless handoff flips a hidden, buffered element to active; it is
 * paused, with `ended` false, until `play()` takes. A timer that expired mid-arc
 * stopped there — the one thing the unit boundary exists to prevent.
 *
 * The two cases differ in *when* the deadline is crossed, and that difference is
 * what separates the real fix from a plausible half-fix. Guarding on
 * `video.ended` instead of `wantsPlayRef` would survive the first case and fail
 * the second, because in the promotion window the element on air has never
 * ended.
 */
describe('a handoff mid-arc', () => {
  it('plays on when the deadline is crossed inside the promotion window', async () => {
    const deck = arcDeck(3)
    const sc = await open(deck)
    await sc.prewarm()
    expect(sc.state().pendingNext?.episode.id).toBe(deck[1].episode.id)

    await sc.pauseForEnd()
    await sc.ended()

    // Mid-flip: part 2 is on air and has not started yet. This is the window.
    const promoted = sc.activeVideo()
    expect(sc.state().nowPlaying?.episode.id).toBe(deck[1].episode.id)
    expect(promoted.paused).toBe(true)
    expect(promoted.ended).toBe(false)

    await sc.expireSleep()
    await sc.settle()

    expect(sc.actions).toEqual(['advance(true)'])
    expect(sc.state().screen).toBe('player')
    expect(sc.state().nowPlaying?.arc).toMatchObject({ partIndex: 2, partCount: 3 })
    // Part 2 was committed and is playing — not picked and abandoned.
    expect(reportedEnds(sc.calls)).toEqual([{ episodeId: deck[0].episode.id, completed: true }])
    expect(sc.activeVideo().paused).toBe(false)
  })

  it('carries an already-expired timer through the boundary into the next part', async () => {
    const deck = arcDeck(3)
    const sc = await open(deck)
    await sc.expireSleep()
    await sc.prewarm()

    await sc.endEpisode()

    expect(sc.actions).toEqual(['advance(true)'])
    expect(sc.state().screen).toBe('player')
    expect(sc.state().nowPlaying?.arc).toMatchObject({ partIndex: 2, partCount: 3 })
    expect(reportedEnds(sc.calls)).toEqual([{ episodeId: deck[0].episode.id, completed: true }])
  })
})

/**
 * The other side of the guard: it must not be so strong that the paused branch
 * never fires. A viewer who paused and did not come back is the exact case the
 * timer is for, and it is the one path that stops mid-episode.
 */
describe('a genuine viewer pause', () => {
  it('stops at once when the timer expires while the viewer has it paused', async () => {
    const deck = standaloneDeck(3)
    const sc = await open(deck)

    // The OSD button, not the element: `togglePlay` is the only place a human
    // asks, and it is the only place `wantsPlayRef` is cleared.
    await sc.viewerPause()
    expect(sc.activeVideo().paused).toBe(true)

    await sc.expireSleep()
    await sc.settle()

    expect(sc.actions).toEqual(['sleepNow'])
    // Nothing finished, so this one is not a watch — the honest half of stopping.
    expect(reportedEnds(sc.calls)).toEqual([{ episodeId: deck[0].episode.id, completed: false }])
    expect(sc.calls).toContainEqual({ call: 'release', channelId: 7, episodeId: null })
    expect(sc.state().screen).toBe('blackout')
    expect(sc.state().sleepUntil).toBeNull()
  })
})

/**
 * The prewarm gate. Once the timer is due to stop after this episode there is
 * nothing to buffer, and committing a pick would spend a schedule step we would
 * only release again at the boundary.
 *
 * The second half is the subtle one: `prewarmedAfterRef` is deliberately left
 * unset on the suppressed pass, so cancelling the timer inside the window
 * re-runs the effect and the prewarm fires late but still in time to be gapless.
 * Setting the ref eagerly would cost the handoff on every change of mind.
 */
describe('the up-next window with the timer expired', () => {
  it('suppresses the prewarm, then makes it up when the timer is cancelled', async () => {
    const deck = standaloneDeck(3)
    const sc = await open(deck)
    await sc.expireSleep()

    await sc.at(EPISODE_DURATION_S - 25)

    expect(sc.actions).toEqual([])
    expect(sc.calls.some((entry) => entry.call === 'prewarmNext')).toBe(false)
    expect(sc.state().pendingNext).toBeNull()

    await sc.armSleep(null)

    expect(sc.actions).toEqual(['prewarm'])
    expect(sc.calls.filter((entry) => entry.call === 'prewarmNext')).toHaveLength(1)
    expect(sc.state().pendingNext?.episode.id).toBe(deck[1].episode.id)
  })
})
