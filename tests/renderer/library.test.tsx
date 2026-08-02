/**
 * @vitest-environment happy-dom
 *
 * Screen 04 · the Library.
 *
 * The assignment path is the reason this suite exists. `assignUnmatched` has a
 * thorough service-side suite (`tests/library-assign.test.ts`), but nothing
 * covered the *wiring*: which fields become which arguments, which inputs are
 * refused before the call is made at all, and whether the screen re-reads
 * afterwards so the file leaves the unmatched list. A screen that sent
 * `episodeEnd` as a string, or dropped the title, would have passed everything.
 *
 * The empty states are here for a smaller reason: they are the first thing a
 * new user sees, and "no folders" versus "folders but nothing scanned" send
 * them to two different places.
 */

import type { RerunApi } from "@shared/ipc.js";
import type {
    AssignUnmatchedInput,
    LibraryOverview,
    ScanRoot,
    ScanStatus,
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

/** One show, one file the parser could not place. */
function overview(patch: Partial<LibraryOverview> = {}): LibraryOverview {
    return {
        shows: [
            {
                id: 10,
                title: "Cheers",
                episodeCount: 3,
                seasonCount: 1,
                arcCount: 0,
                paths: { direct: 3, remux: 0, transcode: 0 },
                remuxAudioEncode: 0,
            },
        ],
        unmatched: [
            {
                id: 99,
                path: "/tv/Cheers/bloopers.mkv",
                reason: "no season/episode in the name",
                mtimeMs: 0,
                sizeBytes: 1,
            },
        ],
        totalEpisodes: 3,
        ...patch,
    };
}

/** Every `assignUnmatched` call the screen made, in order. */
let assigned: AssignUnmatchedInput[] = [];
let dismissed: number[] = [];

let container: HTMLDivElement;
let root: Root;

function bridge(): RerunApi {
    return makeBridge({
        library: {
            getOverview: async () => overview(),
            listShows: async () => [
                {
                    id: 10,
                    title: "Cheers",
                    folderPath: "/tv/Cheers",
                    addedAt: 0,
                },
            ],
            listRoots: async () => [ROOT],
            listArcs: async () => [],
            listEpisodes: async () => [],
            getScanStatus: async () => IDLE_SCAN,
            rescan: async () => undefined,
            assignUnmatched: async (input) => {
                assigned.push(input);
            },
            dismissUnmatched: async (fileId) => {
                dismissed.push(fileId);
            },
        },
        channels: { list: async () => [] },
    });
}

/** The first button whose label is exactly `label`. */
function button(label: string): HTMLButtonElement {
    const match = [...container.querySelectorAll("button")].find(
        (el) => (el.textContent ?? "").trim() === label,
    );
    if (!match) throw new Error(`no button labelled "${label}"`);
    return match as HTMLButtonElement;
}

/** The assign form's submit button — the one that actually files the episode. */
function submitAssign(): HTMLButtonElement {
    const match = container.querySelector(
        'form.assign button[type="submit"]',
    ) as HTMLButtonElement | null;
    if (!match) throw new Error("the assign form is not open");
    return match;
}

async function click(el: HTMLElement): Promise<void> {
    await act(async () => {
        el.click();
        await Promise.resolve();
    });
}

/** Type into a labelled field the way a user would — value then `input`. */
async function fill(labelText: string, value: string): Promise<void> {
    const label = [...container.querySelectorAll("label")].find(
        (el) => el.textContent === labelText,
    );
    if (!label) throw new Error(`no field labelled "${labelText}"`);
    const field = container.querySelector(`#${label.getAttribute("for")}`) as
        | HTMLInputElement
        | HTMLSelectElement;
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
            field instanceof HTMLSelectElement
                ? HTMLSelectElement.prototype
                : HTMLInputElement.prototype,
            "value",
        )?.set;
        setter?.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        await Promise.resolve();
    });
}

/** Visible `role="alert"` text, which is how every failure reaches the user. */
function alerts(): string[] {
    return [...container.querySelectorAll('[role="alert"]')].map(
        (el) => el.textContent ?? "",
    );
}

