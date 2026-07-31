/**
 * The scheduler (plan §5) — arcs are atomic, the lottery is over units, and
 * peeking never spends the schedule.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '@main/db/index.js'
import {
  addChannelShow,
  createChannel,
  getChannel,
  getShowState,
  listChannelShowSeasonModes,
  setActiveArc,
  setChannelShowMode,
  setChannelShowSeasonMode,
  setChannelShowWeight
} from '@main/db/repositories/channels.js'
import {
  discardReserved,
  peekNext,
  pickNext,
  promoteReserved,
  reserveNext,
  resetProgress,
  validateActiveArc
} from '@main/scheduler/scheduler.js'
import { buildUnits, unitKeyForArc } from '@main/scheduler/units.js'
import { getChannelDetail, listChannelSummaries } from '@main/services/channels.js'

/** mulberry32 — a tiny, deterministic PRNG so every statistical test is reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function insertShow(db: Db, title: string): number {
  return Number(
    db
      .prepare(`INSERT INTO shows (title, folder_path, added_at) VALUES (?, ?, 0)`)
      .run(title, `/tv/${title}`).lastInsertRowid
  )
}

function insertEpisode(db: Db, showId: number, season: number, episode: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO episodes (show_id, season, episode, path, duration_s)
         VALUES (?, ?, ?, ?, 1200)`
      )
      .run(showId, season, episode, `/tv/${showId}/S${season}E${episode}.mkv`).lastInsertRowid
  )
}

function insertArc(db: Db, showId: number, title: string, episodeIds: number[]): number {
  const groupId = Number(
    db
      .prepare(`INSERT INTO part_groups (show_id, title, source) VALUES (?, ?, 'manual')`)
      .run(showId, title).lastInsertRowid
  )
  const link = db.prepare(`UPDATE episodes SET part_group_id = ?, part_index = ? WHERE id = ?`)
  episodeIds.forEach((id, i) => link.run(groupId, i + 1, id))
  return groupId
}

/** A show of `count` standalone episodes in season 1. */
function seedFlatShow(db: Db, title: string, count: number): number {
  const showId = insertShow(db, title)
  for (let e = 1; e <= count; e++) insertEpisode(db, showId, 1, e)
  return showId
}

/** The plan's sample show: 8 standalone episodes + one 3-part arc (9 units). */
function seedArcShow(db: Db): { showId: number; groupId: number; episodeIds: number[] } {
  const showId = insertShow(db, 'Gargoyles')
  const episodeIds: number[] = []
  for (let e = 1; e <= 11; e++) episodeIds.push(insertEpisode(db, showId, 1, e))
  const groupId = insertArc(db, showId, 'The Gathering', [
    episodeIds[4],
    episodeIds[5],
    episodeIds[6]
  ])
  return { showId, groupId, episodeIds }
}

let db: Db
beforeEach(() => {
  db = openDatabase(':memory:')
})

