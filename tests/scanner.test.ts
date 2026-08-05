/**
 * The scanner, without ffmpeg (docs/library.md).
 *
 * `tests/integration.test.ts` already drives the scanner end-to-end, but that
 * suite needs a real ffmpeg to make its clips and skips itself wholesale where
 * there isn't one — which left the incremental fast path, the pruner, the
 * unmatched bucket and the arc refresh untested on any machine without a media
 * toolchain. None of that logic is about video: it is filesystem stat maths and
 * SQLite bookkeeping.
 *
 * So the files here are text on disk with video extensions, and the one part
 * that genuinely needs a decoder — the probe — is injected. Everything else is
 * the real thing: a real temp directory, a real SQLite database, the real
 * repository functions.
 */

import {
    mkdirSync,
    mkdtempSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDatabase } from "@main/db/index.js";
import {
    addScanRoot,
    findEpisodeByPath,
    listArcs,
    listEpisodes,
    listShows,
    listUnmatched,
} from "@main/db/repositories/library.js";
import {
    describe as describeError,
    type ProbeResult,
    resolveContainer,
} from "@main/library/ffprobe.js";
import { Scanner } from "@main/library/scanner.js";
import type { ScanStatus } from "@shared/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * What the injected probe reports. H.264 + AAC in MKV, which the playback
 * decision routes to `remux` — a value worth asserting, because it proves the
 * scanner really did store the probe rather than a default.
 */
const MKV_PROBE: ProbeResult = {
    durationS: 1320,
    container: "matroska",
    vcodec: "h264",
    acodec: "aac",
    width: 1280,
    height: 720,
};

interface Harness {
    root: string;
    db: Db;
    /** One entry per file the injected probe was asked about, in order. */
    probed: string[];
    /** Progress snapshots, so throttling and terminal state are observable. */
    progress: ScanStatus[];
    /** How many times the scanner told the UI the library moved. */
    changes: () => number;
    scanner: Scanner;
}

let h: Harness;

/** Probe answers keyed by file path; anything unlisted gets `MKV_PROBE`. */
let probeAnswers: Map<string, ProbeResult | Error>;

beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "rerun-scanner-"));
    const db = openDatabase(":memory:");
    addScanRoot(db, root);
    probeAnswers = new Map();

    const probed: string[] = [];
    const progress: ScanStatus[] = [];
    const partial = { changes: 0 };

    const scanner = new Scanner({
        db,
        // Never used: the injected probe never shells out.
        ffprobePath: () => "/nonexistent/ffprobe",
        onProgress: (status) => progress.push(status),
        onLibraryChanged: () => {
            partial.changes++;
        },
        probe: async (filePath) => {
            probed.push(filePath);
            const answer = probeAnswers.get(filePath) ?? MKV_PROBE;
            if (answer instanceof Error) throw answer;
            return answer;
        },
    });

    h = { root, db, probed, progress, changes: () => partial.changes, scanner };
});

afterEach(() => {
    h.scanner.dispose();
    h.db.close();
    rmSync(h.root, { recursive: true, force: true });
});

/** Create a file with real bytes (so stat size is non-zero) and return its path. */
function makeFile(...segments: string[]): string {
    const path = join(h.root, ...segments);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "not really a video, and the scanner never looks");
    return path;
}

/** Ages a file so a rescan sees a different mtime without touching its size. */
async function touchOlder(path: string, secondsAgo: number): Promise<void> {
    const when = new Date(Date.now() - secondsAgo * 1000);
    await utimes(path, when, when);
}

function showNamed(title: string) {
    const show = listShows(h.db).find((s) => s.title === title);
    if (!show) throw new Error(`no show titled ${title}`);
    return show;
}

// ---------------------------------------------------------------------------
// The first pass
// ---------------------------------------------------------------------------

