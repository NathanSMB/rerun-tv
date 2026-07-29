/**
 * Channel view models — the shapes the renderer actually draws (plan §8,
 * mockup Screens 01 and 03).
 *
 * The repository layer returns rows; this layer answers questions the UI asks:
 * "what's on deck for every channel?" and "what does this lineup look like
 * right now?". Two things it deliberately does *not* do: touch SQL for the
 * lineup itself (that is `db/repositories/channels.ts`) and consume the
 * schedule (the guide's on-deck line is a `peekNext`, never a `pickNext`).
 *
 * The Channel Editor shows episode counts and unit counts side by side on
 * purpose — that is how a five-parter visibly holds exactly one lottery ticket.
 */

import type {
  ChannelDetail,
  ChannelSummary,
  EpisodeView,
  LineupEntry,
  LineupProgress,
  PlayableUnit
} from '@shared/types.js'
import { episodeCode } from '@shared/playback.js'
import type { Db } from '../db/index.js'
import {
  getChannel,
  getShowState,
  listChannels,
  listChannelShows,
  listChannelShowSeasonModes
} from '../db/repositories/channels.js'
import { peekNext } from '../scheduler/scheduler.js'
import { buildUnits } from '../scheduler/units.js'

interface EpisodeViewRow {
  id: number
  showId: number
  showTitle: string
  season: number
  episode: number
  episodeEnd: number | null
  title: string | null
  durationS: number
  playbackPath: EpisodeView['playbackPath']
}

const EPISODE_VIEW_SQL = `
  SELECT e.id            AS id,
         e.show_id       AS showId,
         s.title         AS showTitle,
         e.season        AS season,
         e.episode       AS episode,
         e.episode_end   AS episodeEnd,
         e.title         AS title,
         e.duration_s    AS durationS,
         e.playback_path AS playbackPath
    FROM episodes e
    JOIN shows s ON s.id = e.show_id
   WHERE e.id = ?`

/** An episode flattened for the guide and the OSD, with its `S04E11` code built in. */
export function toEpisodeView(db: Db, episodeId: number): EpisodeView | null {
  const row = db.prepare(EPISODE_VIEW_SQL).get(episodeId) as EpisodeViewRow | undefined
  if (!row) return null
  return {
    id: row.id,
    showId: row.showId,
    showTitle: row.showTitle,
    season: row.season,
    episode: row.episode,
    episodeEnd: row.episodeEnd,
    title: row.title,
    code: episodeCode(row.season, row.episode, row.episodeEnd),
    durationS: row.durationS,
    playbackPath: row.playbackPath
  }
}

/**
 * The guide: every channel in dial order with its lineup's show titles and the
 * scheduler's *actual* next pick. On-deck comes from `peekNext`, so the guide
 * tells the truth without spending the schedule — for a shuffle show it is one
 * plausible draw, which is exactly what "what's on next" means on a channel
 * that shuffles.
 */
export function listChannelSummaries(db: Db): ChannelSummary[] {
  return listChannels(db).map((channel) => {
    const showTitles = (
      db
        .prepare(
          `SELECT s.title AS title
             FROM channel_shows cs
             JOIN shows s ON s.id = cs.show_id
            WHERE cs.channel_id = ?
            ORDER BY cs.sort_order, cs.show_id`
        )
        .all(channel.id) as { title: string }[]
    ).map((r) => r.title)

    const pick = peekNext(db, channel.id)
    return {
      channel,
      showTitles,
      onDeck: pick ? toEpisodeView(db, pick.episodeId) : null
    }
  })
}

/**
 * The Channel Editor's whole payload: one entry per show with its live
 * scheduling state, plus the header's "213 playable units · 6 multipart arcs"
 * totals.
 */
