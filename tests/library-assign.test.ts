/**
 * `assignUnmatched` — the Library screen's fix-up (plan §3, §8).
 *
 * This is the one library write a *user* drives: they look at a file the
 * filename parser gave up on, type the show, season and episode themselves, and
 * the file becomes a real episode. It is also the only library write that is
 * async, because the numbers the user types are not enough — duration and the
 * playback decision still have to come from ffprobe.
 *
 * That makes it worth its own file: the guards it puts around the user's input,
 * and — the case that matters most — what it leaves behind when the probe fails.
 * A file whose probe fails is still unplayable, so it has to stay in the bucket;
 * consuming the unmatched row would strand it as an episode nothing can play and
 * take away the only UI that could fix it.
 *
 * The cases that need a real probe generate a one-second `lavfi` clip and skip
 * themselves without ffmpeg, the way the other ffmpeg-backed suites do.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDatabase } from "@main/db/index.js";
import {
    addUnmatched,
    getEpisode,
    listEpisodes,
    listUnmatched,
    upsertShow,
} from "@main/db/repositories/library.js";
import { assignUnmatched } from "@main/services/library.js";
import { resolveFfmpeg } from "@main/stream/ffmpeg.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ffmpegMissing } from "./ffmpeg-guard.js";

const ff = resolveFfmpeg();
const noFfmpeg = ffmpegMissing(
    Boolean(ff.ffmpegPath && ff.ffprobePath),
    "assignUnmatched",
);
/** Real when we have one; a name that cannot resolve otherwise. */
const ffprobePath = ff.ffprobePath ?? "ffprobe-does-not-exist";

let dir: string;
let db: Db;
let showId: number;

/** One second of H.264 + AAC at postage-stamp size. */
function makeClip(path: string): void {
    execFileSync(ff.ffmpegPath as string, [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=d=1:s=128x96:r=10",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=mono",
        "-shortest",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-t",
        "1",
        path,
    ]);
}

/** Put `path` in the fix-up bucket and hand back its row id. */
function bucket(path: string): number {
    addUnmatched(db, path, "could not parse a season/episode", 1000, 500);
    const row = listUnmatched(db).find((f) => f.path === path);
    if (!row) throw new Error(`test setup: ${path} did not reach the bucket`);
    return row.id;
}

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rerun-assign-"));
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
    db = openDatabase(":memory:");
    showId = upsertShow(db, "Gargoyles", "/tv/Gargoyles").id;
});

describe("assignUnmatched — refusals", () => {
    it("throws when the unmatched file is already gone", async () => {
        // Two windows open on the same library, or a rescan that matched the file
        // between the dialog opening and the user pressing Save. Failing loudly is
        // right: silently doing nothing would look like the assignment worked.
        await expect(
            assignUnmatched(
                db,
                { fileId: 9999, showId, season: 1, episode: 1 },
                ffprobePath,
            ),
        ).rejects.toThrow(/no unmatched file 9999/);
    });

    it("throws when the show it would be filed under does not exist", async () => {
        const fileId = bucket(join(dir, "mystery.mkv"));

        await expect(
            assignUnmatched(
                db,
                { fileId, showId: 4242, season: 1, episode: 1 },
                ffprobePath,
            ),
        ).rejects.toThrow(/no show 4242/);

        // The episode row would have failed the foreign key anyway; what matters is
        // that we never got as far as consuming the bucket entry.
        expect(listUnmatched(db)).toHaveLength(1);
    });

    it("leaves the file in the bucket when the probe fails", async () => {
        // The regression this exists for. A file ffprobe cannot read is still
        // unplayable, so it has to stay where the user can see it — turning it into
        // an episode with a zero duration would put it into a channel's rotation
        // and remove the only screen that could undo that.
        const path = join(dir, "not-really-a-video.mkv");
        writeFileSync(path, "MKV? no. just some text.");
        const fileId = bucket(path);

        await expect(
            assignUnmatched(
                db,
                { fileId, showId, season: 1, episode: 3 },
                ffprobePath,
            ),
        ).rejects.toThrow(/ffprobe/);

        expect(listUnmatched(db).map((f) => f.path)).toEqual([path]);
        expect(listEpisodes(db, showId)).toHaveLength(0);
    });

    it("leaves the file in the bucket when it has vanished from disk", async () => {
        const path = join(dir, "deleted-since-the-scan.mkv");
        const fileId = bucket(path);

        await expect(
            assignUnmatched(
                db,
                { fileId, showId, season: 1, episode: 4 },
                ffprobePath,
            ),
        ).rejects.toThrow();

        expect(listUnmatched(db)).toHaveLength(1);
        expect(listEpisodes(db, showId)).toHaveLength(0);
    });
});

