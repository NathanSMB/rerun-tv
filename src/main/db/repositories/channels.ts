/**
 * All SQL for the channel side of the database: `channels`, `channel_shows`,
 * `channel_show_state` and `play_log` (plan §4).
 *
 * The split the schema insists on is honoured here: `channel_shows` is
 * *configuration* (the lineup you built — mode, weight, order) while
 * `channel_show_state` is *progress* (a cursor and a shuffle bag). "Reset
 * progress" therefore never touches the lineup, and rebuilding a lineup never
 * silently rewinds a show.
 *
 * Rows are camel-cased into the `@shared/types.js` shapes at this boundary, so
 * nothing above the repository ever sees snake_case. Callers that need several
 * of these calls to be atomic (the scheduler does) wrap them in their own
 * `db.transaction`; better-sqlite3 nests transactions as savepoints, so it is
 * safe for these functions to open their own too.
 */

import type {
  Channel,
  ChannelShow,
  ChannelShowState,
  PlayMode,
  UpdateChannelInput
} from '@shared/types.js'
import type { Db } from '../index.js'

interface ChannelRow {
  id: number
  name: string
  number: number
  accent: string | null
  active_group_id: number | null
  active_part_index: number | null
  sort_order: number
}

interface ChannelShowRow {
  channel_id: number
  show_id: number
  mode: PlayMode
  weight: number
}

interface ChannelShowStateRow {
  channel_id: number
  show_id: number
  cursor_unit_index: number
  shuffle_bag: string
}

function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    name: row.name,
    number: row.number,
    accent: row.accent,
    activeGroupId: row.active_group_id,
    activePartIndex: row.active_part_index,
    sortOrder: row.sort_order
  }
}

/**
 * A stored bag is a JSON array of unit keys. Anything unparseable is treated as
 * an empty bag rather than throwing — a corrupt bag costs one reshuffle, while
 * a throw would wedge the channel.
 */
