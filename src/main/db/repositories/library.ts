/**
 * Every SQL statement that touches the library tables (plan §4).
 *
 * This is the camel-case boundary: rows come out of SQLite in snake_case and
 * leave this module shaped exactly like the interfaces in `shared/types.ts`, so
 * nothing above it — services, IPC, renderer — ever sees a column name.
 *
 * better-sqlite3 is synchronous, so a "transaction" here is genuinely atomic
 * with no await points for other work to interleave at. Arc mutations lean on
 * that: they rewrite `part_group_id`/`part_index` across several episode rows
 * and must never be observed half-applied.
 */

import type {
  ArcSource,
  ArcView,
  Episode,
  ScanRoot,
  Show,
  UnmatchedFile
} from '@shared/types.js'
import { episodeCode } from '@shared/playback.js'
import type { Db } from '../index.js'

/** An episode with no id yet — what the scanner hands to `upsertEpisode`. */
export type EpisodeInput = Omit<Episode, 'id'>

/**
 * SQLite refuses more than 32k bound parameters per statement, and a big
 * library can easily hold more paths than that. Everything that fans a list out
 * into an `IN (...)` clause chunks at this size.
 */
const PARAM_CHUNK = 500

// ---------------------------------------------------------------------------
// Row shapes (snake_case, straight from SQLite)
// ---------------------------------------------------------------------------

interface ShowRow {
  id: number
  title: string
  folder_path: string
  added_at: number
}

interface EpisodeRow {
  id: number
  show_id: number
  season: number
  episode: number
  episode_end: number | null
  title: string | null
  path: string
  duration_s: number
  container: string
  vcodec: string
  acodec: string
  width: number | null
  height: number | null
  part_group_id: number | null
  part_index: number | null
  playback_path: string
  mtime_ms: number
  size_bytes: number
}

interface ScanRootRow {
  id: number
  path: string
  added_at: number
}

interface UnmatchedRow {
  id: number
  path: string
  reason: string
  mtime_ms: number
  size_bytes: number
}

function toShow(row: ShowRow): Show {
  return { id: row.id, title: row.title, folderPath: row.folder_path, addedAt: row.added_at }
}

function toEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    showId: row.show_id,
    season: row.season,
    episode: row.episode,
    episodeEnd: row.episode_end,
    title: row.title,
    path: row.path,
    durationS: row.duration_s,
    container: row.container,
    vcodec: row.vcodec,
    acodec: row.acodec,
    width: row.width,
    height: row.height,
    partGroupId: row.part_group_id,
    partIndex: row.part_index,
    playbackPath: row.playback_path as Episode['playbackPath'],
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes
  }
}

function toScanRoot(row: ScanRootRow): ScanRoot {
  return { id: row.id, path: row.path, addedAt: row.added_at }
}

function toUnmatched(row: UnmatchedRow): UnmatchedFile {
  return {
    id: row.id,
    path: row.path,
    reason: row.reason,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes
  }
}