describe('arc atomicity', () => {
  it('hands out every part in order once an arc starts, whatever the RNG says', () => {
    const { showId, groupId, episodeIds } = seedArcShow(db)
    const channel = createChannel(db, 'Saturday Morning')
    addChannelShow(db, channel.id, showId)

    // Start the arc explicitly, then hammer it with a hostile RNG.
    setActiveArc(db, channel.id, groupId, 0)
    const hostile = seeded(9)

    const first = pickNext(db, channel.id, hostile)
    expect(first?.episodeId).toBe(episodeIds[4])
    expect(first?.arc).toEqual({ title: 'The Gathering', partIndex: 1, partCount: 3 })

    const second = pickNext(db, channel.id, hostile)
    expect(second?.episodeId).toBe(episodeIds[5])
    expect(second?.arc?.partIndex).toBe(2)
    expect(getChannel(db, channel.id)?.activeGroupId).toBe(groupId)

    const third = pickNext(db, channel.id, hostile)
    expect(third?.episodeId).toBe(episodeIds[6])
    expect(third?.arc?.partIndex).toBe(3)

    // The final part released the channel: the lottery runs again.
    expect(getChannel(db, channel.id)?.activeGroupId).toBeNull()
    expect(getChannel(db, channel.id)?.activePartIndex).toBeNull()

    const fourth = pickNext(db, channel.id, hostile)
    expect(fourth?.arc === null || fourth?.arc?.partIndex === 1).toBe(true)
  })

  it('locks the channel when the lottery draws an arc, and logs each part', () => {
    const { showId, groupId, episodeIds } = seedArcShow(db)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    const rng = seeded(3)

    let started: ReturnType<typeof pickNext> = null
    for (let i = 0; i < 20 && !started; i++) {
      const pick = pickNext(db, channel.id, rng)
      if (pick?.unit.kind === 'arc') started = pick
    }

    expect(started?.episodeId).toBe(episodeIds[4])
    expect(getChannel(db, channel.id)?.activeGroupId).toBe(groupId)
    expect(getChannel(db, channel.id)?.activePartIndex).toBe(1)

    const parts = [pickNext(db, channel.id, rng), pickNext(db, channel.id, rng)]
    expect(parts.map((p) => p?.episodeId)).toEqual([episodeIds[5], episodeIds[6]])

    const logged = db
      .prepare(
        `SELECT episode_id AS episodeId FROM play_log WHERE channel_id = ? ORDER BY id DESC LIMIT 3`
      )
      .all(channel.id) as { episodeId: number }[]
    expect(logged.map((r) => r.episodeId)).toEqual([episodeIds[6], episodeIds[5], episodeIds[4]])
  })

  it('a single-episode group does not lock the channel', () => {
    const showId = insertShow(db, 'One-shot')
    const only = insertEpisode(db, showId, 1, 1)
    insertArc(db, showId, 'Prologue', [only])
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)

    const pick = pickNext(db, channel.id, seeded(1))

    expect(pick?.unit.kind).toBe('arc')
    expect(pick?.arc).toBeNull()
    expect(getChannel(db, channel.id)?.activeGroupId).toBeNull()
  })
})

describe('the per-unit lottery', () => {
  it('starts the 3-part arc 1 time in 9, not 3 in 11', () => {
    const { showId } = seedArcShow(db)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    const rng = seeded(20260729)

    let arcStarts = 0
    let standaloneStarts = 0
    for (let i = 0; i < 9000; i++) {
      const pick = pickNext(db, channel.id, rng)
      if (!pick) throw new Error('lineup went empty')
      if (pick.unit.kind === 'arc') {
        if (pick.arc?.partIndex === 1) arcStarts++
      } else {
        standaloneStarts++
      }
    }

    const draws = arcStarts + standaloneStarts
    const share = arcStarts / draws
    expect(share).toBeCloseTo(1 / 9, 2)
    // The naive per-episode lottery would have been 3/11 ≈ 0.273.
    expect(share).toBeLessThan(0.2)
  })

  it('draws weight 2 about twice as often as weight 1', () => {
    const heavy = seedFlatShow(db, 'Heavy', 4)
    const light = seedFlatShow(db, 'Light', 4)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, heavy)
    addChannelShow(db, channel.id, light)
    setChannelShowMode(db, channel.id, heavy, 'sequential')
    setChannelShowMode(db, channel.id, light, 'sequential')
    setChannelShowWeight(db, channel.id, heavy, 2)
    const rng = seeded(77)

    const counts = new Map<number, number>()
    for (let i = 0; i < 6000; i++) {
      const pick = pickNext(db, channel.id, rng)
      const showId = pick?.unit.showId as number
      counts.set(showId, (counts.get(showId) ?? 0) + 1)
    }

    const ratio = (counts.get(heavy) ?? 0) / (counts.get(light) ?? 1)
    expect(ratio).toBeGreaterThan(1.85)
    expect(ratio).toBeLessThan(2.15)
  })

  it('skips shows with no units instead of looping, and returns null when all are empty', () => {
    const empty = insertShow(db, 'Nothing here')
    const real = seedFlatShow(db, 'Real', 3)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, empty)
    addChannelShow(db, channel.id, real)
    const rng = seeded(5)

    for (let i = 0; i < 50; i++) {
      expect(pickNext(db, channel.id, rng)?.unit.showId).toBe(real)
    }

    const bare = createChannel(db, 'Bare')
    addChannelShow(db, bare.id, empty)
    expect(pickNext(db, bare.id, rng)).toBeNull()
    expect(peekNext(db, bare.id, rng)).toBeNull()
  })
})

