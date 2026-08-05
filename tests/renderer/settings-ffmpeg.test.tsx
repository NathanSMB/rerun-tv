/**
 * @vitest-environment happy-dom
 *
 * Screen 05 · the ffmpeg version tracker and the managed copy.
 *
 * Settings is where someone goes to answer three questions: which ffmpeg am I
 * actually running, where did it come from, and is there a newer one? The card
 * has to answer all three honestly in the awkward case as well as the easy one —
 * a managed copy that exists but is *not* the binary in use, because something
 * (the env override) outranks it. Reporting only the winner there would tell
 * someone with an update on disk that nothing was installed.
 *
 * Same seam as the hardware-acceleration suite: the real screen, the real store,
 * only the preload bridge faked.
 */

import type { RerunApi } from "@shared/ipc.js";
import {
    DEFAULT_SETTINGS,
    type FfmpegState,
    type FfmpegUpdateCheck,
} from "@shared/types.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Settings from "../../src/renderer/src/screens/Settings.js";
import { useStore } from "../../src/renderer/src/store.js";
import { ffmpegState, makeBridge, systemInfo } from "./bridge.js";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let current: FfmpegState;
let update: FfmpegUpdateCheck;
let installCalls: number;
let removeCalls: number;

const MANAGED = ffmpegState({
    path: "/home/u/.local/share/rerun-tv/ffmpeg/versions/n8.1.2-test/ffmpeg",
    source: "managed",
    version: "n8.1.2-test",
    managed: {
        version: "n8.1.2-test",
        installedAt: "2026-08-05T00:00:00.000Z",
        dir: "/home/u/.local/share/rerun-tv/ffmpeg/versions/n8.1.2-test",
    },
});

function bridge(): RerunApi {
    return makeBridge({
        settings: {
            getAll: async () => DEFAULT_SETTINGS,
            set: async (key, value) => ({ ...DEFAULT_SETTINGS, [key]: value }),
        },
        library: {
            listRoots: async () => [],
            getOverview: async () => ({
                shows: [],
                unmatched: [],
                totalEpisodes: 0,
            }),
        },
        system: {
            getInfo: async () => systemInfo(),
            getFfmpegState: async () => current,
            checkFfmpegUpdate: async () => update,
            installManagedFfmpeg: async () => {
                installCalls++;
                current = MANAGED;
                return "n8.1.2-test";
            },
            removeManagedFfmpeg: async () => {
                removeCalls++;
                current = ffmpegState({ source: "system" });
                return current;
            },
        },
    });
}

