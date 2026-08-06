/**
 * @vitest-environment happy-dom
 *
 * Screen 04 · the show metadata card.
 *
 * The card is mounted through the real `<Library/>`, not on its own, because
 * half of what it promises is about the screen around it: the aside has to hand
 * it the `Show` *entity* (the aggregate's `title` is already coalesced and
 * carries no link state), and Escape has to close the panel without disturbing
 * anything else the Library is holding.
 *
 * Four behaviours here are the ones a hand-wired typeahead gets wrong, and each
 * would pass a suite that only checked rendering:
 *
 * - the debounce (three keystrokes are one request, not three — TVmaze rate-limits),
 * - the single-flight guard (a slow answer for a prefix must not overwrite the
 *   list for the longer query the user has since typed),
 * - that Apply sends back the *same* plan object the preview showed, since the
 *   whole preview/apply split exists so nothing is recomputed between look and
 *   commit,
 * - and that a main-process failure lands inline with the query intact.
 */

import type { RerunApi } from "@shared/ipc.js";
import type {
    LibraryOverview,
    MetadataCandidate,
    MetadataPlan,
    ScanRoot,
    ScanStatus,
    Show,
} from "@shared/types.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Library from "../../src/renderer/src/screens/Library.js";
import { useStore } from "../../src/renderer/src/store.js";
import { makeBridge } from "./bridge.js";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const IDLE_SCAN: ScanStatus = {
    state: "idle",
    total: 0,
    done: 0,
    probed: 0,
    currentRoot: null,
    error: null,
};

const ROOT: ScanRoot = { id: 1, path: "/tv", addedAt: 0 };

const OVERVIEW: LibraryOverview = {
    shows: [
        {
            id: 10,
            title: "Gargoyles",
            episodeCount: 3,
            seasonCount: 1,
            arcCount: 0,
            paths: { direct: 3, remux: 0, transcode: 0 },
            remuxAudioEncode: 0,
        },
    ],
    unmatched: [],
    totalEpisodes: 3,
};

function showEntity(patch: Partial<Show> = {}): Show {
    return {
        id: 10,
        title: "Gargoyles.1994.DVDRip",
        displayTitle: null,
        metadataSource: null,
        metadataId: null,
        folderPath: "/tv/Gargoyles.1994.DVDRip",
        addedAt: 0,
        ...patch,
    };
}

const GARGOYLES: MetadataCandidate = {
    providerShowId: "111",
    name: "Gargoyles",
    premiered: "1994-10-24",
    year: 1994,
    network: "Syndication",
    status: "Ended",
};

const GOLIATH: MetadataCandidate = {
    providerShowId: "222",
    name: "Gargoyles: The Goliath Chronicles",
    premiered: "1996-09-07",
    year: 1996,
    network: "ABC",
    status: "Ended",
};

const PLAN: MetadataPlan = {
    showId: 10,
    provider: "tvmaze",
    providerShowId: "111",
    displayTitle: "Gargoyles",
    episodes: [
        { episodeId: 1, title: "Awakening: Part One" },
        { episodeId: 2, title: "Awakening: Part Two" },
    ],
    matchedCount: 1,
    multiCount: 1,
    unmatchedCount: 1,
};

/** What the card asked of main, in order — the whole point of most assertions. */
let searched: string[] = [];
let previewed: { showId: number; providerShowId: string }[] = [];
let applied: MetadataPlan[] = [];
let unlinked: number[] = [];

/** Per-query scripting for the search: answer, and how slowly. */
let searchScript: Map<string, { after: number; results: MetadataCandidate[] }>;
/** Set to make search or preview fail the way main would. */
let searchFails: string | null = null;

let container: HTMLDivElement;
let root: Root;

