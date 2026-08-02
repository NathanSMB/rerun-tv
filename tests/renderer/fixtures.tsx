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
    | { call: "release"; channelId: number; episodeId: number | null };

export interface ScriptedBridge {
    api: RerunApi;
    calls: BridgeCall[];
}

function episodeView(index: number): EpisodeView {
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
        // The majority path in a real library, and the one that cannot be seeked
        // natively — so the Player's URL-reload seek is the one under test.
        playbackPath: "remux",
    };
}

function playing(episode: EpisodeView, arc: NowPlaying["arc"]): NowPlaying {
    return {
        channelId: CHANNEL_ID,
        channelNumber: CHANNEL_NUMBER,
        channelName: "Test",
        episode,
        streamUrl: `http://127.0.0.1:9/stream/${episode.id}?ch=${CHANNEL_ID}`,
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
        release: async (channelId, episodeId) => {
            calls.push({
                call: "release",
                channelId,
                episodeId: episodeId ?? null,
            });
        },
    };

    // Only what the playback path touches, as a partial object cast: anything else
    // the store reaches for fails loudly as a TypeError, which is what we want
    // from a test that has drifted out of date.
    const api = {
        player,
        channels: { list: async () => [] },
        settings: { set: async () => useStore.getState().settings },
    } as unknown as RerunApi;

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