describe.skipIf(noFfmpeg)("assignUnmatched — the assignment", () => {
    it("promotes the file into an episode and empties the bucket entry", async () => {
        const path = join(dir, "clip-plain.mp4");
        makeClip(path);
        const fileId = bucket(path);

        await assignUnmatched(
            db,
            {
                fileId,
                showId,
                season: 2,
                episode: 5,
                title: "City of Stone",
            },
            ffprobePath,
        );

        const episodes = listEpisodes(db, showId);
        expect(episodes).toHaveLength(1);
        expect(episodes[0]).toMatchObject({
            season: 2,
            episode: 5,
            episodeEnd: null,
            title: "City of Stone",
            path,
            vcodec: "h264",
            acodec: "aac",
        });
        // Duration and the playback decision come from the probe, never the user.
        expect(episodes[0].durationS).toBeGreaterThan(0);
        expect(episodes[0].playbackPath).toBe("direct");
        // Stat'd fresh, so the next scan recognises the file instead of re-probing:
        // the numbers recorded in the bucket were placeholders (1000/500).
        expect(episodes[0].sizeBytes).toBeGreaterThan(500);
        expect(listUnmatched(db)).toHaveLength(0);
    });

    it("keeps an episodeEnd that spans forward and drops one that does not", async () => {
        // The UI lets both numbers be typed, so "S01E05–E04" and "S01E05–E05" are
        // both reachable. A range that doesn't go forward isn't a double episode,
        // and storing one would make the Library screen render `S01E05-E04`.
        const spanning = join(dir, "clip-span.mp4");
        const backwards = join(dir, "clip-backwards.mp4");
        const equal = join(dir, "clip-equal.mp4");
        makeClip(spanning);
        makeClip(backwards);
        makeClip(equal);

        await assignUnmatched(
            db,
            {
                fileId: bucket(spanning),
                showId,
                season: 1,
                episode: 1,
                episodeEnd: 2,
            },
            ffprobePath,
        );
        await assignUnmatched(
            db,
            {
                fileId: bucket(backwards),
                showId,
                season: 1,
                episode: 5,
                episodeEnd: 4,
            },
            ffprobePath,
        );
        await assignUnmatched(
            db,
            {
                fileId: bucket(equal),
                showId,
                season: 1,
                episode: 9,
                episodeEnd: 9,
            },
            ffprobePath,
        );

        const byPath = new Map(
            listEpisodes(db, showId).map((e) => [e.path, e.episodeEnd]),
        );
        expect(byPath.get(spanning)).toBe(2);
        expect(byPath.get(backwards)).toBeNull();
        expect(byPath.get(equal)).toBeNull();
    });

    it("files an unmatched file that needs a remux under the right playback path", async () => {
        // The other half of "the probe decides": an MKV is the same H.264/AAC
        // content, but Chromium cannot open the container, so it must land as a
        // remux even though the user typed exactly the same numbers.
        const path = join(dir, "clip-remux.mkv");
        makeClip(path);
        const fileId = bucket(path);

        await assignUnmatched(
            db,
            { fileId, showId, season: 3, episode: 1 },
            ffprobePath,
        );

        const episode = listEpisodes(db, showId)[0];
        expect(episode.playbackPath).toBe("remux");
        expect(getEpisode(db, episode.id)?.container).toBe("matroska");
    });
});
