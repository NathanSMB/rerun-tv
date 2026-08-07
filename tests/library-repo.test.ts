import { type Db, openDatabase } from "@main/db/index.js";
import {
    addScanRoot,
    addUnmatched,
    clearAutoArcs,
    clearShowMetadata,
    countEpisodes,
    createArc,
    deleteArc,
    deleteEpisodesNotIn,
    findEpisodeByPath,
    getEpisode,
    getEpisodesByIds,
    getLoudness,
    getShow,
    getShowByFolder,
    getUnmatched,
    listArcs,
    listEpisodes,
    listEpisodesNeedingLoudness,
    listScanRoots,
    listShows,
    listUnmatched,
    loudnessCoverage,
    removeScanRoot,
    removeUnmatched,
    saveLoudness,
    setEpisodeMetadataTitles,
    setShowMetadata,
    upsertEpisode,
    upsertShow,
} from "@main/db/repositories/library.js";
import { getLibraryOverview } from "@main/services/library.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { episodeInput as episode } from "./helpers/db.js";

let db: Db;

beforeEach(() => {
    db = openDatabase(":memory:");
});

// An in-memory database is small, but a file handle per test is still a handle:
// leaving them open is how a suite ends up unable to exit.
afterEach(() => {
    db.close();
});

describe("shows", () => {
    it("upserts by folder path and keeps the id stable across a retitle", () => {
        const first = upsertShow(db, "Gargoyles", "/tv/Gargoyles");
        const second = upsertShow(db, "Gargoyles (1994)", "/tv/Gargoyles");
        expect(second.id).toBe(first.id);
        expect(second.title).toBe("Gargoyles (1994)");
        expect(listShows(db)).toHaveLength(1);
        expect(getShowByFolder(db, "/tv/Gargoyles")?.id).toBe(first.id);
    });

    it("returns null for an unknown folder", () => {
        expect(getShowByFolder(db, "/nope")).toBeNull();
    });
});