export function getChannelDetail(db: Db, channelId: number): ChannelDetail | null {
  const channel = getChannel(db, channelId)
  if (!channel) return null

  const lineup: LineupEntry[] = listChannelShows(db, channelId).map((entry) => {
    const show = db.prepare(`SELECT title FROM shows WHERE id = ?`).get(entry.showId) as
      | { title: string }
      | undefined
    const { count: episodeCount } = db
      .prepare(`SELECT COUNT(*) AS count FROM episodes WHERE show_id = ?`)
      .get(entry.showId) as { count: number }

    const units = buildUnits(db, entry.showId)
    const arcs = units.filter((u) => u.kind === 'arc')
    const state = getShowState(db, channelId, entry.showId)
    const overrides = new Map(
      listChannelShowSeasonModes(db, channelId, entry.showId).map((item) => [
        item.season,
        item.mode
      ])
    )
    const seasons = (
      db
        .prepare(
          `SELECT season, COUNT(*) AS episodeCount
             FROM episodes
            WHERE show_id = ?
            GROUP BY season
            ORDER BY season`
        )
        .all(entry.showId) as { season: number; episodeCount: number }[]
    ).map((season) => ({
      ...season,
      modeOverride: overrides.get(season.season) ?? null,
      effectiveMode: overrides.get(season.season) ?? entry.mode
    }))

    let progress: LineupProgress
    if (seasons.every((season) => season.effectiveMode === 'sequential')) {
      const cursor =
        state.cursorUnitIndex >= 0 && state.cursorUnitIndex < units.length
          ? state.cursorUnitIndex
          : 0
      progress = { kind: 'cursor', code: units.length > 0 ? unitCode(db, units[cursor]) : null }
    } else {
      const live = new Set(units.map((u) => u.key))
      const remaining = state.shuffleBag.filter((key) => live.has(key)).length
      // An empty bag is not "0 left" — it is a cycle about to be dealt, so the
      // honest remaining count is the full unit list.
      progress = {
        kind: 'bag',
        remaining: remaining === 0 ? units.length : remaining,
        total: units.length
      }
    }

    return {
      showId: entry.showId,
      title: show?.title ?? `Show ${entry.showId}`,
      mode: entry.mode,
      weight: entry.weight,
      episodeCount,
      unitCount: units.length,
      arcCount: arcs.length,
      arcSummary: summarizeArcs(arcs),
      seasons,
      progress
    }
  })

  return {
    channel,
    lineup,
    totalUnits: lineup.reduce((sum, e) => sum + e.unitCount, 0),
    totalArcs: lineup.reduce((sum, e) => sum + e.arcCount, 0)
  }
}

/** The episode code a unit leads with — what the sequential cursor is "parked on". */
function unitCode(db: Db, unit: PlayableUnit): string | null {
  const row = db
    .prepare(`SELECT season, episode, episode_end AS episodeEnd FROM episodes WHERE id = ?`)
    .get(unit.episodeIds[0]) as
    | { season: number; episode: number; episodeEnd: number | null }
    | undefined
  return row ? episodeCode(row.season, row.episode, row.episodeEnd) : null
}

/**
 * The arc badge, in the mockup's voice: `"AWAKENING" ×5 + 2 MORE` when one arc
 * clearly dominates the show, otherwise a plain `3 ARCS`.
 *
 * "Dominant" means a single longest arc of at least three parts — the kind of
 * multiparter people name. A show whose arcs are all two-part doubles has no
 * headline, so it just gets a count.
 */
function summarizeArcs(arcs: PlayableUnit[]): string | null {
  if (arcs.length === 0) return null
  const byLength = arcs.slice().sort((a, b) => b.episodeIds.length - a.episodeIds.length)
  const top = byLength[0]
  const runnerUp = byLength[1]
  const dominant =
    top.episodeIds.length >= 3 &&
    (runnerUp === undefined || top.episodeIds.length > runnerUp.episodeIds.length)

  if (!dominant) return arcs.length === 1 ? '1 ARC' : `${arcs.length} ARCS`
  const head = `"${top.title.toUpperCase()}" ×${top.episodeIds.length}`
  return arcs.length > 1 ? `${head} + ${arcs.length - 1} MORE` : head
}
