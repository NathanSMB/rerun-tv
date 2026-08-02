/** @vitest-environment happy-dom */
/**
 * Picture-in-picture, wired to the real Player (docs/pip-plan.html).
 *
 * `tests/pip.test.ts` pins the controller: events in, commands out, every
 * ordering, no DOM. This layer asks the question that one cannot — whether the
 * screen actually *executes* those commands against the right element at the
 * right moment — and it is where the feature's two real hazards live:
 *
 * 1. **The gesture rule.** A fresh session may only be opened while user
 *    activation is live; a transfer to another element may not. The harness's
 *    PiP model enforces that rather than assuming it, so an entry that drifted
 *    out of its click handler and into an effect fails here exactly as it would
 *    in the app.
 * 2. **The handoff.** Two `<video>` elements, and the floating window has to
 *    move between them at every episode boundary without the session ever
 *    lapsing — because a lapsed session cannot be reopened without a gesture,
 *    and nobody makes one at 2 a.m. when episode four rolls into episode five.
 *
 * The `pipLog` assertions are what make the second one honest: they read the
 * whole life of the session, so a handoff that closed the window and opened a
 * new one — invisible in a "is it floating?" check — shows up as an `exit`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { arcDeck, reportedEnds, standaloneDeck } from "./fixtures.js";
import { openPlayer, type Scenario } from "./harness.js";

let player: Scenario | null = null;

async function open(...args: Parameters<typeof openPlayer>): Promise<Scenario> {
    player = await openPlayer(...args);
    return player;
}

afterEach(async () => {
    await player?.unmount();
    player = null;
});

/** Put the picture in a floating window the way a viewer does. */
async function float(sc: Scenario): Promise<void> {
    await sc.clickPip();
    expect(sc.pipSlot()).not.toBeNull();
}

describe("opening the window", () => {
    it("floats the surface that is on air", async () => {
        const sc = await open(standaloneDeck(3));

        await sc.clickPip();

        expect(sc.pipSlot()).toBe("a");
        expect(sc.pipLog()).toEqual(["enter:a"]);
        // The store's mirror is what keeps this screen mounted once the viewer
        // navigates away (App.tsx).
        expect(sc.state().pipActive).toBe(true);
    });

    it("opens on P as well as on the button", async () => {
        const sc = await open(standaloneDeck(3));

        await sc.press("p");

        expect(sc.pipSlot()).toBe("a");
    });

    it("marks the button pressed while the window is up", async () => {
        const sc = await open(standaloneDeck(3));
        const button = document.querySelector("button.osd-btn.pip")!;
        expect(button.getAttribute("aria-pressed")).toBe("false");

        await float(sc);

        expect(button.getAttribute("aria-pressed")).toBe("true");
    });

    /**
     * The constraint the whole design is shaped around, stated as a test so it
     * cannot quietly stop being true. If this ever passes, the entry no longer
     * needs to live inside the click handler — and the transfer dance at every
     * handoff could be replaced by something simpler.
     */
    it("refuses a fresh session asked for outside a gesture", async () => {
        const sc = await open(standaloneDeck(3));

        await sc.enterPipWithoutGesture();

        expect(sc.pipSlot()).toBeNull();
        expect(sc.pipLog()).toEqual([]);
    });

    it("says where the picture went", async () => {
        const sc = await open(standaloneDeck(3));

        await float(sc);

        // Chromium blanks the in-page element, so a black stage with no explanation
        // is the alternative to this.
        expect(document.querySelector(".pip-placard")).not.toBeNull();
        // …and the OSD is still there, driving the same element.
        expect(
            document.querySelector('button[aria-label="Pause"]'),
        ).not.toBeNull();
    });
});

/**
 * The headline. Nothing about the handoff changes — the standby is still
 * promoted with its buffer intact — except that the window has to come along.
 */
