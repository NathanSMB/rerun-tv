/**
 * @vitest-environment happy-dom
 *
 * Screen 01 · the Guide's fold-out channel editor.
 *
 * The Channels screen was retired into the Guide (docs/channel-edit-ux.html,
 * "Hot Rows"), which moved three things that used to be somebody else's problem
 * onto one surface. Each is pinned here because each was load-bearing in the
 * design rather than incidental:
 *
 *  1. **One fold at a time.** ✎ on another row has to *move* the editor, not open
 *     a second one — the store holds a single `channelDetail`, so two open folds
 *     would render the same channel's lineup under two different headings.
 *  2. **Hover is a shortcut, not the only path.** The pointer does not exist for
 *     a keyboard, so E/Esc are the real interface and are tested as such.
 *  3. **Delete is a two-step, inline.** Electron has no `window.confirm`, so the
 *     first press must arm rather than delete — a one-press delete would be
 *     unrecoverable, and there is no undo behind it.
 *
 * happy-dom lays nothing out, so nothing here asserts on geometry; the row's
 * fixed height under hover is a CSS grid overlap (Guide.css) and is not
 * something a DOM test can see.
 */

import type { RerunApi } from "@shared/ipc.js";
import type {
    AppSettings,
    Channel,
    ChannelDetail,
    ChannelSummary,
} from "@shared/types.js";
import { DEFAULT_SETTINGS } from "@shared/types.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppBar from "../../src/renderer/src/components/AppBar.js";
import Guide from "../../src/renderer/src/screens/Guide.js";
import { useStore } from "../../src/renderer/src/store.js";
import { inertEvents, makeBridge, systemInfo } from "./bridge.js";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
/** Channels the scripted bridge currently holds; `remove` really removes. */
let channels: ChannelSummary[];
let removed: number[];
let created: string[];
/** Every other channels.* call, so the fold's wiring can be asserted. */
let calls: Array<Record<string, unknown>>;
/** What `settings.getAll` reports — the start-screen coercion needs to vary it. */
let settings: AppSettings;
/** Channel ids `tune()` was asked for, with the real action stubbed out. */
let tuned: number[];

function channel(id: number, number: number, name: string): Channel {
    return {
        id,
        name,
        number,
        accent: null,
        activeGroupId: null,
        activePartIndex: null,
        sortOrder: number,
    };
}

function summary(id: number, number: number, name: string): ChannelSummary {
    return {
        channel: channel(id, number, name),
        showTitles: ["Gargoyles"],
        onDeck: {
            id: 100 + id,
            showId: 1,
            showTitle: "Gargoyles",
            season: 1,
            episode: 1,
            episodeEnd: null,
            title: "Awakening",
            code: "S01E01",
            durationS: 1320,
            playbackPath: "remux",
        },
    };
}

function detail(id: number, number: number, name: string): ChannelDetail {
    return {
        channel: channel(id, number, name),
        lineup: [
            {
                showId: 1,
                title: "Gargoyles",
                mode: "shuffle",
                weight: 2,
                episodeCount: 78,
                unitCount: 78,
                arcCount: 0,
                arcSummary: null,
                seasons: [],
                progress: { kind: "bag", remaining: 31, total: 78 },
            },
        ],
        totalUnits: 78,
        totalArcs: 0,
    };
}

/**
 * The current detail for a channel the fake still holds — the shape every lineup
 * mutation answers with, per the contract. The fold discards these (it refreshes
 * from `get` instead), but returning the wrong type would hide a real drift.
 */
function detailFor(id: number): ChannelDetail {
    const found = channels.find((c) => c.channel.id === id);
    if (!found) throw new Error(`no channel ${id}`);
    return detail(id, found.channel.number, found.channel.name);
}

