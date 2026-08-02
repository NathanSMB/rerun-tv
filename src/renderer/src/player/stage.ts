/**
 * The stage: which of the two video surfaces is on air, and what each holds.
 *
 * Pure and DOM-free, and in its own module for the same reason `mse.ts` and
 * `pip.ts` are: the interesting part of a handoff is a state transition, and a
 * state transition is far easier to trust when it can be asserted directly
 * rather than inferred from what two `<video>` elements did.
 *
 * The whole double-buffering idea lives in `reconcile` and `mirrorPending`:
 * the standby surface quietly buffers the next episode, and a handoff is then a
 * *flip* of which surface is on top — no load, no black frame. Everything that
 * touches an actual element stays in `Player.tsx`.
 */

import type { NowPlaying, PlaybackPath } from "@shared/types.js";

/** What to play. `key` changes exactly when a fresh stream must be opened. */
export interface VideoSource {
    /** Identity of this stream: `<episodeId>@<offset>`, bumped by a seek. */
    key: string;
    url: string;
    playbackPath: PlaybackPath;
    /**
     * The MSE timeline's length: episode runtime *minus the seek offset*, because
     * an `-ss` seek restarts the pipe's timestamps at zero.
     */
    durationS: number;
}

/** Which of the two surfaces we mean. */
export type SlotId = "a" | "b";

/** What one surface is playing, plus the display offset a URL-seek left behind. */
export interface Slot {
    episodeId: number;
    url: string;
    /** Seconds the stream was started at; added to `currentTime` for display. */
    offset: number;
    source: VideoSource;
}

export interface StageState {
    active: SlotId;
    a: Slot | null;
    b: Slot | null;
    /** Per-slot reload counter: Retry re-opens one stream without touching the other. */
    generation: { a: number; b: number };
}

export const other = (slot: SlotId): SlotId => (slot === "a" ? "b" : "a");

export function slotFor(playing: NowPlaying, offset = 0, url?: string): Slot {
    const streamUrl = url ?? playing.streamUrl;
    return {
        episodeId: playing.episode.id,
        url: streamUrl,
        offset,
        source: {
            // Identity of the stream, not of the episode: a seek must open a new one.
            key: `${playing.episode.id}@${offset}`,
            url: streamUrl,
            playbackPath: playing.episode.playbackPath,
            // What is left of the episode from where this stream starts — the pipe's
            // own timestamps restart at zero after an `-ss` seek.
            durationS: Math.max(1, playing.episode.durationS - offset),
        },
    };
}

export function writeSlot(
    stage: StageState,
    slot: SlotId,
    value: Slot | null,
): StageState {
    return slot === "a" ? { ...stage, a: value } : { ...stage, b: value };
}

export const EMPTY_STAGE: StageState = {
    active: "a",
    a: null,
    b: null,
    generation: { a: 0, b: 0 },
};

/**
 * Fold a new `nowPlaying` into the stage.
 *
 * The important branch is the first one: when the standby already holds the
 * episode the store just promoted, the handoff is a *flip* — the element keeps
 * its buffer and its ffmpeg, and playback starts on the next frame. Anything
 * else is an ordinary load into the active surface, which also discards a
 * standby that is now stale (a skip mid-prewarm, say).
 */
export function reconcile(
    stage: StageState,
    playing: NowPlaying | null,
): StageState {
    if (playing === null)
        return {
            ...EMPTY_STAGE,
            active: stage.active,
            generation: stage.generation,
        };

    const standbySlot = other(stage.active);
    const standby = stage[standbySlot];
    if (standby !== null && standby.episodeId === playing.episode.id) {
        return writeSlot({ ...stage, active: standbySlot }, stage.active, null);
    }
    return writeSlot(
        writeSlot(stage, stage.active, slotFor(playing)),
        standbySlot,
        null,
    );
}

/**
 * Fold the store's pending pick into the standby surface, or clear it.
 *
 * Separate from `reconcile` because it answers a different question: not "what
 * is on air" but "what should be quietly buffering behind it".
 */
export function mirrorPending(
    stage: StageState,
    pendingNext: NowPlaying | null,
): StageState {
    const slot = other(stage.active);
    const clear = stage[slot] === null ? stage : writeSlot(stage, slot, null);
    if (pendingNext === null) return clear;

    /**
     * A channel whose lineup has exactly one playable unit picks the episode it
     * is already playing. There is nothing to prewarm — and worse, the standby
     * would request the same stream URL on the same channel, which is the same
     * encoder slot, and taking that slot would kill the stream on screen. The
     * handoff for this case is an ordinary reload, which costs tune-in latency
     * on a channel with one episode in it. Fine.
     */
    if (pendingNext.episode.id === stage[stage.active]?.episodeId) return clear;

    if (stage[slot]?.episodeId === pendingNext.episode.id) return stage;
    return writeSlot(stage, slot, slotFor(pendingNext));
}