/** Split a long id/path list into statement-sized chunks. */
function chunk<T>(items: T[], size = PARAM_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** `?, ?, ?` for an `IN` clause. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

// ---------------------------------------------------------------------------
// Shows
// ---------------------------------------------------------------------------

/** All shows, alphabetically — the order the Library screen and pickers use. */
export function listShows(db: Db): Show[] {
  const rows = db
    .prepare('SELECT * FROM shows ORDER BY title COLLATE NOCASE, id')
    .all() as ShowRow[]
  return rows.map(toShow)
}

export function getShow(db: Db, showId: number): Show | null {
  const row = db.prepare('SELECT * FROM shows WHERE id = ?').get(showId) as ShowRow | undefined
  return row ? toShow(row) : null
}

/**
 * A show's identity is its folder, not its title: renaming `Gargoyles` to
 * `Gargoyles (1994)` in the parser must not orphan the channel lineups that
 * already point at it.
 */
export function getShowByFolder(db: Db, folderPath: string): Show | null {
  const row = db.prepare('SELECT * FROM shows WHERE folder_path = ?').get(folderPath) as
    | ShowRow
    | undefined
  return row ? toShow(row) : null
}

/**
 * Insert the show, or refresh the title of the existing row for this folder.
 * Called once per file during a scan, so it must be cheap and idempotent.
 */
export function upsertShow(db: Db, title: string, folderPath: string): Show {
  db.prepare(
    `INSERT INTO shows (title, folder_path, added_at)
     VALUES (?, ?, ?)
     ON CONFLICT(folder_path) DO UPDATE SET title = excluded.title`
  ).run(title, folderPath, Date.now())
  return getShowByFolder(db, folderPath) as Show
}

/** Removes the show and — via `ON DELETE CASCADE` — its episodes and arcs. */
export function deleteShow(db: Db, showId: number): void {
  db.prepare('DELETE FROM shows WHERE id = ?').run(showId)
}

/**
 * Drop shows that no longer have a single episode. Called at the end of a scan:
 * a folder the user deleted from disk should not linger in the Library screen
 * (and in channel lineups) as an empty entry. Returns how many were removed.
 */
export function deleteEmptyShows(db: Db): number {
  const info = db
    .prepare('DELETE FROM shows WHERE NOT EXISTS (SELECT 1 FROM episodes WHERE show_id = shows.id)')
    .run()
  return info.changes
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

/** A show's episodes in airing order — the order units are built in. */
export function listEpisodes(db: Db, showId: number): Episode[] {
  const rows = db
    .prepare('SELECT * FROM episodes WHERE show_id = ? ORDER BY season, episode, id')
    .all(showId) as EpisodeRow[]
  return rows.map(toEpisode)
}

export function getEpisode(db: Db, episodeId: number): Episode | null {
  const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId) as
    | EpisodeRow
    | undefined
  return row ? toEpisode(row) : null
}

/**
 * Batch fetch, returned in *airing* order rather than the order of `ids` —
 * callers (arc playback, unit building) want the sequence, not the argument
 * order.
 */
export function getEpisodesByIds(db: Db, ids: number[]): Episode[] {
  if (ids.length === 0) return []
  const rows: EpisodeRow[] = []
  for (const part of chunk(ids)) {
    rows.push(
      ...(db
        .prepare(`SELECT * FROM episodes WHERE id IN (${placeholders(part.length)})`)
        .all(...part) as EpisodeRow[])
    )
  }
  rows.sort((a, b) => a.season - b.season || a.episode - b.episode || a.id - b.id)
  return rows.map(toEpisode)
}

/** The rescan lookup: `path` is unique, and mtime+size decide whether to re-probe. */
export function findEpisodeByPath(db: Db, path: string): Episode | null {
  const row = db.prepare('SELECT * FROM episodes WHERE path = ?').get(path) as
    | EpisodeRow
    | undefined
  return row ? toEpisode(row) : null
}

/**
 * Insert or refresh the episode at this path and return its id.
 *
 * Arc membership is deliberately *not* part of the update: the scanner has no
 * opinion about `part_group_id`/`part_index` (it passes nulls) and a rescan must
 * not silently dissolve arcs the user grouped by hand. Membership is only ever
 * changed through `createArc`/`deleteArc`.
 */
export function upsertEpisode(db: Db, row: EpisodeInput): number {
  db.prepare(
    `INSERT INTO episodes (
       show_id, season, episode, episode_end, title, path,
       duration_s, container, vcodec, acodec, width, height,
       part_group_id, part_index, playback_path, mtime_ms, size_bytes
     ) VALUES (
       @showId, @season, @episode, @episodeEnd, @title, @path,
       @durationS, @container, @vcodec, @acodec, @width, @height,
       @partGroupId, @partIndex, @playbackPath, @mtimeMs, @sizeBytes
     )
     ON CONFLICT(path) DO UPDATE SET
       show_id      = excluded.show_id,
       season       = excluded.season,
       episode      = excluded.episode,
       episode_end  = excluded.episode_end,
       title        = excluded.title,
       duration_s   = excluded.duration_s,
       container    = excluded.container,
       vcodec       = excluded.vcodec,
       acodec       = excluded.acodec,
       width        = excluded.width,
       height       = excluded.height,
       playback_path= excluded.playback_path,
       mtime_ms     = excluded.mtime_ms,
       size_bytes   = excluded.size_bytes`
  ).run({
    showId: row.showId,
    season: row.season,
    episode: row.episode,
    episodeEnd: row.episodeEnd,
    title: row.title,
    path: row.path,
    durationS: row.durationS,
    container: row.container,
    vcodec: row.vcodec,
    acodec: row.acodec,
    width: row.width,
    height: row.height,
    partGroupId: row.partGroupId,
    partIndex: row.partIndex,
    playbackPath: row.playbackPath,
    mtimeMs: row.mtimeMs,
    sizeBytes: row.sizeBytes
  })

  const found = db.prepare('SELECT id FROM episodes WHERE path = ?').get(row.path) as
    | { id: number }
    | undefined
  if (!found) throw new Error(`upsertEpisode: row vanished for ${row.path}`)
  return found.id
}

/**
 * Prune a show down to the files that still exist. `keepPaths` is what the scan
 * actually saw; anything else in this show is gone from disk.
 *
 * An empty `keepPaths` deletes every episode of the show, which is intentional —
 * that is exactly the "folder was deleted" case.
 */
export function deleteEpisodesNotIn(db: Db, showId: number, keepPaths: string[]): void {
  if (keepPaths.length === 0) {
    db.prepare('DELETE FROM episodes WHERE show_id = ?').run(showId)
    return
  }
  // With more paths than fit in one statement, delete per chunk of *survivors*
  // by staging them in a temp table — simpler and faster than N round trips.
  db.transaction(() => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS _keep_paths (path TEXT PRIMARY KEY)')
    db.exec('DELETE FROM _keep_paths')
    const insert = db.prepare('INSERT OR IGNORE INTO _keep_paths (path) VALUES (?)')
    for (const p of keepPaths) insert.run(p)
    db.prepare(
      'DELETE FROM episodes WHERE show_id = ? AND path NOT IN (SELECT path FROM _keep_paths)'
    ).run(showId)
    db.exec('DELETE FROM _keep_paths')
  })()
}

