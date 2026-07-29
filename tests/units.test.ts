/**
 * Unit construction — the abstraction every scheduling structure indexes.
 */

import { describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '@main/db/index.js'
import { buildUnits, unitKeyForArc, unitKeyForEpisode } from '@main/scheduler/units.js'

function insertShow(db: Db, title: string): number {
  return Number(
    db
      .prepare(`INSERT INTO shows (title, folder_path, added_at) VALUES (?, ?, 0)`)
      .run(title, `/tv/${title}`).lastInsertRowid
  )
}

function insertEpisode(
  db: Db,
  showId: number,
  season: number,
  episode: number,
  title: string | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO episodes (show_id, season, episode, title, path, duration_s)
         VALUES (?, ?, ?, ?, ?, 1200)`
      )
      .run(showId, season, episode, title, `/tv/${showId}/S${season}E${episode}.mkv`).lastInsertRowid
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

/** 11 episodes: S01E01–E04 standalone, E05–E07 a 3-part arc, E08–E11 standalone. */
function seedShow(db: Db): { showId: number; groupId: number; episodeIds: number[] } {
  const showId = insertShow(db, 'Gargoyles')
  const episodeIds: number[] = []
  for (let e = 1; e <= 11; e++) {
    episodeIds.push(insertEpisode(db, showId, 1, e, e === 1 ? 'Awakening' : null))
  }
  const groupId = insertArc(db, showId, 'The Gathering', [
    episodeIds[4],
    episodeIds[5],
    episodeIds[6]
  ])
  return { showId, groupId, episodeIds }
}

describe('buildUnits', () => {
  it('collapses a 3-part arc so 8 standalones + one arc yield 9 units', () => {
    const db = openDatabase(':memory:')
    const { showId, groupId, episodeIds } = seedShow(db)

    const units = buildUnits(db, showId)

    expect(units).toHaveLength(9)
    expect(units.filter((u) => u.kind === 'arc')).toHaveLength(1)
    expect(units.filter((u) => u.kind === 'episode')).toHaveLength(8)

    // The arc sits where its first part sits: after E01–E04, before E08.
    expect(units[4].key).toBe(unitKeyForArc(groupId))
    expect(units[3].key).toBe(unitKeyForEpisode(episodeIds[3]))
    expect(units[5].key).toBe(unitKeyForEpisode(episodeIds[7]))
    expect(units[4].season).toBe(1)
    expect(units[4].episode).toBe(5)
    db.close()
  })

  it('orders arc episodeIds by part_index, not by file order', () => {
    const db = openDatabase(':memory:')
    const showId = insertShow(db, 'Babylon 5')
    const a = insertEpisode(db, showId, 1, 1)
    const b = insertEpisode(db, showId, 1, 2)
    const c = insertEpisode(db, showId, 1, 3)
    const groupId = Number(
      db
        .prepare(`INSERT INTO part_groups (show_id, title, source) VALUES (?, 'Chrysalis', 'manual')`)
        .run(showId).lastInsertRowid
    )
    // Deliberately reversed: part_index is the source of truth.
    const link = db.prepare(`UPDATE episodes SET part_group_id = ?, part_index = ? WHERE id = ?`)
    link.run(groupId, 3, a)
    link.run(groupId, 1, b)
    link.run(groupId, 2, c)

    const units = buildUnits(db, showId)

    expect(units).toHaveLength(1)
    expect(units[0].episodeIds).toEqual([b, c, a])
    expect(units[0].title).toBe('Chrysalis')
    db.close()
  })

  it('titles episode units with the episode title, falling back to its code', () => {
    const db = openDatabase(':memory:')
    const { showId } = seedShow(db)

    const units = buildUnits(db, showId)

    expect(units[0].title).toBe('Awakening')
    expect(units[1].title).toBe('S01E02')
    expect(units[4].title).toBe('The Gathering')
    db.close()
  })

  it('keys are stable and shaped ep:<id> / arc:<id>', () => {
    expect(unitKeyForEpisode(12)).toBe('ep:12')
    expect(unitKeyForArc(4)).toBe('arc:4')
  })

  it('orders units by season then episode across seasons', () => {
    const db = openDatabase(':memory:')
    const showId = insertShow(db, 'DuckTales')
    insertEpisode(db, showId, 2, 1)
    insertEpisode(db, showId, 1, 10)
    insertEpisode(db, showId, 1, 2)

    const units = buildUnits(db, showId)

    expect(units.map((u) => [u.season, u.episode])).toEqual([
      [1, 2],
      [1, 10],
      [2, 1]
    ])
    db.close()
  })

  it('returns an empty list for a show with no episodes', () => {
    const db = openDatabase(':memory:')
    const showId = insertShow(db, 'Empty')
    expect(buildUnits(db, showId)).toEqual([])
    db.close()
  })
})