describe('sequential mode', () => {
  it('advances one unit per pick and wraps to the pilot after the finale', () => {
    const showId = seedFlatShow(db, 'In Order', 4)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setChannelShowMode(db, channel.id, showId, 'sequential')
    const units = buildUnits(db, showId)
    const rng = seeded(1)

    const aired = [0, 1, 2, 3, 4].map(() => pickNext(db, channel.id, rng)?.unit.key)

    expect(aired).toEqual([
      units[0].key,
      units[1].key,
      units[2].key,
      units[3].key,
      units[0].key // wrapped
    ])
    expect(getShowState(db, channel.id, showId).cursorUnitIndex).toBe(1)
  })

  it('advances the cursor by one *unit* when that unit is a whole arc', () => {
    const { showId, groupId } = seedArcShow(db)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setChannelShowMode(db, channel.id, showId, 'sequential')
    const rng = seeded(1)

    // Four standalones, then the arc unit.
    for (let i = 0; i < 4; i++) pickNext(db, channel.id, rng)
    const arcStart = pickNext(db, channel.id, rng)

    expect(arcStart?.unit.key).toBe(unitKeyForArc(groupId))
    // One unit consumed, even though three episodes will air.
    expect(getShowState(db, channel.id, showId).cursorUnitIndex).toBe(5)
    pickNext(db, channel.id, rng)
    pickNext(db, channel.id, rng)
    expect(getShowState(db, channel.id, showId).cursorUnitIndex).toBe(5)
  })
})

describe('shuffle mode', () => {
  it('airs every unit exactly once before any repeats', () => {
    const showId = seedFlatShow(db, 'Shuffled', 9)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    const expected = buildUnits(db, showId)
      .map((u) => u.key)
      .sort()
    const rng = seeded(42)

    const cycleOne: string[] = []
    for (let i = 0; i < 9; i++) cycleOne.push(pickNext(db, channel.id, rng)?.unit.key as string)
    const cycleTwo: string[] = []
    for (let i = 0; i < 9; i++) cycleTwo.push(pickNext(db, channel.id, rng)?.unit.key as string)

    expect(cycleOne.slice().sort()).toEqual(expected)
    expect(cycleTwo.slice().sort()).toEqual(expected)
    expect(new Set(cycleOne).size).toBe(9)
    expect(cycleOne).not.toEqual(cycleTwo)
  })

  it('never refills a bag that leads with the unit that just aired', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const fresh = openDatabase(':memory:')
      const showId = seedFlatShow(fresh, 'Shuffled', 5)
      const channel = createChannel(fresh, 'Ch')
      addChannelShow(fresh, channel.id, showId)
      const rng = seeded(seed)

      const keys: string[] = []
      for (let i = 0; i < 10; i++) keys.push(pickNext(fresh, channel.id, rng)?.unit.key as string)

      // Position 4 ends a cycle, position 5 opens the refilled bag.
      expect(keys[5]).not.toBe(keys[4])
      fresh.close()
    }
  })

  it('drops bag keys whose units no longer exist', () => {
    const showId = seedFlatShow(db, 'Shuffled', 4)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    const rng = seeded(11)
    pickNext(db, channel.id, rng)

    const stale = getShowState(db, channel.id, showId).shuffleBag
    expect(stale.length).toBe(3)
    db.prepare(`DELETE FROM episodes WHERE id = ?`).run(Number(stale[0].slice('ep:'.length)))

    const next = pickNext(db, channel.id, rng)
    expect(next?.unit.key).not.toBe(stale[0])
    expect(getShowState(db, channel.id, showId).shuffleBag).not.toContain(stale[0])
  })
})