describe("episodes", () => {
    it("inserts, then updates in place on the second upsert of the same path", () => {
        const show = upsertShow(db, "Show", "/tv/Show");
        const id = upsertEpisode(db, episode(show.id, 1, 1));
        const again = upsertEpisode(
            db,
            episode(show.id, 1, 1, { durationS: 1400, mtimeMs: 2000 }),
        );

        expect(again).toBe(id);
        expect(countEpisodes(db)).toBe(1);
        const stored = getEpisode(db, id);
        expect(stored?.durationS).toBe(1400);
        expect(stored?.mtimeMs).toBe(2000);
    });

    it("exposes the rescan key so an unchanged file can be skipped", () => {
        const show = upsertShow(db, "Show", "/tv/Show");
        upsertEpisode(
            db,
            episode(show.id, 1, 1, { mtimeMs: 111, sizeBytes: 222 }),
        );
        const found = findEpisodeByPath(db, "/tv/Show/S1E1.mkv");
        expect(found).toMatchObject({ mtimeMs: 111, sizeBytes: 222 });
        expect(findEpisodeByPath(db, "/tv/Show/missing.mkv")).toBeNull();
    });

    /**
     * Measuring loudness costs a full audio decode per file, so the cache has to
     * survive everything that isn't a genuine change to the file — including a
     * *full* rescan, which re-probes files whose stat pair never moved.
     */
    it("keeps a cached loudness measurement through a rescan of the same bytes", () => {
        const show = upsertShow(db, "Show", "/tv/Show");
        const id = upsertEpisode(
            db,
            episode(show.id, 1, 1, { mtimeMs: 111, sizeBytes: 222 }),
        );
        saveLoudness(
            db,
            id,
            { i: -22.8, tp: -3.1, lra: 15.2, thresh: -33.1 },
            1234,
        );

        // Same file, re-probed: a different duration, the same mtime and size.
        upsertEpisode(
            db,
            episode(show.id, 1, 1, {
                mtimeMs: 111,
                sizeBytes: 222,
                durationS: 1400,
            }),
        );

        expect(getLoudness(db, id)).toEqual({
            i: -22.8,
            tp: -3.1,
            lra: 15.2,
            thresh: -33.1,
        });
        expect(loudnessCoverage(db)).toEqual({ measured: 1, total: 1 });
    });

    it("drops it when the file itself changed, which is the one thing that invalidates it", () => {
        const show = upsertShow(db, "Show", "/tv/Show");
        const id = upsertEpisode(
            db,
            episode(show.id, 1, 1, { mtimeMs: 111, sizeBytes: 222 }),
        );
        saveLoudness(
            db,
            id,
            { i: -22.8, tp: -3.1, lra: 15.2, thresh: -33.1 },
            1234,
        );

        upsertEpisode(
            db,
            episode(show.id, 1, 1, { mtimeMs: 999, sizeBytes: 222 }),
        );

        expect(getLoudness(db, id)).toBeNull();
        // Back in the work list, rather than merely blank.
        expect(listEpisodesNeedingLoudness(db).map((row) => row.id)).toEqual([
            id,
        ]);
    });

    /** A silent file is measured once and then left alone forever. */
    it("records an unmeasurable file as measured, so it is never queued twice", () => {
        const show = upsertShow(db, "Show", "/tv/Show");
        const id = upsertEpisode(db, episode(show.id, 1, 1));
        saveLoudness(db, id, null, 1234);

        expect(getLoudness(db, id)).toBeNull();
        expect(listEpisodesNeedingLoudness(db)).toHaveLength(0);
        expect(loudnessCoverage(db).measured).toBe(1);
    });

    it("leaves a genuinely silent episode out of the work list entirely", () => {
        const show = upsertShow(db, "Show", "/tv/Show");
        upsertEpisode(db, episode(show.id, 1, 1, { acodec: "none" }));
        expect(listEpisodesNeedingLoudness(db)).toHaveLength(0);
        expect(loudnessCoverage(db)).toEqual({ measured: 0, total: 0 });
    });

    it("preserves arc membership across a rescan upsert", () => {
        const show = upsertShow(db, "Show", "/tv/Show");
        const ids = [1, 2].map((n) =>
            upsertEpisode(db, episode(show.id, 1, n)),
        );
        createArc(db, show.id, "Awakening", ids, "manual");

        upsertEpisode(db, episode(show.id, 1, 1, { mtimeMs: 9999 }));

        expect(getEpisode(db, ids[0])).toMatchObject({
            partIndex: 1,
            mtimeMs: 9999,
        });
        expect(getEpisode(db, ids[0])?.partGroupId).not.toBeNull();
    });

    it("lists in airing order and batch-fetches in airing order", () => {
        const show = upsertShow(db, "Show", "/tv/Show");
        const c = upsertEpisode(db, episode(show.id, 2, 1));
        const a = upsertEpisode(db, episode(show.id, 1, 1));
        const b = upsertEpisode(db, episode(show.id, 1, 2));
        expect(listEpisodes(db, show.id).map((e) => e.id)).toEqual([a, b, c]);
        expect(getEpisodesByIds(db, [c, b, a]).map((e) => e.id)).toEqual([
            a,
            b,
            c,
        ]);
        expect(getEpisodesByIds(db, [])).toEqual([]);
    });

    it("prunes everything not in the keep list", () => {
        const show = upsertShow(db, "Show", "/tv/Show");
        const keep = upsertEpisode(db, episode(show.id, 1, 1));
        upsertEpisode(db, episode(show.id, 1, 2));
        deleteEpisodesNotIn(db, show.id, ["/tv/Show/S1E1.mkv"]);
        expect(listEpisodes(db, show.id).map((e) => e.id)).toEqual([keep]);

        deleteEpisodesNotIn(db, show.id, []);
        expect(listEpisodes(db, show.id)).toEqual([]);
    });
});

