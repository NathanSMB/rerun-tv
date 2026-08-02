/**
 * Database fixtures.
 *
 * Every scheduling suite needs the same two sentences of setup — "a show", "a
 * show with a three-part arc in the middle of it" — and each one used to spell
 * them out in its own copy of the same INSERTs. The copies are worse than
 * redundant: when the columns move, a suite whose seeder still compiles but no
 * longer matches its neighbours' is a test asserting about a library nobody has.
 *
 * These write through raw SQL rather than the repositories on purpose. A seeder
 * built out of `upsertEpisode()` would make the repository's own tests circular,
 * and would quietly hide a repository bug behind itself.
 *
 * One deliberate non-user: `migrations.test.ts` seeds rows against the *old*
 * schema, which is the whole point of it, so its SQL stays hand-written there.
 */

import type { Db } from "@main/db/index.js";
import type { EpisodeInput } from "@main/db/repositories/library.js";
import { MIGRATIONS } from "@main/db/schema.js";
import Database from "better-sqlite3";

/** A show with a synthetic folder path derived from its title. */
export function insertShow(db: Db, title: string): number {
    return Number(
        db
            .prepare(
                `INSERT INTO shows (title, folder_path, added_at) VALUES (?, ?, 0)`,
            )
            .run(title, `/tv/${title}`).lastInsertRowid,
    );
}

/** One 20-minute episode at a synthetic path. `title` is usually irrelevant. */
export function insertEpisode(
    db: Db,
    showId: number,
    season: number,
    episode: number,
    title: string | null = null,
): number {
    return Number(
        db
            .prepare(
                `INSERT INTO episodes (show_id, season, episode, title, path, duration_s)
         VALUES (?, ?, ?, ?, ?, 1200)`,
            )
            .run(
                showId,
                season,
                episode,
                title,
                `/tv/${showId}/S${season}E${episode}.mkv`,
            ).lastInsertRowid,
    );
}

/** Bind `episodeIds` into a manual part group, in the order given. */
export function insertArc(
    db: Db,
    showId: number,
    title: string,
    episodeIds: number[],
): number {
    const groupId = Number(
        db
            .prepare(
                `INSERT INTO part_groups (show_id, title, source) VALUES (?, ?, 'manual')`,
            )
            .run(showId, title).lastInsertRowid,
    );
    const link = db.prepare(
        `UPDATE episodes SET part_group_id = ?, part_index = ? WHERE id = ?`,
    );
    episodeIds.forEach((id, i) => {
        link.run(groupId, i + 1, id);
    });
    return groupId;
}

/** A show of `count` standalone episodes in season 1. */
export function seedFlatShow(db: Db, title: string, count: number): number {
    const showId = insertShow(db, title);
    for (let e = 1; e <= count; e++) insertEpisode(db, showId, 1, e);
    return showId;
}

export interface ArcShow {
    showId: number;
    groupId: number;
    episodeIds: number[];
}

/**
 * The plan's sample show: 11 episodes in season 1, of which E05–E07 are a
 * 3-part arc — so 8 standalones plus one arc make 9 units, and the arc sits
 * fifth in airing order rather than at either end.
 */
export function seedArcShow(
    db: Db,
    options: { showTitle?: string; pilotTitle?: string | null } = {},
): ArcShow {
    const { showTitle = "Gargoyles", pilotTitle = null } = options;
    const showId = insertShow(db, showTitle);
    const episodeIds: number[] = [];
    for (let e = 1; e <= 11; e++) {
        episodeIds.push(
            insertEpisode(db, showId, 1, e, e === 1 ? pilotTitle : null),
        );
    }
    const groupId = insertArc(db, showId, "The Gathering", [
        episodeIds[4],
        episodeIds[5],
        episodeIds[6],
    ]);
    return { showId, groupId, episodeIds };
}

/**
 * A fully-populated `EpisodeInput` for the repository layer, with `patch`
 * overriding whichever field the test is actually about.
 *
 * The defaults describe the ordinary case — a matroska H.264/AAC file on the
 * remux path — so a test that cares about, say, `partGroupId` can say only that.
 */
export function episodeInput(
    showId: number,
    season: number,
    ep: number,
    patch: Partial<EpisodeInput> = {},
): EpisodeInput {
    return {
        showId,
        season,
        episode: ep,
        episodeEnd: null,
        title: `Episode ${ep}`,
        path: `/tv/Show/S${season}E${ep}.mkv`,
        durationS: 1320,
        container: "matroska",
        vcodec: "h264",
        acodec: "aac",
        width: 1920,
        height: 1080,
        partGroupId: null,
        partIndex: null,
        playbackPath: "remux",
        mtimeMs: 1000,
        sizeBytes: 500,
        ...patch,
    };
}

/**
 * A database with the first `version` migrations applied and no more — the only
 * honest way to test an upgrade, since `openDatabase()` always lands on head.
 *
 * `path` defaults to a private in-memory database; the restore tests pass a real
 * file because their subject is what `migrate()` does to one on disk.
 */
export function openAtVersion(version: number, path = ":memory:"): Db {
    const db = new Database(path);
    db.pragma("foreign_keys = ON");
    for (let i = 0; i < version; i++) db.exec(MIGRATIONS[i]);
    db.pragma(`user_version = ${version}`);
    return db;
}