function parseBag(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** Every channel in guide order: explicit `sort_order` first, dial number as tiebreak. */
export function listChannels(db: Db): Channel[] {
  const rows = db
    .prepare(`SELECT * FROM channels ORDER BY sort_order, number`)
    .all() as ChannelRow[]
  return rows.map(toChannel)
}

export function getChannel(db: Db, channelId: number): Channel | null {
  const row = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(channelId) as
    | ChannelRow
    | undefined
  return row ? toChannel(row) : null
}

/**
 * The lowest unused dial number, starting at 2 — channel 1 is left for the
 * user to claim deliberately, and gaps left by deleted channels get reused
 * before the dial keeps climbing.
 */
function nextFreeNumber(db: Db): number {
  const used = new Set(
    (db.prepare(`SELECT number FROM channels`).all() as { number: number }[]).map((r) => r.number)
  )
  let n = 2
  while (used.has(n)) n++
  return n
}

/**
 * Create a channel, appending it to the end of the guide. `number` is the dial
 * number and is unique; when omitted the next free one is assigned.
 */
export function createChannel(db: Db, name: string, number?: number): Channel {
  return db.transaction(() => {
    const dial = number ?? nextFreeNumber(db)
    const { max } = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS max FROM channels`).get() as {
      max: number
    }
    const info = db
      .prepare(`INSERT INTO channels (name, number, sort_order) VALUES (?, ?, ?)`)
      .run(name, dial, max + 1)
    const created = getChannel(db, Number(info.lastInsertRowid))
    if (!created) throw new Error('Channel insert did not produce a row')
    return created
  })()
}

/** Patch name/number/accent. Absent keys are left alone; `accent: null` clears it. */
export function updateChannel(db: Db, channelId: number, patch: UpdateChannelInput): Channel {
  const sets: string[] = []
  const values: (string | number | null)[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    values.push(patch.name)
  }
  if (patch.number !== undefined) {
    sets.push('number = ?')
    values.push(patch.number)
  }
  if ('accent' in patch) {
    sets.push('accent = ?')
    values.push(patch.accent ?? null)
  }
  if (sets.length > 0) {
    values.push(channelId)
    db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  }
  const updated = getChannel(db, channelId)
  if (!updated) throw new Error(`No such channel: ${channelId}`)
  return updated
}

/** Lineup, state and play log go with it — foreign keys are ON and cascade. */
export function deleteChannel(db: Db, channelId: number): void {
  db.prepare(`DELETE FROM channels WHERE id = ?`).run(channelId)
}

/** Persist a drag-reorder of the guide: `channelIds` in display order. */
export function reorderChannels(db: Db, channelIds: number[]): void {
  const update = db.prepare(`UPDATE channels SET sort_order = ? WHERE id = ?`)
  db.transaction(() => {
    channelIds.forEach((id, index) => update.run(index, id))
  })()
}

/**
 * Lock (or unlock) the channel onto a multipart arc. `partIndex` is the
 * 0-based index of the part that will be handed out *next*; passing
 * `(null, null)` releases the channel back to the lottery.
 */
export function setActiveArc(
  db: Db,
  channelId: number,
  groupId: number | null,
  partIndex: number | null
): void {
  db.prepare(`UPDATE channels SET active_group_id = ?, active_part_index = ? WHERE id = ?`).run(
    groupId,
    groupId == null ? null : partIndex,
    channelId
  )
}

// ---------------------------------------------------------------------------
// Lineup — configuration
// ---------------------------------------------------------------------------

/** The channel's lineup in editor order. */
export function listChannelShows(db: Db, channelId: number): ChannelShow[] {
  const rows = db
    .prepare(
      `SELECT channel_id, show_id, mode, weight
         FROM channel_shows
        WHERE channel_id = ?
        ORDER BY sort_order, show_id`
    )
    .all(channelId) as ChannelShowRow[]
  return rows.map((r) => ({
    channelId: r.channel_id,
    showId: r.show_id,
    mode: r.mode,
    weight: r.weight
  }))
}

/**
 * Add a show to the lineup (shuffle, weight 1 by default) and create its
 * progress row in the same breath, so the scheduler never has to care whether
 * state exists. Re-adding a show that is already in the lineup is a no-op and
 * keeps its progress.
 */
export function addChannelShow(db: Db, channelId: number, showId: number): void {
  db.transaction(() => {
    const { max } = db
      .prepare(`SELECT COALESCE(MAX(sort_order), -1) AS max FROM channel_shows WHERE channel_id = ?`)
      .get(channelId) as { max: number }
    db.prepare(
      `INSERT OR IGNORE INTO channel_shows (channel_id, show_id, mode, weight, sort_order)
       VALUES (?, ?, 'shuffle', 1, ?)`
    ).run(channelId, showId, max + 1)
    db.prepare(
      `INSERT OR IGNORE INTO channel_show_state (channel_id, show_id, cursor_unit_index, shuffle_bag)
       VALUES (?, ?, 0, '[]')`
    ).run(channelId, showId)
  })()
}

/** Drop a show from the lineup, discarding its cursor and bag with it. */
export function removeChannelShow(db: Db, channelId: number, showId: number): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM channel_shows WHERE channel_id = ? AND show_id = ?`).run(
      channelId,
      showId
    )
    db.prepare(`DELETE FROM channel_show_state WHERE channel_id = ? AND show_id = ?`).run(
      channelId,
      showId
    )
  })()
}

/** `sequential` keeps a cursor, `shuffle` deals a bag. Progress is left intact. */
export function setChannelShowMode(
  db: Db,
  channelId: number,
  showId: number,
  mode: PlayMode
): void {
  db.prepare(`UPDATE channel_shows SET mode = ? WHERE channel_id = ? AND show_id = ?`).run(
    mode,
    channelId,
    showId
  )
}

