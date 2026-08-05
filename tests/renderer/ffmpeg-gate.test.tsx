/**
 * @vitest-environment happy-dom
 *
 * The first-launch ffmpeg gate.
 *
 * The gate is the only modal in the app and the only thing that ever blocks the
 * window, so the properties worth pinning are the ones that decide whether
 * someone gets stuck behind it:
 *
 * - it appears only when there is genuinely no ffmpeg, and never while the first
 *   answer is still in flight;
 * - it goes away on its own when one turns up, whether that was our download or
 *   a package manager in another terminal;
 * - a failed download leaves a readable reason and the buttons still usable.
 *
 * Mounted through `App`'s real slot rather than the component directly, because
 * "does it show at all" is the half of the behaviour that lives in the shell.
 */

import type { RerunApi } from "@shared/ipc.js";
import type { FfmpegInstallProgress, FfmpegState } from "@shared/types.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FfmpegGateSlot } from "../../src/renderer/src/App.js";
import FfmpegGate from "../../src/renderer/src/components/FfmpegGate.js";
import { useStore } from "../../src/renderer/src/store.js";
import { ffmpegState, makeBridge, systemInfo } from "./bridge.js";

declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
/** What the next `getFfmpegState`/`recheckFfmpeg` will answer with. */
let current: FfmpegState;
let installCalls: number;
let cancelCalls: number;
/** Set to make the download reject, standing in for a failed transfer. */
let installError: string | null;
let rechecks: number;

const MISSING = ffmpegState({
    path: null,
    ffprobePath: null,
    version: null,
    source: "missing",
});

function bridge(): RerunApi {
    return makeBridge({
        system: {
            getInfo: async () => systemInfo(),
            getFfmpegState: async () => current,
            recheckFfmpeg: async () => {
                rechecks++;
                return current;
            },
            installManagedFfmpeg: async () => {
                installCalls++;
                if (installError != null) throw new Error(installError);
                current = ffmpegState({ source: "managed" });
                return "n8.1.2-test";
            },
            cancelFfmpegInstall: async () => {
                cancelCalls++;
            },
        },
    });
}

async function mount(state: FfmpegState = MISSING): Promise<void> {
    current = state;
    (window as unknown as { rerun: RerunApi }).rerun = bridge();
    useStore.setState({ ffmpeg: state, ffmpegInstall: null });
    await act(async () => {
        root.render(<FfmpegGate />);
        await Promise.resolve();
    });
}

function button(label: string): HTMLButtonElement {
    const node = [...container.querySelectorAll("button")].find((el) =>
        el.textContent?.includes(label),
    );
    if (!node) throw new Error(`no button matching "${label}"`);
    return node;
}

async function click(node: HTMLElement): Promise<void> {
    await act(async () => {
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
    });
}

/** Push a progress event the way the main process would. */
async function progress(patch: Partial<FfmpegInstallProgress>): Promise<void> {
    await act(async () => {
        useStore.setState({
            ffmpegInstall: {
                phase: "downloading",
                receivedBytes: null,
                totalBytes: null,
                version: null,
                message: null,
                ...patch,
            },
        });
    });
}

beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    installCalls = 0;
    cancelCalls = 0;
    rechecks = 0;
    installError = null;
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useStore.setState({ ffmpeg: null, ffmpegInstall: null });
    vi.useRealTimers();
});

describe("whether it exists at all", () => {
    /** The shell's half of the rule — see `App.FfmpegGateSlot`. */
    async function mountSlot(ffmpeg: FfmpegState | null): Promise<void> {
        current = ffmpeg ?? MISSING;
        (window as unknown as { rerun: RerunApi }).rerun = bridge();
        useStore.setState({ ffmpeg, ffmpegInstall: null });
        await act(async () => {
            root.render(<FfmpegGateSlot />);
            await Promise.resolve();
        });
    }

    it("shows nothing while the first answer is still in flight", async () => {
        // A gate that flashed up before the app knew would be wrong more often
        // than right — most machines have ffmpeg.
        await mountSlot(null);
        expect(container.querySelector(".ffg-dialog")).toBeNull();
    });

    it("shows nothing when ffmpeg is present", async () => {
        await mountSlot(ffmpegState({ source: "system" }));
        expect(container.querySelector(".ffg-dialog")).toBeNull();
    });

    it("shows the dialog when there is none", async () => {
        await mountSlot(MISSING);
        expect(container.querySelector(".ffg-dialog")).not.toBeNull();
    });

    it("unmounts itself the moment one turns up", async () => {
        await mountSlot(MISSING);
        expect(container.querySelector(".ffg-dialog")).not.toBeNull();

        await act(async () => {
            useStore.setState({ ffmpeg: ffmpegState({ source: "managed" }) });
        });
        expect(container.querySelector(".ffg-dialog")).toBeNull();
    });
});

