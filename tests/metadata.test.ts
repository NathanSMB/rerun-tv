/**
 * The show metadata lookup (`main/services/metadata.ts`).
 *
 * Two subjects, split the way the module is. `buildPlan` is pure, so its cases
 * are the awkward shapes of a real library — a file that spans two episodes, a
 * span the provider only half knows about, an unnumbered special, a provider
 * episode nobody has on disk — asserted against plain arrays with no database in
 * sight. The client half is about the network misbehaving, which is the only
 * part a user ever sees go wrong: a 429, a 503, a connection that never answers.
 * Those all have to arrive as one readable sentence, because the renderer prints
 * whatever comes back verbatim next to the input.
 *
 * The fetch is injected (`MetadataDeps`) exactly as in
 * `tests/ffmpeg-manager.test.ts`, so nothing here touches TVmaze.
 */

import {
    buildPlan,
    fetchEpisodes,
    fetchShowName,
    type LocalEpisode,
    type MetadataDeps,
    type ProviderEpisode,
    searchShows,
} from "@main/services/metadata.js";
import { describe, expect, it } from "vitest";

/** A provider episode list, written the way the assertions read. */
const pe = (season: number, number: number, name: string): ProviderEpisode => ({
    season,
    number,
    name,
});

/** A local row: id, season, first episode, and an optional span end. */
const le = (
    id: number,
    season: number,
    episode: number,
    episodeEnd: number | null = null,
): LocalEpisode => ({ id, season, episode, episodeEnd });

const target = {
    showId: 7,
    providerShowId: "3182",
    name: "Gargoyles",
};

/** Serve one canned body to every request, recording the URLs asked for. */
function fakeFetch(
    body: unknown,
    init: { status?: number } = {},
): { deps: MetadataDeps; urls: string[] } {
    const urls: string[] = [];
    const deps: MetadataDeps = {
        fetch: (async (url: string) => {
            urls.push(url);
            return {
                ok: (init.status ?? 200) < 400,
                status: init.status ?? 200,
                json: async () => body,
            } as unknown as Response;
        }) as unknown as typeof globalThis.fetch,
    };
    return { deps, urls };
}

/** A network that fails the way `fetch` does — by rejecting, not by status. */
function failingFetch(err: Error): MetadataDeps {
    return {
        fetch: (async () => {
            throw err;
        }) as unknown as typeof globalThis.fetch,
    };
}

describe("buildPlan", () => {
    it("matches a plain file to the provider entry at the same number", () => {
        const plan = buildPlan(
            target,
            [pe(1, 1, "Awakening: Part One"), pe(2, 7, "The Mirror")],
            [le(10, 1, 1), le(11, 2, 7)],
        );

        expect(plan.episodes).toEqual([
            { episodeId: 10, title: "Awakening: Part One" },
            { episodeId: 11, title: "The Mirror" },
        ]);
        expect(plan.matchedCount).toBe(2);
        expect(plan.multiCount).toBe(0);
        expect(plan.unmatchedCount).toBe(0);
        // The whole reason the plan carries these: apply writes them, not a
        // re-derived guess.
        expect(plan.showId).toBe(7);
        expect(plan.provider).toBe("tvmaze");
        expect(plan.providerShowId).toBe("3182");
        expect(plan.displayTitle).toBe("Gargoyles");
    });

    it("joins both titles of a multi-episode file", () => {
        const plan = buildPlan(
            target,
            [pe(1, 5, "Enter Macbeth"), pe(1, 6, "The Edge")],
            [le(10, 1, 5, 6)],
        );

        expect(plan.episodes).toEqual([
            { episodeId: 10, title: "Enter Macbeth / The Edge" },
        ]);
        expect(plan.multiCount).toBe(1);
        expect(plan.matchedCount).toBe(0);
    });

    /**
     * Half a title is better than none: the file really does contain that
     * episode, and the preview shows the user exactly what will be written.
     */
    it("joins whatever part of a span exists", () => {
        const plan = buildPlan(
            target,
            [pe(1, 6, "The Edge")],
            [le(10, 1, 5, 6)],
        );

        expect(plan.episodes).toEqual([{ episodeId: 10, title: "The Edge" }]);
        expect(plan.multiCount).toBe(1);
        expect(plan.unmatchedCount).toBe(0);
    });

    it("counts a fully missing span as unmatched and writes nothing for it", () => {
        const plan = buildPlan(
            target,
            [pe(1, 1, "Awakening")],
            [le(10, 4, 5, 6)],
        );

        expect(plan.episodes).toEqual([]);
        expect(plan.unmatchedCount).toBe(1);
        expect(plan.multiCount).toBe(0);
    });

    it("treats a span whose end equals its start as a plain match", () => {
        const plan = buildPlan(
            target,
            [pe(1, 5, "Enter Macbeth")],
            [le(10, 1, 5, 5)],
        );

        expect(plan.matchedCount).toBe(1);
        expect(plan.multiCount).toBe(0);
    });

    it("leaves local files with no provider entry untouched", () => {
        const plan = buildPlan(
            target,
            [pe(1, 1, "Awakening")],
            [le(10, 1, 1), le(11, 1, 2), le(12, 1, 3)],
        );

        expect(plan.episodes).toEqual([{ episodeId: 10, title: "Awakening" }]);
        expect(plan.unmatchedCount).toBe(2);
    });

    it("ignores provider episodes with no local file", () => {
        const plan = buildPlan(
            target,
            [
                pe(1, 1, "Awakening"),
                pe(1, 2, "Part Two"),
                pe(1, 3, "Part Three"),
            ],
            [le(10, 1, 2)],
        );

        expect(plan.episodes).toEqual([{ episodeId: 10, title: "Part Two" }]);
        expect(plan.matchedCount).toBe(1);
        expect(plan.unmatchedCount).toBe(0);
    });

    it("matches season-0 specials like anything else", () => {
        const plan = buildPlan(
            target,
            [pe(0, 1, "The Pilot Reel")],
            [le(10, 0, 1)],
        );

        expect(plan.episodes).toEqual([
            { episodeId: 10, title: "The Pilot Reel" },
        ]);
    });
});

