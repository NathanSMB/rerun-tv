/** @vitest-environment happy-dom */
/**
 * The sleep panel's wiring (docs/sleep-dial-plan.html).
 *
 * `handoff.test.ts` owns what the *store* does with a duration — the clamp, the
 * relative nudge, the unit boundary. What it cannot see is whether a keystroke
 * ever reaches those actions, and that is the whole risk in this feature: the
 * panel is a dialog laid over a screen whose window-level map already owns the
 * arrow keys. `→` is skip-episode out there. An arrow aimed at the dial that
 * also changed the channel's mind would be a data bug — a real episode logged as
 * skipped — reached by a keypress a viewer makes on purpose.
 *
 * So every case below is about *routing*: which handler swallowed the key, and
 * which store action came out. `sc.press()` delivers to `document.activeElement`
 * rather than to `window` for exactly that reason — see the harness.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { SLEEP_MAX_MIN } from '@shared/types.js'
import { openPlayer, type Scenario } from './harness.js'
import { standaloneDeck } from './fixtures.js'

let player: Scenario | null = null

async function open(...args: Parameters<typeof openPlayer>): Promise<Scenario> {
  player = await openPlayer(...args)
  return player
}

afterEach(async () => {
  await player?.unmount()
  player = null
})

/** Minutes left on the armed timer, rounded the way the dial rounds. */
function remainingMin(sc: Scenario): number {
  const until = sc.state().sleepUntil
  if (until === null) throw new Error('the timer is not armed')
  return Math.round((until - Date.now()) / 60_000)
}

describe('opening the panel', () => {
  it('arms the default on the first press and opens around it', async () => {
    const sc = await open(standaloneDeck(3), { sleepTimerDefaultMin: 45 })
    expect(sc.sleepPanel()).toBeNull()

    await sc.press('s')

    // The old one-press fast path, intact: the panel is a refinement, not a
    // detour on the way to "give me the usual".
    expect(sc.sleepPanel()).not.toBeNull()
    expect(sc.state().sleepMinutes).toBe(45)
  })

  it('leaves an already-armed timer alone when it opens', async () => {
    const sc = await open(standaloneDeck(3), { sleepTimerDefaultMin: 45 })
    await sc.armSleep(120)

    await sc.press('s')

    expect(sc.sleepPanel()).not.toBeNull()
    expect(sc.state().sleepMinutes).toBe(120)
  })

  it('closes on a second press without disarming', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.press('s')
    await sc.press('s')

    expect(sc.sleepPanel()).toBeNull()
    // Closing is not cancelling — the timer the viewer set is still running.
    expect(sc.state().sleepUntil).not.toBeNull()
  })

  it('opens from the moon button too', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.clickSleep()

    expect(sc.sleepPanel()).not.toBeNull()
    expect(sc.sleepButton().getAttribute('aria-expanded')).toBe('true')
  })
})

describe('keys while the panel is open', () => {
  /**
   * The case this file exists for. Mutation that turns it red: drop the sleep
   * panel's `stopPropagation`, or the player map's `[role="slider"]` guard.
   */
  it('does not skip the episode when the dial is arrowed', async () => {
    const sc = await open(standaloneDeck(3))
    const onAir = sc.state().nowPlaying!.episode.id
    await sc.press('s')

    await sc.press('ArrowRight')
    await sc.press('ArrowRight')

    // No advance was even considered, and the same episode is still on air.
    expect(sc.actions).toEqual([])
    expect(sc.state().nowPlaying?.episode.id).toBe(onAir)
  })

  it('moves the timer by five minutes an arrow', async () => {
    const sc = await open(standaloneDeck(3), { sleepTimerDefaultMin: 30 })
    await sc.press('s')

    await sc.press('ArrowRight')
    expect(remainingMin(sc)).toBe(35)

    await sc.press('ArrowLeft')
    await sc.press('ArrowLeft')
    expect(remainingMin(sc)).toBe(25)
  })

  it('moves by thirty on the vertical arrows, and does not touch the volume', async () => {
    const sc = await open(standaloneDeck(3), { sleepTimerDefaultMin: 30 })
    const volume = sc.state().volume
    await sc.press('s')

    await sc.press('ArrowUp')

    expect(remainingMin(sc)).toBe(60)
    // ↑/↓ are volume in the player's map; the dial has to swallow them whole.
    expect(sc.state().volume).toBe(volume)
  })

  it('takes typed digits as minutes', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.press('s')

    // Three digits cannot grow, so this commits without waiting out the buffer.
    await sc.press('1')
    await sc.press('3')
    await sc.press('5')

    expect(sc.state().sleepMinutes).toBe(135)
  })

  it('switches the timer off on a typed zero', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.press('s')

    await sc.press('0')

    expect(sc.state().sleepUntil).toBeNull()
    // Still open: the viewer can change their mind without reopening.
    expect(sc.sleepPanel()).not.toBeNull()
  })

  /**
   * Esc is the busiest key on this screen — it leaves fullscreen, and it leaves
   * the player. The panel is the innermost thing open, so it takes the first
   * one; a viewer closing the dial must not land back in the guide.
   */
  it('closes on Esc without leaving the player', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.press('s')

    await sc.press('Escape')

    expect(sc.sleepPanel()).toBeNull()
    expect(sc.actions).toEqual([])
    expect(sc.state().screen).toBe('player')
  })

  it('closes on Enter', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.press('s')

    await sc.press('Enter')

    expect(sc.sleepPanel()).toBeNull()
    expect(sc.state().screen).toBe('player')
  })

  it('hands the arrows back to the player once the panel is closed', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.press('s')
    await sc.press('Escape')

    await sc.press('ArrowRight')

    // The skip key is a skip key again — the panel borrowed it, it didn't keep it.
    expect(sc.actions).toEqual(['advance(false)'])
  })
})

describe('the wheel', () => {
  it('adjusts the timer over the moon without opening anything', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.armSleep(60)

    await sc.wheel(sc.sleepButton(), 'up')

    expect(remainingMin(sc)).toBe(65)
    // The point of the wheel path: no panel, no click, no chrome to dismiss.
    expect(sc.sleepPanel()).toBeNull()
  })

  it('arms from off when scrolled with no timer running', async () => {
    const sc = await open(standaloneDeck(3))
    expect(sc.state().sleepUntil).toBeNull()

    await sc.wheel(sc.sleepButton(), 'up')

    expect(sc.state().sleepMinutes).toBe(5)
  })

  it('winds a timer down and off', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.armSleep(5)

    await sc.wheel(sc.sleepButton(), 'down')

    expect(sc.state().sleepUntil).toBeNull()
  })

  it('stops at the ceiling', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.armSleep(SLEEP_MAX_MIN)

    await sc.wheel(sc.sleepButton(), 'up')

    expect(sc.state().sleepMinutes).toBe(SLEEP_MAX_MIN)
  })
})

describe('the panel and the rest of the chrome', () => {
  /**
   * The panel is player chrome, so it cannot outlive it. Left mounted it would
   * be a dialog sitting over a black screen with no channel behind it.
   */
  it('goes when the timer takes the channel down', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.press('s')
    expect(sc.sleepPanel()).not.toBeNull()

    await sc.expireSleep()
    await sc.endEpisode()

    expect(sc.state().screen).toBe('blackout')
    expect(sc.sleepPanel()).toBeNull()
  })

  it('goes when the viewer leaves for the guide', async () => {
    const sc = await open(standaloneDeck(3))
    await sc.press('s')
    await sc.press('Escape')
    await sc.press('Escape')

    expect(sc.state().screen).toBe('guide')
    expect(sc.sleepPanel()).toBeNull()
  })
})
