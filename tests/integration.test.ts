/**
 * End-to-end integration: a real folder of real (tiny) video files goes in, and
 * a playable stream comes out.
 *
 * The unit suites cover each subsystem in isolation against fixtures. This one
 * covers the seams between them — that the scanner's parse feeds the arc
 * heuristic, that the arc feeds the scheduler's unit list, and that the
 * scheduler's episode id resolves to something the stream server will actually
 * serve. Those are exactly the places where two correct modules can still
 * disagree about a contract.
 *
 * Requires ffmpeg; skips itself cleanly when it isn't installed.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Db, openDatabase } from "../src/main/db/index.js";
import {
    addChannelShow,
    createChannel,
    setChannelShowMode,
} from "../src/main/db/repositories/channels.js";
import {
    addScanRoot,
    listArcs,
    listEpisodes,
    listShows,
} from "../src/main/db/repositories/library.js";
import { Scanner } from "../src/main/library/scanner.js";
import { peekNext, pickNext } from "../src/main/scheduler/scheduler.js";
import { buildUnits } from "../src/main/scheduler/units.js";
import { resolveFfmpeg } from "../src/main/stream/ffmpeg.js";
import {
    type StreamServer,
    startStreamServer,
} from "../src/main/stream/server.js";
import { DEFAULT_SETTINGS } from "../src/shared/types.js";
import { ffmpegMissing } from "./ffmpeg-guard.js";

const execFileAsync = promisify(execFile);
const ff = resolveFfmpeg();
const noFfmpeg = ffmpegMissing(
    Boolean(ff.ffmpegPath && ff.ffprobePath),
    "scan → schedule → stream integration",
);

/** One second of H.264 + AAC at postage-stamp size — a few kilobytes on disk. */
async function makeClip(path: string): Promise<void> {
    await execFileAsync(ff.ffmpegPath as string, [
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

describe.skipIf(noFfmpeg)("scan → schedule → stream", () => {
    let root: string;
    let db: Db;
    let server: StreamServer;

    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), "rerun-tv-e2e-"));

        // Gargoyles: a 3-part arc followed by two standalones. MKV, so the codecs
        // are fine but the container isn't — the remux path.
        const gargoyles = join(root, "Gargoyles", "Season 01");
        mkdirSync(gargoyles, { recursive: true });
        await makeClip(
            join(gargoyles, "Gargoyles - S01E01 - Awakening Part 1.mkv"),
        );
        await makeClip(
            join(gargoyles, "Gargoyles - S01E02 - Awakening Part 2.mkv"),
        );
        await makeClip(
            join(gargoyles, "Gargoyles - S01E03 - Awakening Part 3.mkv"),
        );
        await makeClip(
            join(gargoyles, "Gargoyles - S01E04 - Enter Macbeth.mkv"),
        );
        await makeClip(join(gargoyles, "Gargoyles - S01E05 - The Edge.mkv"));

        // TNG: MP4 with native codecs — the direct path.
        const tng = join(root, "Star Trek TNG", "Season 04");
        mkdirSync(tng, { recursive: true });
        await makeClip(join(tng, "Star Trek TNG - S04E11 - Data's Day.mp4"));

        // A file the parser can't read — it must land in Unmatched, not vanish.
        await makeClip(join(root, "Gargoyles", "gargoyles_special (1).mp4"));

        db = openDatabase(":memory:");
        addScanRoot(db, root);

        const scanner = new Scanner({
            db,
            ffprobePath: ff.ffprobePath as string,
            onProgress: () => {},
            onLibraryChanged: () => {},
        });
        await scanner.scan();
        scanner.dispose();

        server = await startStreamServer({
            db,
            getSettings: () => DEFAULT_SETTINGS,
        });
    }, 120_000);

    afterAll(async () => {
        await server?.close();
        db?.close();
        rmSync(root, { recursive: true, force: true });
    });

    it("parses shows from folder names and episodes from filenames", () => {
        const shows = listShows(db)
            .map((s) => s.title)
            .sort();
        expect(shows).toEqual(["Gargoyles", "Star Trek TNG"]);

        const gargoyles = listShows(db).find((s) => s.title === "Gargoyles")!;
        const episodes = listEpisodes(db, gargoyles.id);
        expect(episodes).toHaveLength(5);
        expect(episodes[0].season).toBe(1);
        expect(episodes[0].episode).toBe(1);
        expect(episodes[3].title).toBe("Enter Macbeth");
    });

    it("stores the playback decision at scan time", () => {
        const gargoyles = listShows(db).find((s) => s.title === "Gargoyles")!;
        const tng = listShows(db).find((s) => s.title === "Star Trek TNG")!;

        // H.264 + AAC in MKV: codecs fine, container isn't.
        expect(
            listEpisodes(db, gargoyles.id).every(
                (e) => e.playbackPath === "remux",
            ),
        ).toBe(true);
        // The same codecs in MP4 need no ffmpeg at all.
        expect(listEpisodes(db, tng.id)[0].playbackPath).toBe("direct");
    });

    it("auto-detects the multipart arc and collapses it into one unit", () => {
        const gargoyles = listShows(db).find((s) => s.title === "Gargoyles")!;

        const arcs = listArcs(db, gargoyles.id);
        expect(arcs).toHaveLength(1);
        expect(arcs[0].title).toBe("Awakening");
        expect(arcs[0].partCount).toBe(3);
        expect(arcs[0].source).toBe("auto");

        // 5 episodes, but only 3 units: the arc holds exactly one lottery ticket.
        const units = buildUnits(db, gargoyles.id);
        expect(units).toHaveLength(3);
        expect(units[0].kind).toBe("arc");
        expect(units[0].episodeIds).toHaveLength(3);
    });

    it("routes an unparseable file to the Unmatched bucket instead of dropping it", () => {
        const rows = db.prepare("SELECT path FROM unmatched_files").all() as {
            path: string;
        }[];
        expect(
            rows.some((r) => r.path.endsWith("gargoyles_special (1).mp4")),
        ).toBe(true);
    });

    it("airs the arc start-to-finish once it starts, whatever the lottery says", () => {
        const gargoyles = listShows(db).find((s) => s.title === "Gargoyles")!;
        const channel = createChannel(db, "Test Channel", 3);
        addChannelShow(db, channel.id, gargoyles.id);
        setChannelShowMode(db, channel.id, gargoyles.id, "sequential");

        // Sequential starts at the pilot, which is the arc.
        const first = pickNext(db, channel.id)!;
        expect(first.arc).not.toBeNull();
        expect(first.arc!.partIndex).toBe(1);
        expect(first.arc!.partCount).toBe(3);

        // An RNG that always picks the last option can't divert the channel: an
        // in-progress arc wins ahead of the lottery.
        const second = pickNext(db, channel.id, () => 0.999)!;
        expect(second.arc!.partIndex).toBe(2);
        const third = pickNext(db, channel.id, () => 0.999)!;
        expect(third.arc!.partIndex).toBe(3);

        // Only now does the lottery run again.
        const fourth = pickNext(db, channel.id)!;
        expect(fourth.arc).toBeNull();
    });

    it("peekNext agrees with the next pickNext and changes nothing", () => {
        const tng = listShows(db).find((s) => s.title === "Star Trek TNG")!;
        const channel = createChannel(db, "Peek Channel", 4);
        addChannelShow(db, channel.id, tng.id);

        const before = db
            .prepare("SELECT COUNT(*) AS n FROM play_log")
            .get() as { n: number };
        const peeked = peekNext(db, channel.id)!;
        const peekedTwice = peekNext(db, channel.id)!;
        const after = db
            .prepare("SELECT COUNT(*) AS n FROM play_log")
            .get() as { n: number };

        expect(peeked.episodeId).toBe(peekedTwice.episodeId);
        expect(after.n).toBe(before.n);
        expect(pickNext(db, channel.id)!.episodeId).toBe(peeked.episodeId);
    });

    it("serves the direct path with range support", async () => {
        const tng = listShows(db).find((s) => s.title === "Star Trek TNG")!;
        const episode = listEpisodes(db, tng.id)[0];

        const full = await fetch(server.urlFor(episode.id));
        expect(full.status).toBe(200);
        expect(full.headers.get("accept-ranges")).toBe("bytes");
        const body = new Uint8Array(await full.arrayBuffer());
        expect(body.byteLength).toBeGreaterThan(0);

        const ranged = await fetch(server.urlFor(episode.id), {
            headers: { Range: "bytes=0-9" },
        });
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("content-range")).toBe(
            `bytes 0-9/${body.byteLength}`,
        );
        expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(
            body.slice(0, 10),
        );
    });

    it("serves the remux path as a fragmented MP4 pipe", async () => {
        const gargoyles = listShows(db).find((s) => s.title === "Gargoyles")!;
        const episode = listEpisodes(db, gargoyles.id)[0];

        // Third argument is the channel id, which names the supervisor's job slot.
        const res = await fetch(server.urlFor(episode.id, 0, 3));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("video/mp4");

        const body = new Uint8Array(await res.arrayBuffer());
        expect(body.byteLength).toBeGreaterThan(0);
        // An fMP4 stream opens with an `ftyp` box: 4 size bytes, then the type.
        expect(String.fromCharCode(...body.slice(4, 8))).toBe("ftyp");
    }, 30_000);
});
