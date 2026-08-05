/**
 * The gapless handoff (docs/playback.md, "Gapless handoffs").
 *
 * This is the phase with a way to be quietly, badly wrong: `prewarmNext`
 * *reserves* the next pick thirty seconds early and `promoteNext` commits it at
 * the handoff. Promote twice — or fall back to `next` with a standby pending —
 * and the channel advances twice for one episode watched: a shuffle bag loses
 * an episode a cycle, a sequential cursor skips one, and a multipart arc drops
 * a part. Commit a reservation nobody watched and the same corruption arrives
 * from the other side — which is exactly what prewarming did before it became a
 * reservation, and what the "spends nothing" cases below pin down.
 *
 * So the store's transition logic is tested against the *real* scheduler over a
 * real in-memory database, with only the IPC hop faked. The invariant every case
 * below checks is the same one: **one play-log entry per episode the viewer
 * actually saw.**
 */

import { type Db, openDatabase } from "@main/db/index.js";
import {
    addChannelShow,
    createChannel,
    getChannel,
    markLastAiringCompleted,
    setChannelShowMode,
} from "@main/db/repositories/channels.js";
import {
    clearPlaybackState,
    getPlaybackState,
    savePlaybackPosition,
} from "@main/db/repositories/playback-state.js";
import {
    discardReserved,
    peekNext,
    promoteReserved,
    reserveNext,
    resetProgress,
    validateActiveArc,
} from "@main/scheduler/scheduler.js";
import { toEpisodeView } from "@main/services/channels.js";
import {
    advanceChannel,
    notePromoted,
    tuneIn,
} from "@main/services/playback.js";
import type { RerunApi } from "@shared/ipc.js";
import type { EpisodeView, NowPlaying } from "@shared/types.js";
import { DEFAULT_SETTINGS, SLEEP_MAX_MIN } from "@shared/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providePosition, useStore } from "../src/renderer/src/store.js";

let db: Db;
let channelId: number;
let showId: number;
/** Every encoder release the store asked for, in order: `channel:3` or `channel:3:41`. */
let released: string[];
/** How many times the schedule was *spent* (a committing pick or a promoted
 * reservation). The number this suite is really about. */
let commits: number;

function insertShow(title: string): number {
    return Number(
        db
            .prepare(
                `INSERT INTO shows (title, folder_path, added_at) VALUES (?, ?, 0)`,
            )
            .run(title, `/tv/${title}`).lastInsertRowid,
    );
}

function insertEpisode(season: number, episode: number): number {
    return Number(
        db
            .prepare(
                `INSERT INTO episodes (show_id, season, episode, path, duration_s, container, vcodec, acodec, playback_path)
         VALUES (?, ?, ?, ?, 1320, 'matroska', 'h264', 'ac3', 'remux')`,
            )
            .run(showId, season, episode, `/tv/show/S${season}E${episode}.mkv`)
            .lastInsertRowid,
    );
}

function insertArc(title: string, episodeIds: number[]): void {
    const groupId = Number(
        db
            .prepare(
                `INSERT INTO part_groups (show_id, title, source) VALUES (?, ?, 'manual')`,
            )
            .run(showId, title).lastInsertRowid,
    );
    const link = db.prepare(
        `UPDATE episodes SET part_group_id = ?, part_index = ? WHERE id = ?`,
    );
    episodeIds.forEach((id, index) => {
        link.run(groupId, index + 1, id);
    });
}

function playLog(): { episodeId: number; completed: number }[] {
    return db
        .prepare(
            `SELECT episode_id AS episodeId, completed FROM play_log ORDER BY id`,
        )
        .all() as { episodeId: number; completed: number }[];
}

/** What the main process's `toNowPlaying` builds, minus Electron. */
function nowPlaying(
    channel: number,
    episodeId: number,
    arc: NowPlaying["arc"],
    resumeAtS = 0,
): NowPlaying | null {
    const channelRow = getChannel(db, channel);
    const episode = toEpisodeView(db, episodeId);
    if (!channelRow || !episode) return null;
    return {
        channelId: channelRow.id,
        channelNumber: channelRow.number,
        channelName: channelRow.name,
        episode,
        streamUrl: `http://127.0.0.1:9/stream/${episodeId}?ch=${channel}`,
        resumeAtS,
        arc,
    };
}

/**
 * The preload bridge, backed by the real scheduler.
 *
 * Only the methods the playback actions touch are implemented — a partial object
 * cast rather than a hundred lines of stubs. Anything else the store reaches for
 * fails loudly as a TypeError, which is the outcome we want from a test that has
 * drifted out of date.
 */