describe("the handoff while floating", () => {
    it("transfers the session to the promoted surface without ever closing it", async () => {
        const deck = standaloneDeck(3);
        const sc = await open(deck);
        await sc.prewarm();
        await float(sc);

        await sc.endEpisode();

        expect(sc.state().nowPlaying?.episode.id).toBe(deck[1].episode.id);
        // The picture followed the promotion onto the other element…
        expect(sc.pipSlot()).toBe("b");
        // …and this is the assertion that matters: no `exit` anywhere in the log.
        // Closing and reopening would have needed a gesture nobody made, and the
        // window would simply have stayed shut.
        expect(sc.pipLog()).toEqual(["enter:a", "leave:a", "enter:b"]);
        expect(sc.state().pipActive).toBe(true);
    });

    it("keeps the window through a run of episodes", async () => {
        const sc = await open(standaloneDeck(5));
        await float(sc);

        for (let handoff = 0; handoff < 3; handoff++) {
            await sc.prewarm();
            await sc.endEpisode();
            expect(sc.pipSlot()).not.toBeNull();
        }

        // Alternating surfaces, one continuous session, no exits.
        expect(sc.pipSlot()).toBe("b");
        expect(sc.pipLog().filter((entry) => entry === "exit")).toEqual([]);
        expect(sc.state().pipActive).toBe(true);
    });

    it("carries the window across a part boundary inside an arc", async () => {
        const deck = arcDeck(3);
        const sc = await open(deck);
        await sc.prewarm();
        await float(sc);

        await sc.endEpisode();

        expect(sc.state().nowPlaying?.arc).toMatchObject({
            partIndex: 2,
            partCount: 3,
        });
        expect(sc.pipSlot()).toBe("b");
        expect(sc.pipLog()).not.toContain("exit");
    });

    /**
     * With prewarming off there is no standby, so the "handoff" is an ordinary
     * load into the *same* element. The session must survive that too — which is
     * the src-swap case, and is also what a seek and a Retry do.
     */
    it("survives a handoff that reloads the surface in place", async () => {
        const sc = await open(standaloneDeck(3), { prewarmNext: false });
        await float(sc);

        await sc.endEpisode();

        expect(sc.pipSlot()).toBe("a");
        expect(sc.pipLog()).toEqual(["enter:a"]);
    });
});

describe("closing the window", () => {
    it("brings the picture home when the viewer presses the button again", async () => {
        const sc = await open(standaloneDeck(3));
        await float(sc);

        await sc.clickPip();

        expect(sc.pipSlot()).toBeNull();
        expect(sc.pipLog()).toEqual(["enter:a", "exit"]);
        expect(sc.state().pipActive).toBe(false);
        expect(document.querySelector(".pip-placard")).toBeNull();
        // Still watching, still on the player: closing the window is not leaving.
        expect(sc.state().screen).toBe("player");
        expect(sc.state().nowPlaying).not.toBeNull();
    });

    it("treats the window’s own close the same way", async () => {
        const sc = await open(standaloneDeck(3));
        await float(sc);

        await sc.closePipWindow();

        expect(sc.state().pipActive).toBe(false);
        expect(sc.state().screen).toBe("player");
        expect(sc.state().nowPlaying).not.toBeNull();
        // Nothing was reported ended: the viewer changed where they are watching,
        // not whether they are.
        expect(reportedEnds(sc.calls)).toEqual([]);
    });
});

/**
 * Phase 2: the point of the feature. The viewer goes off to the guide and the
 * channel keeps playing in the corner — which only works if the Player is still
 * mounted, holding the same elements and the same ffmpeg pipes.
 */