describe('season mode overrides', () => {
  it('keeps an ordered season in order inside an otherwise shuffled cycle', () => {
    const showId = insertShow(db, 'Mixed South Park')
    for (let season = 1; season <= 2; season++) {
      for (let episode = 1; episode <= 5; episode++) {
        insertEpisode(db, showId, season, episode)
      }
    }
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setChannelShowSeasonMode(db, channel.id, showId, 1, 'sequential')
    const rng = seeded(37)

    const cycle = Array.from({ length: 10 }, () => pickNext(db, channel.id, rng)?.unit)
    const orderedEpisodes = cycle
      .filter((unit) => unit?.season === 1)
      .map((unit) => unit?.episode)
    const shuffledEpisodes = cycle
      .filter((unit) => unit?.season === 2)
      .map((unit) => unit?.episode)

    expect(orderedEpisodes).toEqual([1, 2, 3, 4, 5])
    expect(shuffledEpisodes.slice().sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5
    ])
    expect(shuffledEpisodes).not.toEqual([1, 2, 3, 4, 5])
  })

  it('can shuffle one season inside a show whose default is in order', () => {
    const showId = insertShow(db, 'Mostly ordered')
    for (let season = 1; season <= 2; season++) {
      for (let episode = 1; episode <= 6; episode++) {
        insertEpisode(db, showId, season, episode)
      }
    }
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setChannelShowMode(db, channel.id, showId, 'sequential')
    setChannelShowSeasonMode(db, channel.id, showId, 2, 'shuffle')
    const rng = seeded(91)

    const cycle = Array.from({ length: 12 }, () => pickNext(db, channel.id, rng)?.unit)
    expect(
      cycle.filter((unit) => unit?.season === 1).map((unit) => unit?.episode)
    ).toEqual([1, 2, 3, 4, 5, 6])
    expect(
      cycle.filter((unit) => unit?.season === 2).map((unit) => unit?.episode)
    ).not.toEqual([1, 2, 3, 4, 5, 6])
  })

  it('removes an override to inherit again and exposes effective modes to the editor', () => {
    const showId = insertShow(db, 'Overrides')
    insertEpisode(db, showId, 1, 1)
    insertEpisode(db, showId, 2, 1)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)

    setChannelShowSeasonMode(db, channel.id, showId, 2, 'sequential')
    expect(listChannelShowSeasonModes(db, channel.id, showId)).toHaveLength(1)
    expect(getChannelDetail(db, channel.id)?.lineup[0].seasons).toEqual([
      {
        season: 1,
        episodeCount: 1,
        modeOverride: null,
        effectiveMode: 'shuffle'
      },
      {
        season: 2,
        episodeCount: 1,
        modeOverride: 'sequential',
        effectiveMode: 'sequential'
      }
    ])

    setChannelShowSeasonMode(db, channel.id, showId, 2, null)

    expect(listChannelShowSeasonModes(db, channel.id, showId)).toEqual([])
    expect(getChannelDetail(db, channel.id)?.lineup[0].seasons[1]).toMatchObject({
      modeOverride: null,
      effectiveMode: 'shuffle'
    })
  })

  it('reports the progress model the scheduler actually keeps, not one per season', () => {
    // Season 2 has an episode but no unit of its own: both episodes belong to a
    // cross-season arc, which counts once under season 1. Overriding season 2
    // therefore cannot change how the show is scheduled, and the editor must not
    // claim a shuffle bag for a show the scheduler walks with a cursor.
    const showId = insertShow(db, 'Cross-season arc')
    const first = insertEpisode(db, showId, 1, 1)
    const second = insertEpisode(db, showId, 2, 1)
    insertArc(db, showId, 'Spans the break', [first, second])
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setChannelShowMode(db, channel.id, showId, 'sequential')
    setChannelShowSeasonMode(db, channel.id, showId, 2, 'shuffle')

    const entry = getChannelDetail(db, channel.id)?.lineup[0]
    // The override is still listed — it is a control the user set and can unset.
    expect(entry?.seasons).toMatchObject([
      { season: 1, effectiveMode: 'sequential' },
      { season: 2, modeOverride: 'shuffle', effectiveMode: 'shuffle' }
    ])
    expect(entry?.progress.kind).toBe('cursor')

    // And the scheduler agrees: the cursor advances, the bag stays empty.
    pickNext(db, channel.id, seeded(5))
    expect(getShowState(db, channel.id, showId).shuffleBag).toEqual([])
  })
})