function fakeBridge(): RerunApi {
    const player: RerunApi["player"] = {
        tune: async (channel) => {
            validateActiveArc(db, channel);
            released.push(`channel:${channel}`);
            // The real handler's shape: `tuneIn` either resumes — spending
            // nothing — or draws. A play-log row is written exactly when the
            // schedule *is* spent, so counting rows is what tells the two apart.
            const before = playLog().length;
            const tuned = tuneIn(db, channel);
            if (playLog().length > before) commits += 1;
            if (!tuned) return null;
            return nowPlaying(
                channel,
                tuned.episodeId,
                tuned.arc,
                tuned.resumeAtS,
            );
        },
        next: async (channel) => {
            released.push(`channel:${channel}`);
            commits += 1;
            const tuned = advanceChannel(db, channel);
            return tuned
                ? nowPlaying(channel, tuned.episodeId, tuned.arc)
                : null;
        },
        // A reservation, not a commit — the real handler's exact shape. `commits`
        // therefore does not move until the handoff promotes it.
        prewarmNext: async (channel) => {
            const pick = reserveNext(db, channel);
            return pick ? nowPlaying(channel, pick.episodeId, pick.arc) : null;
        },
        promoteNext: async (channel, episodeId) => {
            commits += 1;
            promoteReserved(db, channel, episodeId);
            notePromoted(db, channel, episodeId);
        },
        peekNext: async (channel): Promise<EpisodeView | null> => {
            const pick = peekNext(db, channel);
            return pick ? toEpisodeView(db, pick.episodeId) : null;
        },
        reportEnded: async (channel, episodeId, completed) => {
            markLastAiringCompleted(db, channel, episodeId, completed);
            clearPlaybackState(db, channel, episodeId);
            released.push(`channel:${channel}:${episodeId}`);
        },
        savePosition: async (channel, episodeId, positionS) => {
            savePlaybackPosition(db, channel, episodeId, positionS);
        },
        release: async (channel, episodeId) => {
            // Mirrors the real handler: abandoning an encoder abandons the
            // reservation it was buffering for.
            discardReserved(db, channel, episodeId ?? undefined);
            released.push(
                episodeId == null
                    ? `channel:${channel}`
                    : `channel:${channel}:${episodeId}`,
            );
        },
    };

    return {
        player,
        channels: { list: async () => [] },
        settings: { set: async () => useStore.getState().settings },
    } as unknown as RerunApi;
}

beforeEach(() => {
    db = openDatabase(":memory:");
    released = [];
    commits = 0;
    showId = insertShow("Gargoyles");
    (globalThis as { rerun?: RerunApi }).rerun = fakeBridge();
    // The Player is what registers a playhead, and it is not mounted here — so
    // the default is "nothing is playing" and `savePosition` writes nothing
    // unless a case says otherwise. Reset per test: this is module-level state
    // in the store, which is the one thing that can bleed between them.
    providePosition(() => null);

    useStore.setState({
        nowPlaying: null,
        upNext: null,
        pendingNext: null,
        sleepUntil: null,
        sleepMinutes: null,
        screen: "guide",
        channels: [],
        settings: { ...DEFAULT_SETTINGS, prewarmNext: true },
    });
});

/** A deadline that has already passed — the state the store checks, not a wait. */
function expireSleepTimer(): void {
    useStore.setState({ sleepUntil: Date.now() - 1000, sleepMinutes: 30 });
}

/** A show of `count` standalone episodes on a sequential channel — a known order. */
function sequentialChannel(count: number, dial = 3): void {
    for (let episode = 1; episode <= count; episode++)
        insertEpisode(1, episode);
    channelId = createChannel(db, "Test", dial).id;
    addChannelShow(db, channelId, showId);
    setChannelShowMode(db, channelId, showId, "sequential");
}

const store = (): ReturnType<typeof useStore.getState> => useStore.getState();