describe("browsing while it floats", () => {
    it("leaves the channel running when Esc goes to the guide", async () => {
        const deck = standaloneDeck(3);
        const sc = await open(deck);
        await float(sc);
        const before = sc.activeVideo();

        await sc.press("Escape");

        expect(sc.state().screen).toBe("guide");
        // Still tuned in, nothing logged as ended, nothing released.
        expect(sc.state().nowPlaying?.episode.id).toBe(deck[0].episode.id);
        expect(reportedEnds(sc.calls)).toEqual([]);
        expect(sc.calls.some((entry) => entry.call === "release")).toBe(false);
        // The same element, not a fresh one: a remount here would have restarted
        // the stream and dropped the window with it.
        expect(sc.activeVideo()).toBe(before);
        expect(sc.pipSlot()).toBe("a");
    });

    it("still stops watching on Esc when nothing is floating", async () => {
        const deck = standaloneDeck(3);
        const sc = await open(deck);

        await sc.press("Escape");

        expect(sc.actions).toEqual(["leavePlayer"]);
        expect(sc.state().screen).toBe("guide");
        expect(sc.state().nowPlaying).toBeNull();
        expect(reportedEnds(sc.calls)).toEqual([
            { episodeId: deck[0].episode.id, completed: false },
        ]);
    });

    it("hands off between surfaces while the viewer is off the player screen", async () => {
        const deck = standaloneDeck(3);
        const sc = await open(deck);
        await sc.prewarm();
        await float(sc);
        await sc.press("Escape");
        expect(sc.state().screen).toBe("guide");

        await sc.endEpisode();

        // The whole promise of phase 2: the channel went on without the screen.
        expect(sc.state().nowPlaying?.episode.id).toBe(deck[1].episode.id);
        expect(sc.pipSlot()).toBe("b");
        expect(sc.pipLog()).not.toContain("exit");
        expect(sc.state().screen).toBe("guide");
    });

    it("does not answer the player’s keys from off-stage", async () => {
        const sc = await open(standaloneDeck(3));
        await float(sc);
        await sc.press("Escape");
        const playing = sc.state().nowPlaying?.episode.id;

        // A Space typed in the guide is a Space typed in the guide.
        await sc.press(" ");
        await sc.press("ArrowRight");

        expect(sc.actions).toEqual([]);
        expect(sc.state().nowPlaying?.episode.id).toBe(playing);
        expect(sc.activeVideo().paused).toBe(false);
    });

    it("comes back to the player when the floating window is closed", async () => {
        const sc = await open(standaloneDeck(3));
        await float(sc);
        await sc.press("Escape");
        expect(sc.state().screen).toBe("guide");

        await sc.closePipWindow();

        // The picture is inline again, so the page had better be showing it.
        expect(sc.state().screen).toBe("player");
        expect(sc.state().pipActive).toBe(false);
        expect(sc.state().nowPlaying).not.toBeNull();
    });
});

describe("when something else takes the screen", () => {
    it("goes dark with the rest of the player when the sleep timer lands", async () => {
        const deck = standaloneDeck(3);
        const sc = await open(deck);
        await float(sc);
        await sc.expireSleep();

        await sc.endEpisode();

        // A floating window is a light source too.
        expect(sc.state().screen).toBe("blackout");
        expect(sc.pipSlot()).toBeNull();
        expect(sc.pipLog()).toEqual(["enter:a", "exit"]);
        expect(sc.state().pipActive).toBe(false);
        // …and the episode that finished is still logged as watched.
        expect(reportedEnds(sc.calls)).toEqual([
            { episodeId: deck[0].episode.id, completed: true },
        ]);
    });

    it("goes dark from the guide too, with the picture still floating", async () => {
        const sc = await open(standaloneDeck(3));
        await float(sc);
        await sc.press("Escape");
        await sc.expireSleep();

        await sc.endEpisode();

        expect(sc.state().screen).toBe("blackout");
        expect(sc.pipSlot()).toBeNull();
        expect(sc.state().pipActive).toBe(false);
    });

    /**
     * A dead stream in a floating window is a frozen frame and no explanation —
     * the Retry/Skip card is on the page the viewer isn't looking at. So the
     * picture comes home to meet it.
     */
    it("brings the picture home when the stream dies", async () => {
        const sc = await open(standaloneDeck(3));
        await float(sc);

        await sc.breakStream();

        expect(sc.pipSlot()).toBeNull();
        expect(sc.state().pipActive).toBe(false);
        expect(sc.state().screen).toBe("player");
        expect(document.querySelector(".player-error")).not.toBeNull();
        expect(document.querySelector(".pip-placard")).toBeNull();
    });
});