describe("arcs", () => {
    function showWithEpisodes(n: number): { showId: number; ids: number[] } {
        const show = upsertShow(db, "Show", "/tv/Show");
        const ids: number[] = [];
        for (let i = 1; i <= n; i++)
            ids.push(upsertEpisode(db, episode(show.id, 1, i)));
        return { showId: show.id, ids };
    }

    it("round-trips creation: members get part indexes in airing order", () => {
        const { showId, ids } = showWithEpisodes(4);
        const arc = createArc(
            db,
            showId,
            "Awakening",
            [ids[2], ids[0], ids[1]],
            "auto",
        );

        expect(arc).toMatchObject({
            showId,
            title: "Awakening",
            source: "auto",
            partCount: 3,
            range: "S01E01–E03",
        });
        expect(arc.episodeIds).toEqual([ids[0], ids[1], ids[2]]);
        expect(getEpisode(db, ids[0])).toMatchObject({
            partGroupId: arc.id,
            partIndex: 1,
        });
        expect(getEpisode(db, ids[2])).toMatchObject({
            partGroupId: arc.id,
            partIndex: 3,
        });
        expect(getEpisode(db, ids[3])).toMatchObject({
            partGroupId: null,
            partIndex: null,
        });
        expect(listArcs(db, showId)).toEqual([arc]);
    });

    it("deletion releases the members", () => {
        const { showId, ids } = showWithEpisodes(2);
        const arc = createArc(db, showId, "Awakening", ids, "manual");
        deleteArc(db, arc.id);

        expect(listArcs(db, showId)).toEqual([]);
        for (const id of ids) {
            expect(getEpisode(db, id)).toMatchObject({
                partGroupId: null,
                partIndex: null,
            });
        }
    });

    it("allows non-consecutive and cross-season episodes in airing order", () => {
        const { showId, ids } = showWithEpisodes(3);
        const seasonTwo = upsertEpisode(db, episode(showId, 2, 2));
        const arc = createArc(
            db,
            showId,
            "Interrupted conclusion",
            [seasonTwo, ids[0], ids[2]],
            "manual",
        );

        expect(arc.episodeIds).toEqual([ids[0], ids[2], seasonTwo]);
        expect(arc.range).toBe("S01E01 · S01E03 · S02E02");
        expect(getEpisode(db, ids[0])).toMatchObject({
            partGroupId: arc.id,
            partIndex: 1,
        });
        expect(getEpisode(db, seasonTwo)).toMatchObject({
            partGroupId: arc.id,
            partIndex: 3,
        });
    });

    it("rejects episodes from another show and empty input", () => {
        const { showId, ids } = showWithEpisodes(2);
        const other = upsertShow(db, "Other", "/tv/Other");
        const stray = upsertEpisode(
            db,
            episode(other.id, 1, 1, { path: "/tv/Other/S1E1.mkv" }),
        );
        // Matched rather than bare: a bare `.toThrow()` passes on *any* failure, so
        // a typo that made `createArc` throw a TypeError on every call — including
        // the legal ones — would still look green here.
        expect(() =>
            createArc(db, showId, "Nope", [...ids, stray], "manual"),
        ).toThrow(new RegExp(`episode ${stray} belongs to show ${other.id}`));
        expect(() => createArc(db, showId, "Nope", [], "manual")).toThrow(
            /no episodes given/,
        );
        // And a rejected arc leaves nothing half-created behind.
        expect(listArcs(db, showId)).toEqual([]);
    });

    it("spans a double episode when computing the range", () => {
        const show = upsertShow(db, "Show", "/tv/Show");
        const a = upsertEpisode(db, episode(show.id, 1, 1, { episodeEnd: 2 }));
        const b = upsertEpisode(
            db,
            episode(show.id, 1, 3, { path: "/tv/Show/S1E3.mkv" }),
        );
        const arc = createArc(db, show.id, "Awakening", [a, b], "manual");
        expect(arc.range).toBe("S01E01-E02–E03");
    });

    it("clearAutoArcs removes auto arcs and leaves manual ones alone", () => {
        const { showId, ids } = showWithEpisodes(4);
        // Not captured: the arc under test is the one that will be *gone*, and the
        // assertion this file used to make about it — `expect(auto.source).toBe
        // ("auto")` after the clear — only restated the argument passed in here.
        createArc(db, showId, "Auto", [ids[0], ids[1]], "auto");
        const manual = createArc(
            db,
            showId,
            "Manual",
            [ids[2], ids[3]],
            "manual",
        );

        clearAutoArcs(db, showId);

        expect(listArcs(db, showId).map((a) => a.id)).toEqual([manual.id]);
        expect(getEpisode(db, ids[0])).toMatchObject({
            partGroupId: null,
            partIndex: null,
        });
        expect(getEpisode(db, ids[3])).toMatchObject({
            partGroupId: manual.id,
            partIndex: 2,
        });
    });

    it("regrouping moves members and drops the group left empty", () => {
        const { showId, ids } = showWithEpisodes(3);
        const first = createArc(db, showId, "Auto", [ids[0], ids[1]], "auto");
        const second = createArc(
            db,
            showId,
            "Manual",
            [ids[0], ids[1], ids[2]],
            "manual",
        );

        const arcs = listArcs(db, showId);
        expect(arcs.map((a) => a.id)).toEqual([second.id]);
        expect(arcs[0].partCount).toBe(3);
        expect(first.id).not.toBe(second.id);
    });

    it("renumbers the survivors when a regroup only takes *some* of a group", () => {
        // Regression: the move used to delete groups left completely empty but never
        // touched the part indexes of a group left half-full. Pulling part 1 out of a
        // two-part arc left the survivor still labelled "part 2" of a one-part arc —
        // and the scheduler prints `part_index`, so the user saw "Part 2" with no
        // part 1 anywhere.
        const { showId, ids } = showWithEpisodes(4);
        const original = createArc(
            db,
            showId,
            "Trilogy",
            [ids[0], ids[1], ids[2]],
            "auto",
        );
        expect(getEpisode(db, ids[2])).toMatchObject({ partIndex: 3 });

        // Steal the first part into a new arc; parts 2 and 3 stay behind.
        createArc(db, showId, "Crossover", [ids[0], ids[3]], "manual");

        // The old group survives with two members, which must be parts 1 and 2 —
        // in their original airing order, not renumbered arbitrarily.
        const survivor = listArcs(db, showId).find((a) => a.id === original.id);
        expect(survivor?.partCount).toBe(2);
        expect(survivor?.episodeIds).toEqual([ids[1], ids[2]]);
        expect(getEpisode(db, ids[1])).toMatchObject({
            partGroupId: original.id,
            partIndex: 1,
        });
        expect(getEpisode(db, ids[2])).toMatchObject({
            partGroupId: original.id,
            partIndex: 2,
        });
    });
});