async function mount(state: FfmpegState): Promise<void> {
    current = state;
    (window as unknown as { rerun: RerunApi }).rerun = bridge();
    useStore.setState({
        settings: DEFAULT_SETTINGS,
        system: systemInfo(),
        ffmpeg: state,
        ffmpegInstall: null,
    });
    await act(async () => {
        root.render(<Settings />);
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

function button(label: string): HTMLButtonElement {
    const node = [...container.querySelectorAll("button")].find((el) =>
        el.textContent?.trim().startsWith(label),
    );
    if (!node) throw new Error(`no button matching "${label}"`);
    return node;
}

function hasButton(label: string): boolean {
    return [...container.querySelectorAll("button")].some((el) =>
        el.textContent?.trim().startsWith(label),
    );
}

async function click(node: HTMLElement): Promise<void> {
    await act(async () => {
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    installCalls = 0;
    removeCalls = 0;
    update = {
        installed: "n8.1.2-test",
        latest: "n8.1.2-test",
        updateAvailable: false,
        source: "BtbN/FFmpeg-Builds",
    };
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useStore.setState({
        settings: DEFAULT_SETTINGS,
        system: null,
        ffmpeg: null,
        ffmpegInstall: null,
    });
});

describe("the version tracker", () => {
    it("names the version, the path and where it came from", async () => {
        await mount(ffmpegState({ source: "system" }));
        expect(container.textContent).toContain("n8.1.2");
        expect(container.textContent).toContain("/usr/bin/ffmpeg");
        expect(container.textContent).toContain("installed on this system");
    });

    it("says when the binary in use is Rerun TV's own", async () => {
        await mount(MANAGED);
        expect(container.textContent).toContain("managed by Rerun TV");
        expect(container.textContent).toContain("never added to your PATH");
    });

    /**
     * The awkward case the two fields exist for: a managed copy is installed but
     * something else is winning, so the card must report both rather than only
     * the active one.
     */
    it("still reports a managed copy that is being outranked", async () => {
        await mount(
            ffmpegState({
                source: "system",
                path: "/opt/custom/ffmpeg",
                managed: {
                    version: "n8.1.2-test",
                    installedAt: "2026-08-05T00:00:00.000Z",
                    dir: "/home/u/.local/share/rerun-tv/ffmpeg/versions/n8.1.2-test",
                },
            }),
        );
        expect(container.textContent).toContain("is installed but not in use");
        expect(container.textContent).toContain("n8.1.2-test");
    });

    it("reports a machine with no ffmpeg at all", async () => {
        await mount(ffmpegState({ source: "missing", path: null }));
        expect(container.textContent).toContain("not found");
        // And the rail's foot, visible from every section, agrees.
        expect(
            container.querySelector(".set-rail-status")?.textContent,
        ).toContain("ffmpeg missing");
    });
});

describe("the managed copy's controls", () => {
    it("offers a plain download when nothing is installed", async () => {
        await mount(ffmpegState({ source: "system" }));
        expect(hasButton("Download")).toBe(true);
        // Nothing to check for updates on, and nothing to remove.
        expect(hasButton("Check for updates")).toBe(false);
    });

    it("offers reinstall, update-check and removal once one exists", async () => {
        await mount(MANAGED);
        expect(hasButton("Reinstall")).toBe(true);
        expect(hasButton("Check for updates")).toBe(true);
        expect(
            container.querySelector('[aria-label="Remove the managed ffmpeg"]'),
        ).not.toBeNull();
    });

    it("cannot download where no build is published", async () => {
        await mount(ffmpegState({ source: "system", downloadable: false }));
        expect(button("Download").disabled).toBe(true);
        expect(container.textContent).toContain(
            "No managed build is published for this platform",
        );
    });

    it("downloads and then reports what it is now using", async () => {
        await mount(ffmpegState({ source: "system" }));
        await click(button("Download"));

        expect(installCalls).toBe(1);
        expect(container.textContent).toContain("n8.1.2-test installed");
    });

    it("says it is up to date when the manifest agrees", async () => {
        await mount(MANAGED);
        await click(button("Check for updates"));
        expect(container.textContent).toContain("Up to date (n8.1.2-test)");
    });

    it("names the newer build when there is one", async () => {
        update = {
            installed: "n8.1.2-test",
            latest: "n8.2.0-test",
            updateAvailable: true,
            source: "BtbN/FFmpeg-Builds",
        };
        await mount(MANAGED);
        await click(button("Check for updates"));
        expect(container.textContent).toContain("n8.2.0-test is available");
    });

    /** Deleting the app's own binary is worth one confirm; declining must do nothing. */
    it("asks before removing, and honours a no", async () => {
        const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
        await mount(MANAGED);

        await click(
            container.querySelector(
                '[aria-label="Remove the managed ffmpeg"]',
            ) as HTMLElement,
        );

        expect(confirm).toHaveBeenCalled();
        expect(removeCalls).toBe(0);
        confirm.mockRestore();
    });

    it("removes it and says what took over", async () => {
        const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
        await mount(MANAGED);

        await click(
            container.querySelector(
                '[aria-label="Remove the managed ffmpeg"]',
            ) as HTMLElement,
        );

        expect(removeCalls).toBe(1);
        expect(container.textContent).toContain(
            "Rerun TV is using the installed on this system binary now",
        );
        confirm.mockRestore();
    });
});

describe("an install in flight", () => {
    it("echoes the phase and swaps the buttons for a cancel", async () => {
        await mount(ffmpegState({ source: "system" }));
        await act(async () => {
            useStore.setState({
                ffmpegInstall: {
                    phase: "downloading",
                    receivedBytes: 60_000_000,
                    totalBytes: 120_000_000,
                    version: "n8.1.2-test",
                    message: null,
                },
            });
        });

        expect(container.textContent).toContain("Downloading — 50%");
        expect(hasButton("Cancel")).toBe(true);
        expect(hasButton("Download")).toBe(false);
    });

    it("puts the buttons back when it fails, with the reason", async () => {
        await mount(ffmpegState({ source: "system" }));
        await act(async () => {
            useStore.setState({
                ffmpegInstall: {
                    phase: "error",
                    receivedBytes: null,
                    totalBytes: null,
                    version: null,
                    message: "the download did not match its checksum",
                },
            });
        });

        expect(container.textContent).toContain("did not match its checksum");
        expect(hasButton("Download")).toBe(true);
    });
});