async function mount(
    state: Partial<{
        roots: ScanRoot[] | null;
        library: LibraryOverview | null;
    }> = {},
) {
    useStore.setState({
        library: overview(),
        shows: [
            { id: 10, title: "Cheers", folderPath: "/tv/Cheers", addedAt: 0 },
        ],
        roots: [ROOT],
        scan: IDLE_SCAN,
        ...state,
    });
    root = createRoot(container);
    await act(async () => {
        root.render(<Library />);
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    (window as unknown as { rerun: RerunApi }).rerun = bridge();
    assigned = [];
    dismissed = [];
    container = document.createElement("div");
    document.body.appendChild(container);
});

afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
});

describe("assigning an unmatched file", () => {
    it("sends the form's values as the input the service expects", async () => {
        await mount();
        await click(button("Assign…"));

        await fill("Season", "2");
        await fill("Episode", "5");
        await fill("Episode end", "6");
        await fill("Title", "  Bloopers  ");
        await click(submitAssign());

        // Numbers as numbers, not the strings the inputs hold, and the title
        // trimmed — the three things a hand-wired form gets wrong.
        expect(assigned).toEqual([
            {
                fileId: 99,
                showId: 10,
                season: 2,
                episode: 5,
                episodeEnd: 6,
                title: "Bloopers",
            },
        ]);
    });

    it("sends no title at all when the field is blank", async () => {
        await mount();
        await click(button("Assign…"));
        await fill("Season", "1");
        await fill("Episode", "1");
        await click(submitAssign());

        expect(assigned[0]).toMatchObject({ title: null, episodeEnd: null });
    });

    /**
     * Refused in the screen, before the call. Note what this does *not* test: a
     * season of 0 never reaches the guard at all, because the input carries
     * `min=1` and the browser refuses to submit the form. An empty field is the
     * case that gets through the constraint and still has to be caught.
     */
    it("refuses an empty season without calling the service", async () => {
        await mount();
        await click(button("Assign…"));
        await fill("Season", "");
        await click(submitAssign());

        expect(assigned).toEqual([]);
        expect(alerts().join(" ")).toContain("Season");
    });

    it("refuses an episode range that runs backwards", async () => {
        await mount();
        await click(button("Assign…"));
        await fill("Season", "1");
        await fill("Episode", "5");
        await fill("Episode end", "2");
        await click(submitAssign());

        expect(assigned).toEqual([]);
        expect(alerts().join(" ")).toContain("Episode end");
    });

    it("surfaces a service failure instead of pretending it worked", async () => {
        (window as unknown as { rerun: RerunApi }).rerun = makeBridge({
            library: {
                getOverview: async () => overview(),
                listShows: async () => [
                    {
                        id: 10,
                        title: "Cheers",
                        folderPath: "/tv/Cheers",
                        addedAt: 0,
                    },
                ],
                listRoots: async () => [ROOT],
                listArcs: async () => [],
                getScanStatus: async () => IDLE_SCAN,
                assignUnmatched: async () => {
                    throw new Error("that episode already exists");
                },
            },
            channels: { list: async () => [] },
        });
        await mount();
        await click(button("Assign…"));
        await fill("Season", "1");
        await fill("Episode", "1");
        await click(submitAssign());

        expect(alerts().join(" ")).toContain("that episode already exists");
    });
});

describe("dismissing", () => {
    it("passes the file's id, not its index", async () => {
        await mount();
        await click(button("Dismiss"));
        expect(dismissed).toEqual([99]);
    });
});

describe("empty states", () => {
    /**
     * Two different nothings: no folders configured sends you to Settings, while
     * folders with nothing in them sends you to a scan. Getting these the wrong
     * way round strands a new user on a button that cannot help them.
     */
    it("points at Settings when there are no scan roots", async () => {
        await mount({ roots: [] });
        expect(container.textContent).toContain("No folders to scan yet");
        expect(button("Open Settings")).toBeTruthy();
    });

    it("says nothing has been scanned when roots exist but the library is empty", async () => {
        await mount({
            library: overview({ totalEpisodes: 0, shows: [], unmatched: [] }),
        });
        expect(container.textContent).toContain("Nothing scanned yet");
    });

    it("shows no empty state at all while the roots are still unknown", async () => {
        await mount({ roots: null });
        expect(container.textContent).not.toContain("No folders to scan yet");
    });
});