describe("prewarm then handoff", () => {
    beforeEach(() => sequentialChannel(6));

    it("advances the schedule exactly once across a prewarmed handoff", async () => {
        await store().tune(channelId);
        const first = store().nowPlaying!;
        expect(commits).toBe(1);
        expect(playLog()).toHaveLength(1);

        await store().prewarm();
        const pending = store().pendingNext!;
        // Reserved, not committed: the standby buffers episode 2 — the actual next
        // episode in airing order, not a guess — while the schedule stays unspent.
        expect(commits).toBe(1);
        expect(playLog()).toHaveLength(1);
        expect(pending.episode.episode).toBe(2);

        await store().advance(true);

        // The promotion committed the reservation, exactly once. This is the whole test.
        expect(commits).toBe(2);
        expect(playLog()).toHaveLength(2);
        expect(store().nowPlaying?.episode.id).toBe(pending.episode.id);
        expect(store().pendingNext).toBeNull();
        // The finished episode is logged complete; the promoted one is still airing.
        expect(playLog()).toEqual([
            { episodeId: first.episode.id, completed: 1 },
            { episodeId: pending.episode.id, completed: 0 },
        ]);
    });

    it("advances exactly once when the viewer skips into a pending prewarm", async () => {
        await store().tune(channelId);
        const first = store().nowPlaying!;
        await store().prewarm();
        const pending = store().pendingNext!;

        await store().advance(false);

        expect(commits).toBe(2);
        expect(store().nowPlaying?.episode.id).toBe(pending.episode.id);
        // Skipped, so the abandoned episode stays incomplete — a skip is not a watch.
        expect(playLog()).toEqual([
            { episodeId: first.episode.id, completed: 0 },
            { episodeId: pending.episode.id, completed: 0 },
        ]);
    });

    it("never double-advances when a skip lands while the prewarm is still in flight", async () => {
        await store().tune(channelId);

        // The race the store's serialisation exists for: both transitions issued
        // before either has resolved.
        const prewarming = store().prewarm();
        const advancing = store().advance(true);
        await Promise.all([prewarming, advancing]);

        // Two picks total — the tune-in and one advance — however the two interleaved.
        expect(commits).toBe(2);
        expect(playLog()).toHaveLength(2);
        expect(store().pendingNext).toBeNull();
        expect(store().nowPlaying?.episode.id).toBe(playLog()[1].episodeId);
    });

    it("keeps the play log one entry per episode across a marathon of handoffs", async () => {
        await store().tune(channelId);
        const watched = [store().nowPlaying!.episode.id];

        for (let handoff = 0; handoff < 5; handoff++) {
            await store().prewarm();
            await store().advance(true);
            watched.push(store().nowPlaying!.episode.id);
        }

        // Six episodes seen, six log entries, in the order they aired, no repeats.
        expect(watched).toHaveLength(6);
        expect(new Set(watched).size).toBe(6);
        expect(playLog().map((row) => row.episodeId)).toEqual(watched);
    });

    it("spends nothing on a reservation the viewer walks out on", async () => {
        await store().tune(channelId);
        const first = store().nowPlaying!;
        await store().prewarm();
        const pending = store().pendingNext!;

        await store().leavePlayer();

        expect(store().nowPlaying).toBeNull();
        expect(store().pendingNext).toBeNull();
        // Both encoders on the channel go — including the prewarm nobody will watch.
        expect(released).toContain(`channel:${channelId}`);
        // The reservation went with them: no phantom log entry, no burned unit.
        expect(playLog()).toEqual([
            { episodeId: first.episode.id, completed: 0 },
        ]);
        expect(commits).toBe(1);

        // The proof the unit wasn't burned: tuning back in airs the episode the
        // discarded reservation was holding, not the one after it.
        await store().tune(channelId);
        expect(store().nowPlaying?.episode.id).toBe(pending.episode.id);
    });

    it("releases the outgoing encoder on a handoff and nothing else", async () => {
        await store().tune(channelId);
        const first = store().nowPlaying!;
        await store().prewarm();
        released.length = 0;

        await store().advance(true);

        // Just the episode that finished. Killing the channel here would take the
        // prewarmed stream with it and undo the whole point.
        expect(released).toEqual([`channel:${channelId}:${first.episode.id}`]);
    });

    it("abandons a pending pick when prewarming is switched off mid-episode", async () => {
        await store().tune(channelId);
        await store().prewarm();
        const pending = store().pendingNext!;
        released.length = 0;

        await store().setSetting("prewarmNext", false);

        expect(store().pendingNext).toBeNull();
        // The pending episode's job only — the one on air is on the same channel.
        expect(released).toEqual([
            `channel:${channelId}:${pending.episode.id}`,
        ]);
        expect(released).not.toContain(`channel:${channelId}`);
    });

    /**
     * Loudness equalization is an ffmpeg argument, so a standby spawned before the
     * toggle is still encoding with the *old* audio settings. Left alone it would
     * hand off mid-channel to an episode that sounds different from the setting
     * that is now switched on — the one place this feature could be audibly
     * self-contradictory. Dropping the standby makes the next episode be
     * re-requested at handoff, which is where every other consumer of Settings
     * picks a change up.
     */
    it("abandons a pending pick when loudness equalization is toggled", async () => {
        for (const value of [true, false]) {
            await store().tune(channelId);
            await store().prewarm();
            const pending = store().pendingNext!;
            released.length = 0;

            await store().setSetting("loudnessEq", value);

            expect(store().pendingNext).toBeNull();
            expect(released).toEqual([
                `channel:${channelId}:${pending.episode.id}`,
            ]);
            expect(released).not.toContain(`channel:${channelId}`);
        }
    });
});

/**
 * The sleep timer (docs/ui.md, "The sleep timer").
 *
 * Same invariant as the rest of this file — one play-log entry per episode
 * watched — with one addition: going to sleep is *not* the same as walking out.
 * The episode that finished is a watched episode and must be logged complete, or
 * a sequential channel would re-air it the next evening.
 */
