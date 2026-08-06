/**
 * Every *write* to the library tables, and the shared row mapping
 * (docs/data-model.md).
 *
 * Read-model queries — the ones that exist to shape one view — deliberately
 * live beside the view model they feed, in `services/` and `scheduler/`, rather
 * than being funnelled through here as one-caller functions. What this module
 * owns is anything that mutates, plus the row shapes everything above reuses.
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

import { episodeCode } from "@shared/playback.js";
import type {
    ArcSource,
    ArcView,
    Episode,
    LoudnessMeasurement,
    ScanRoot,
    Show,
    UnmatchedFile,
} from "@shared/types.js";
import type { Db } from "../index.js";

/**
 * An episode with no id yet — what the scanner hands to `upsertEpisode`.
 *
 * `metadataTitle` is omitted as well as `id`: like the cached loudness columns
 * it belongs to a different owner (the metadata lookup), and leaving it off the
 * input is what makes "the scanner has no opinion about it" a compile error
 * rather than a convention.
 */
export type EpisodeInput = Omit<Episode, "id" | "metadataTitle">;

/**
 * SQLite refuses more than 32k bound parameters per statement, and a big
 * library can easily hold more paths than that. Everything that fans a list out
 * into an `IN (...)` clause chunks at this size.
 */
const PARAM_CHUNK = 500;

/**
 * Keep a cached column through an upsert unless the file itself changed.
 *
 * Inside `ON CONFLICT DO UPDATE`, `episodes.x` is the stored row and
 * `excluded.x` the incoming one; SQLite evaluates every right-hand side against
 * the *original* row, so this still compares the old stat pair even though the
 * same statement goes on to overwrite it.
 */
function keepUnlessFileChanged(column: string): string {
    return `CASE WHEN episodes.mtime_ms = excluded.mtime_ms
                AND episodes.size_bytes = excluded.size_bytes
           THEN episodes.${column} ELSE NULL END`;
}

// ---------------------------------------------------------------------------
// Row shapes (snake_case, straight from SQLite)
// ---------------------------------------------------------------------------

interface ShowRow {
    id: number;
    title: string;
    display_title: string | null;
    metadata_source: string | null;
    metadata_id: string | null;
    folder_path: string;
    added_at: number;
}

interface EpisodeRow {
    id: number;
    show_id: number;
    season: number;
    episode: number;
    episode_end: number | null;
    title: string | null;
    metadata_title: string | null;
    path: string;
    duration_s: number;
    container: string;
    vcodec: string;
    acodec: string;
    width: number | null;
    height: number | null;
    part_group_id: number | null;
    part_index: number | null;
    playback_path: string;
    mtime_ms: number;
    size_bytes: number;
}

interface ScanRootRow {
    id: number;
    path: string;
    added_at: number;
}

interface UnmatchedRow {
    id: number;
    path: string;
    reason: string;
    mtime_ms: number;
    size_bytes: number;
}

function toShow(row: ShowRow): Show {
    return {
        id: row.id,
        title: row.title,
        displayTitle: row.display_title,
        metadataSource: row.metadata_source,
        metadataId: row.metadata_id,
        folderPath: row.folder_path,
        addedAt: row.added_at,
    };
}

function toEpisode(row: EpisodeRow): Episode {
    return {
        id: row.id,
        showId: row.show_id,
        season: row.season,
        episode: row.episode,
        episodeEnd: row.episode_end,
        title: row.title,
        metadataTitle: row.metadata_title,
        path: row.path,
        durationS: row.duration_s,
        container: row.container,
        vcodec: row.vcodec,
        acodec: row.acodec,
        width: row.width,
        height: row.height,
        partGroupId: row.part_group_id,
        partIndex: row.part_index,
        playbackPath: row.playback_path as Episode["playbackPath"],
        mtimeMs: row.mtime_ms,
        sizeBytes: row.size_bytes,
    };
}

function toScanRoot(row: ScanRootRow): ScanRoot {
    return { id: row.id, path: row.path, addedAt: row.added_at };
}

function toUnmatched(row: UnmatchedRow): UnmatchedFile {
    return {
        id: row.id,
        path: row.path,
        reason: row.reason,
        mtimeMs: row.mtime_ms,
        sizeBytes: row.size_bytes,
    };
}