function bridge(): RerunApi {
    return makeBridge({
        library: {
            getOverview: async () => OVERVIEW,
            listShows: async () => [showEntity()],
            listRoots: async () => [ROOT],
            listArcs: async () => [],
            listEpisodes: async () => [
                {
                    id: 1,
                    showId: 10,
                    season: 1,
                    episode: 1,
                    episodeEnd: null,
                    title: null,
                    metadataTitle: null,
                    path: "/tv/g/S01E01.mkv",
                    durationS: 1200,
                    container: "matroska",
                    vcodec: "h264",
                    acodec: "aac",
                    width: 640,
                    height: 480,
                    audioChannels: 2,
                    partGroupId: null,
                    partIndex: null,
                    playbackPath: "direct",
                    mtimeMs: 0,
                    sizeBytes: 1,
                    addedAt: 0,
                },
            ],
            getScanStatus: async () => IDLE_SCAN,
            searchMetadata: async (query) => {
                searched.push(query);
                if (searchFails != null) throw new Error(searchFails);
                const scripted = searchScript.get(query);
                if (scripted == null) return [];
                await new Promise((resolve) =>
                    setTimeout(resolve, scripted.after),
                );
                return scripted.results;
            },
            previewMetadata: async (input) => {
                previewed.push(input);
                return PLAN;
            },
            applyMetadata: async (plan) => {
                applied.push(plan);
            },
            unlinkMetadata: async (showId) => {
                unlinked.push(showId);
            },
        },
        channels: { list: async () => [] },
    });
}

function button(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find(
        (el) => (el.textContent ?? "").trim() === label,
    );
    if (!match) throw new Error(`no button labelled "${label}"`);
    return match as HTMLButtonElement;
}

async function click(el: HTMLElement): Promise<void> {
    await act(async () => {
        el.click();
        await Promise.resolve();
    });
}

function searchInput(): HTMLInputElement {
    const input = container.querySelector(
        ".meta-card input.search",
    ) as HTMLInputElement | null;
    if (!input) throw new Error("the lookup panel is not open");
    return input;
}

/** Type as a user does — React's value setter, then an `input` event. */
async function type(value: string): Promise<void> {
    const field = searchInput();
    await act(async () => {
        Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
        )?.set?.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
    });
}

async function press(key: string): Promise<void> {
    await act(async () => {
        searchInput().dispatchEvent(
            new KeyboardEvent("keydown", { key, bubbles: true }),
        );
        await Promise.resolve();
    });
}

/** Let the 300 ms debounce fire and its answer land. */
async function settle(ms = 400): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}

function text(): string {
    return container.textContent ?? "";
}

function alerts(): string[] {
    return [...container.querySelectorAll('[role="alert"]')].map(
        (el) => el.textContent ?? "",
    );
}