describe("sleep timer", () => {
    beforeEach(() => sequentialChannel(6));

    it("finishes the episode, then goes dark without spending another pick", async () => {
        await store().tune(channelId);
        const first = store().nowPlaying!;
        expireSleepTimer();

        await store().advance(true);

        expect(store().screen).toBe("blackout");
        expect(store().nowPlaying).toBeNull();
        expect(store().upNext).toBeNull();
        // The timer has done its job; it must not still be armed on the far side.
        expect(store().sleepUntil).toBeNull();
        // No pick was committed for an episode nobody is going to watch.
        expect(commits).toBe(1);
        // Completed, unlike leaving the player — the episode genuinely ended.
        expect(playLog()).toEqual([
            { episodeId: first.episode.id, completed: 1 },
        ]);
        expect(released).toContain(`channel:${channelId}`);
    });

    it("does not prewarm once the timer is due to stop after this episode", async () => {
        await store().tune(channelId);
        expireSleepTimer();

        await store().prewarm();

        // Committing here would spend a schedule step we'd only release again.
        expect(store().pendingNext).toBeNull();
        expect(commits).toBe(1);
        expect(playLog()).toHaveLength(1);
    });

    /**
     * Expiry inside the last 30 seconds: the prewarm already ran, so a standby is
     * buffering a reserved pick. Going dark discards the reservation with the
     * encoder — the schedule never spent anything on the episode nobody watched.
     */
    it("discards a reservation made before the timer expired", async () => {
        await store().tune(channelId);
        const first = store().nowPlaying!;
        await store().prewarm();
        expect(store().pendingNext).not.toBeNull();
        expect(commits).toBe(1);

        expireSleepTimer();
        released.length = 0;
        await store().advance(true);

        expect(store().screen).toBe("blackout");
        expect(store().pendingNext).toBeNull();
        // The whole channel, which takes the prewarmed encoder with it.
        expect(released).toContain(`channel:${channelId}`);
        expect(commits).toBe(1);
        // Only the episode that genuinely finished — the reservation left no trace.
        expect(playLog()).toEqual([
            { episodeId: first.episode.id, completed: 1 },
        ]);
    });

    it("keeps playing while the deadline is still ahead", async () => {
        await store().tune(channelId);
        store().armSleep(30);

        await store().advance(true);

        expect(store().screen).toBe("player");
        expect(store().nowPlaying).not.toBeNull();
        expect(store().sleepUntil).not.toBeNull();
    });

    it("stops at once when the timer expires while paused, logging no false watch", async () => {
        await store().tune(channelId);
        const first = store().nowPlaying!;
        expireSleepTimer();

        await store().sleepNow();

        expect(store().screen).toBe("blackout");
        expect(store().nowPlaying).toBeNull();
        expect(store().sleepUntil).toBeNull();
        // Nothing finished, so this one is not a watch.
        expect(playLog()).toEqual([
            { episodeId: first.episode.id, completed: 0 },
        ]);
        expect(commits).toBe(1);
    });

    /**
     * The dial's far end (docs/ui.md, "The sleep timer"). A five-hour timer is
     * one a whole evening runs underneath, so what is checked here is that nothing about
     * the handoff path treats a long deadline differently: episodes keep airing,
     * one log entry each, and the stop lands on the unit that crosses expiry.
     */
    it("runs a five-hour timer through handoffs and stops at the unit that crosses it", async () => {
        await store().tune(channelId);
        store().armSleep(SLEEP_MAX_MIN);
        const armedUntil = store().sleepUntil!;

        for (let handoff = 0; handoff < 3; handoff++) {
            await store().prewarm();
            await store().advance(true);
            expect(store().screen).toBe("player");
        }
        // Untouched by the handoffs — the deadline is wall-clock, not per-episode.
        expect(store().sleepUntil).toBe(armedUntil);

        expireSleepTimer();
        await store().advance(true);

        expect(store().screen).toBe("blackout");
        // Four episodes watched to the end, one entry each, all complete.
        const log = playLog();
        expect(log).toHaveLength(4);
        expect(log.every((row) => row.completed === 1)).toBe(true);
        expect(commits).toBe(4);
    });

    it("clamps an armed duration to the five-hour ceiling", async () => {
        await store().tune(channelId);
        const before = Date.now();

        store().armSleep(900);

        expect(store().sleepMinutes).toBe(SLEEP_MAX_MIN);
        expect(store().sleepUntil!).toBeLessThanOrEqual(
            before + SLEEP_MAX_MIN * 60_000 + 1000,
        );
    });

    /**
     * The reason `adjustSleep` exists. A viewer who armed an hour and comes back
     * forty minutes later to scroll the wheel is asking for more television *from
     * now* — resolving the nudge against the armed hour instead of the twenty
     * minutes left would hand them a deadline they have already passed.
     */
    it("adds scrolled minutes to the time remaining, not to the armed figure", async () => {
        await store().tune(channelId);
        store().armSleep(60);
        // Forty minutes in: twenty left of the armed hour.
        useStore.setState({ sleepUntil: Date.now() + 20 * 60_000 });

        store().adjustSleep(5);

        expect(store().sleepMinutes).toBe(25);
        const remainingMin = (store().sleepUntil! - Date.now()) / 60_000;
        expect(remainingMin).toBeGreaterThan(24);
        expect(remainingMin).toBeLessThanOrEqual(25);
    });

    it("arms from now when the wheel is scrolled with the timer off", async () => {
        await store().tune(channelId);
        expect(store().sleepUntil).toBeNull();

        store().adjustSleep(5);

        expect(store().sleepMinutes).toBe(5);
        expect(store().sleepUntil).not.toBeNull();
    });

    it("switches a running timer off when it is wound below zero", async () => {
        await store().tune(channelId);
        store().armSleep(5);

        store().adjustSleep(-5);

        expect(store().sleepUntil).toBeNull();
        expect(store().sleepMinutes).toBeNull();
    });

    /**
     * An expired timer is waiting on a unit boundary, and there is no remaining
     * time left to take away — winding it down must not quietly disarm the stop
     * the viewer is counting on.
     */
    it("leaves an expired timer armed when it is wound down", async () => {
        await store().tune(channelId);
        expireSleepTimer();
        const due = store().sleepUntil;

        store().adjustSleep(-5);

        expect(store().sleepUntil).toBe(due);
    });

    it("clamps the wheel to the ceiling instead of running past it", async () => {
        await store().tune(channelId);
        store().armSleep(SLEEP_MAX_MIN);

        store().adjustSleep(30);

        expect(store().sleepMinutes).toBe(SLEEP_MAX_MIN);
    });

    /**
     * The "after this ep" chip. It arms zero minutes — an already-due timer — so
     * the stop is produced by the same unit boundary as every other expiry, with
     * no second code path to keep in step.
     */
    it("stops at the end of the current episode when armed with zero minutes", async () => {
        await store().tune(channelId);
        const first = store().nowPlaying!;

        store().armSleep(0);
        expect(store().sleepUntil).not.toBeNull();

        await store().advance(true);

        expect(store().screen).toBe("blackout");
        expect(playLog()).toEqual([
            { episodeId: first.episode.id, completed: 1 },
        ]);
        expect(commits).toBe(1);
    });

    it("disarms when the viewer leaves the player themselves", async () => {
        await store().tune(channelId);
        store().armSleep(30);

        await store().leavePlayer();

        // A timer that survived into the guide would fire against the next channel.
        expect(store().screen).toBe("guide");
        expect(store().sleepUntil).toBeNull();
        expect(store().sleepMinutes).toBeNull();
    });

    it("stops on a skip that happens to end the unit, since the viewer can cancel", async () => {
        await store().tune(channelId);
        const first = store().nowPlaying!;
        expireSleepTimer();

        await store().advance(false);

        expect(store().screen).toBe("blackout");
        // Skipped, not watched — the outcome is logged honestly either way.
        expect(playLog()).toEqual([
            { episodeId: first.episode.id, completed: 0 },
        ]);
        expect(commits).toBe(1);
    });
});