/** Lottery weight: a show at weight 2 is drawn twice as often as one at weight 1. */
export function setChannelShowWeight(
  db: Db,
  channelId: number,
  showId: number,
  weight: number
): void {
  db.prepare(`UPDATE channel_shows SET weight = ? WHERE channel_id = ? AND show_id = ?`).run(
    weight,
    channelId,
    showId
  )
}

// ---------------------------------------------------------------------------
// Progress — state
// ---------------------------------------------------------------------------

/**
 * Never null: a show with no state row behaves exactly like a freshly added one
 * (cursor at the pilot, empty bag that will be dealt on first draw). That keeps
 * the scheduler free of "does state exist yet" branches.
 */
export function getShowState(db: Db, channelId: number, showId: number): ChannelShowState {
  const row = db
    .prepare(`SELECT * FROM channel_show_state WHERE channel_id = ? AND show_id = ?`)
    .get(channelId, showId) as ChannelShowStateRow | undefined
  return {
    channelId,
    showId,
    cursorUnitIndex: row?.cursor_unit_index ?? 0,
    shuffleBag: row ? parseBag(row.shuffle_bag) : []
  }
}

/** Upsert a whole state object. The bag is stored as a JSON array of unit keys. */
export function saveShowState(db: Db, state: ChannelShowState): void {
  db.prepare(
    `INSERT INTO channel_show_state (channel_id, show_id, cursor_unit_index, shuffle_bag)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (channel_id, show_id)
     DO UPDATE SET cursor_unit_index = excluded.cursor_unit_index,
                   shuffle_bag       = excluded.shuffle_bag`
  ).run(state.channelId, state.showId, state.cursorUnitIndex, JSON.stringify(state.shuffleBag))
}

/** Cursor back to the pilot, bag emptied so the next draw deals a fresh cycle. */
export function resetShowState(db: Db, channelId: number, showId: number): void {
  saveShowState(db, { channelId, showId, cursorUnitIndex: 0, shuffleBag: [] })
}

// ---------------------------------------------------------------------------
// Play log
// ---------------------------------------------------------------------------

/**
 * Record an airing. Written the moment the scheduler commits a pick, with
 * `completed` false — the player flips it once the episode actually finishes
 * (see `markLastAiringCompleted`). The log is what `lastAired` reads to keep a
 * refilled shuffle bag from repeating the episode that just played, and it is
 * the raw material a post-MVP simulated-live schedule will need.
 */
export function logAiring(db: Db, channelId: number, episodeId: number, completed: boolean): void {
  db.prepare(`INSERT INTO play_log (channel_id, episode_id, at, completed) VALUES (?, ?, ?, ?)`).run(
    channelId,
    episodeId,
    Date.now(),
    completed ? 1 : 0
  )
}

/**
 * Flip the outcome of the most recent airing of `episodeId` on this channel.
 * Skipping away mid-episode leaves it `false`; playing to `ended` sets it true.
 */
export function markLastAiringCompleted(
  db: Db,
  channelId: number,
  episodeId: number,
  completed: boolean
): void {
  db.prepare(
    `UPDATE play_log
        SET completed = ?
      WHERE id = (SELECT id FROM play_log
                   WHERE channel_id = ? AND episode_id = ?
                   ORDER BY at DESC, id DESC
                   LIMIT 1)`
  ).run(completed ? 1 : 0, channelId, episodeId)
}

/** The last episode of `showId` this channel aired, or null if it never has. */
export function lastAired(db: Db, channelId: number, showId: number): number | null {
  const row = db
    .prepare(
      `SELECT p.episode_id AS episodeId
         FROM play_log p
         JOIN episodes e ON e.id = p.episode_id
        WHERE p.channel_id = ? AND e.show_id = ?
        ORDER BY p.at DESC, p.id DESC
        LIMIT 1`
    )
    .get(channelId, showId) as { episodeId: number } | undefined
  return row?.episodeId ?? null
}