describe('peekNext', () => {
  it('is side-effect free and agrees with the pick that follows', () => {
    const { showId } = seedArcShow(db)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    pickNext(db, channel.id, seeded(4)) // get some state on the board

    const snapshot = (): string =>
      JSON.stringify({
        channel: getChannel(db, channel.id),
        state: getShowState(db, channel.id, showId),
        log: db.prepare(`SELECT COUNT(*) AS n FROM play_log`).get()
      })

    const before = snapshot()
    const peeks = [peekNext(db, channel.id, seeded(8)), peekNext(db, channel.id, seeded(8))]
    expect(snapshot()).toBe(before)
    expect(peeks[0]?.episodeId).toBe(peeks[1]?.episodeId)

    const committed = pickNext(db, channel.id, seeded(8))
    expect(committed?.episodeId).toBe(peeks[0]?.episodeId)
    expect(committed?.unit.key).toBe(peeks[0]?.unit.key)
    expect(snapshot()).not.toBe(before)
  })

  it('reports the arc part that is actually next while an arc is locked', () => {
    const { showId, groupId, episodeIds } = seedArcShow(db)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setActiveArc(db, channel.id, groupId, 1)

    const peek = peekNext(db, channel.id, seeded(2))

    expect(peek?.episodeId).toBe(episodeIds[5])
    expect(peek?.arc).toEqual({ title: 'The Gathering', partIndex: 2, partCount: 3 })
    expect(getChannel(db, channel.id)?.activePartIndex).toBe(1)
  })
})

describe('progress control', () => {
  it('resetProgress rewinds the cursor and empties the bag without touching the lineup', () => {
    const showId = seedFlatShow(db, 'Reset me', 5)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setChannelShowMode(db, channel.id, showId, 'sequential')
    setChannelShowWeight(db, channel.id, showId, 3)
    const rng = seeded(6)
    pickNext(db, channel.id, rng)
    pickNext(db, channel.id, rng)
    expect(getShowState(db, channel.id, showId).cursorUnitIndex).toBe(2)

    resetProgress(db, channel.id, showId)

    const state = getShowState(db, channel.id, showId)
    expect(state.cursorUnitIndex).toBe(0)
    expect(state.shuffleBag).toEqual([])
    const detail = getChannelDetail(db, channel.id)
    expect(detail?.lineup[0].weight).toBe(3)
    expect(detail?.lineup[0].mode).toBe('sequential')
    expect(pickNext(db, channel.id, rng)?.unit.episode).toBe(1)
  })

  it('validateActiveArc clears a lock whose arc no longer exists', () => {
    const { showId, groupId } = seedArcShow(db)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setActiveArc(db, channel.id, groupId, 1)

    // The Library ungrouped the arc: the group survives with no parts left.
    db.prepare(`UPDATE episodes SET part_group_id = NULL, part_index = NULL WHERE part_group_id = ?`).run(
      groupId
    )

    validateActiveArc(db, channel.id)

    expect(getChannel(db, channel.id)?.activeGroupId).toBeNull()
    expect(getChannel(db, channel.id)?.activePartIndex).toBeNull()
  })

  it('validateActiveArc clears a lock whose part index is out of range', () => {
    const { showId, groupId } = seedArcShow(db)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setActiveArc(db, channel.id, groupId, 7)

    validateActiveArc(db, channel.id)

    expect(getChannel(db, channel.id)?.activeGroupId).toBeNull()
  })

  it('leaves a healthy lock alone', () => {
    const { showId, groupId } = seedArcShow(db)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setActiveArc(db, channel.id, groupId, 2)

    validateActiveArc(db, channel.id)

    expect(getChannel(db, channel.id)?.activeGroupId).toBe(groupId)
    expect(getChannel(db, channel.id)?.activePartIndex).toBe(2)
  })

  it('a deleted arc cannot wedge a channel: the next pick still returns an episode', () => {
    const { showId, groupId } = seedArcShow(db)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setActiveArc(db, channel.id, groupId, 1)
    db.prepare(`DELETE FROM part_groups WHERE id = ?`).run(groupId)

    const pick = pickNext(db, channel.id, seeded(12))

    expect(pick).not.toBeNull()
  })
})