/**
 * The fullscreen handoff (docs/ui.md, "Blackout").
 *
 * Fullscreen belongs to the Player's stage wrapper, and going dark unmounts the
 * Player — so without a handoff the sleep screen drops back to a window and a
 * dark room gets its taskbar back at the one moment the app means to emit
 * nothing. The store's part is to re-target fullscreen to the document root
 * *before* it flips the screen, which is the ordering these cases pin down.
 *
 * This module is compiled DOM-free (see `tsconfig.node.json`), so the document
 * is a stand-in installed on `globalThis` — the same way the preload bridge is
 * faked, and the same way the store reaches both.
 */
describe("going dark keeps fullscreen", () => {
    /** Screens the fake document had been asked to fill, in order. */
    let fullscreenRequests: string[];
    /** Set when the request is made, to prove it happened before the screen flip. */
    let screenAtRequest: string | null;

    /**
     * @param element what `document.fullscreenElement` reports — null is a viewer
     *   watching in a window, and must leave the request unmade.
     * @param reject a Chromium that refuses the gesture-less re-target.
     */
    function fakeDocument(element: unknown, reject = false): void {
        (globalThis as { document?: unknown }).document = {
            fullscreenElement: element,
            documentElement: {
                requestFullscreen: async (): Promise<void> => {
                    fullscreenRequests.push("documentElement");
                    screenAtRequest = store().screen;
                    if (reject) throw new Error("gesture required");
                },
            },
        };
    }

    beforeEach(() => {
        sequentialChannel(4);
        fullscreenRequests = [];
        screenAtRequest = null;
    });

    afterEach(() => {
        delete (globalThis as { document?: unknown }).document;
    });

    it("hands fullscreen to the document root before the Player unmounts", async () => {
        await store().tune(channelId);
        fakeDocument({ id: "stage" });
        expireSleepTimer();

        await store().advance(true);

        expect(fullscreenRequests).toEqual(["documentElement"]);
        // The whole point of the ordering: the stage still exists when the request
        // is made, so there is a live session to re-target and no gesture is needed.
        expect(screenAtRequest).toBe("player");
        expect(store().screen).toBe("blackout");
    });

    it("makes the same handoff when the timer expires while paused", async () => {
        await store().tune(channelId);
        fakeDocument({ id: "stage" });
        expireSleepTimer();

        await store().sleepNow();

        expect(fullscreenRequests).toEqual(["documentElement"]);
        expect(store().screen).toBe("blackout");
    });

    it("asks for nothing when the viewer was watching in a window", async () => {
        await store().tune(channelId);
        fakeDocument(null);
        expireSleepTimer();

        await store().advance(true);

        // Requesting here would *enter* fullscreen on someone who never asked for it.
        expect(fullscreenRequests).toEqual([]);
        expect(store().screen).toBe("blackout");
    });

    it("still goes dark when the browser refuses the re-target", async () => {
        await store().tune(channelId);
        fakeDocument({ id: "stage" }, true);
        const first = store().nowPlaying!;
        expireSleepTimer();

        await store().advance(true);

        // A refusal costs the fullscreen, never the sleep: black-but-windowed is the
        // degraded case, and a rejected promise must not strand a running channel.
        expect(store().screen).toBe("blackout");
        expect(store().nowPlaying).toBeNull();
        expect(released).toContain(`channel:${channelId}`);
        expect(playLog()).toEqual([
            { episodeId: first.episode.id, completed: 1 },
        ]);
    });

    it("leaves fullscreen alone when the viewer walks out to the guide", async () => {
        await store().tune(channelId);
        fakeDocument({ id: "stage" });
        store().armSleep(30);

        await store().leavePlayer();

        // Leaving is a decision to go and browse, and the guide is a windowed screen
        // with an app bar — the Player's own teardown drops fullscreen there.
        expect(fullscreenRequests).toEqual([]);
        expect(store().screen).toBe("guide");
    });
});

