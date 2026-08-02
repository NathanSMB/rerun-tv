/**
 * @vitest-environment happy-dom
 *
 * Screen 05 · the tuning rail's scroll spy.
 *
 * The rail replaced a four-card grid, and the whole reason it earns its keep is
 * that it says where you are. So the thing worth pinning is the case that gets
 * it wrong: the *last* stop. System is shorter than the window, so it never
 * reaches the reading line and never becomes the top-most intersecting element
 * — the first cut of this used an `IntersectionObserver` and left the dial stuck
 * on 03 with System filling the screen. Reaching the end of the scroll is the
 * only honest signal that you have arrived, so that is what the spy reads.
 *
 * happy-dom lays nothing out (every box is 0×0), so geometry is scripted here:
 * a scroller with a real scroll extent, and section tops that move with it.
 */

import type { RerunApi } from "@shared/ipc.js";
import { DEFAULT_SETTINGS, type SystemInfo } from "@shared/types.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Settings from "../../src/renderer/src/screens/Settings.js";
import { useStore } from "../../src/renderer/src/store.js";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

const SYSTEM: SystemInfo = {
    appVersion: "0.1.0",
    ffmpegPath: "/usr/bin/ffmpeg",
    ffprobePath: "/usr/bin/ffprobe",
    ffmpegVersion: "n8.1.2",
    ffmpegSource: "system",
    codecCheck: "ok",
    hwAccel: { vaapi: "ok", nvenc: "ok", vaapiDevice: "/dev/dri/renderD129" },
    dbPath: "/tmp/library.db",
    dbSizeBytes: 1024,
    streamPort: 9,
    lastRestore: null,
};

/** A window's worth of viewport, and four screens' worth of settings under it. */
const VIEWPORT = 800;
const CONTENT = 2400;
const MAX_SCROLL = CONTENT - VIEWPORT;

/** Where each section starts, measured from the top of the content. */
const TOPS: Record<string, number> = {
    "set-library": 0,
    "set-playback": 420,
    "set-interface": 1250,
    "set-system": 2050,
};

let scroller: HTMLElement;
let container: HTMLDivElement;
let root: Root;

function bridge(): RerunApi {
    return {
        settings: {
            getAll: async () => DEFAULT_SETTINGS,
            set: async () => DEFAULT_SETTINGS,
        },
        library: {
            listRoots: async () => [],
            addRoot: async () => [],
            removeRoot: async () => [],
            rescan: async () => undefined,
            getOverview: async () => ({
                shows: [],
                unmatched: [],
                totalEpisodes: 0,
            }),
        },
        system: { getInfo: async () => SYSTEM },
    } as unknown as RerunApi;
}

/** Put the scroller at `scrollTop` and move every section's box to match. */
async function scrollTo(scrollTop: number): Promise<void> {
    Object.defineProperty(scroller, "scrollTop", {
        value: scrollTop,
        configurable: true,
    });
    for (const [id, top] of Object.entries(TOPS)) {
        const node = document.getElementById(id);
        if (node == null) throw new Error(`section ${id} not rendered`);
        node.getBoundingClientRect = () =>
            ({ top: top - scrollTop }) as DOMRect;
    }
    await act(async () => {
        scroller.dispatchEvent(new Event("scroll"));
    });
}

/** The name beside the number the rail is lit on, e.g. "System". */
function tunedStop(): string | null {
    const current = container.querySelector(
        '.set-rail-item[aria-current="true"]',
    );
    return current?.querySelector(".name")?.textContent ?? null;
}

beforeEach(async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    (window as unknown as { rerun: RerunApi }).rerun = bridge();
    useStore.setState({ settings: DEFAULT_SETTINGS, system: SYSTEM });

    // The shell's scroll container — the element the spy looks for and the one
    // the rail sticks inside.
    scroller = document.createElement("main");
    scroller.className = "app-scroll";
    container = document.createElement("div");
    scroller.appendChild(container);
    document.body.appendChild(scroller);

    scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    Object.defineProperty(scroller, "clientHeight", {
        value: VIEWPORT,
        configurable: true,
    });
    Object.defineProperty(scroller, "scrollHeight", {
        value: CONTENT,
        configurable: true,
    });
    Object.defineProperty(scroller, "scrollTop", {
        value: 0,
        configurable: true,
    });

    root = createRoot(container);
    await act(async () => {
        root.render(<Settings />);
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // happy-dom gives every fresh box a top of 0; the sections only get their
    // scripted geometry once `scrollTo` has run.
    await scrollTo(0);
});

afterEach(() => {
    act(() => root.unmount());
    scroller.remove();
    useStore.setState({ settings: DEFAULT_SETTINGS, system: null });
});

describe("the tuning rail", () => {
    it("opens on the first stop", () => {
        expect(tunedStop()).toBe("Library");
    });

    /**
     * A window tall enough to hold all four sections never scrolls, so its scroll
     * position is at the end and at the top simultaneously. Read naively that
     * lights 04 on arrival and leaves it there for the life of the screen.
     */
    it("stays on the first stop when the page does not scroll at all", async () => {
        Object.defineProperty(scroller, "scrollHeight", {
            value: VIEWPORT,
            configurable: true,
        });
        await scrollTo(0);
        expect(tunedStop()).toBe("Library");
    });

    it("follows the reader down the page", async () => {
        await scrollTo(500);
        expect(tunedStop()).toBe("Playback");
        await scrollTo(1300);
        expect(tunedStop()).toBe("Interface");
    });

    /**
     * The one this test file exists for. At the bottom of the scroll, System's
     * top is still 450 px *below* the reading line — by tops alone the answer is
     * Interface, and that is exactly the wrong answer, because System is what
     * fills the screen.
     */
    it("lands on the last stop at the bottom of the page", async () => {
        await scrollTo(MAX_SCROLL);
        expect(TOPS["set-system"] - MAX_SCROLL).toBeGreaterThan(96); // above the line
        expect(tunedStop()).toBe("System");
    });

    it("lets go of the last stop again on the way back up", async () => {
        await scrollTo(MAX_SCROLL);
        await scrollTo(600);
        expect(tunedStop()).toBe("Playback");
    });

    it("tunes to a section by its number", async () => {
        let jumped: string | null = null;
        for (const id of Object.keys(TOPS)) {
            const node = document.getElementById(id);
            if (node != null)
                node.scrollIntoView = () => {
                    jumped = id;
                };
        }
        const stops = [
            ...container.querySelectorAll<HTMLButtonElement>(".set-rail-item"),
        ];
        await act(async () => {
            stops[3].click();
        });
        expect(jumped).toBe("set-system");
    });
});