describe('channel view models', () => {
  it('summarises the guide with an on-deck pick that is not consumed', () => {
    const showId = seedFlatShow(db, 'Guide show', 4)
    const channel = createChannel(db, 'Saturday Morning')
    addChannelShow(db, channel.id, showId)

    const before = db.prepare(`SELECT COUNT(*) AS n FROM play_log`).get() as { n: number }
    const summaries = listChannelSummaries(db)
    const after = db.prepare(`SELECT COUNT(*) AS n FROM play_log`).get() as { n: number }

    expect(summaries).toHaveLength(1)
    expect(summaries[0].channel.number).toBe(2)
    expect(summaries[0].showTitles).toEqual(['Guide show'])
    expect(summaries[0].onDeck?.showTitle).toBe('Guide show')
    expect(summaries[0].onDeck?.code).toMatch(/^S01E0\d$/)
    expect(after.n).toBe(before.n)
  })

  it('reports units, arcs and live progress for the channel editor', () => {
    const { showId, episodeIds } = seedArcShow(db)
    insertArc(db, showId, 'Doubles', [episodeIds[8], episodeIds[9]])
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setChannelShowMode(db, channel.id, showId, 'sequential')

    const detail = getChannelDetail(db, channel.id)
    const entry = detail?.lineup[0]

    expect(entry?.episodeCount).toBe(11)
    expect(entry?.unitCount).toBe(8) // 11 episodes − 2 collapsed arcs' extra parts
    expect(entry?.arcCount).toBe(2)
    expect(entry?.arcSummary).toBe('"THE GATHERING" ×3 + 1 MORE')
    expect(entry?.progress).toEqual({ kind: 'cursor', code: 'S01E01' })
    expect(detail?.totalUnits).toBe(8)
    expect(detail?.totalArcs).toBe(2)

    pickNext(db, channel.id, seeded(1))
    expect(getChannelDetail(db, channel.id)?.lineup[0].progress).toEqual({
      kind: 'cursor',
      code: 'S01E02'
    })
  })

  it('reports a shuffle bag as remaining-of-total, counting an empty bag as a fresh cycle', () => {
    const showId = seedFlatShow(db, 'Bagged', 6)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)

    expect(getChannelDetail(db, channel.id)?.lineup[0].progress).toEqual({
      kind: 'bag',
      remaining: 6,
      total: 6
    })

    const rng = seeded(3)
    pickNext(db, channel.id, rng)
    pickNext(db, channel.id, rng)

    expect(getChannelDetail(db, channel.id)?.lineup[0].progress).toEqual({
      kind: 'bag',
      remaining: 4,
      total: 6
    })
  })

  it('falls back to a plain arc count when no single arc dominates', () => {
    const { showId, episodeIds } = seedArcShow(db)
    insertArc(db, showId, 'Second', [episodeIds[7], episodeIds[8], episodeIds[9]])
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)

    expect(getChannelDetail(db, channel.id)?.lineup[0].arcSummary).toBe('2 ARCS')
  })

  it('returns null detail for a channel that does not exist', () => {
    expect(getChannelDetail(db, 999)).toBeNull()
  })
})

