/**
 * Fixtures for the renderer harness: the view models the Player reads, and a
 * scripted preload bridge over a fixed deck of episodes.
 *
 * The bridge sits at the same `RerunApi` seam `handoff.test.ts` already fakes,
 * but it is deliberately SQLite-free and re-stated here rather than shared.
 * What the scheduler *picks* is that suite's question, over the real database;
 * this layer's question is which store action the Player invokes, and running a
 * second copy of the scheduler here would blur both. It is also what keeps
 * these files ownable by `tsconfig.web.json`, which has no Node types.
 */

import type { RerunApi } from "@shared/ipc.js";
import type { EpisodeView, NowPlaying } from "@shared/types.js";
import { useStore } from "../../src/renderer/src/store.js";
import { makeBridge } from "./bridge.js";

export const CHANNEL_ID = 7;
export const CHANNEL_NUMBER = 3;
/** 22 minutes — the same runtime `handoff.test.ts` gives its fixtures. */
export const EPISODE_DURATION_S = 1320;

/**
 * One call the store made across the bridge.
 *
 * `peekNext` is deliberately not logged: it commits nothing, the store calls it
 * after every transition, and it would drown the assertions that matter.
 */
export type BridgeCall =
    | { call: "tune"; channelId: number }
    | { call: "next"; channelId: number }
    | { call: "prewarmNext"; channelId: number }
    | { call: "promoteNext"; channelId: number; episodeId: number }
    | {
          call: "reportEnded";
          channelId: number;
          episodeId: number;
          completed: boolean;
      }
    | {
          call: "savePosition";
          channelId: number;
          episodeId: number;
          positionS: number;
      }
    | { call: "release"; channelId: number; episodeId: number | null };

export interface ScriptedBridge {
    api: RerunApi;
    calls: BridgeCall[];
}

function episodeView(
    index: number,
    playbackPath: EpisodeView["playbackPath"] = "remux",
): EpisodeView {
    const episode = index + 1;
    return {
        id: 100 + episode,
        showId: 1,
        showTitle: "Gargoyles",
        season: 1,
        episode,
        episodeEnd: null,
        title: `Episode ${episode}`,
        code: `S01E${String(episode).padStart(2, "0")}`,
        durationS: EPISODE_DURATION_S,
        // Defaults to the majority path in a real library, and the one that
        // cannot be seeked natively — so the Player's URL-reload seek is what is
        // under test unless a fixture asks for `direct`.
        playbackPath,
    };
}

function playing(
    episode: EpisodeView,
    arc: NowPlaying["arc"],
    resumeAtS = 0,
): NowPlaying {
    return {
        channelId: CHANNEL_ID,
        channelNumber: CHANNEL_NUMBER,
        channelName: "Test",
        episode,
        streamUrl:
            `http://127.0.0.1:9/stream/${episode.id}?ch=${CHANNEL_ID}` +
            // What `toNowPlaying` mints: a resumed *piped* episode carries its
            // seek in the URL, and the slot's offset has to agree with it. A
            // `direct` one never does — `serveFile` ignores `?t=`.
            (resumeAtS > 0 && episode.playbackPath !== "direct"
                ? `&t=${resumeAtS}`
                : ""),
        resumeAtS,
        arc,
    };
}

/** `count` standalone episodes in airing order — each one ends its own unit. */
export function standaloneDeck(count: number): NowPlaying[] {
    return Array.from({ length: count }, (_, index) =>
        playing(episodeView(index), null),
    );
}

/**
 * The same deck, but tuning in lands partway through the first episode — what
 * the main process hands back when a channel is resumed
 * (docs/playback.md, "Resuming a channel"). Only the first: everything after it
 * is a fresh pick and starts at the top.
 *
 * `playbackPath` is the axis that matters here, because the two paths resume by
 * different mechanisms. A piped episode arrives already positioned (its `?t=`
 * restarted ffmpeg at the offset, and the slot carries that offset for
 * display); a `direct` file arrives at zero and the Player has to seek the
 * element itself.
 */
export function resumedDeck(
    count: number,
    resumeAtS: number,
    playbackPath: EpisodeView["playbackPath"] = "remux",
): NowPlaying[] {
    return Array.from({ length: count }, (_, index) =>
        playing(
            episodeView(index, playbackPath),
            null,
            index === 0 ? resumeAtS : 0,
        ),
    );
}

/**
 * One multipart arc, in order. Only the final part ends the playable unit, so
 * everything before it is a boundary the sleep timer must play straight through.
 */
export function arcDeck(partCount: number, title = "Awakening"): NowPlaying[] {
    return Array.from({ length: partCount }, (_, index) =>
        playing(episodeView(index), { title, partIndex: index + 1, partCount }),
    );
}

/**
 * The preload bridge over a fixed deck.
 *
 * The one piece of scheduler behaviour it keeps is the distinction the whole
 * handoff rests on: `prewarmNext` **reserves** the next pick without spending
 * it, and only `promoteNext` commits it. Promoting an episode other than the
 * reserved one throws rather than quietly re-ordering the deck, so a Player that
 * drove the transition wrongly fails here instead of passing on a coincidence.
 */
export function scriptedBridge(deck: NowPlaying[]): ScriptedBridge {
    const calls: BridgeCall[] = [];
    /** How many picks the schedule has spent. A reservation does not move it. */
    let aired = 0;

    const commit = (): NowPlaying | null => {
        const pick = deck[aired] ?? null;
        if (pick) aired += 1;
        return pick;
    };

    const player: RerunApi["player"] = {
        tune: async (channelId) => {
            calls.push({ call: "tune", channelId });
            return commit();
        },
        next: async (channelId) => {
            calls.push({ call: "next", channelId });
            return commit();
        },
        prewarmNext: async (channelId) => {
            calls.push({ call: "prewarmNext", channelId });
            return deck[aired] ?? null;
        },
        promoteNext: async (channelId, episodeId) => {
            calls.push({ call: "promoteNext", channelId, episodeId });
            const reserved = deck[aired]?.episode.id;
            if (reserved !== episodeId) {
                throw new Error(
                    `promoteNext(${episodeId}) but the reservation was ${reserved}`,
                );
            }
            aired += 1;
        },
        peekNext: async () => deck[aired]?.episode ?? null,
        reportEnded: async (channelId, episodeId, completed) => {
            calls.push({
                call: "reportEnded",
                channelId,
                episodeId,
                completed,
            });
        },
        savePosition: async (channelId, episodeId, positionS) => {
            calls.push({
                call: "savePosition",
                channelId,
                episodeId,
                positionS,
            });
        },
        release: async (channelId, episodeId) => {
            calls.push({
                call: "release",
                channelId,
                episodeId: episodeId ?? null,
            });
        },
    };

    // Only what the playback path touches. Everything else `makeBridge` fills
    // with a thrower, so a store that has drifted into reaching further fails
    // loudly here instead of passing against a fake that quietly grew a method.
    const api = makeBridge({
        player,
        channels: { list: async () => [] },
        settings: { set: async () => useStore.getState().settings },
    });

    return { api, calls };
}

/** The play-log shape: what each episode was reported as, in order. */
export function reportedEnds(
    calls: BridgeCall[],
): Array<{ episodeId: number; completed: boolean }> {
    return calls.flatMap((entry) =>
        entry.call === "reportEnded"
            ? [{ episodeId: entry.episodeId, completed: entry.completed }]
            : [],
    );
}