/** Split a long id/path list into statement-sized chunks. */
function chunk<T>(items: T[], size = PARAM_CHUNK): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size)
        out.push(items.slice(i, i + size));
    return out;
}

/** `?, ?, ?` for an `IN` clause. */
function placeholders(count: number): string {
    return new Array(count).fill("?").join(", ");
}

// ---------------------------------------------------------------------------
// Shows
// ---------------------------------------------------------------------------

/** All shows, alphabetically — the order the Library screen and pickers use. */
export function listShows(db: Db): Show[] {
    const rows = db
        .prepare(
            // Ordered by what the UI actually prints, so a linked show sorts
            // where its display title puts it and not where the folder name did.
            `SELECT * FROM shows
              ORDER BY COALESCE(display_title, title) COLLATE NOCASE, id`,
        )
        .all() as ShowRow[];
    return rows.map(toShow);
}

export function getShow(db: Db, showId: number): Show | null {
    const row = db.prepare("SELECT * FROM shows WHERE id = ?").get(showId) as
        | ShowRow
        | undefined;
    return row ? toShow(row) : null;
}

/**
 * A show's identity is its folder, not its title: renaming `Gargoyles` to
 * `Gargoyles (1994)` in the parser must not orphan the channel lineups that
 * already point at it.
 */
export function getShowByFolder(db: Db, folderPath: string): Show | null {
    const row = db
        .prepare("SELECT * FROM shows WHERE folder_path = ?")
        .get(folderPath) as ShowRow | undefined;
    return row ? toShow(row) : null;
}

/**
 * Insert the show, or refresh the title of the existing row for this folder.
 * Called once per file during a scan, so it must be cheap and idempotent.
 *
 * `title` is the only column the scan owns here. `display_title`,
 * `metadata_source` and `metadata_id` are deliberately absent from the `SET`
 * list: they belong to the metadata lookup, and a rescan — which re-derives the
 * title from the folder name on every pass — must not undo a link the user made.
 * Their absence is the whole mechanism, so it has a regression test
 * (tests/library-repo.test.ts).
 */
export function upsertShow(db: Db, title: string, folderPath: string): Show {
    db.prepare(
        `INSERT INTO shows (title, folder_path, added_at)
     VALUES (?, ?, ?)
     ON CONFLICT(folder_path) DO UPDATE SET title = excluded.title`,
    ).run(title, folderPath, Date.now());
    return getShowByFolder(db, folderPath) as Show;
}

/** Removes the show and — via `ON DELETE CASCADE` — its episodes and arcs. */
export function deleteShow(db: Db, showId: number): void {
    db.prepare("DELETE FROM shows WHERE id = ?").run(showId);
}

/**
 * Drop shows that no longer have a single episode. Called at the end of a scan:
 * a folder the user deleted from disk should not linger in the Library screen
 * (and in channel lineups) as an empty entry. Returns how many were removed.
 */
