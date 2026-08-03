/** @vitest-environment happy-dom */
/**
 * The blackout inherits fullscreen (docs/ui.md, "Blackout").
 *
 * `handoff.test.ts` owns the store's half — that `goDark` asks for the handoff,
 * and asks before it flips the screen. What it cannot see is the half that made
 * this a bug in the first place, because the bug is not in either component:
 * fullscreen is held by a DOM element the Player owns, the sleep timer unmounts
 * the Player, and *removing the fullscreen element is itself enough to drop
 * fullscreen*. Nothing either file does alone can prove the picture and the
 * black screen are the same fullscreen session; only mounting both across the
 * swap can, which is what these cases do.
 *
 * The second thing pinned here is the Player's teardown. It exits fullscreen on
 * unmount so walking out to the guide cannot strand the window — and that exit,
 * left unguarded, undoes the handoff a few microseconds after it lands. Both
 * directions are below, because a guard that is too eager breaks the other one.
 */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { standaloneDeck } from "./fixtures.js";
import { openPlayer, type Scenario } from "./harness.js";

let player: Scenario | null = null;

async function open(...args: Parameters<typeof openPlayer>): Promise<Scenario> {
    player = await openPlayer(...args);
    return player;
}

afterEach(async () => {
    await player?.unmount();
    player = null;
    vi.useRealTimers();
});

/** <kbd>F</kbd>, which carries the gesture a fresh fullscreen request needs. */
async function goFullscreen(sc: Scenario): Promise<void> {
    await sc.press("f");
    expect(sc.fullscreenTarget()).toBe("stage");
}

describe("going dark from fullscreen", () => {
    it("keeps the screen full when the timer expires at the end of an episode", async () => {
        const sc = await open(standaloneDeck(3));
        await goFullscreen(sc);

        await sc.expireSleep();
        await sc.endEpisode();

        expect(sc.state().screen).toBe("blackout");
        // The stage is gone with the Player; the root took fullscreen over before it
        // went. Without the handoff this reads `null` — a windowed black screen, and
        // a taskbar in a dark room.
        expect(sc.fullscreenTarget()).toBe("root");
        expect(document.querySelector(".blackout")).not.toBeNull();
    });

    it("keeps the screen full when the timer expires while paused", async () => {
        const sc = await open(standaloneDeck(3));
        await goFullscreen(sc);
        await sc.viewerPause();

        await sc.expireSleep();
        await sc.settle();

        expect(sc.state().screen).toBe("blackout");
        expect(sc.fullscreenTarget()).toBe("root");
    });

    it("leaves a windowed viewer windowed", async () => {
        const sc = await open(standaloneDeck(3));
        expect(sc.fullscreenTarget()).toBeNull();

        await sc.expireSleep();
        await sc.endEpisode();

        // Nobody asked for fullscreen, so going to sleep must not grant it.
        expect(sc.state().screen).toBe("blackout");
        expect(sc.fullscreenTarget()).toBeNull();
    });
});

describe("leaving the blackout", () => {
    /** The way back to the guide, revealed by the same pointer move a viewer makes. */
    function exitButton(): HTMLElement {
        const el = document.querySelector<HTMLElement>(".blackout-exit");
        if (!el) throw new Error("the blackout is not on screen");
        return el;
    }

    async function sleepFromFullscreen(): Promise<Scenario> {
        const sc = await open(standaloneDeck(3));
        await goFullscreen(sc);
        await sc.expireSleep();
        await sc.endEpisode();
        expect(sc.fullscreenTarget()).toBe("root");
        return sc;
    }

    it("drops fullscreen on the way to the guide", async () => {
        const sc = await sleepFromFullscreen();

        await act(async () => {
            exitButton().click();
        });
        await sc.settle();

        // The guide is a windowed screen with an app bar; a fullscreen guide is not
        // a state this app has.
        expect(sc.state().screen).toBe("guide");
        expect(sc.fullscreenTarget()).toBeNull();
    });

    it("does the same on Enter", async () => {
        const sc = await sleepFromFullscreen();

        await sc.press("Enter");

        expect(sc.state().screen).toBe("guide");
        expect(sc.fullscreenTarget()).toBeNull();
    });

    /**
     * Esc is Chromium's first: it leaves fullscreen and the page never sees the
     * key, exactly as on the Player. So the way out of a *fullscreen* blackout is
     * two presses — the second one arrives, because by then there is no fullscreen
     * for the browser to take it for.
     */
    it("takes two presses of Esc out of fullscreen, and one out of a window", async () => {
        const sc = await sleepFromFullscreen();

        await sc.press("Escape");
        expect(sc.fullscreenTarget()).toBeNull();
        expect(sc.state().screen).toBe("blackout");

        await sc.press("Escape");
        expect(sc.state().screen).toBe("guide");
    });
});

describe("the Player still gives fullscreen up when it should", () => {
    it("drops it when the viewer walks out to the guide", async () => {
        // The guard the second Esc has to clear is a `Date.now()` comparison, so the
        // clock is the only thing that needs to move — and `shouldAdvanceTime` keeps
        // the harness's own `setTimeout(…, 0)` macrotasks resolving on their own, so
        // `settle()` still works underneath. Without it the fake clock would freeze
        // the harness solid.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const sc = await open(standaloneDeck(3));
        await goFullscreen(sc);

        // Esc out of fullscreen, then Esc out of the player — the map's two steps.
        await sc.press("Escape");
        // The Player ignores a second Esc within 400ms of leaving fullscreen: the
        // browser's own exit and the keystroke arrive together, and one press must
        // not do both jobs. A viewer's second press is a beat later, so this is too —
        // 450 fake milliseconds instead of 450 real ones off the suite's runtime.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(450);
        });
        await sc.press("Escape");

        expect(sc.state().screen).toBe("guide");
        // The guard on the Player's teardown must not have kept it alive.
        expect(sc.fullscreenTarget()).toBeNull();
    });

    it("drops it when the picture goes to a floating window instead", async () => {
        const sc = await open(standaloneDeck(3));
        await goFullscreen(sc);

        await sc.clickPip();

        // Filling the screen and floating beside it are two states of one picture.
        expect(sc.pipSlot()).not.toBeNull();
        expect(sc.fullscreenTarget()).toBeNull();
    });
});