function bridge(): RerunApi {
    const channelsApi: Partial<RerunApi["channels"]> = {
        list: async () => channels,
        get: async (id) => detailFor(id),
        create: async ({ name }) => {
            created.push(name);
            const fresh = summary(99, 12, name);
            channels = [...channels, fresh];
            return fresh.channel;
        },
        remove: async (id) => {
            removed.push(id);
            channels = channels.filter((c) => c.channel.id !== id);
        },
        reorder: async (ids) => {
            calls.push({ call: "reorder", ids });
            channels = ids.flatMap((id) =>
                channels.filter((c) => c.channel.id === id),
            );
        },
        update: async (id, patch) => {
            calls.push({ call: "update", id, patch });
            channels = channels.map((c) =>
                c.channel.id === id
                    ? { ...c, channel: { ...c.channel, ...patch } }
                    : c,
            );
            return detailFor(id).channel;
        },
        setMode: async (channelId, showId, mode) => {
            calls.push({ call: "setMode", channelId, showId, mode });
            return detailFor(channelId);
        },
        // Never exercised by these tests, but the season override is part of the
        // fold's surface: without a stub, a screen that grew a call to it would
        // fail here for the wrong reason.
        setSeasonMode: async (channelId, showId, season, mode) => {
            calls.push({
                call: "setSeasonMode",
                channelId,
                showId,
                season,
                mode,
            });
            return detailFor(channelId);
        },
        setWeight: async (channelId, showId, weight) => {
            calls.push({ call: "setWeight", channelId, showId, weight });
            return detailFor(channelId);
        },
        removeShow: async (channelId, showId) => {
            calls.push({ call: "removeShow", channelId, showId });
            return detailFor(channelId);
        },
        addShow: async (channelId, showId) => {
            calls.push({ call: "addShow", channelId, showId });
            return detailFor(channelId);
        },
        resetProgress: async (channelId, showId) => {
            calls.push({ call: "resetProgress", channelId, showId });
            return detailFor(channelId);
        },
    };

    const library: Partial<RerunApi["library"]> = {
        getOverview: async () => ({
            shows: [],
            unmatched: [],
            totalEpisodes: 0,
        }),
        listShows: async () => [],
        getScanStatus: async () => ({
            state: "idle",
            total: 0,
            done: 0,
            probed: 0,
            currentRoot: null,
            error: null,
        }),
    };

    return makeBridge({
        channels: channelsApi,
        library,
        settings: { getAll: async () => settings, set: async () => settings },
        system: { getInfo: async () => systemInfo() },
        events: inertEvents,
    });
}

// ---- DOM helpers ----------------------------------------------------------

const rows = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>(".ch-row"));

const button = (label: string): HTMLElement => {
    const el = document.querySelector<HTMLElement>(
        `button[aria-label="${label}"]`,
    );
    if (!el) throw new Error(`no button labelled "${label}" is on screen`);
    return el;
};

const byText = (text: string): HTMLElement | null =>
    Array.from(document.querySelectorAll<HTMLElement>("button")).find(
        (el) => el.textContent?.trim() === text,
    ) ?? null;

/** The open fold's heading, or null when every row is closed. */
const foldHeading = (): string | null =>
    document.querySelector<HTMLElement>(".fold-bar .caption")?.textContent ??
    null;

const click = async (el: HTMLElement): Promise<void> => {
    await act(async () => {
        el.click();
        await Promise.resolve();
    });
    await act(async () => {
        await Promise.resolve();
    });
};

/**
 * A keystroke on the highlighted row — where focus actually sits in the app,
 * thanks to the roving tabindex. Firing at the list instead would skip the guard
 * that keeps the fold's own inputs from being read as guide shortcuts.
 */
const press = async (key: string, altKey = false): Promise<void> => {
    const target =
        document.querySelector<HTMLElement>(".ch-row.sel") ?? rows()[0];
    if (!target) throw new Error("no row is on screen");
    await act(async () => {
        target.dispatchEvent(
            new KeyboardEvent("keydown", { key, altKey, bubbles: true }),
        );
        await Promise.resolve();
    });
    await act(async () => {
        await Promise.resolve();
    });
};

/**
 * Type into a React-controlled field. React installs its own `value` setter and
 * ignores an assignment that bypasses it, so the native one has to be called
 * explicitly or `onChange` never fires and the form stays empty.
 */
const type = async (el: HTMLInputElement, text: string): Promise<void> => {
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
    )?.set;
    setter?.call(el, text);
    await act(async () => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
    });
};

/** Mount the Guide. Split out so the store-level tests can skip it. */
async function mount(): Promise<void> {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
        root.render(<Guide />);
    });
}

beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    channels = [
        summary(1, 3, "Saturday Morning"),
        summary(2, 7, "Late Night Static"),
    ];
    removed = [];
    created = [];
    calls = [];
    tuned = [];
    settings = { ...DEFAULT_SETTINGS };
    (globalThis as { rerun?: RerunApi }).rerun = bridge();

    useStore.setState({
        channels,
        channelDetail: null,
        editingChannelId: null,
        selectedChannelId: 1,
        shows: [
            { id: 5, title: "Batman: The Animated Series", episodeCount: 85 },
            { id: 6, title: "Animaniacs", episodeCount: 99 },
        ] as never,
        library: null,
        settings: DEFAULT_SETTINGS,
        // Tuning in commits scheduler state over the bridge; this layer's question
        // is only whether the guide asked, so the real action is stubbed.
        tune: async (channelId: number) => {
            tuned.push(channelId);
        },
    });

    await mount();
});

afterEach(async () => {
    await act(async () => {
        root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
});

describe("the guide rows", () => {
    it("gives every row its own tune-in and edit controls", () => {
        expect(rows()).toHaveLength(2);
        expect(button("Tune in to CH 03 Saturday Morning")).toBeTruthy();
        expect(button("Edit CH 03 Saturday Morning")).toBeTruthy();
        expect(button("Tune in to CH 07 Late Night Static")).toBeTruthy();
        expect(button("Edit CH 07 Late Night Static")).toBeTruthy();
    });

    it("will not offer to tune in to a channel with nothing on deck", async () => {
        channels = [
            { ...summary(1, 3, "Saturday Morning"), onDeck: null },
            channels[1],
        ];
        await act(async () => {
            useStore.setState({ channels });
        });
        expect(button("Tune in to CH 03 Saturday Morning")).toHaveProperty(
            "disabled",
            true,
        );
    });

    it("tunes in from the row control without selecting first", async () => {
        // The point of hover controls: any row, one click, no selection step.
        await click(button("Tune in to CH 07 Late Night Static"));
        expect(tuned).toEqual([2]);
    });

    it("tunes in from the keyboard too", async () => {
        await press("Enter");
        expect(tuned).toEqual([1]);
    });

    it("still moves the highlight with the arrows", async () => {
        await press("ArrowDown");
        expect(useStore.getState().selectedChannelId).toBe(2);
        await press("ArrowUp");
        expect(useStore.getState().selectedChannelId).toBe(1);
    });

    it("still reorders the dial from the keyboard", async () => {
        await press("ArrowDown", true);
        expect(calls).toContainEqual({ call: "reorder", ids: [2, 1] });
    });
});

describe("opening the fold", () => {
    it("unfolds the editor under the row that was pressed", async () => {
        expect(foldHeading()).toBeNull();

        await click(button("Edit CH 03 Saturday Morning"));

        expect(useStore.getState().editingChannelId).toBe(1);
        expect(foldHeading()).toContain("Saturday Morning");
        // The fold belongs to its row: it is rendered inside the same slot, so it
        // cannot drift away from the channel it edits when the order changes.
        expect(
            rows()[0].parentElement?.querySelector(".fold.open"),
        ).toBeTruthy();
    });

    it("moves the fold rather than opening a second one", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        await click(button("Edit CH 07 Late Night Static"));

        expect(document.querySelectorAll(".fold.open")).toHaveLength(1);
        expect(useStore.getState().editingChannelId).toBe(2);
        expect(foldHeading()).toContain("Late Night Static");
    });

    it("closes the fold when the same row is pressed again", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        await click(button("Edit CH 03 Saturday Morning"));

        expect(useStore.getState().editingChannelId).toBeNull();
        expect(foldHeading()).toBeNull();
    });

    it("opens and closes from the keyboard, which hover cannot serve", async () => {
        await press("e");
        expect(useStore.getState().editingChannelId).toBe(1);

        await press("Escape");
        expect(useStore.getState().editingChannelId).toBeNull();
    });

    it("keeps selection and the open editor pointing at the same channel", async () => {
        await click(button("Edit CH 07 Late Night Static"));
        // Alt+↑/↓ reorders *the selected channel*, so a selection that lagged behind
        // the fold would move a channel other than the one being edited.
        expect(useStore.getState().selectedChannelId).toBe(2);
    });
});