/** Used by the pruner and the folder watcher's `unlink` handler. */
export function deleteEpisodesByPaths(db: Db, paths: string[]): number {
  let removed = 0
  for (const part of chunk(paths)) {
    if (part.length === 0) continue
    removed += db
      .prepare(`DELETE FROM episodes WHERE path IN (${placeholders(part.length)})`)
      .run(...part).changes
  }
  return removed
}

/** Every known path, with its show — the pruner's working set. */
export function listEpisodePaths(db: Db): { id: number; showId: number; path: string }[] {
  const rows = db.prepare('SELECT id, show_id, path FROM episodes').all() as {
    id: number
    show_id: number
    path: string
  }[]
  return rows.map((r) => ({ id: r.id, showId: r.show_id, path: r.path }))
}

/** Total across the whole library — the `totalEpisodes` figure in the overview. */
export function countEpisodes(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM episodes').get() as { n: number }
  return row.n
}

// ---------------------------------------------------------------------------
// Scan roots
// ---------------------------------------------------------------------------

export function listScanRoots(db: Db): ScanRoot[] {
  const rows = db.prepare('SELECT * FROM scan_roots ORDER BY added_at, id').all() as ScanRootRow[]
  return rows.map(toScanRoot)
}

/** Idempotent: adding a root twice is a no-op rather than an error dialog. */
export function addScanRoot(db: Db, path: string): void {
  db.prepare('INSERT OR IGNORE INTO scan_roots (path, added_at) VALUES (?, ?)').run(
    path,
    Date.now()
  )
}