describe("scan roots and unmatched files", () => {
    it("adds roots idempotently and removes them", () => {
        addScanRoot(db, "/tv");
        addScanRoot(db, "/tv");
        addScanRoot(db, "/movies");
        expect(listScanRoots(db).map((r) => r.path)).toEqual([
            "/tv",
            "/movies",
        ]);

        removeScanRoot(db, listScanRoots(db)[0].id);
        expect(listScanRoots(db).map((r) => r.path)).toEqual(["/movies"]);
    });

    it("upserts unmatched files by path and removes them by id", () => {
        addUnmatched(db, "/tv/junk.mkv", "unparsed", 1, 2);
        addUnmatched(db, "/tv/junk.mkv", "ffprobe failed", 3, 4);
        const [file] = listUnmatched(db);
        expect(file).toMatchObject({
            reason: "ffprobe failed",
            mtimeMs: 3,
            sizeBytes: 4,
        });
        expect(getUnmatched(db, file.id)?.path).toBe("/tv/junk.mkv");

        removeUnmatched(db, file.id);
        expect(listUnmatched(db)).toEqual([]);
        expect(getUnmatched(db, file.id)).toBeNull();
    });

    /**
     * The contract the doc comment claims, now that the SQL agrees with it: the
     * bucket is a queue, not an alphabetised directory. It used to be `ORDER BY
     * path`, which reads identically on the tidy libraries a test usually builds
     * and differently on every real one — and the difference matters, because a
     * viewer working down the list must not have it reshuffled by a rescan that
     * re-records an entry they have already looked at.
     */
    it("lists unmatched files oldest first, and a rescan does not reorder them", () => {
        // Deliberately reverse-alphabetical, so path order and insert order differ.
        addUnmatched(db, "/tv/zulu.mkv", "unparsed", 1, 1);
        addUnmatched(db, "/tv/mike.mkv", "unparsed", 1, 1);
        addUnmatched(db, "/tv/alpha.mkv", "unparsed", 1, 1);

        expect(listUnmatched(db).map((f) => f.path)).toEqual([
            "/tv/zulu.mkv",
            "/tv/mike.mkv",
            "/tv/alpha.mkv",
        ]);

        // Re-recording the first one refreshes its reason in place; it does not go
        // to the back of the queue, because it is not a newly discovered problem.
        addUnmatched(db, "/tv/zulu.mkv", "ffprobe failed", 2, 2);
        expect(listUnmatched(db).map((f) => f.path)).toEqual([
            "/tv/zulu.mkv",
            "/tv/mike.mkv",
            "/tv/alpha.mkv",
        ]);
        expect(listUnmatched(db)[0].reason).toBe("ffprobe failed");
    });
});