async function mount(show: Show = showEntity()): Promise<void> {
    useStore.setState({
        library: OVERVIEW,
        shows: [show],
        roots: [ROOT],
        scan: IDLE_SCAN,
    });
    root = createRoot(container);
    await act(async () => {
        root.render(<Library />);
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** Open the panel and clear the prefilled folder title in one gesture. */
async function openLookup(): Promise<void> {
    await click(button("Look up…"));
    await type("");
}

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    (window as unknown as { rerun: RerunApi }).rerun = bridge();
    searched = [];
    previewed = [];
    applied = [];
    unlinked = [];
    searchFails = null;
    searchScript = new Map([
        ["gar", { after: 250, results: [GOLIATH] }],
        ["gargoyles", { after: 0, results: [GARGOYLES, GOLIATH] }],
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

describe("the typeahead", () => {
    it("searches once for a burst of keystrokes, with the final query", async () => {
        await mount();
        await openLookup();
        await type("g");
        await type("ga");
        await type("gargoyles");
        await settle();

        expect(searched).toEqual(["gargoyles"]);
        expect(text()).toContain("1994 · Syndication");
    });

    it("drops a slow answer for a query the user has moved on from", async () => {
        await mount();
        await openLookup();
        // "gar" gets far enough to be requested, then is superseded while its
        // (slower) answer is still in flight.
        await type("gar");
        await settle();
        await type("gargoyles");
        await settle();

        expect(searched).toEqual(["gar", "gargoyles"]);
        // The stale answer is one row; the live one is two. Counting rows is
        // what tells them apart — both lists mention "Gargoyles".
        expect(container.querySelectorAll(".meta-card .m-pick")).toHaveLength(
            2,
        );
        expect(text()).toContain("1994 · Syndication");
    });

    it("keeps the query and shows the failure inline when main refuses", async () => {
        await mount();
        await openLookup();
        searchFails = "TVmaze is rate-limiting — try again in a moment";
        await type("gargoyles");
        await settle();

        expect(alerts().join(" ")).toContain("TVmaze is rate-limiting");
        expect(searchInput().value).toBe("gargoyles");
    });

    it("closes on Escape without touching the rest of the screen", async () => {
        await mount();
        await openLookup();
        await type("gargoyles");
        await settle();
        await press("Escape");

        expect(container.querySelector(".meta-card input.search")).toBeNull();
        // The Library is intact behind it: the show is still selected, so the
        // arcs panel still names it.
        expect(text()).toContain("Detected arcs");
        expect(button("Look up…")).toBeTruthy();
    });
});

describe("preview and apply", () => {
    async function toPreview(): Promise<void> {
        await mount();
        await openLookup();
        await type("gargoyles");
        await settle();
        // Enter previews whatever ↑↓ has highlighted; the first row by default.
        await press("Enter");
        await settle(0);
    }

    it("previews the highlighted candidate and counts what would be written", async () => {
        await toPreview();

        expect(previewed).toEqual([{ showId: 10, providerShowId: "111" }]);
        // matched + multi of the three files, and the two other counts.
        expect(text()).toContain("2 of 3");
        expect(text()).toContain("1 multi-episode file");
        expect(text()).toContain("1 keep filename titles");
        // The concrete retitles, joined with the local numbering.
        expect(text()).toContain("S01E01");
        expect(text()).toContain("Awakening: Part One");
    });

    it("sends the preview's own plan object to apply, unchanged", async () => {
        await toPreview();
        await click(button("Apply"));

        expect(applied).toHaveLength(1);
        // Identity, not just shape: a card that rebuilt the plan could commit
        // something the user never read.
        expect(applied[0]).toBe(PLAN);
    });

    /**
     * Escape is Back. The search box is unmounted in this state, so the key is
     * dispatched at the document the way a real one arrives with focus on the
     * body — the card still has to catch it, write nothing, and hand the user
     * back the candidate list rather than letting it fall through to the screen.
     */
    it("backs out of the preview on Escape, writing nothing", async () => {
        await toPreview();

        await act(async () => {
            document.body.dispatchEvent(
                new KeyboardEvent("keydown", {
                    key: "Escape",
                    bubbles: true,
                }),
            );
            await Promise.resolve();
        });

        expect(applied).toEqual([]);
        expect(container.querySelector(".meta-card input.search")).toBeTruthy();
        // The Library kept its selection behind the card.
        expect(text()).toContain("Detected arcs");
    });

    it("writes nothing on Back", async () => {
        await toPreview();
        await click(button("Back"));

        expect(applied).toEqual([]);
        expect(container.querySelector(".meta-card input.search")).toBeTruthy();
    });
});

describe("a linked show", () => {
    const LINKED = showEntity({
        displayTitle: "Gargoyles",
        metadataSource: "tvmaze",
        metadataId: "111",
    });

    it("offers Refresh and Unlink instead of a lookup", async () => {
        await mount(LINKED);

        expect(text()).toContain("Linked to TVmaze");
        expect(button("Refresh")).toBeTruthy();
        expect(button("Unlink")).toBeTruthy();
    });

    it("refreshes straight into a preview the user still has to apply", async () => {
        await mount(LINKED);
        await click(button("Refresh"));
        await settle(0);

        // The stored id, no search round-trip — and nothing written yet.
        expect(previewed).toEqual([{ showId: 10, providerShowId: "111" }]);
        expect(applied).toEqual([]);
        expect(text()).toContain("2 of 3");
    });

    it("unlinks by show id", async () => {
        await mount(LINKED);
        await click(button("Unlink"));
        await settle(0);

        expect(unlinked).toEqual([10]);
    });

    it("titles the show list by the display title, not the folder", async () => {
        await mount(LINKED);

        const name = container.querySelector(".show-row .s-name");
        expect(name?.textContent).toBe("Gargoyles");
    });
});
