/**
 * Playable units (plan §4, "the key abstraction").
 *
 * A *unit* is either one standalone episode or an entire multipart arc. Every
 * scheduling structure in the app — sequential cursors, shuffle bags, and the
 * weighted lottery — indexes units, never raw episodes. That single choice is
 * what makes an arc uninterruptible *and* exactly as likely to air as any other
 * pick: "The Gathering, Parts 1–3" holds one lottery ticket, not three. If the
 * lottery drew episodes instead, a three-parter would start almost three times
 * as often as a standalone — and could start at Part 2.
 *
 * Units are derived, never stored. They are rebuilt from `episodes` +
 * `part_groups` on demand, which is why bags and cursors reference *keys*
 * (`ep:12`, `arc:4`) rather than positions: regrouping episodes in the Library
 * reshapes the unit list, and stale keys simply drop out (see `scheduler.ts`).
 */

import type { PlayableUnit } from '@shared/types.js'
import { episodeCode } from '@shared/playback.js'
import type { Db } from '../db/index.js'

interface EpisodeRow {
  id: number
  season: number
  episode: number
  episode_end: number | null
  title: string | null
  part_group_id: number | null
  part_index: number | null
}

/** Shuffle-bag identity for a standalone episode. */
export function unitKeyForEpisode(episodeId: number): string {
  return `ep:${episodeId}`
}

/** Shuffle-bag identity for a whole multipart arc. */
export function unitKeyForArc(groupId: number): string {
  return `arc:${groupId}`
}

/**
 * The show's units in season/episode order.
 *
 * Episodes that belong to a `part_group` collapse into a single `arc` unit,
 * positioned where the arc's first part sits in the season/episode ordering,
 * with `episodeIds` in `part_index` order (that is the airing order the arc
 * will be handed out in, and it is the Library's source of truth — not the
 * filename order). Everything else becomes its own `episode` unit.
 *
 * A group holding a single episode still yields an `arc` unit; the scheduler
 * simply never locks the channel for it because there is no Part 2 to protect.
 */
export function buildUnits(db: Db, showId: number): PlayableUnit[] {
  const episodes = db
    .prepare(
      `SELECT id, season, episode, episode_end, title, part_group_id, part_index
         FROM episodes
        WHERE show_id = ?
        ORDER BY season, episode, id`
    )
    .all(showId) as EpisodeRow[]

  const arcTitles = new Map<number, string>()
  for (const row of db
    .prepare(`SELECT id, title FROM part_groups WHERE show_id = ?`)
    .all(showId) as { id: number; title: string }[]) {
    arcTitles.set(row.id, row.title)
  }

  // Gather each arc's parts first so we can order them by part_index, then walk
  // the show once more to place each arc at its first part's position.
  const partsByGroup = new Map<number, EpisodeRow[]>()
  for (const row of episodes) {
    if (row.part_group_id == null) continue
    const parts = partsByGroup.get(row.part_group_id)
    if (parts) parts.push(row)
    else partsByGroup.set(row.part_group_id, [row])
  }
  for (const parts of partsByGroup.values()) {
    parts.sort((a, b) => {
      // Missing part_index sorts last; ties fall back to airing order.
      const ai = a.part_index ?? Number.MAX_SAFE_INTEGER
      const bi = b.part_index ?? Number.MAX_SAFE_INTEGER
      if (ai !== bi) return ai - bi
      if (a.season !== b.season) return a.season - b.season
      if (a.episode !== b.episode) return a.episode - b.episode
      return a.id - b.id
    })
  }

  const units: PlayableUnit[] = []
  const emitted = new Set<number>()

  for (const row of episodes) {
    if (row.part_group_id == null) {
      units.push({
        key: unitKeyForEpisode(row.id),
        kind: 'episode',
        showId,
        title: row.title ?? episodeCode(row.season, row.episode, row.episode_end),
        episodeIds: [row.id],
        season: row.season,
        episode: row.episode
      })
      continue
    }

    const groupId = row.part_group_id
    if (emitted.has(groupId)) continue
    emitted.add(groupId)

    const parts = partsByGroup.get(groupId) ?? [row]
    const first = parts[0]
    units.push({
      key: unitKeyForArc(groupId),
      kind: 'arc',
      showId,
      title: arcTitles.get(groupId) ?? first.title ?? episodeCode(first.season, first.episode),
      episodeIds: parts.map((p) => p.id),
      season: first.season,
      episode: first.episode
    })
  }

  return units
}