export function deleteEmptyShows(db: Db): number {
    const info = db
        .prepare(
            "DELETE FROM shows WHERE NOT EXISTS (SELECT 1 FROM episodes WHERE show_id = shows.id)",
        )
        .run();
    return info.changes;
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

/** A show's episodes in airing order — the order units are built in. */
export function listEpisodes(db: Db, showId: number): Episode[] {
    const rows = db
        .prepare(
            "SELECT * FROM episodes WHERE show_id = ? ORDER BY season, episode, id",
        )
        .all(showId) as EpisodeRow[];
    return rows.map(toEpisode);
}

export function getEpisode(db: Db, episodeId: number): Episode | null {
    const row = db
        .prepare("SELECT * FROM episodes WHERE id = ?")
        .get(episodeId) as EpisodeRow | undefined;
    return row ? toEpisode(row) : null;
}

/**
 * Batch fetch, returned in *airing* order rather than the order of `ids` —
 * callers (arc playback, unit building) want the sequence, not the argument
 * order.
 */
export function getEpisodesByIds(db: Db, ids: number[]): Episode[] {
    if (ids.length === 0) return [];
    const rows: EpisodeRow[] = [];
    for (const part of chunk(ids)) {
        rows.push(
            ...(db
                .prepare(
                    `SELECT * FROM episodes WHERE id IN (${placeholders(part.length)})`,
                )
                .all(...part) as EpisodeRow[]),
        );
    }
    rows.sort(
        (a, b) => a.season - b.season || a.episode - b.episode || a.id - b.id,
    );
    return rows.map(toEpisode);
}

/** The rescan lookup: `path` is unique, and mtime+size decide whether to re-probe. */
export function findEpisodeByPath(db: Db, path: string): Episode | null {
    const row = db.prepare("SELECT * FROM episodes WHERE path = ?").get(path) as
        | EpisodeRow
        | undefined;
    return row ? toEpisode(row) : null;
}

/**
 * Insert or refresh the episode at this path and return its id.
 *
 * Arc membership is deliberately *not* part of the update: the scanner has no
 * opinion about `part_group_id`/`part_index` (it passes nulls) and a rescan must
 * not silently dissolve arcs the user grouped by hand. Membership is only ever
 * changed through `createArc`/`deleteArc`.
 *
 * The cached loudness columns are handled the same way — owned by the background
 * measuring job, not by the scanner — with one difference: they *are* invalidated
 * here, but only when the stat pair actually moved. A file whose bytes changed
 * has a loudness we no longer know; a *full* rescan, which re-probes files that
 * did not change, must not throw away hours of measuring to learn nothing.
 *
 * `metadata_title` is a third owner and the strictest of them: it is missing
 * from the `SET` list *and* from `EpisodeInput`, so a rescan cannot touch it
 * even when the file's bytes changed. A provider name is keyed on (season,
 * episode), not on the file, so re-encoding an episode does not make its title
 * stale — and losing it would silently undo a lookup the user did by hand.
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
       loudness_i          = ${keepUnlessFileChanged("loudness_i")},
       loudness_tp         = ${keepUnlessFileChanged("loudness_tp")},
       loudness_lra        = ${keepUnlessFileChanged("loudness_lra")},
       loudness_thresh     = ${keepUnlessFileChanged("loudness_thresh")},
       loudness_scanned_at = ${keepUnlessFileChanged("loudness_scanned_at")},
       mtime_ms     = excluded.mtime_ms,
       size_bytes   = excluded.size_bytes`,
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
        sizeBytes: row.sizeBytes,
    });

    const found = db
        .prepare("SELECT id FROM episodes WHERE path = ?")
        .get(row.path) as { id: number } | undefined;
    if (!found) throw new Error(`upsertEpisode: row vanished for ${row.path}`);
    return found.id;
}

/**
 * Prune a show down to the files that still exist. `keepPaths` is what the scan
 * actually saw; anything else in this show is gone from disk.
 *
 * An empty `keepPaths` deletes every episode of the show, which is intentional —
 * that is exactly the "folder was deleted" case.
 */
export function deleteEpisodesNotIn(
    db: Db,
    showId: number,
    keepPaths: string[],
): void {
    if (keepPaths.length === 0) {
        db.prepare("DELETE FROM episodes WHERE show_id = ?").run(showId);
        return;
    }
    // With more paths than fit in one statement, delete per chunk of *survivors*
    // by staging them in a temp table — simpler and faster than N round trips.
    db.transaction(() => {
        db.exec(
            "CREATE TEMP TABLE IF NOT EXISTS _keep_paths (path TEXT PRIMARY KEY)",
        );
        db.exec("DELETE FROM _keep_paths");
        const insert = db.prepare(
            "INSERT OR IGNORE INTO _keep_paths (path) VALUES (?)",
        );
        for (const p of keepPaths) insert.run(p);
        db.prepare(
            "DELETE FROM episodes WHERE show_id = ? AND path NOT IN (SELECT path FROM _keep_paths)",
        ).run(showId);
        db.exec("DELETE FROM _keep_paths");
    })();
}

/** Used by the pruner and the folder watcher's `unlink` handler. */
export function deleteEpisodesByPaths(db: Db, paths: string[]): number {
    let removed = 0;
    for (const part of chunk(paths)) {
        if (part.length === 0) continue;
        removed += db
            .prepare(
                `DELETE FROM episodes WHERE path IN (${placeholders(part.length)})`,
            )
            .run(...part).changes;
    }
    return removed;
}

/** Every known path, with its show — the pruner's working set. */
export function listEpisodePaths(
    db: Db,
): { id: number; showId: number; path: string }[] {
    const rows = db.prepare("SELECT id, show_id, path FROM episodes").all() as {
        id: number;
        show_id: number;
        path: string;
    }[];
    return rows.map((r) => ({ id: r.id, showId: r.show_id, path: r.path }));
}

// ---------------------------------------------------------------------------
// Cached loudness (docs/playback.md, "The background measuring job")
// ---------------------------------------------------------------------------

/**
 * The measuring job's work list: episodes with a soundtrack that has never been
 * measured, oldest row first so a library fills in predictably.
 *
 * Silent files are excluded here rather than discovered by measuring them —
 * `acodec` already says there is nothing to weigh.
 */
export function listEpisodesNeedingLoudness(
    db: Db,
): { id: number; path: string }[] {
    return db
        .prepare(
            `SELECT id, path FROM episodes
        WHERE loudness_scanned_at IS NULL AND acodec <> 'none'
        ORDER BY id`,
        )
        .all() as { id: number; path: string }[];
}

/**
 * Record one measurement. A null `measurement` still stamps `scanned_at`: the
 * file was measured and had nothing to report (digital silence), and repeating
 * that every launch would be a decode for a guaranteed non-answer.
 *
 * Guarded on the row still existing rather than assumed — a measuring pass runs
 * for as long as it runs, and the episode can be deleted underneath it.
 */
export function saveLoudness(
    db: Db,
    episodeId: number,
    measurement: LoudnessMeasurement | null,
    at: number,
): void {
    db.prepare(
        `UPDATE episodes
        SET loudness_i = @i, loudness_tp = @tp, loudness_lra = @lra,
            loudness_thresh = @thresh, loudness_scanned_at = @at
      WHERE id = @id`,
    ).run({
        id: episodeId,
        i: measurement?.i ?? null,
        tp: measurement?.tp ?? null,
        lra: measurement?.lra ?? null,
        thresh: measurement?.thresh ?? null,
        at,
    });
}

export function getLoudness(
    db: Db,
    episodeId: number,
): LoudnessMeasurement | null {
    const row = db
        .prepare(
            "SELECT loudness_i, loudness_tp, loudness_lra, loudness_thresh FROM episodes WHERE id = ?",
        )
        .get(episodeId) as
        | {
              loudness_i: number | null;
              loudness_tp: number | null;
              loudness_lra: number | null;
              loudness_thresh: number | null;
          }
        | undefined;
    if (!row || row.loudness_i === null || row.loudness_tp === null)
        return null;
    if (row.loudness_lra === null || row.loudness_thresh === null) return null;
    return {
        i: row.loudness_i,
        tp: row.loudness_tp,
        lra: row.loudness_lra,
        thresh: row.loudness_thresh,
    };
}

/** How far the measuring job has got — `measured` of `total` episodes with audio. */
export function loudnessCoverage(db: Db): { measured: number; total: number } {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS total,
              COUNT(loudness_scanned_at) AS measured
         FROM episodes WHERE acodec <> 'none'`,
        )
        .get() as { total: number; measured: number };
    return { measured: row.measured, total: row.total };
}

/** Total across the whole library — the `totalEpisodes` figure in the overview. */
export function countEpisodes(db: Db): number {
    const row = db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as {
        n: number;
    };
    return row.n;
}

// ---------------------------------------------------------------------------
// Provider metadata (docs/library.md, "Show metadata lookup")
// ---------------------------------------------------------------------------

/**
 * Link a show to a provider series and give it its display title.
 *
 * All three columns move together on purpose: a `display_title` with no
 * `metadata_id` behind it is a title nobody can refresh or explain, and an id
 * with no title is a link with nothing to show for it. There is no partial
 * state — `clearShowMetadata` is the only other value these three ever take.
 */
export function setShowMetadata(
    db: Db,
    showId: number,
    metadata: { displayTitle: string; source: string; providerId: string },
): void {
    db.prepare(
        `UPDATE shows
        SET display_title   = @displayTitle,
            metadata_source = @source,
            metadata_id     = @providerId
      WHERE id = @id`,
    ).run({
        id: showId,
        displayTitle: metadata.displayTitle,
        source: metadata.source,
        providerId: metadata.providerId,
    });
}

/**
 * Write the provider episode titles, one prepared statement reused across the
 * whole plan — a linked show is hundreds of rows, and re-preparing per row is
 * the difference between one fast write and a visible pause.
 *
 * Deliberately *not* wrapped in a transaction here: the caller is applying a
 * plan that also calls `setShowMetadata`, and those writes have to land or fail
 * as one thing. A transaction in here would nest inside that one and buy
 * nothing, while making the atomic unit look smaller than it is.
 *
 * Ids that no longer exist are a silent no-op (`UPDATE` matching nothing),
 * which is the right outcome for a plan built before a scan pruned a file — the
 * handler drops foreign ids before this, so what reaches here is only ever
 * "this row vanished in the last few seconds".
 */
export function setEpisodeMetadataTitles(
    db: Db,
    pairs: { episodeId: number; title: string }[],
): void {
    const update = db.prepare(
        "UPDATE episodes SET metadata_title = ? WHERE id = ?",
    );
    for (const pair of pairs) update.run(pair.title, pair.episodeId);
}

/**
 * Blank every provider title on a show, ahead of writing a plan's.
 *
 * An apply is a wholesale replacement, not a merge: the plan is the complete
 * set of titles the new link produces, so any row it doesn't name has to fall
 * back to its filename title. Without this, re-linking a show to a different
 * series (or to the same one after the provider dropped episodes) would leave
 * the old link's titles stranded on the uncovered rows, and nothing afterwards
 * would explain where they came from. Like `setEpisodeMetadataTitles` it takes
 * no transaction of its own — the apply owns one for both halves.
 */
export function clearEpisodeMetadataTitles(db: Db, showId: number): void {
    db.prepare(
        "UPDATE episodes SET metadata_title = NULL WHERE show_id = ?",
    ).run(showId);
}

/**
 * Unlink: back to exactly what the scanner named.
 *
 * Both halves of the link go in one transaction, because the half-states are
 * each their own bug — a show with no `display_title` whose episodes still carry
 * provider names looks like a scanner that renamed one row and not the rest.
 * The episode `UPDATE` is unfiltered on `metadata_title` deliberately; it costs
 * one indexed sweep of the show and needs no idea of which rows matched.
 */
export function clearShowMetadata(db: Db, showId: number): void {
    db.transaction(() => {
        db.prepare(
            `UPDATE shows
            SET display_title = NULL, metadata_source = NULL, metadata_id = NULL
          WHERE id = ?`,
        ).run(showId);
        db.prepare(
            "UPDATE episodes SET metadata_title = NULL WHERE show_id = ?",
        ).run(showId);
    })();
}

// ---------------------------------------------------------------------------
// Scan roots
// ---------------------------------------------------------------------------

export function listScanRoots(db: Db): ScanRoot[] {
    const rows = db
        .prepare("SELECT * FROM scan_roots ORDER BY added_at, id")
        .all() as ScanRootRow[];
    return rows.map(toScanRoot);
}

/** Idempotent: adding a root twice is a no-op rather than an error dialog. */
export function addScanRoot(db: Db, path: string): void {
    db.prepare(
        "INSERT OR IGNORE INTO scan_roots (path, added_at) VALUES (?, ?)",
    ).run(path, Date.now());
}

/**
 * Forget a root. Episodes under it are left alone until the next scan prunes
 * them, so removing a root by mistake doesn't instantly destroy channel state.
 */
export function removeScanRoot(db: Db, rootId: number): void {
    db.prepare("DELETE FROM scan_roots WHERE id = ?").run(rootId);
}

// ---------------------------------------------------------------------------
// Unmatched files
// ---------------------------------------------------------------------------

/**
 * The Library screen's fix-up bucket, oldest first.
 *
 * There is no timestamp column, but the id is an `INTEGER PRIMARY KEY
 * AUTOINCREMENT` — the rowid — and `addUnmatched` updates a known path in place
 * rather than reinserting it, so first-seen order is exactly id order. That is
 * what "oldest" means here: the files that have been waiting for attention
 * longest come first, and re-scanning does not shuffle the list under a viewer
 * who is working down it. (This used to say oldest first and sort by path.)
 */
export function listUnmatched(db: Db): UnmatchedFile[] {
    const rows = db
        .prepare("SELECT * FROM unmatched_files ORDER BY id")
        .all() as UnmatchedRow[];
    return rows.map(toUnmatched);
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
    sizeBytes: number,
): void {
    db.prepare(
        `INSERT INTO unmatched_files (path, reason, mtime_ms, size_bytes)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       reason = excluded.reason,
       mtime_ms = excluded.mtime_ms,
       size_bytes = excluded.size_bytes`,
    ).run(path, reason, mtimeMs, sizeBytes);
}

export function getUnmatched(db: Db, fileId: number): UnmatchedFile | null {
    const row = db
        .prepare("SELECT * FROM unmatched_files WHERE id = ?")
        .get(fileId) as UnmatchedRow | undefined;
    return row ? toUnmatched(row) : null;
}

/** Dismiss (or consume, after a manual assignment) one unmatched row. */
export function removeUnmatched(db: Db, fileId: number): void {
    db.prepare("DELETE FROM unmatched_files WHERE id = ?").run(fileId);
}

/**
 * Clear a path from the bucket. The scanner calls this whenever a file *does*
 * parse, so renaming `blah.mkv` to `Show - S01E03.mkv` makes the unmatched entry
 * disappear on the next pass instead of lingering forever.
 */
export function removeUnmatchedByPath(db: Db, path: string): void {
    db.prepare("DELETE FROM unmatched_files WHERE path = ?").run(path);
}

// ---------------------------------------------------------------------------
// Arcs (part groups)
// ---------------------------------------------------------------------------

interface ArcRow {
    id: number;
    show_id: number;
    title: string;
    source: string;
}

/**
 * A show's arcs with everything the Library and Channel screens render:
 * the member ids in part order, the part count and a `S01E01–E05` range label.
 */
export function listArcs(db: Db, showId: number): ArcView[] {
    const groups = db
        .prepare("SELECT * FROM part_groups WHERE show_id = ? ORDER BY id")
        .all(showId) as ArcRow[];
    return groups.map((g) => buildArcView(db, g));
}

export function getArc(db: Db, groupId: number): ArcView | null {
    const row = db
        .prepare("SELECT * FROM part_groups WHERE id = ?")
        .get(groupId) as ArcRow | undefined;
    return row ? buildArcView(db, row) : null;
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
 * result is deleted so the Library screen never shows a zero-part arc. A group
 * left with *some* of its members is renumbered 1..n instead — `part_index` is
 * what the scheduler prints, so a survivor still labelled "part 2" of a group
 * that now has one part is a bug the user can see.
 */
export function createArc(
    db: Db,
    showId: number,
    title: string,
    episodeIds: number[],
    source: ArcSource,
): ArcView {
    if (episodeIds.length === 0)
        throw new Error("createArc: no episodes given");

    const run = db.transaction((): number => {
        const members = getEpisodesByIds(db, episodeIds);
        if (members.length !== new Set(episodeIds).size) {
            throw new Error("createArc: one or more episode ids do not exist");
        }
        const foreign = members.find((e) => e.showId !== showId);
        if (foreign) {
            throw new Error(
                `createArc: episode ${foreign.id} belongs to show ${foreign.showId}`,
            );
        }
        const groupId = Number(
            db
                .prepare(
                    "INSERT INTO part_groups (show_id, title, source) VALUES (?, ?, ?)",
                )
                .run(showId, title, source).lastInsertRowid,
        );

        // Where these episodes are coming from, noted before the move erases it.
        const vacated = new Set(
            members
                .map((ep) => ep.partGroupId)
                .filter((id): id is number => id != null),
        );

        // `members` is already in season/episode order, which is the part order.
        const assign = db.prepare(
            "UPDATE episodes SET part_group_id = ?, part_index = ? WHERE id = ?",
        );
        members.forEach((ep, i) => {
            assign.run(groupId, i + 1, ep.id);
        });

        db.prepare(
            `DELETE FROM part_groups
        WHERE show_id = ?
          AND NOT EXISTS (SELECT 1 FROM episodes WHERE part_group_id = part_groups.id)`,
        ).run(showId);

        // Close the gaps a partial regroup left behind. Ordering by the existing
        // `part_index` keeps the parts in the order they were already in; the id is
        // only a tiebreaker for rows a migration left unindexed.
        const remaining = db.prepare(
            "SELECT id FROM episodes WHERE part_group_id = ? ORDER BY part_index, id",
        );
        for (const vacatedId of vacated) {
            if (vacatedId === groupId) continue;
            const rows = remaining.all(vacatedId) as { id: number }[];
            rows.forEach((row, i) => {
                assign.run(vacatedId, i + 1, row.id);
            });
        }

        return groupId;
    });

    const groupId = run();
    const view = getArc(db, groupId);
    if (!view)
        throw new Error("createArc: group vanished immediately after creation");
    return view;
}

/** Ungroup: members become standalone units again, then the group row goes. */
export function deleteArc(db: Db, groupId: number): void {
    db.transaction(() => {
        db.prepare(
            "UPDATE episodes SET part_group_id = NULL, part_index = NULL WHERE part_group_id = ?",
        ).run(groupId);
        db.prepare("DELETE FROM part_groups WHERE id = ?").run(groupId);
    })();
}

/**
 * Throw away this show's *detected* arcs so the scanner can redetect them.
 *
 * Filtering on `source = 'auto'` is the whole point: the heuristic re-runs on
 * every scan, but a user's manual grouping is the source of truth
 * (docs/library.md) and has to survive a rescan untouched.
 */
export function clearAutoArcs(db: Db, showId: number): void {
    db.transaction(() => {
        db.prepare(
            `UPDATE episodes SET part_group_id = NULL, part_index = NULL
        WHERE part_group_id IN (SELECT id FROM part_groups WHERE show_id = ? AND source = 'auto')`,
        ).run(showId);
        db.prepare(
            "DELETE FROM part_groups WHERE show_id = ? AND source = 'auto'",
        ).run(showId);
    })();
}

/** How many arcs each show has, keyed by show id — one query for the overview. */
export function countArcsByShow(db: Db): Map<number, number> {
    const rows = db
        .prepare(
            "SELECT show_id, COUNT(*) AS n FROM part_groups GROUP BY show_id",
        )
        .all() as { show_id: number; n: number }[];
    return new Map(rows.map((r) => [r.show_id, r.n]));
}

// ---------------------------------------------------------------------------
// Arc helpers
// ---------------------------------------------------------------------------

function buildArcView(db: Db, group: ArcRow): ArcView {
    const rows = db
        .prepare(
            `SELECT * FROM episodes
        WHERE part_group_id = ?
        ORDER BY part_index, season, episode, id`,
        )
        .all(group.id) as EpisodeRow[];
    const members = rows.map(toEpisode);
    return {
        id: group.id,
        showId: group.show_id,
        title: group.title,
        source: group.source as ArcSource,
        partCount: members.length,
        range: arcRange(members),
        episodeIds: members.map((e) => e.id),
    };
}

/**
 * Consecutive members use the compact `S01E01–E05` form from the mockup.
 * Gapped or cross-season arcs list every member so the label never implies that
 * the intervening episodes belong to the arc.
 */
function arcRange(members: Episode[]): string {
    if (members.length === 0) return "";
    const first = members[0];
    const last = members[members.length - 1];
    const start = episodeCode(first.season, first.episode, first.episodeEnd);
    if (members.length === 1) return start;
    const consecutive = members.every((member, index) => {
        if (index === 0) return true;
        const previous = members[index - 1];
        const previousEnd = previous.episodeEnd ?? previous.episode;
        return (
            member.season === previous.season &&
            member.episode === previousEnd + 1
        );
    });
    if (!consecutive) {
        return members
            .map((member) =>
                episodeCode(member.season, member.episode, member.episodeEnd),
            )
            .join(" · ");
    }
    const lastNumber = last.episodeEnd ?? last.episode;
    return `${start}–E${String(lastNumber).padStart(2, "0")}`;
}