describe("Scanner: initial scan", () => {
    it("creates one show per folder and one episode per parsed file", async () => {
        makeFile(
            "Gargoyles",
            "Season 01",
            "Gargoyles - S01E01 - Awakening Part 1.mkv",
        );
        makeFile(
            "Gargoyles",
            "Season 01",
            "Gargoyles - S01E02 - Awakening Part 2.mkv",
        );
        makeFile(
            "Star Trek TNG",
            "Season 04",
            "Star Trek TNG - S04E11 - Data's Day.mkv",
        );

        await h.scanner.scan();

        expect(
            listShows(h.db)
                .map((s) => s.title)
                .sort(),
        ).toEqual(["Gargoyles", "Star Trek TNG"]);

        const episodes = listEpisodes(h.db, showNamed("Gargoyles").id);
        expect(episodes).toHaveLength(2);
        expect(episodes[0].season).toBe(1);
        expect(episodes[0].episode).toBe(1);
        expect(episodes[0].title).toBe("Awakening Part 1");
        // Straight from the injected probe, plus the decision derived from it —
        // the whole reason tune-in doesn't have to touch the disk.
        expect(episodes[0].durationS).toBe(1320);
        expect(episodes[0].container).toBe("matroska");
        expect(episodes[0].vcodec).toBe("h264");
        expect(episodes[0].width).toBe(1280);
        expect(episodes[0].playbackPath).toBe("remux");
    });

    it("stats and probes each file exactly once, and reports it finished", async () => {
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening Part 1.mkv");
        makeFile("Gargoyles", "Gargoyles - S01E02 - Awakening Part 2.mkv");

        await h.scanner.scan();

        expect(h.probed).toHaveLength(2);
        const last = h.progress.at(-1)!;
        expect(last.state).toBe("idle");
        expect(last.total).toBe(2);
        expect(last.done).toBe(2);
        expect(last.probed).toBe(2);
        expect(last.error).toBeNull();
        // The UI is told exactly once per pass that it should refetch.
        expect(h.changes()).toBe(1);
    });

    it("ignores non-video files and dot-directories", async () => {
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening.mkv");
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening.srt");
        makeFile("Gargoyles", "poster.jpg");
        // Syncthing/Trash bookkeeping, which must never be walked into.
        makeFile(".stfolder", "Gargoyles - S01E09 - Reawakening.mkv");

        await h.scanner.scan();

        expect(h.probed).toHaveLength(1);
        expect(listEpisodes(h.db, showNamed("Gargoyles").id)).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Rescans
// ---------------------------------------------------------------------------

describe("Scanner: rescan", () => {
    it("spawns no probe at all when nothing changed — the incremental fast path", async () => {
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening.mkv");
        makeFile("Gargoyles", "Gargoyles - S01E02 - Awakening Part 2.mkv");
        await h.scanner.scan();
        expect(h.probed).toHaveLength(2);

        h.probed.length = 0;
        await h.scanner.scan();

        // The property that makes rescan-on-launch and the folder watcher
        // affordable: an unchanged library costs zero subprocesses.
        expect(h.probed).toEqual([]);
        expect(h.progress.at(-1)!.probed).toBe(0);
        expect(listEpisodes(h.db, showNamed("Gargoyles").id)).toHaveLength(2);
    });

    it("re-probes a file whose mtime moved, and only that file", async () => {
        const changed = makeFile(
            "Gargoyles",
            "Gargoyles - S01E01 - Awakening.mkv",
        );
        makeFile("Gargoyles", "Gargoyles - S01E02 - Awakening Part 2.mkv");
        await h.scanner.scan();

        h.probed.length = 0;
        await touchOlder(changed, 3600);
        // A re-encode: same path, different content. The stored decision must move
        // with it or the stream server keeps remuxing a file that no longer needs it.
        probeAnswers.set(changed, {
            ...MKV_PROBE,
            container: "mp4",
            durationS: 1400,
        });

        await h.scanner.scan();

        expect(h.probed).toEqual([changed]);
        const row = findEpisodeByPath(h.db, changed)!;
        expect(row.container).toBe("mp4");
        expect(row.durationS).toBe(1400);
        expect(row.playbackPath).toBe("direct");
    });

    it("re-probes everything on a full scan even when no file changed", async () => {
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening.mkv");
        makeFile("Gargoyles", "Gargoyles - S01E02 - Awakening Part 2.mkv");
        await h.scanner.scan();

        h.probed.length = 0;
        // The escape hatch for stale metadata: a codec fix-up or a parser change
        // has to be able to overwrite rows the stat check would call current.
        await h.scanner.scan(true);

        expect(h.probed).toHaveLength(2);
    });

    it("does not duplicate an episode when the same file is scanned again", async () => {
        const path = makeFile(
            "Gargoyles",
            "Gargoyles - S01E01 - Awakening.mkv",
        );
        await h.scanner.scan();
        await touchOlder(path, 60);
        await h.scanner.scan();

        expect(listEpisodes(h.db, showNamed("Gargoyles").id)).toHaveLength(1);
        expect(listShows(h.db)).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Deletions
// ---------------------------------------------------------------------------

describe("Scanner: pruning", () => {
    it("drops rows whose file is gone, and the show once it is empty", async () => {
        const keep = makeFile(
            "Gargoyles",
            "Gargoyles - S01E01 - Awakening.mkv",
        );
        const gone = makeFile("Xena", "Xena - S01E01 - Sins of the Past.mkv");
        await h.scanner.scan();
        expect(listShows(h.db)).toHaveLength(2);

        rmSync(gone);
        await h.scanner.scan();

        expect(findEpisodeByPath(h.db, gone)).toBeNull();
        expect(findEpisodeByPath(h.db, keep)).not.toBeNull();
        // An empty show would otherwise linger in the Library list and in channel
        // lineups that still reference it.
        expect(listShows(h.db).map((s) => s.title)).toEqual(["Gargoyles"]);
    });

    it("keeps rows whose root disappeared rather than wiping the library", async () => {
        const path = makeFile(
            "Gargoyles",
            "Gargoyles - S01E01 - Awakening.mkv",
        );
        await h.scanner.scan();

        // An unmounted drive or an unreadable folder: the walk finds nothing, but
        // the files still exist as far as anyone knows. Deleting here would take
        // the channel lineups with it, so existence is checked per path instead of
        // inferred from "wasn't seen this pass". Simulated by pointing the scan
        // root at a directory that isn't there.
        h.db
            .prepare("UPDATE scan_roots SET path = ?")
            .run(join(h.root, "nope"));

        await h.scanner.scan();

        expect(findEpisodeByPath(h.db, path)).not.toBeNull();
        expect(listShows(h.db)).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// The unmatched bucket
// ---------------------------------------------------------------------------

describe("Scanner: unmatched files", () => {
    it("records a file the parser cannot read instead of dropping it", async () => {
        const odd = makeFile("Gargoyles", "gargoyles_special (1).mkv");
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening.mkv");

        await h.scanner.scan();

        const unmatched = listUnmatched(h.db);
        expect(unmatched.map((u) => u.path)).toEqual([odd]);
        expect(unmatched[0].reason).toBe("unparsed");
        // Never probed: the parse fails first, so no subprocess is spent on it.
        expect(h.probed).toHaveLength(1);
        // …and the file next to it still landed normally.
        expect(listEpisodes(h.db, showNamed("Gargoyles").id)).toHaveLength(1);
    });

    it("records the probe's own message when the probe is what failed", async () => {
        const broken = makeFile(
            "Gargoyles",
            "Gargoyles - S01E01 - Awakening.mkv",
        );
        makeFile("Gargoyles", "Gargoyles - S01E02 - Awakening Part 2.mkv");
        probeAnswers.set(broken, new Error("ffprobe found no streams"));

        await h.scanner.scan();

        expect(listUnmatched(h.db)[0].reason).toBe("ffprobe found no streams");
        // Failure is local: the rest of the library still scanned.
        expect(listEpisodes(h.db, showNamed("Gargoyles").id)).toHaveLength(1);
        expect(h.progress.at(-1)!.state).toBe("idle");
    });

    it("clears the bucket once a rename makes the file parse", async () => {
        const odd = makeFile("Gargoyles", "gargoyles_special (1).mkv");
        await h.scanner.scan();
        expect(listUnmatched(h.db)).toHaveLength(1);

        const fixed = join(
            h.root,
            "Gargoyles",
            "Gargoyles - S01E11 - The Mirror.mkv",
        );
        renameSync(odd, fixed);
        await h.scanner.scan();

        // Both halves matter: the fixed name became an episode, and the stale
        // fix-up row is gone rather than sitting in the Library screen forever.
        expect(listUnmatched(h.db)).toEqual([]);
        expect(findEpisodeByPath(h.db, fixed)).not.toBeNull();
    });

    it("forgets an unmatched file that was deleted", async () => {
        const odd = makeFile("Gargoyles", "gargoyles_special (1).mkv");
        await h.scanner.scan();
        rmSync(odd);

        await h.scanner.scan();

        expect(listUnmatched(h.db)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Arcs
// ---------------------------------------------------------------------------

describe("Scanner: arc redetection", () => {
    it("detects a multipart arc during the pass that created its episodes", async () => {
        for (let part = 1; part <= 3; part++) {
            makeFile(
                "Gargoyles",
                "Season 01",
                `Gargoyles - S01E0${part} - Awakening Part ${part}.mkv`,
            );
        }
        makeFile(
            "Gargoyles",
            "Season 01",
            "Gargoyles - S01E04 - Enter Macbeth.mkv",
        );

        await h.scanner.scan();

        const arcs = listArcs(h.db, showNamed("Gargoyles").id);
        expect(arcs).toHaveLength(1);
        expect(arcs[0].title).toBe("Awakening");
        expect(arcs[0].partCount).toBe(3);
        expect(arcs[0].source).toBe("auto");
    });

    it("extends the arc when a later part is added, without rebuilding the rest", async () => {
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening Part 1.mkv");
        makeFile("Gargoyles", "Gargoyles - S01E02 - Awakening Part 2.mkv");
        await h.scanner.scan();
        expect(listArcs(h.db, showNamed("Gargoyles").id)[0].partCount).toBe(2);

        // The regression this guards: the redetect only runs for shows marked
        // dirty, so a pass whose *only* change is one new file still has to
        // re-cut that show's arcs.
        makeFile("Gargoyles", "Gargoyles - S01E03 - Awakening Part 3.mkv");
        await h.scanner.scan();

        const arcs = listArcs(h.db, showNamed("Gargoyles").id);
        expect(arcs).toHaveLength(1);
        expect(arcs[0].partCount).toBe(3);
    });

    it("leaves auto arcs alone on a pass that changed nothing", async () => {
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening Part 1.mkv");
        makeFile("Gargoyles", "Gargoyles - S01E02 - Awakening Part 2.mkv");
        await h.scanner.scan();
        const before = listArcs(h.db, showNamed("Gargoyles").id);

        await h.scanner.scan();

        // Same group, same id: a no-op rescan must not churn arc rows, because
        // channel state and the "already airing this arc" bookkeeping key off them.
        expect(listArcs(h.db, showNamed("Gargoyles").id)).toEqual(before);
    });

    it("drops the deleted part from its arc, and re-cuts the arc on the next change", async () => {
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening Part 1.mkv");
        const part2 = makeFile(
            "Gargoyles",
            "Gargoyles - S01E02 - Awakening Part 2.mkv",
        );
        makeFile("Gargoyles", "Gargoyles - S01E03 - Enter Macbeth.mkv");
        await h.scanner.scan();
        const show = showNamed("Gargoyles").id;
        expect(listArcs(h.db, show)[0].partCount).toBe(2);

        rmSync(part2);
        await h.scanner.scan();

        // The membership follows the episode row out of the database — an arc must
        // never keep pointing at a file that no longer exists, or the scheduler
        // will hand the player a dead path mid-arc.
        expect(listArcs(h.db, show)[0].episodeIds).toHaveLength(1);
        // The group row itself does survive this pass: pruning runs *after* the
        // redetect, so the detector still saw both parts. It is corrected by the
        // next pass that actually changes this show, which is what happens here.
        makeFile(
            "Gargoyles",
            "Gargoyles - S01E04 - The Thrill of the Hunt.mkv",
        );
        await h.scanner.scan();

        expect(listArcs(h.db, show)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Pause / resume / dispose
// ---------------------------------------------------------------------------

describe("Scanner: lifecycle", () => {
    it("drops a concurrent scan rather than running two passes over one library", async () => {
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening.mkv");

        const first = h.scanner.scan();
        // The double-clicked rescan button. Two passes would only fight over the
        // same rows, so the second call is a no-op that resolves immediately.
        const second = h.scanner.scan();
        await Promise.all([first, second]);

        expect(h.probed).toHaveLength(1);
    });

    it("dispose() unblocks a paused pass so shutdown cannot hang", async () => {
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening.mkv");
        makeFile("Gargoyles", "Gargoyles - S01E02 - Awakening Part 2.mkv");

        const pass = h.scanner.scan();
        h.scanner.pause();
        expect(h.scanner.getStatus().state).toBe("paused");
        h.scanner.dispose();

        // Without the waiter drain in dispose() this promise never settles and the
        // app hangs on quit.
        await expect(pass).resolves.toBeUndefined();
    });

    it("hands out a status snapshot callers cannot mutate", async () => {
        makeFile("Gargoyles", "Gargoyles - S01E01 - Awakening.mkv");
        await h.scanner.scan();

        const status = h.scanner.getStatus();
        status.done = 999;
        expect(h.scanner.getStatus().done).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// ffprobe's pure helpers
// ---------------------------------------------------------------------------

describe("resolveContainer", () => {
    it("takes an unambiguous demuxer name as it stands", () => {
        expect(resolveContainer("/x/ep.mp4", "mov,mp4,m4a,3gp,3g2,mj2")).toBe(
            "mp4",
        );
        expect(resolveContainer("/x/ep.avi", "avi")).toBe("avi");
    });

    it("uses the extension to split matroska from webm", () => {
        // ffprobe reports one demuxer for both. Resolving pessimistically costs a
        // genuine .webm an entirely unnecessary remux, so the extension wins when
        // it names one of the formats reported.
        expect(resolveContainer("/x/ep.webm", "matroska,webm")).toBe("webm");
        expect(resolveContainer("/x/ep.mkv", "matroska,webm")).toBe("matroska");
        expect(resolveContainer("/x/EP.WEBM", "matroska,webm")).toBe("webm");
    });

    it("ignores an extension the demuxer did not report", () => {
        // A `.webm` that is really an mp4 must be described as an mp4 — the
        // extension is a tie-breaker among ffprobe's answers, never an override.
        expect(resolveContainer("/x/ep.webm", "mov,mp4,m4a,3gp,3g2,mj2")).toBe(
            "mp4",
        );
        // And an extension nobody mentioned falls through to the normal rules.
        expect(resolveContainer("/x/ep.mkv", "mov,mp4")).toBe("mp4");
    });
});

describe("describe (ffprobe error text)", () => {
    it("prefers stderr, which is where ffprobe says what was wrong", () => {
        expect(
            describeError({
                stderr: "  ep.mkv: Invalid data found\n",
                message: "Command failed",
            }),
        ).toBe("ep.mkv: Invalid data found");
    });

    it("keeps the message readable by capping a long stderr at three lines", () => {
        // This string ends up in the unmatched bucket's `reason` column and on
        // screen; a hundred lines of ffmpeg noise there helps nobody.
        expect(describeError({ stderr: "a\nb\nc\nd\ne" })).toBe("a b c");
    });

    it("falls back to the message, then the exit code, then the value itself", () => {
        expect(describeError({ stderr: "   ", message: "spawn ENOENT" })).toBe(
            "spawn ENOENT",
        );
        expect(describeError({ code: 1 })).toBe("exit code 1");
        expect(describeError("plain string")).toBe("plain string");
        expect(describeError(null)).toBe("null");
    });
});