describe("client mapping", () => {
    it("maps search hits to candidates, with the year off the premiere date", async () => {
        const { deps, urls } = fakeFetch([
            {
                show: {
                    id: 3182,
                    name: "Gargoyles",
                    premiered: "1994-10-24",
                    status: "Ended",
                    network: { name: "Syndication" },
                },
            },
            {
                show: {
                    id: 9,
                    name: "Gargoyle Gals",
                    premiered: null,
                    status: "Running",
                    network: null,
                    webChannel: { name: "YouTube" },
                },
            },
        ]);

        const found = await searchShows("gargoyles & co", deps);

        expect(urls[0]).toBe(
            "https://api.tvmaze.com/search/shows?q=gargoyles%20%26%20co",
        );
        expect(found).toEqual([
            {
                providerShowId: "3182",
                name: "Gargoyles",
                premiered: "1994-10-24",
                year: 1994,
                network: "Syndication",
                status: "Ended",
            },
            {
                providerShowId: "9",
                name: "Gargoyle Gals",
                premiered: null,
                year: null,
                // A web-only series identifies by its web channel or not at all.
                network: "YouTube",
                status: "Running",
            },
        ]);
    });

    it("caps the candidate list and never asks for a blank query", async () => {
        const many = Array.from({ length: 25 }, (_, i) => ({
            show: { id: i, name: `Show ${i}` },
        }));
        const { deps, urls } = fakeFetch(many);

        expect(await searchShows("   ", deps)).toEqual([]);
        expect(urls).toEqual([]);

        expect(await searchShows("show", deps)).toHaveLength(10);
    });

    it("drops unnumbered specials and nameless entries before the join", async () => {
        const { deps, urls } = fakeFetch([
            { season: 1, number: 1, name: "Awakening" },
            { season: 0, number: null, name: "Unaired Promo" },
            { season: null, number: 3, name: "Lost" },
            { season: 1, number: 2, name: null },
        ]);

        const episodes = await fetchEpisodes("3182", deps);

        expect(urls[0]).toBe(
            "https://api.tvmaze.com/shows/3182/episodes?specials=1",
        );
        expect(episodes).toEqual([{ season: 1, number: 1, name: "Awakening" }]);
    });

    it("reads the display title off the show endpoint", async () => {
        const { deps, urls } = fakeFetch({ id: 3182, name: "Gargoyles" });

        expect(await fetchShowName("3182", deps)).toBe("Gargoyles");
        expect(urls[0]).toBe("https://api.tvmaze.com/shows/3182");
    });
});

describe("client errors", () => {
    /**
     * The one failure where the right advice is "do exactly that again, in a
     * second" — so it must not read like the other outages, and must never turn
     * into a retry loop that makes the rate limit worse.
     */
    it("says so when TVmaze rate-limits", async () => {
        const { deps } = fakeFetch(null, { status: 429 });

        await expect(searchShows("gargoyles", deps)).rejects.toThrow(
            /rate-limiting/i,
        );
    });

    it("reports any other HTTP status readably", async () => {
        const { deps } = fakeFetch(null, { status: 503 });

        await expect(fetchEpisodes("3182", deps)).rejects.toThrow(/503/);
    });

    it("distinguishes a timeout from being offline", async () => {
        const timeout = new Error("The operation was aborted");
        timeout.name = "TimeoutError";

        await expect(
            searchShows("gargoyles", failingFetch(timeout)),
        ).rejects.toThrow(/did not respond in time/i);

        await expect(
            searchShows("gargoyles", failingFetch(new Error("ENOTFOUND"))),
        ).rejects.toThrow(/could not reach tvmaze/i);
    });
});