describe("with prewarming off", () => {
    beforeEach(() => {
        sequentialChannel(4);
        useStore.setState({
            settings: { ...DEFAULT_SETTINGS, prewarmNext: false },
        });
    });

    it("commits nothing early and advances through `next`, exactly as before phase 3", async () => {
        await store().tune(channelId);
        await store().prewarm();

        expect(store().pendingNext).toBeNull();
        expect(commits).toBe(1);
        expect(playLog()).toHaveLength(1);

        released.length = 0;
        await store().advance(true);

        expect(commits).toBe(2);
        expect(playLog()).toHaveLength(2);
        // `next` takes the whole channel, which is safe precisely because there is
        // no prewarm to protect.
        expect(released).toContain(`channel:${channelId}`);
    });
});

describe("prewarm inside a multipart arc", () => {
    beforeEach(() => {
        const parts = [
            insertEpisode(1, 1),
            insertEpisode(1, 2),
            insertEpisode(1, 3),
        ];
        insertEpisode(1, 4);
        insertEpisode(1, 5);
        insertArc("Awakening", parts);
        channelId = createChannel(db, "Arc", 4).id;
        addChannelShow(db, channelId, showId);
        setChannelShowMode(db, channelId, showId, "sequential");
    });

    /**
     * The nastiest failure mode. An arc's parts are handed out one at a time by
     * `pickNext` under a channel lock, so a double-advance here does not merely
     * reorder episodes — it makes part 2 of a three-parter never air.
     */
    it("hands out consecutive parts without skipping or repeating one", async () => {
        await store().tune(channelId);
        expect(store().nowPlaying?.arc).toMatchObject({
            partIndex: 1,
            partCount: 3,
        });

        await store().prewarm();
        expect(store().pendingNext?.arc).toMatchObject({
            partIndex: 2,
            partCount: 3,
        });
        await store().advance(true);
        expect(store().nowPlaying?.arc).toMatchObject({
            partIndex: 2,
            partCount: 3,
        });

        await store().prewarm();
        expect(store().pendingNext?.arc).toMatchObject({
            partIndex: 3,
            partCount: 3,
        });
        await store().advance(true);
        expect(store().nowPlaying?.arc).toMatchObject({
            partIndex: 3,
            partCount: 3,
        });

        // Handing out the final part releases the lock, so the lottery runs again.
        expect(getChannel(db, channelId)?.activeGroupId).toBeNull();

        await store().prewarm();
        expect(store().pendingNext?.arc).toBeNull();
        await store().advance(true);

        // Three parts in order, one log entry each, then one standalone.
        const log = playLog();
        expect(log).toHaveLength(4);
        expect(new Set(log.map((row) => row.episodeId)).size).toBe(4);
        expect(commits).toBe(4);
    });

    /**
     * The sleep timer's whole promise, on the case that makes it worth having: an
     * expired timer must not strand a viewer three-quarters of the way through a
     * two-parter. The arc lock already guarantees the *next* pick continues the
     * arc; what is tested here is that the store keeps asking for one.
     */
    it("plays an expired timer out to the end of the arc, not the end of the part", async () => {
        await store().tune(channelId);
        expect(store().nowPlaying?.arc).toMatchObject({
            partIndex: 1,
            partCount: 3,
        });

        expireSleepTimer();

        await store().advance(true);
        expect(store().screen).toBe("player");
        expect(store().nowPlaying?.arc).toMatchObject({
            partIndex: 2,
            partCount: 3,
        });

        await store().advance(true);
        expect(store().screen).toBe("player");
        expect(store().nowPlaying?.arc).toMatchObject({
            partIndex: 3,
            partCount: 3,
        });

        // The final part ends the unit, so this is where it stops.
        await store().advance(true);
        expect(store().screen).toBe("blackout");
        expect(store().nowPlaying).toBeNull();

        // Three parts aired, three log entries, all complete — and the arc lock was
        // released on the way out rather than left pointing at a fourth part.
        const log = playLog();
        expect(log).toHaveLength(3);
        expect(log.every((row) => row.completed === 1)).toBe(true);
        expect(getChannel(db, channelId)?.activeGroupId).toBeNull();
    });

    /**
     * "After this ep" pressed in the middle of a two-parter. The chip is worded
     * for the common case, but the boundary it arms is the *unit's* — so it plays
     * the arc out rather than stranding the viewer between parts. This is the case
     * that would break if zero minutes were ever special-cased into "stop here".
     */
    it("plays a zero-minute timer out to the end of the arc", async () => {
        await store().tune(channelId);
        expect(store().nowPlaying?.arc).toMatchObject({
            partIndex: 1,
            partCount: 3,
        });

        store().armSleep(0);

        await store().advance(true);
        expect(store().screen).toBe("player");
        expect(store().nowPlaying?.arc).toMatchObject({
            partIndex: 2,
            partCount: 3,
        });

        await store().advance(true);
        await store().advance(true);

        expect(store().screen).toBe("blackout");
        expect(playLog()).toHaveLength(3);
        expect(getChannel(db, channelId)?.activeGroupId).toBeNull();
    });

    it("resumes at the unwatched part when the viewer quits mid-arc after a prewarm", async () => {
        await store().tune(channelId);
        await store().prewarm();
        await store().leavePlayer();

        // Part 2 was only *reserved*, never watched, so discarding the prewarm
        // leaves the channel parked on part 2 — re-tuning must air it, not skip to
        // part 3 as the old committing prewarm did.
        const channel = getChannel(db, channelId);
        expect(channel?.activeGroupId).not.toBeNull();
        expect(channel?.activePartIndex).toBe(1);

        await store().tune(channelId);
        expect(store().nowPlaying?.arc).toMatchObject({
            partIndex: 2,
            partCount: 3,
        });
    });
});

