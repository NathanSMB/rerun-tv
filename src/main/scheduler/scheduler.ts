/**
 * The scheduler — what plays next (plan §5).
 *
 * Every time a channel needs an episode (tune-in, auto-advance on `ended`, or a
 * user skip) this module runs the plan's two-stage pick: draw a *show* by
 * weight, then a *unit* within that show by its mode. Arc playback preempts
 * both stages — once a multipart arc starts, nothing interrupts it until the
 * final part has been handed out.
 *
 * The reason everything below talks about units rather than episodes is the
 * whole point of the design (see `units.ts`). A three-part arc is one entry in
 * a shuffle bag and one step of a sequential cursor, so it airs exactly as
 * often as any standalone episode — 1/9 for a show of 8 standalones plus one
 * three-parter, not 3/11 — and it can never be joined at Part 2.
 *
 * Two invariants this module is built around:
 *
 * 1. **Every state transition is a single SQLite transaction** (plan §10). The
 *    cursor advance, the bag pop, the arc lock and the play-log write either
 *    all land or none do, so a crash mid-arc can never leave a channel
 *    pointing at half a decision. better-sqlite3 is synchronous, so there are
 *    no await points inside a transaction to interleave with anything.
 * 2. **Peeking is free of side effects.** `peekNext` runs the identical
 *    decision against copies of the state and writes nothing — it is *not* a
 *    rolled-back transaction, because the guide calls it for every channel on
 *    every render.
 *
 * `channels.active_part_index` is the 0-based index of the part that will be
 * handed out *next*. Handing out the final part clears `active_group_id` in the
 * same transaction: the arc is complete, so the channel is already free.
 */

import type { ChannelShow, ChannelShowState, PlayableUnit } from '@shared/types.js'
import type { Db } from '../db/index.js'
import {
  getChannel,
  getShowState,
  lastAired,
  listChannelShows,
  logAiring,
  resetShowState,
  saveShowState,
  setActiveArc
} from '../db/repositories/channels.js'
import { buildUnits, unitKeyForArc } from './units.js'

/** A pick, already committed to the database. */
export interface Pick {
  episodeId: number
  unit: PlayableUnit
  arc: { title: string; partIndex: number; partCount: number } | null
}

/**
 * A decision plus the exact state it implies — computed by pure reads so that
 * `peekNext` can return the pick and throw the mutations away, while
 * `pickNext` applies them inside one transaction.
 */
interface PlannedPick {
  pick: Pick
  /** The channel's arc lock after this pick. `{ null, null }` releases it. */
  arc: { groupId: number | null; partIndex: number | null }
  /** Show state to persist, or null when the pick was an arc continuation. */
  state: ChannelShowState | null
}