/**
 * Forget a root. Episodes under it are left alone until the next scan prunes
 * them, so removing a root by mistake doesn't instantly destroy channel state.
 */
export function removeScanRoot(db: Db, rootId: number): void {
  db.prepare('DELETE FROM scan_roots WHERE id = ?').run(rootId)
}

// ---------------------------------------------------------------------------
// Unmatched files
// ---------------------------------------------------------------------------

/** The Library screen's fix-up bucket, oldest first. */
export function listUnmatched(db: Db): UnmatchedFile[] {
  const rows = db.prepare('SELECT * FROM unmatched_files ORDER BY path').all() as UnmatchedRow[]
  return rows.map(toUnmatched)
}

/**
 * Record a file the parser (or ffprobe) couldn't handle. Re-recording the same
 * path refreshes the reason and the stat pair instead of duplicating it.
 */
export function addUnmatched(
  db: Db,
  path: string,
  reason: string,
  mtimeMs: number,
  sizeBytes: number
): void {
  db.prepare(
    `INSERT INTO unmatched_files (path, reason, mtime_ms, size_bytes)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       reason = excluded.reason,
       mtime_ms = excluded.mtime_ms,
       size_bytes = excluded.size_bytes`
  ).run(path, reason, mtimeMs, sizeBytes)
}

export function getUnmatched(db: Db, fileId: number): UnmatchedFile | null {
  const row = db.prepare('SELECT * FROM unmatched_files WHERE id = ?').get(fileId) as
    | UnmatchedRow
    | undefined
  return row ? toUnmatched(row) : null
}

/** Dismiss (or consume, after a manual assignment) one unmatched row. */
export function removeUnmatched(db: Db, fileId: number): void {
  db.prepare('DELETE FROM unmatched_files WHERE id = ?').run(fileId)
}

/**
 * Clear a path from the bucket. The scanner calls this whenever a file *does*
 * parse, so renaming `blah.mkv` to `Show - S01E03.mkv` makes the unmatched entry
 * disappear on the next pass instead of lingering forever.
 */
export function removeUnmatchedByPath(db: Db, path: string): void {
  db.prepare('DELETE FROM unmatched_files WHERE path = ?').run(path)
}

// ---------------------------------------------------------------------------
// Arcs (part groups)
// ---------------------------------------------------------------------------

interface ArcRow {
  id: number
  show_id: number
  title: string
  source: string
}

/**
 * A show's arcs with everything the Library and Channel screens render:
 * the member ids in part order, the part count and a `S01E01–E05` range label.
 */
export function listArcs(db: Db, showId: number): ArcView[] {
  const groups = db
    .prepare('SELECT * FROM part_groups WHERE show_id = ? ORDER BY id')
    .all(showId) as ArcRow[]
  return groups.map((g) => buildArcView(db, g))
}

export function getArc(db: Db, groupId: number): ArcView | null {
  const row = db.prepare('SELECT * FROM part_groups WHERE id = ?').get(groupId) as
    | ArcRow
    | undefined
  return row ? buildArcView(db, row) : null
}

/**
 * Group episodes into an arc.
 *
 * Members do not have to be consecutive or belong to the same season. Some
 * shows deliberately interrupt a multipart story, so part order is the show's
 * normal season/episode order rather than selection order.
 *
 * Members that already belonged to another group are moved into this one (that
 * is what "regroup this run" means in the UI), and any group left empty as a
 * result is deleted so the Library screen never shows a zero-part arc.
 */