/**
 * Prewarm reservations — the third invariant in the module header. A prewarm
 * plans the next pick without spending it; only a promotion commits, and a
 * discarded reservation leaves the schedule exactly as it found it.
 */
describe('prewarm reservations', () => {
  function playLogCount(): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM play_log`).get() as { n: number }).n
  }

  it('reserving commits nothing and repeats the same pick until resolved', () => {
    const showId = seedFlatShow(db, 'Sequential', 5)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setChannelShowMode(db, channel.id, showId, 'sequential')

    const first = reserveNext(db, channel.id, seeded(1))
    const again = reserveNext(db, channel.id, seeded(99))
    expect(first?.episodeId).toBe(again?.episodeId)
    expect(playLogCount()).toBe(0)
    expect(getShowState(db, channel.id, showId).cursorUnitIndex).toBe(0)

    // The peek promises the reservation — the standby is buffering exactly it.
    expect(peekNext(db, channel.id, seeded(7))?.episodeId).toBe(first?.episodeId)
  })

  it('promoting spends the reservation exactly as pickNext would have', () => {
    const showId = seedFlatShow(db, 'Sequential', 5)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setChannelShowMode(db, channel.id, showId, 'sequential')

    const reserved = reserveNext(db, channel.id, seeded(1))!
    promoteReserved(db, channel.id, reserved.episodeId)

    expect(playLogCount()).toBe(1)
    expect(getShowState(db, channel.id, showId).cursorUnitIndex).toBe(1)
    // Spent: the next reservation is a fresh plan, not the old one replayed.
    expect(reserveNext(db, channel.id, seeded(1))?.episodeId).not.toBe(reserved.episodeId)
  })

  it('a discarded reservation leaves cursor, bag, arc lock and log untouched', () => {
    // The arc is the *first* unit, so the reservation is an arc start — the
    // case that used to lock the channel at Part 2 for a part nobody watched.
    const showId = insertShow(db, 'Arc first')
    const parts = [1, 2, 3].map((e) => insertEpisode(db, showId, 1, e))
    insertEpisode(db, showId, 1, 4)
    insertArc(db, showId, 'Opener', parts)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setChannelShowMode(db, channel.id, showId, 'sequential')

    const reserved = reserveNext(db, channel.id, seeded(1))!
    expect(reserved.arc).toMatchObject({ partIndex: 1, partCount: 3 })
    discardReserved(db, channel.id, reserved.episodeId)

    expect(playLogCount()).toBe(0)
    expect(getShowState(db, channel.id, showId).cursorUnitIndex).toBe(0)
    expect(getChannel(db, channel.id)?.activeGroupId).toBeNull()

    // The schedule was never touched, so the next commit airs the same unit.
    expect(pickNext(db, channel.id, seeded(1))?.episodeId).toBe(reserved.episodeId)
  })

  it('pickNext supersedes an outstanding reservation instead of stacking on it', () => {
    const showId = seedFlatShow(db, 'Sequential', 5)
    const channel = createChannel(db, 'Ch')
    addChannelShow(db, channel.id, showId)
    setChannelShowMode(db, channel.id, showId, 'sequential')

    const reserved = reserveNext(db, channel.id, seeded(1))!
    const committed = pickNext(db, channel.id, seeded(1))!

    // Same episode — the reservation never advanced the cursor, the pick did.
    expect(committed.episodeId).toBe(reserved.episodeId)
    expect(getShowState(db, channel.id, showId).cursorUnitIndex).toBe(1)
    // And the reservation is gone: promoting it now must not double-spend.
    promoteReserved(db, channel.id, reserved.episodeId)
    expect(getShowState(db, channel.id, showId).cursorUnitIndex).toBe(1)
    expect(playLogCount()).toBe(2) // both airings logged, one schedule step each
  })
})
