/**
 * The player's stage — which surface is on air, and what each holds.
 *
 * These transitions are the whole of the double-buffered handoff, and until
 * this module was extracted they could only be observed indirectly, through
 * what two `<video>` elements did in a happy-dom harness. The invariant worth
 * pinning is the one that makes a handoff free: when the standby is already
 * holding the episode being promoted, the result is a *flip* — the slot keeps
 * its object identity, so React keeps the element, so the element keeps its
 * buffer and its ffmpeg.
 */

import {
    EMPTY_STAGE,
    mirrorPending,
    other,
    reconcile,
    type StageState,
    slotFor,
    writeSlot,
} from "@renderer/player/stage.js";
import type { NowPlaying } from "@shared/types.js";
import { describe, expect, it } from "vitest";

function playing(episodeId: number, channelId = 1): NowPlaying {
    return {
        channelId,
        channelNumber: 3,
        channelName: "Ch",
        episode: {
            id: episodeId,
            showId: 1,
            showTitle: "Cheers",
            season: 1,
            episode: episodeId,
            episodeEnd: null,
            title: null,
            code: `S01E0${episodeId}`,
            durationS: 1200,
            playbackPath: "remux",
        },
        streamUrl: `http://127.0.0.1:1/stream/${episodeId}?k=x`,
        arc: null,
    };
}

describe("slotFor", () => {
    it("keys the source by stream, not by episode, so a seek opens a new one", () => {
        expect(slotFor(playing(7)).source.key).toBe("7@0");
        expect(slotFor(playing(7), 90).source.key).toBe("7@90");
    });

    it("shortens the reported duration by the seek offset", () => {
        // The pipe's own timestamps restart at zero after `-ss`.
        expect(slotFor(playing(7), 200).source.durationS).toBe(1000);
    });

    it("never reports a duration below one second", () => {
        expect(slotFor(playing(7), 5000).source.durationS).toBe(1);
    });
});

describe("reconcile", () => {
    it("loads into the active surface when nothing is standing by", () => {
        const stage = reconcile(EMPTY_STAGE, playing(1));
        expect(stage.active).toBe("a");
        expect(stage.a?.episodeId).toBe(1);
        expect(stage.b).toBeNull();
    });

    /**
     * The handoff. `b` was buffering episode 2; promoting it must flip rather
     * than load — and the slot object must be the *same one*, because a new
     * object would re-render the surface and throw away the buffer the prewarm
     * spent thirty seconds building.
     */
    it("flips to the standby when it already holds the promoted episode", () => {
        let stage = reconcile(EMPTY_STAGE, playing(1));
        stage = mirrorPending(stage, playing(2));
        const standbySlot = stage.b;

        const after = reconcile(stage, playing(2));

        expect(after.active).toBe("b");
        expect(after.b).toBe(standbySlot); // identity, not just equality
        expect(after.a).toBeNull(); // the finished episode's surface is released
    });

    it("loads normally when the standby holds something else — a skip mid-prewarm", () => {
        let stage = reconcile(EMPTY_STAGE, playing(1));
        stage = mirrorPending(stage, playing(2));

        const after = reconcile(stage, playing(9));

        expect(after.active).toBe("a");
        expect(after.a?.episodeId).toBe(9);
        // The stale standby goes with it; nothing is buffering episode 2 now.
        expect(after.b).toBeNull();
    });

    it("clears both surfaces when there is nothing playing, keeping generations", () => {
        let stage = reconcile(EMPTY_STAGE, playing(1));
        stage = { ...stage, generation: { a: 3, b: 1 } };

        const after = reconcile(stage, null);

        expect(after.a).toBeNull();
        expect(after.b).toBeNull();
        // Generations are Retry's counter — resetting them would re-use a URL key
        // the surface already rejected.
        expect(after.generation).toEqual({ a: 3, b: 1 });
    });
});

describe("mirrorPending", () => {
    it("puts the pending pick on the standby surface", () => {
        const stage = mirrorPending(
            reconcile(EMPTY_STAGE, playing(1)),
            playing(2),
        );
        expect(stage.b?.episodeId).toBe(2);
        expect(stage.active).toBe("a");
    });

    it("clears the standby when the pick is withdrawn", () => {
        let stage = mirrorPending(
            reconcile(EMPTY_STAGE, playing(1)),
            playing(2),
        );
        stage = mirrorPending(stage, null);
        expect(stage.b).toBeNull();
    });

    /**
     * The one-unit channel. The standby would request the same stream URL on the
     * same channel — the same encoder slot — and taking that slot would kill the
     * stream on screen. Nothing may be mirrored.
     */
    it("refuses to prewarm the episode already on air", () => {
        const stage = mirrorPending(
            reconcile(EMPTY_STAGE, playing(1)),
            playing(1),
        );
        expect(stage.b).toBeNull();
    });

    it("is idempotent, so a re-render cannot restart the prewarm", () => {
        const first = mirrorPending(
            reconcile(EMPTY_STAGE, playing(1)),
            playing(2),
        );
        const second = mirrorPending(first, playing(2));
        // Same state object: React sees no change, the surface is not remounted.
        expect(second).toBe(first);
    });
});

describe("writeSlot / other", () => {
    it("writes the named slot and leaves the other alone", () => {
        const stage: StageState = reconcile(EMPTY_STAGE, playing(1));
        const next = writeSlot(stage, "b", slotFor(playing(5)));
        expect(next.a).toBe(stage.a);
        expect(next.b?.episodeId).toBe(5);
    });

    it("other() is the surface that isn't this one", () => {
        expect(other("a")).toBe("b");
        expect(other("b")).toBe("a");
    });
});