export function createArc(
  db: Db,
  showId: number,
  title: string,
  episodeIds: number[],
  source: ArcSource
): ArcView {
  if (episodeIds.length === 0) throw new Error('createArc: no episodes given')

  const run = db.transaction((): number => {
    const members = getEpisodesByIds(db, episodeIds)
    if (members.length !== new Set(episodeIds).size) {
      throw new Error('createArc: one or more episode ids do not exist')
    }
    const foreign = members.find((e) => e.showId !== showId)
    if (foreign) {
      throw new Error(`createArc: episode ${foreign.id} belongs to show ${foreign.showId}`)
    }
    const groupId = Number(
      db
        .prepare('INSERT INTO part_groups (show_id, title, source) VALUES (?, ?, ?)')
        .run(showId, title, source).lastInsertRowid
    )

    // `members` is already in season/episode order, which is the part order.
    const assign = db.prepare('UPDATE episodes SET part_group_id = ?, part_index = ? WHERE id = ?')
    members.forEach((ep, i) => assign.run(groupId, i + 1, ep.id))

    db.prepare(
      `DELETE FROM part_groups
        WHERE show_id = ?
          AND NOT EXISTS (SELECT 1 FROM episodes WHERE part_group_id = part_groups.id)`
    ).run(showId)

    return groupId
  })

  const groupId = run()
  const view = getArc(db, groupId)
  if (!view) throw new Error('createArc: group vanished immediately after creation')
  return view
}

/** Ungroup: members become standalone units again, then the group row goes. */
export function deleteArc(db: Db, groupId: number): void {
  db.transaction(() => {
    db.prepare('UPDATE episodes SET part_group_id = NULL, part_index = NULL WHERE part_group_id = ?')
      .run(groupId)
    db.prepare('DELETE FROM part_groups WHERE id = ?').run(groupId)
  })()
}

/**
 * Throw away this show's *detected* arcs so the scanner can redetect them.
 *
 * Filtering on `source = 'auto'` is the whole point: the heuristic re-runs on
 * every scan, but a user's manual grouping is the source of truth (plan §3) and
 * has to survive a rescan untouched.
 */
export function clearAutoArcs(db: Db, showId: number): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE episodes SET part_group_id = NULL, part_index = NULL
        WHERE part_group_id IN (SELECT id FROM part_groups WHERE show_id = ? AND source = 'auto')`
    ).run(showId)
    db.prepare("DELETE FROM part_groups WHERE show_id = ? AND source = 'auto'").run(showId)
  })()
}

/** How many arcs each show has, keyed by show id — one query for the overview. */
export function countArcsByShow(db: Db): Map<number, number> {
  const rows = db
    .prepare('SELECT show_id, COUNT(*) AS n FROM part_groups GROUP BY show_id')
    .all() as { show_id: number; n: number }[]
  return new Map(rows.map((r) => [r.show_id, r.n]))
}

// ---------------------------------------------------------------------------
// Arc helpers
// ---------------------------------------------------------------------------

function buildArcView(db: Db, group: ArcRow): ArcView {
  const rows = db
    .prepare(
      `SELECT * FROM episodes
        WHERE part_group_id = ?
        ORDER BY part_index, season, episode, id`
    )
    .all(group.id) as EpisodeRow[]
  const members = rows.map(toEpisode)
  return {
    id: group.id,
    showId: group.show_id,
    title: group.title,
    source: group.source as ArcSource,
    partCount: members.length,
    range: arcRange(members),
    episodeIds: members.map((e) => e.id)
  }
}

/**
 * Consecutive members use the compact `S01E01–E05` form from the mockup.
 * Gapped or cross-season arcs list every member so the label never implies that
 * the intervening episodes belong to the arc.
 */
function arcRange(members: Episode[]): string {
  if (members.length === 0) return ''
  const first = members[0]
  const last = members[members.length - 1]
  const start = episodeCode(first.season, first.episode, first.episodeEnd)
  if (members.length === 1) return start
  const consecutive = members.every((member, index) => {
    if (index === 0) return true
    const previous = members[index - 1]
    const previousEnd = previous.episodeEnd ?? previous.episode
    return member.season === previous.season && member.episode === previousEnd + 1
  })
  if (!consecutive) {
    return members.map((member) => episodeCode(member.season, member.episode, member.episodeEnd)).join(' · ')
  }
  const lastNumber = last.episodeEnd ?? last.episode
  return `${start}–E${String(lastNumber).padStart(2, '0')}`
}