describe("deleting a channel", () => {
    it("arms before it deletes", async () => {
        await click(button("Edit CH 03 Saturday Morning"));

        const del = byText("Delete channel");
        expect(del).toBeTruthy();
        await click(del as HTMLElement);

        // Armed, and nothing has happened yet — the whole point of the two-step.
        expect(removed).toEqual([]);
        expect(byText("Delete for good")).toBeTruthy();
        expect(byText("Keep")).toBeTruthy();
    });

    it("backs out cleanly", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        await click(byText("Delete channel") as HTMLElement);
        await click(byText("Keep") as HTMLElement);

        expect(removed).toEqual([]);
        expect(byText("Delete channel")).toBeTruthy();
        expect(useStore.getState().editingChannelId).toBe(1);
    });

    it("deletes on the second press and folds shut", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        await click(byText("Delete channel") as HTMLElement);
        await click(byText("Delete for good") as HTMLElement);

        expect(removed).toEqual([1]);
        // Nothing is left to edit, so the editor must not stay open over a channel
        // that no longer exists.
        expect(useStore.getState().editingChannelId).toBeNull();
        expect(foldHeading()).toBeNull();
        expect(useStore.getState().channels.map((c) => c.channel.id)).toEqual([
            2,
        ]);
    });

    it("disarms when the fold is pointed at another channel", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        await click(byText("Delete channel") as HTMLElement);
        // Same fold, different channel. An armed confirm that rode along would put
        // a one-click delete over a channel the user never aimed at.
        await click(button("Edit CH 07 Late Night Static"));

        expect(byText("Delete for good")).toBeNull();
        expect(byText("Delete channel")).toBeTruthy();
        expect(removed).toEqual([]);
    });

    it("disarms when the fold is closed and reopened", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        await click(byText("Delete channel") as HTMLElement);
        await click(button("Edit CH 03 Saturday Morning")); // close
        await click(button("Edit CH 03 Saturday Morning")); // and open again

        expect(byText("Delete for good")).toBeNull();
        expect(removed).toEqual([]);
    });
});

describe("the fold and the guide’s keyboard map", () => {
    /** Fire a key at an element inside the open fold. */
    const pressIn = async (el: HTMLElement, key: string): Promise<void> => {
        await act(async () => {
            el.dispatchEvent(
                new KeyboardEvent("keydown", { key, bubbles: true }),
            );
            await Promise.resolve();
        });
        await act(async () => {
            await Promise.resolve();
        });
    };

    it("does not read typing in the fold as a guide shortcut", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        const search = document.querySelector<HTMLInputElement>(
            ".fold-right .search",
        );
        if (!search) throw new Error("the library search is not on screen");

        // "e" is the edit shortcut *and* an ordinary letter. Searching for
        // "Animaniacs" must not fold the editor shut on the first vowel.
        await pressIn(search, "e");

        expect(useStore.getState().editingChannelId).toBe(1);
    });

    it("leaves Escape to the field that wants it", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        await click(byText("Saturday Morning ✎ rename") as HTMLElement);

        const input = document.querySelector<HTMLInputElement>(
            ".fold-idline .id-input",
        );
        if (!input) throw new Error("the rename field did not open");
        await pressIn(input, "Escape");

        // Escape abandoned the rename, not the whole editor. Closing the fold on a
        // keystroke aimed at a text field would throw away work.
        expect(useStore.getState().editingChannelId).toBe(1);
        expect(document.querySelector(".fold-idline .id-input")).toBeNull();
    });

    it("closes the fold on Escape once no field wants it", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        const search = document.querySelector<HTMLInputElement>(
            ".fold-right .search",
        );
        if (!search) throw new Error("the library search is not on screen");

        // An empty search has nothing to clear, so Escape means what it means
        // everywhere else in the guide — the way out shouldn't depend on where
        // focus happens to be sitting.
        await pressIn(search, "Escape");

        expect(useStore.getState().editingChannelId).toBeNull();
    });

    it("clears a search before it closes anything", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        const search = document.querySelector<HTMLInputElement>(
            ".fold-right .search",
        );
        if (!search) throw new Error("the library search is not on screen");
        await type(search, "Anim");

        await pressIn(search, "Escape");
        expect(useStore.getState().editingChannelId).toBe(1);
        expect(search.value).toBe("");

        await pressIn(search, "Escape");
        expect(useStore.getState().editingChannelId).toBeNull();
    });

    it("commits a rename on Enter", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        await click(byText("Saturday Morning ✎ rename") as HTMLElement);

        const input = document.querySelector<HTMLInputElement>(
            ".fold-idline .id-input",
        );
        if (!input) throw new Error("the rename field did not open");
        await type(input, "Weekend Mornings");
        await act(async () => {
            input.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
            );
            await Promise.resolve();
        });

        expect(calls).toContainEqual({
            call: "update",
            id: 1,
            patch: { name: "Weekend Mornings" },
        });
    });

    it("closes on Done", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        await click(byText("Done") as HTMLElement);
        expect(useStore.getState().editingChannelId).toBeNull();
    });
});