/** Fisher–Yates over `rng`, so a seeded generator makes tests deterministic. */
function shuffled(keys: string[], rng: () => number): string[] {
  const out = keys.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/**
 * Deal a fresh bag. Bags are dealt from the front, so "never lead with the unit
 * that just aired" means position 0 — a refill that opened with the episode you
 * just watched would make the cycle boundary feel broken even though the
 * distribution is fine. The offender is swapped to a random later slot rather
 * than dropped, so it still airs exactly once this cycle.
 */
function dealBag(units: PlayableUnit[], rng: () => number, avoidFirst: string | null): string[] {
  const bag = shuffled(
    units.map((u) => u.key),
    rng
  )
  if (avoidFirst != null && bag.length > 1 && bag[0] === avoidFirst) {
    const j = 1 + Math.floor(rng() * (bag.length - 1))
    bag[0] = bag[j]
    bag[j] = avoidFirst
  }
  return bag
}

/** Weighted lottery over the lineup. Weights are the per-show sliders in the editor. */
function weightedPick<T extends { weight: number }>(candidates: T[], rng: () => number): T {
  const total = candidates.reduce((sum, c) => sum + c.weight, 0)
  let r = rng() * total
  for (const candidate of candidates) {
    r -= candidate.weight
    if (r < 0) return candidate
  }
  return candidates[candidates.length - 1]
}

/** The arc unit for a group id, rebuilt from the library so part order is authoritative. */
function loadArcUnit(db: Db, groupId: number): PlayableUnit | null {
  const row = db.prepare(`SELECT show_id AS showId FROM part_groups WHERE id = ?`).get(groupId) as
    | { showId: number }
    | undefined
  if (!row) return null
  const key = unitKeyForArc(groupId)
  return buildUnits(db, row.showId).find((u) => u.key === key) ?? null
}

/** `arc:12` → 12. Only ever called on keys this module produced. */
function groupIdFromKey(key: string): number {
  return Number(key.slice('arc:'.length))
}

/** Which unit contains a given episode — used to translate `lastAired` into a bag key. */
function unitKeyForEpisodeId(units: PlayableUnit[], episodeId: number): string | null {
  for (const unit of units) {
    if (unit.episodeIds.includes(episodeId)) return unit.key
  }
  return null
}

/**
 * The plan's `nextEpisode()`, expressed as a pure computation. Reads the
 * database, decides, and reports the mutations it would need — but performs
 * none of them.
 */
function planNext(db: Db, channelId: number, rng: () => number): PlannedPick | null {
  const channel = getChannel(db, channelId)
  if (!channel) return null

  // 1 · An in-progress arc always wins — arcs are never interrupted.
  if (channel.activeGroupId != null) {
    const unit = loadArcUnit(db, channel.activeGroupId)
    const index = channel.activePartIndex ?? 0
    if (unit && index >= 0 && index < unit.episodeIds.length) {
      const isFinalPart = index === unit.episodeIds.length - 1
      return {
        pick: {
          episodeId: unit.episodeIds[index],
          unit,
          arc: { title: unit.title, partIndex: index + 1, partCount: unit.episodeIds.length }
        },
        // Handing out the last part releases the channel immediately.
        arc: isFinalPart ? { groupId: null, partIndex: null } : { groupId: channel.activeGroupId, partIndex: index + 1 },
        state: null
      }
    }
    // Stale lock (the group was deleted or regrouped out from under us): fall
    // through to the lottery, which clears it as part of its own mutation.
  }

  // 2 · Pick a show, weighted. Shows with no units at all are not in the draw —
  // an empty show must never be able to win and produce nothing.
  const candidates = listChannelShows(db, channelId)
    .map((show: ChannelShow) => ({ ...show, units: buildUnits(db, show.showId) }))
    .filter((c) => c.units.length > 0 && c.weight > 0)
  if (candidates.length === 0) return null

  const chosen = weightedPick(candidates, rng)
  const units = chosen.units
  const state = getShowState(db, channelId, chosen.showId)

  // 3 · Pick a unit inside that show, by the show's mode.
  let unit: PlayableUnit
  let nextState: ChannelShowState
  if (chosen.mode === 'sequential') {
    // The cursor is an index into a *derived* list, so it can be left dangling
    // by a rescan that removed episodes; treat anything out of range as a wrap.
    const cursor =
      state.cursorUnitIndex >= 0 && state.cursorUnitIndex < units.length ? state.cursorUnitIndex : 0
    unit = units[cursor]
    nextState = { ...state, cursorUnitIndex: (cursor + 1) % units.length }
  } else {
    // Bags hold unit *keys*, so regrouping episodes into an arc mid-cycle
    // invalidates keys rather than corrupting positions: drop the dead ones and
    // carry on with the rest of the cycle.
    const live = new Set(units.map((u) => u.key))
    const bag = state.shuffleBag.filter((key) => live.has(key))
    if (bag.length === 0) {
      const lastEpisodeId = lastAired(db, channelId, chosen.showId)
      const avoid = lastEpisodeId == null ? null : unitKeyForEpisodeId(units, lastEpisodeId)
      bag.push(...dealBag(units, rng, avoid))
    }
    const key = bag.shift() as string
    unit = units.find((u) => u.key === key) ?? units[0]
    nextState = { ...state, shuffleBag: bag }
  }

  // 4 · An arc enters as one unit and locks the channel until it finishes. A
  // one-part group is an arc for bookkeeping but has nothing to protect.
  const partCount = unit.episodeIds.length
  const locks = unit.kind === 'arc' && partCount > 1
  return {
    pick: {
      episodeId: unit.episodeIds[0],
      unit,
      arc: locks ? { title: unit.title, partIndex: 1, partCount } : null
    },
    arc: locks
      ? { groupId: groupIdFromKey(unit.key), partIndex: 1 }
      : { groupId: null, partIndex: null },
    state: nextState
  }
}

/**
 * Commit and return the channel's next episode. Null when the lineup is empty
 * (no shows, or every show in it has no playable units).
 *
 * The cursor/bag write, the arc lock and the play-log entry all happen in one
 * transaction, so the answer this returns is exactly the state the database is
 * left in. `rng` is injectable purely so tests can be deterministic.
 */
export function pickNext(db: Db, channelId: number, rng: () => number = Math.random): Pick | null {
  return db.transaction((): Pick | null => {
    const planned = planNext(db, channelId, rng)
    if (!planned) return null
    if (planned.state) saveShowState(db, planned.state)
    setActiveArc(db, channelId, planned.arc.groupId, planned.arc.partIndex)
    // Logged as incomplete; the player flips it when the episode reaches `ended`.
    logAiring(db, channelId, planned.pick.episodeId, false)
    return planned.pick
  })()
}

/**
 * What `pickNext` would return, without mutating anything — the guide's on-deck
 * line and the player's up-next toast both run on this, and both are called far
 * too often to be allowed to consume the schedule.
 *
 * Given the same `rng` sequence the answer is identical to the following
 * `pickNext`; with the default `Math.random` a shuffle show's peek is a
 * *plausible* next pick rather than a promise.
 */
export function peekNext(db: Db, channelId: number, rng: () => number = Math.random): Pick | null {
  return planNext(db, channelId, rng)?.pick ?? null
}

/**
 * Reset a show's progress in a channel: cursor back to the pilot, bag emptied
 * so the next draw deals a fresh cycle. Progress only — the lineup entry (mode,
 * weight, position) is configuration and is deliberately untouched.
 */
export function resetProgress(db: Db, channelId: number, showId: number): void {
  db.transaction(() => {
    resetShowState(db, channelId, showId)
  })()
}

/**
 * Clear an arc lock that points at a group which no longer exists, or whose
 * part index has fallen out of range because the arc was regrouped or trimmed.
 *
 * Called at tune-in: a crash mid-arc, or a Library edit that deleted the arc
 * while the channel was locked to it, would otherwise wedge the channel on a
 * decision it can never finish (plan §10, "scheduler state corruption").
 */
export function validateActiveArc(db: Db, channelId: number): void {
  db.transaction(() => {
    const channel = getChannel(db, channelId)
    if (!channel || channel.activeGroupId == null) return
    const unit = loadArcUnit(db, channel.activeGroupId)
    const index = channel.activePartIndex ?? 0
    if (!unit || index < 0 || index >= unit.episodeIds.length) {
      setActiveArc(db, channelId, null, null)
    }
  })()
}