/**
 * The nastiest *discard* case, and the invariant the whole unit design exists
 * for: an arc can never be joined at Part 2. A committing prewarm broke it —
 * a prewarm that drew the arc locked the channel at Part 2, and if the viewer
 * then left, the next tune-in aired Part 2 with Part 1 never watched.
 */
describe("a prewarm that would start an arc", () => {
    beforeEach(() => {
        // A standalone *before* the arc, so the prewarm is what draws the arc.
        insertEpisode(1, 1);
        insertArc("City of Stone", [
            insertEpisode(1, 2),
            insertEpisode(1, 3),
            insertEpisode(1, 4),
        ]);
        channelId = createChannel(db, "Arc start", 5).id;
        addChannelShow(db, channelId, showId);
        setChannelShowMode(db, channelId, showId, "sequential");
    });

    it("does not lock the channel when the reservation is abandoned", async () => {
        await store().tune(channelId);
        expect(store().nowPlaying?.arc).toBeNull();

        await store().prewarm();
        expect(store().pendingNext?.arc).toMatchObject({
            partIndex: 1,
            partCount: 3,
        });

        await store().leavePlayer();

        // No lock and no cursor movement: the arc was never entered.
        expect(getChannel(db, channelId)?.activeGroupId).toBeNull();

        // Re-tuning starts the arc from Part 1, never joins it at Part 2.
        await store().tune(channelId);
        expect(store().nowPlaying?.arc).toMatchObject({
            partIndex: 1,
            partCount: 3,
        });
    });

    it("locks the channel only once the reservation is promoted", async () => {
        await store().tune(channelId);
        await store().prewarm();
        // Still unlocked while the standby merely buffers Part 1.
        expect(getChannel(db, channelId)?.activeGroupId).toBeNull();

        await store().advance(true);
        expect(store().nowPlaying?.arc).toMatchObject({
            partIndex: 1,
            partCount: 3,
        });
        const channel = getChannel(db, channelId);
        expect(channel?.activeGroupId).not.toBeNull();
        expect(channel?.activePartIndex).toBe(1);
    });
});

/**
 * Resuming a channel (docs/playback.md, "Resuming a channel").
 *
 * The failure this suite is really about is the one the whole design is bent
 * around: `pickNext` commits at hand-out time, so a resume that re-tuned
 * through the scheduler would spend a *second* schedule step and hand back a
 * different episode than the one being resumed. Every case below therefore
 * checks two things at once — that the viewer lands back where they were, and
 * that the schedule did not move while they did.
 */