describe("what it says", () => {
    it("states the requirement and offers both ways out", async () => {
        await mount();
        expect(container.textContent).toContain("FFmpeg is required");
        expect(button("Download it for me")).toBeTruthy();
        const manual = container.querySelector("a[href]");
        expect(manual?.getAttribute("href")).toBe(
            "https://ffmpeg.org/download.html",
        );
        // Opened by the OS browser through the main process's own scheme check,
        // which only fires for a new window.
        expect(manual?.getAttribute("target")).toBe("_blank");
    });

    /** Nothing is on PATH and nothing is published for this machine either. */
    it("explains itself when no managed build exists for the platform", async () => {
        await mount(ffmpegState({ source: "missing", downloadable: false }));
        expect(button("Download it for me").disabled).toBe(true);
        expect(container.textContent).toContain(
            "No managed build is published for this platform",
        );
    });

    it("takes the keyboard on mount, so nothing behind it is reachable", async () => {
        await mount();
        expect(document.activeElement?.classList.contains("ffg-dialog")).toBe(
            true,
        );
    });
});

describe("downloading", () => {
    it("shows the phase and the byte count while it runs", async () => {
        await mount();
        await progress({
            phase: "downloading",
            receivedBytes: 40_000_000,
            totalBytes: 120_000_000,
        });

        expect(container.textContent).toContain("40 MB of 120 MB");
        const bar = container.querySelector(".ffg-fill") as HTMLElement;
        expect(bar.style.width).toBe("33%");
        // Cancel replaces the download button for as long as one is in flight.
        expect(button("Cancel")).toBeTruthy();
    });

    /** The unpack and the encode test have no byte count; a frozen bar reads as a hang. */
    it("keeps the bar alive through the phases with no byte count", async () => {
        await mount();
        await progress({ phase: "testing" });
        expect(container.textContent).toContain("Testing that it can encode");
        expect(
            container
                .querySelector(".ffg-fill")
                ?.classList.contains("is-indeterminate"),
        ).toBe(true);
    });

    it("asks the main process to stop when cancelled", async () => {
        await mount();
        await progress({ phase: "downloading" });
        await click(button("Cancel"));
        expect(cancelCalls).toBe(1);
    });

    it("reports a failure in words and leaves the button usable", async () => {
        await mount();
        installError =
            "the download did not match its published checksum — nothing was installed";

        await click(button("Download it for me"));

        expect(installCalls).toBe(1);
        expect(container.textContent).toContain(
            "did not match its published checksum",
        );
        expect(button("Download it for me").disabled).toBe(false);
    });
});

describe("closing itself", () => {
    it("re-reads on demand, and the store stops reporting 'missing'", async () => {
        await mount();
        current = ffmpegState({ source: "system" });

        await click(button("Check again"));

        expect(rechecks).toBe(1);
        // The gate does not unmount itself — `App`'s slot does, off this field.
        expect(useStore.getState().ffmpeg?.source).toBe("system");
    });

    /**
     * The whole point of the poll: someone runs `pacman -S ffmpeg` in another
     * window and never touches Rerun TV again. Within a few seconds the app has
     * to notice by itself.
     */
    it("polls while it is open so an outside install is picked up", async () => {
        vi.useFakeTimers();
        await mount();
        current = ffmpegState({ source: "system" });

        await act(async () => {
            vi.advanceTimersByTime(5000);
            await Promise.resolve();
        });

        expect(rechecks).toBeGreaterThanOrEqual(1);
        expect(useStore.getState().ffmpeg?.source).toBe("system");
    });

    it("re-checks when the window comes back to the front", async () => {
        await mount();
        current = ffmpegState({ source: "system" });

        await act(async () => {
            window.dispatchEvent(new Event("focus"));
            await Promise.resolve();
        });

        expect(rechecks).toBe(1);
        expect(useStore.getState().ffmpeg?.source).toBe("system");
    });

    it("stops polling once it is gone", async () => {
        vi.useFakeTimers();
        await mount();
        await act(() => {
            root.unmount();
        });
        // Re-created so `afterEach` has something to unmount.
        root = createRoot(container);

        const before = rechecks;
        await act(async () => {
            vi.advanceTimersByTime(20_000);
            await Promise.resolve();
        });
        expect(rechecks).toBe(before);
    });
});