describe("the lineup controls", () => {
    it("wires the scheduling knobs to the channel", async () => {
        await click(button("Edit CH 03 Saturday Morning"));

        await click(byText("In order") as HTMLElement);
        expect(calls).toContainEqual({
            call: "setMode",
            channelId: 1,
            showId: 1,
            mode: "sequential",
        });

        await click(button("Raise the weight of Gargoyles"));
        expect(calls).toContainEqual({
            call: "setWeight",
            channelId: 1,
            showId: 1,
            weight: 3,
        });

        await click(button("Remove Gargoyles from this channel"));
        expect(calls).toContainEqual({
            call: "removeShow",
            channelId: 1,
            showId: 1,
        });
    });

    it("adds a show from the library column", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        await click(button("Add Animaniacs to this channel"));
        expect(calls).toContainEqual({
            call: "addShow",
            channelId: 1,
            showId: 6,
        });
    });

    it("resets the scheduler’s progress for one show", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        await click(byText("reshuffle") as HTMLElement);
        expect(calls).toContainEqual({
            call: "resetProgress",
            channelId: 1,
            showId: 1,
        });
    });
});

describe("the retired channels screen", () => {
    it("is gone from the nav", async () => {
        const bar = document.createElement("div");
        document.body.append(bar);
        const barRoot = createRoot(bar);
        await act(async () => {
            barRoot.render(<AppBar />);
        });

        const labels = Array.from(bar.querySelectorAll(".appnav button")).map(
            (el) => el.textContent?.trim(),
        );
        expect(labels).toEqual(["Guide", "Library", "Settings"]);

        await act(async () => {
            barRoot.unmount();
        });
        bar.remove();
    });

    it("does not strand an install that used to start on it", async () => {
        // Settings are a loose key–value table merged over the defaults, so nothing
        // rejects a screen name that no longer exists — an uncoerced value would
        // boot to a screen the shell cannot render.
        settings = { ...DEFAULT_SETTINGS, startScreen: "channels" as never };
        await act(async () => {
            await useStore.getState().init();
        });
        expect(useStore.getState().screen).toBe("guide");
    });

    it("still honours a start screen that does exist", async () => {
        settings = { ...DEFAULT_SETTINGS, startScreen: "library" };
        await act(async () => {
            await useStore.getState().init();
        });
        expect(useStore.getState().screen).toBe("library");
    });
});

describe("a channel vanishing under an open fold", () => {
    it("closes the editor when a refresh no longer lists it", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        expect(useStore.getState().editingChannelId).toBe(1);

        // What a `channelsChanged` push looks like after a restore: the channel is
        // simply not in the next listing. An editor left pointing at it would render
        // a stale detail forever.
        channels = channels.filter((c) => c.channel.id !== 1);
        await act(async () => {
            await useStore.getState().refreshChannels();
        });

        expect(useStore.getState().editingChannelId).toBeNull();
        expect(useStore.getState().channelDetail).toBeNull();
        expect(foldHeading()).toBeNull();
    });

    it("leaves an open fold alone when another channel changes", async () => {
        await click(button("Edit CH 03 Saturday Morning"));
        channels = channels.filter((c) => c.channel.id !== 2);
        await act(async () => {
            await useStore.getState().refreshChannels();
        });
        expect(useStore.getState().editingChannelId).toBe(1);
    });
});

describe("creating a channel", () => {
    it("opens the new channel’s lineup straight away", async () => {
        await click(byText("+ New channel") as HTMLElement);

        const input = document.querySelector<HTMLInputElement>(
            ".guide-newch .textinput",
        );
        if (!input) throw new Error("the new-channel field is not on screen");
        await type(input, "Sitcom Dinner Hour");
        await click(byText("Create") as HTMLElement);

        expect(created).toEqual(["Sitcom Dinner Hour"]);
        // A fresh channel has nothing to air, so the lineup is the only useful next
        // step — leaving an empty row behind is the old behaviour this replaced.
        expect(useStore.getState().editingChannelId).toBe(99);
        // Nothing clicked a row here, so this is `openEditor` doing the syncing.
        // Selection left on the old channel would point Alt+↑/↓ at it while the
        // fold on screen belongs to the new one.
        expect(useStore.getState().selectedChannelId).toBe(99);
    });
});