describe("resuming a channel", () => {
    /** The Player's playhead, as the store reads it through `providePosition`. */
    function playheadAt(seconds: number): void {
        providePosition(() => seconds);
    }

    describe("standalone episodes", () => {
        beforeEach(() => sequentialChannel(6));

        it("returns to the same episode and offset, spending nothing", async () => {
            await store().tune(channelId);
            const first = store().nowPlaying!;
            expect(commits).toBe(1);

            playheadAt(430);
            await store().leavePlayer();

            await store().tune(channelId);
            const resumed = store().nowPlaying!;
            expect(resumed.episode.id).toBe(first.episode.id);
            expect(resumed.resumeAtS).toBe(430);
            // The whole point: no second pick, so no second play-log row and no
            // cursor movement. The viewer is one episode in, not two.
            expect(commits).toBe(1);
            expect(playLog()).toHaveLength(1);
        });

        it("carries the offset into the stream URL for a piped episode", async () => {
            await store().tune(channelId);
            playheadAt(430);
            await store().leavePlayer();
            await store().tune(channelId);
            // The fake bridge mints a bare URL, so the assertion that matters here
            // is the number the real `toNowPlaying` would put in `?t=`.
            expect(store().nowPlaying?.resumeAtS).toBe(430);
        });

        it("keeps a separate place on each channel", async () => {
            const other = createChannel(db, "Other", 4).id;
            addChannelShow(db, other, showId);
            setChannelShowMode(db, other, showId, "sequential");

            await store().tune(channelId);
            const onFirst = store().nowPlaying!;
            playheadAt(200);
            // Changing channel saves the outgoing one on its way past.
            await store().tune(other);
            const onSecond = store().nowPlaying!;
            playheadAt(90);
            await store().tune(channelId);

            expect(store().nowPlaying?.episode.id).toBe(onFirst.episode.id);
            expect(store().nowPlaying?.resumeAtS).toBe(200);

            playheadAt(0);
            await store().tune(other);
            expect(store().nowPlaying?.episode.id).toBe(onSecond.episode.id);
            expect(store().nowPlaying?.resumeAtS).toBe(90);
        });

        it("starts the next episode from the top after one finishes", async () => {
            await store().tune(channelId);
            const first = store().nowPlaying!;
            playheadAt(1300);
            // Watched to the end, which is the case a resume must *not* apply to.
            await store().advance(true);
            const second = store().nowPlaying!;
            expect(second.episode.id).not.toBe(first.episode.id);
            expect(second.resumeAtS).toBe(0);
            // And the row already points at it, so a crash here reopens on the
            // episode that is genuinely on air.
            expect(getPlaybackState(db, channelId)?.episodeId).toBe(
                second.episode.id,
            );
        });

        it("does not resume an episode the viewer skipped", async () => {
            await store().tune(channelId);
            const first = store().nowPlaying!;
            playheadAt(300);
            await store().advance(false);
            const second = store().nowPlaying!;

            playheadAt(0);
            await store().leavePlayer();
            await store().tune(channelId);
            // The skipped episode is behind us; the one we skipped *to* is where
            // the channel is.
            expect(store().nowPlaying?.episode.id).toBe(second.episode.id);
            expect(store().nowPlaying?.episode.id).not.toBe(first.episode.id);
        });

        it("resumes the promoted episode after a gapless handoff", async () => {
            await store().tune(channelId);
            await store().prewarm();
            await store().advance(true);
            const promoted = store().nowPlaying!;

            playheadAt(75);
            await store().leavePlayer();
            await store().tune(channelId);
            expect(store().nowPlaying?.episode.id).toBe(promoted.episode.id);
            expect(store().nowPlaying?.resumeAtS).toBe(75);
        });

        it("clamps a position at the very end clear of the last seconds", async () => {
            await store().tune(channelId);
            const first = store().nowPlaying!;
            // Past the runtime entirely — a save that landed as the episode ran out.
            playheadAt(5000);
            await store().leavePlayer();

            await store().tune(channelId);
            expect(store().nowPlaying?.episode.id).toBe(first.episode.id);
            // Not *at* the end: resuming there would play a frame and advance.
            expect(store().nowPlaying?.resumeAtS).toBe(
                first.episode.durationS - 5,
            );
        });

        it("draws a fresh pick when the saved episode has left the library", async () => {
            await store().tune(channelId);
            const first = store().nowPlaying!;
            playheadAt(300);
            await store().leavePlayer();

            // What a scan's prune does to a file that has gone away.
            db.prepare(`DELETE FROM episodes WHERE id = ?`).run(
                first.episode.id,
            );

            await store().tune(channelId);
            expect(store().nowPlaying).not.toBeNull();
            expect(store().nowPlaying?.episode.id).not.toBe(first.episode.id);
            expect(store().nowPlaying?.resumeAtS).toBe(0);
        });

        it("forgets the place when the sleep timer stops the channel", async () => {
            await store().tune(channelId);
            playheadAt(600);
            expireSleepTimer();
            // The unit boundary: the episode finished and the channel went dark.
            await store().advance(true);
            expect(store().screen).toBe("blackout");
            expect(getPlaybackState(db, channelId)).toBeNull();
        });

        it("keeps the place when the sleep timer stops a paused episode", async () => {
            await store().tune(channelId);
            const first = store().nowPlaying!;
            playheadAt(600);
            expireSleepTimer();
            // The paused branch: nothing finished, so this is a viewer who fell
            // asleep mid-episode and is coming back to it.
            await store().sleepNow();
            expect(store().screen).toBe("blackout");

            await store().tune(channelId);
            expect(store().nowPlaying?.episode.id).toBe(first.episode.id);
            expect(store().nowPlaying?.resumeAtS).toBe(600);
        });
    });

    describe("inside a multipart arc", () => {
        beforeEach(() => {
            const ids = [1, 2, 3].map((episode) => insertEpisode(1, episode));
            insertArc("Awakening", ids);
            channelId = createChannel(db, "Test", 3).id;
            addChannelShow(db, channelId, showId);
            setChannelShowMode(db, channelId, showId, "sequential");
        });

        it("returns to the same part without advancing the arc lock", async () => {
            await store().tune(channelId);
            await store().advance(true);
            const partTwo = store().nowPlaying!;
            expect(partTwo.arc).toMatchObject({ partIndex: 2, partCount: 3 });
            // Part 2 was handed out, so the lock already points at Part 3.
            expect(getChannel(db, channelId)?.activePartIndex).toBe(2);

            playheadAt(500);
            await store().leavePlayer();
            await store().tune(channelId);

            const resumed = store().nowPlaying!;
            expect(resumed.episode.id).toBe(partTwo.episode.id);
            expect(resumed.resumeAtS).toBe(500);
            // Rebuilt by reading, not by handing anything out — so the banner
            // still says Part 2, and Part 3 has not been skipped.
            expect(resumed.arc).toMatchObject({ partIndex: 2, partCount: 3 });
            expect(getChannel(db, channelId)?.activePartIndex).toBe(2);
        });

        it("plays on to the next part when the resumed one ends", async () => {
            await store().tune(channelId);
            playheadAt(400);
            await store().leavePlayer();
            await store().tune(channelId);
            expect(store().nowPlaying?.arc).toMatchObject({ partIndex: 1 });

            await store().advance(true);
            expect(store().nowPlaying?.arc).toMatchObject({ partIndex: 2 });
        });
    });

    describe("reset progress", () => {
        beforeEach(() => sequentialChannel(6));

        it("clears the resume point for the show it resets", async () => {
            await store().tune(channelId);
            playheadAt(300);
            await store().leavePlayer();
            expect(getPlaybackState(db, channelId)).not.toBeNull();

            resetProgress(db, channelId, showId);

            // Rewinding a show to its pilot and then resuming the viewer halfway
            // through an episode would be the reset visibly not taking.
            expect(getPlaybackState(db, channelId)).toBeNull();
            await store().tune(channelId);
            expect(store().nowPlaying?.resumeAtS).toBe(0);
        });
    });
});
