import { type ArcCandidate, detectArcs } from "@main/library/arcs.js";
import { describe, expect, it } from "vitest";

/** Terse builder: episodes in one season, numbered from 1 unless told otherwise. */
function season(
    titles: (string | null)[],
    opts: { season?: number; from?: number } = {},
): ArcCandidate[] {
    const s = opts.season ?? 1;
    const from = opts.from ?? 1;
    return titles.map((title, i) => ({
        id: 100 + s * 100 + from + i,
        season: s,
        episode: from + i,
        title,
    }));
}

describe("detectArcs — accepted markers", () => {
    it('groups "Part N"', () => {
        const eps = season([
            "The Gathering - Part 1",
            "The Gathering - Part 2",
            "Enter Macbeth",
        ]);
        expect(detectArcs(eps)).toEqual([
            { title: "The Gathering", episodeIds: [eps[0].id, eps[1].id] },
        ]);
    });

    it('groups "(N)"', () => {
        const eps = season(["Awakening (1)", "Awakening (2)", "Awakening (3)"]);
        expect(detectArcs(eps)).toEqual([
            {
                title: "Awakening",
                episodeIds: [eps[0].id, eps[1].id, eps[2].id],
            },
        ]);
    });

    it('groups "Pt. N" and "Pt N"', () => {
        const dotted = season(["Reunion Pt. 1", "Reunion Pt. 2"]);
        expect(detectArcs(dotted)).toHaveLength(1);
        const bare = season(["Reunion Pt 1", "Reunion Pt 2"]);
        expect(detectArcs(bare)).toHaveLength(1);
    });

    it("groups word-numbered parts", () => {
        const eps = season([
            "Awakening Part One",
            "Awakening Part Two",
            "Awakening Part Three",
        ]);
        expect(detectArcs(eps)).toEqual([
            {
                title: "Awakening",
                episodeIds: [eps[0].id, eps[1].id, eps[2].id],
            },
        ]);
    });

    it("accepts comma and colon separators before the marker", () => {
        expect(
            detectArcs(season(["Awakening, Part 1", "Awakening, Part 2"])),
        ).toHaveLength(1);
        expect(
            detectArcs(season(["Awakening: Part 1", "Awakening: Part 2"])),
        ).toHaveLength(1);
        expect(
            detectArcs(season(["Awakening — Part 1", "Awakening — Part 2"])),
        ).toHaveLength(1);
    });

    it("compares stems case-insensitively but keeps the first one for display", () => {
        const eps = season([
            "The Gathering - Part 1",
            "THE GATHERING - part 2",
        ]);
        expect(detectArcs(eps)).toEqual([
            { title: "The Gathering", episodeIds: [eps[0].id, eps[1].id] },
        ]);
    });

    it("finds several arcs in one season", () => {
        const eps = season([
            "Awakening Part 1",
            "Awakening Part 2",
            "Filler",
            "Reunion Part 1",
            "Reunion Part 2",
        ]);
        expect(detectArcs(eps).map((a) => a.title)).toEqual([
            "Awakening",
            "Reunion",
        ]);
    });
});

describe("detectArcs — rejection", () => {
    it("rejects a single part", () => {
        expect(
            detectArcs(season(["Awakening Part 1", "Enter Macbeth"])),
        ).toEqual([]);
    });

    it("rejects a run that does not start at part 1", () => {
        expect(
            detectArcs(season(["Awakening Part 2", "Awakening Part 3"])),
        ).toEqual([]);
    });

    it("rejects a gap in the part numbers", () => {
        expect(
            detectArcs(season(["Awakening Part 1", "Awakening Part 3"])),
        ).toEqual([]);
    });

    it("rejects non-consecutive episode numbers", () => {
        const eps: ArcCandidate[] = [
            { id: 1, season: 1, episode: 1, title: "Awakening Part 1" },
            { id: 2, season: 1, episode: 5, title: "Awakening Part 2" },
        ];
        expect(detectArcs(eps)).toEqual([]);
    });

    it("rejects parts split across a season boundary", () => {
        const eps: ArcCandidate[] = [
            { id: 1, season: 1, episode: 13, title: "Awakening Part 1" },
            { id: 2, season: 2, episode: 1, title: "Awakening Part 2" },
        ];
        expect(detectArcs(eps)).toEqual([]);
    });

    it("rejects different stems", () => {
        expect(
            detectArcs(season(["Awakening Part 1", "Reunion Part 2"])),
        ).toEqual([]);
    });

    it("rejects a marker with no stem", () => {
        expect(detectArcs(season(["Part 1", "Part 2"]))).toEqual([]);
        expect(detectArcs(season(["(1)", "(2)"]))).toEqual([]);
    });

    it("ignores untitled episodes", () => {
        expect(
            detectArcs(season(["Awakening Part 1", null, "Awakening Part 2"])),
        ).toEqual([]);
    });

    it('does not read a mid-title "Part 2" as a marker', () => {
        expect(
            detectArcs(
                season([
                    "The Part 1 Solution Arrives",
                    "The Part 2 Solution Arrives",
                ]),
            ),
        ).toEqual([]);
    });

    it("does not read roman numerals as parts", () => {
        expect(
            detectArcs(season(["Awakening Part I", "Awakening Part II"])),
        ).toEqual([]);
    });

    it("does not read a year in parentheses as a part", () => {
        expect(
            detectArcs(season(["Awakening (1994)", "Awakening (1995)"])),
        ).toEqual([]);
    });

    it("returns nothing for an empty library", () => {
        expect(detectArcs([])).toEqual([]);
    });
});

describe("detectArcs — ordering", () => {
    it("sorts defensively before grouping", () => {
        const shuffled: ArcCandidate[] = [
            { id: 3, season: 1, episode: 3, title: "Awakening Part 3" },
            { id: 1, season: 1, episode: 1, title: "Awakening Part 1" },
            { id: 2, season: 1, episode: 2, title: "Awakening Part 2" },
        ];
        expect(detectArcs(shuffled)).toEqual([
            { title: "Awakening", episodeIds: [1, 2, 3] },
        ]);
    });

    it("starts a new arc when the numbering restarts", () => {
        const eps = season([
            "Awakening Part 1",
            "Awakening Part 2",
            "Awakening Part 1",
            "Awakening Part 2",
        ]);
        const arcs = detectArcs(eps);
        expect(arcs).toHaveLength(2);
        expect(arcs[0].episodeIds).toEqual([eps[0].id, eps[1].id]);
        expect(arcs[1].episodeIds).toEqual([eps[2].id, eps[3].id]);
    });
});