describe("getLibraryOverview", () => {
    it("aggregates counts, playback paths, arcs and the unmatched bucket", () => {
        const show = upsertShow(db, "Gargoyles", "/tv/Gargoyles");
        const a = upsertEpisode(
            db,
            episode(show.id, 1, 1, { playbackPath: "direct" }),
        );
        const b = upsertEpisode(
            db,
            episode(show.id, 1, 2, { playbackPath: "remux" }),
        );
        // Remux too, but the soundtrack has to be encoded on the way through — the
        // distinction the REMUX tag reports as "· 1 → AAC".
        upsertEpisode(
            db,
            episode(show.id, 1, 3, { playbackPath: "remux", acodec: "ac3" }),
        );
        upsertEpisode(
            db,
            episode(show.id, 2, 1, { playbackPath: "transcode" }),
        );
        createArc(db, show.id, "Awakening", [a, b], "auto");
        addUnmatched(db, "/tv/junk.mkv", "unparsed", 1, 2);

        const overview = getLibraryOverview(db);
        expect(overview.totalEpisodes).toBe(4);
        expect(overview.unmatched).toHaveLength(1);
        expect(overview.shows).toEqual([
            {
                id: show.id,
                title: "Gargoyles",
                episodeCount: 4,
                seasonCount: 2,
                arcCount: 1,
                paths: { direct: 1, remux: 2, transcode: 1 },
                remuxAudioEncode: 1,
            },
        ]);
    });

    it("does not count a silent remuxed file as needing an audio encode", () => {
        const show = upsertShow(db, "Silent", "/tv/Silent");
        upsertEpisode(
            db,
            episode(show.id, 1, 1, { playbackPath: "remux", acodec: "none" }),
        );
        expect(getLibraryOverview(db).shows[0]).toMatchObject({
            paths: { direct: 0, remux: 1, transcode: 0 },
            remuxAudioEncode: 0,
        });
    });

    it("reports zeroes for a show with no episodes", () => {
        upsertShow(db, "Empty", "/tv/Empty");
        expect(getLibraryOverview(db).shows[0]).toMatchObject({
            episodeCount: 0,
            seasonCount: 0,
            arcCount: 0,
            paths: { direct: 0, remux: 0, transcode: 0 },
            remuxAudioEncode: 0,
        });
    });
});

/**
 * The load-bearing decision of the metadata lookup, in one suite.
 *
 * The whole design rests on the scanner and the lookup owning different
 * columns: `shows.title`/`episodes.title` are re-derived from the filesystem on
 * every pass, the four metadata columns are only ever written here. If a
 * metadata column ever reappears in an upsert `SET` list, a rescan silently
 * throws away a link the user made by hand — and nothing else in the suite
 * would notice.
 */
