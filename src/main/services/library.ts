/**
 * Library read models and the unmatched-file fix-up
 * (docs/library.md, docs/ui.md).
 *
 * The Library screen wants one aggregate per show — episode count, season count,
 * arc count, and how the episodes split across the three playback paths (the
 * DIRECT/REMUX/TRANSCODE tags). Doing that with a query per show would be N+1
 * over a library of hundreds, so it is three grouped queries, joined in memory.
 */

import { stat } from "node:fs/promises";
import {
    decidePlaybackPath,
    SUPPORTED_AUDIO_CODECS,
} from "@shared/playback.js";
import type {
    AssignUnmatchedInput,
    LibraryOverview,
    LibraryShow,
    PlaybackPath,
} from "@shared/types.js";
import type { Db } from "../db/index.js";
import {
    countArcsByShow,
    countEpisodes,
    getUnmatched,
    listUnmatched,
    removeUnmatched,
    upsertEpisode,
} from "../db/repositories/library.js";
import { probeFile } from "../library/ffprobe.js";

interface ShowAggregateRow {
    id: number;
    title: string;
    episode_count: number;
    season_count: number;
    direct: number;
    remux: number;
    transcode: number;
    remux_audio_encode: number;
}

/**
 * `'aac','mp3',…,'none'` — the soundtracks that pass through the remux pipe
 * untouched, as a SQL list. Built from the shared codec set rather than spelled
 * out here, so the aggregate and `needsAudioTranscode` can never drift; `none`
 * joins them because a silent file has no audio to encode.
 */
const AUDIO_COPY_SQL_LIST = [...SUPPORTED_AUDIO_CODECS, "none"]
    .map((codec) => `'${codec}'`)
    .join(", ");

/**
 * Everything the Library screen renders in one shot: per-show aggregates, the
 * unmatched bucket, and the library-wide episode total.
 *
 * Shows with zero episodes are included rather than filtered — the scanner
 * deletes those, so if one shows up it is a real state the user should see
 * (a scan in progress, or a folder that just emptied).
 */
export function getLibraryOverview(db: Db): LibraryOverview {
    const rows = db
        .prepare(
            `SELECT
         s.id,
         -- Display resolution happens here rather than in the renderer: the
         -- Library screen renders a title, and which column it came from is not
         -- its business (docs/library.md, "Show metadata lookup").
         COALESCE(s.display_title, s.title)                             AS title,
         COUNT(e.id)                                                   AS episode_count,
         COUNT(DISTINCT e.season)                                      AS season_count,
         COALESCE(SUM(e.playback_path = 'direct'), 0)                  AS direct,
         COALESCE(SUM(e.playback_path = 'remux'), 0)                   AS remux,
         COALESCE(SUM(e.playback_path = 'transcode'), 0)               AS transcode,
         COALESCE(SUM(e.playback_path = 'remux'
                      AND LOWER(e.acodec) NOT IN (${AUDIO_COPY_SQL_LIST})), 0) AS remux_audio_encode
       FROM shows s
       LEFT JOIN episodes e ON e.show_id = s.id
       GROUP BY s.id
       -- Sorted on the same expression that was selected as the title: a linked
       -- show has to sort where the user reads it, not where its folder name is.
       ORDER BY COALESCE(s.display_title, s.title) COLLATE NOCASE, s.id`,
        )
        .all() as ShowAggregateRow[];

    const arcCounts = countArcsByShow(db);

    const shows: LibraryShow[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        episodeCount: r.episode_count,
        seasonCount: r.season_count,
        arcCount: arcCounts.get(r.id) ?? 0,
        paths: {
            direct: r.direct,
            remux: r.remux,
            transcode: r.transcode,
        } satisfies Record<PlaybackPath, number>,
        remuxAudioEncode: r.remux_audio_encode,
    }));

    return {
        shows,
        unmatched: listUnmatched(db),
        totalEpisodes: countEpisodes(db),
    };
}

/**
 * Promote an unmatched file into a real episode using numbers the user supplied.
 *
 * The file still has to be probed — the playback decision and the duration come
 * from ffprobe, not from the user — so this is the one library write that is
 * async. If the probe fails the unmatched row is left in place, which is the
 * honest outcome: the file is still unusable and should stay in the bucket.
 */
export async function assignUnmatched(
    db: Db,
    input: AssignUnmatchedInput,
    ffprobePath: string,
): Promise<void> {
    const file = getUnmatched(db, input.fileId);
    if (!file)
        throw new Error(`assignUnmatched: no unmatched file ${input.fileId}`);

    const show = db
        .prepare("SELECT id FROM shows WHERE id = ?")
        .get(input.showId) as { id: number } | undefined;
    if (!show) throw new Error(`assignUnmatched: no show ${input.showId}`);

    const probe = await probeFile(file.path, ffprobePath);
    // Re-stat rather than trusting the numbers recorded when the file was first
    // seen: the rescan key must describe the file as it is *now*, or the next scan
    // will pointlessly re-probe it.
    const info = await stat(file.path);

    const end = input.episodeEnd ?? null;

    upsertEpisode(db, {
        showId: input.showId,
        season: input.season,
        episode: input.episode,
        episodeEnd: end !== null && end > input.episode ? end : null,
        title: input.title ?? null,
        path: file.path,
        durationS: probe.durationS,
        container: probe.container,
        vcodec: probe.vcodec,
        acodec: probe.acodec,
        width: probe.width,
        height: probe.height,
        partGroupId: null,
        partIndex: null,
        playbackPath: decidePlaybackPath(
            probe.container,
            probe.vcodec,
            probe.acodec,
        ),
        mtimeMs: Math.round(info.mtimeMs),
        sizeBytes: info.size,
    });

    removeUnmatched(db, input.fileId);
}