describe("provider metadata", () => {
    /** Link a show and title both of its episodes, as `applyMetadata` will. */
    function link(): { showId: number; episodeIds: number[] } {
        const show = upsertShow(db, "Gargoyles", "/tv/Gargoyles");
        const episodeIds = [1, 2].map((n) =>
            upsertEpisode(db, episode(show.id, 1, n)),
        );
        setShowMetadata(db, show.id, {
            displayTitle: "Gargoyles (1994)",
            source: "tvmaze",
            providerId: "3182",
        });
        setEpisodeMetadataTitles(db, [
            { episodeId: episodeIds[0], title: "Awakening: Part One" },
            { episodeId: episodeIds[1], title: "Awakening: Part Two" },
        ]);
        return { showId: show.id, episodeIds };
    }

    it("stores the link and the episode titles beside the scanner's own", () => {
        const { showId, episodeIds } = link();

        expect(getShow(db, showId)).toMatchObject({
            title: "Gargoyles",
            displayTitle: "Gargoyles (1994)",
            metadataSource: "tvmaze",
            metadataId: "3182",
        });
        expect(getEpisode(db, episodeIds[0])).toMatchObject({
            title: "Episode 1",
            metadataTitle: "Awakening: Part One",
        });
    });

    /**
     * Every list of shows is sorted on what the user reads, not on the folder
     * name behind it — otherwise a linked show sits in the alphabet at a letter
     * that appears nowhere on screen.
     */
    it("sorts by the displayed title, not the scanner's", () => {
        const zed = upsertShow(db, "Zed's Show", "/tv/Zed");
        upsertShow(db, "Middle", "/tv/Middle");
        setShowMetadata(db, zed.id, {
            displayTitle: "Aardvark Hour",
            source: "tvmaze",
            providerId: "1",
        });

        expect(listShows(db).map((s) => s.displayTitle ?? s.title)).toEqual([
            "Aardvark Hour",
            "Middle",
        ]);
    });

    it("survives a rescan that re-derives every title from the filesystem", () => {
        const { showId, episodeIds } = link();

        // Exactly what a scan does on the second pass: the same folder and the
        // same paths, with the titles the parser produces — including a folder
        // the user renamed, which is the case that rewrites `shows.title`.
        upsertShow(db, "Gargoyles [1080p]", "/tv/Gargoyles");
        upsertEpisode(db, episode(showId, 1, 1));
        upsertEpisode(db, episode(showId, 1, 2));

        expect(getShow(db, showId)).toMatchObject({
            title: "Gargoyles [1080p]",
            displayTitle: "Gargoyles (1994)",
            metadataSource: "tvmaze",
            metadataId: "3182",
        });
        expect(getEpisode(db, episodeIds[0])?.metadataTitle).toBe(
            "Awakening: Part One",
        );
    });

    /**
     * The stricter half: a *full* rescan re-probes files whose bytes changed,
     * which is what invalidates the cached loudness. A provider title is keyed
     * on (season, episode) rather than on the file, so a re-encode must not
     * touch it.
     */
    it("survives a rescan of a file whose bytes changed", () => {
        const { showId, episodeIds } = link();

        upsertEpisode(db, episode(showId, 1, 1, { mtimeMs: 9999 }));

        expect(getEpisode(db, episodeIds[0])).toMatchObject({
            mtimeMs: 9999,
            metadataTitle: "Awakening: Part One",
        });
    });

    it("shows the provider titles through the read models, not the scanner's", () => {
        const { showId } = link();
        expect(getLibraryOverview(db).shows[0].title).toBe("Gargoyles (1994)");
        expect(listShows(db)[0]).toMatchObject({
            title: "Gargoyles",
            displayTitle: "Gargoyles (1994)",
        });
        expect(showId).toBeGreaterThan(0);
    });

    it("unlinks totally — every column back to what the scanner named", () => {
        const { showId, episodeIds } = link();

        clearShowMetadata(db, showId);

        expect(getShow(db, showId)).toMatchObject({
            title: "Gargoyles",
            displayTitle: null,
            metadataSource: null,
            metadataId: null,
        });
        for (const id of episodeIds) {
            expect(getEpisode(db, id)?.metadataTitle).toBeNull();
        }
        expect(getLibraryOverview(db).shows[0].title).toBe("Gargoyles");
    });

    it("ignores a title for an episode id that no longer exists", () => {
        const show = upsertShow(db, "Show", "/tv/Show");
        expect(() =>
            setEpisodeMetadataTitles(db, [{ episodeId: 4242, title: "Gone" }]),
        ).not.toThrow();
        expect(listEpisodes(db, show.id)).toHaveLength(0);
    });
});
