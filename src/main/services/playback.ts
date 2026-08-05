/**
 * What a channel plays when you tune in — resume it, or draw a fresh pick
 * (docs/playback.md, "Resuming a channel").
 *
 * This is a decision, so it lives here rather than in the handler, and it is
 * built around one fact about the scheduler that makes the obvious
 * implementation wrong:
 *
 * **`pickNext` commits at hand-out time, not at completion.** The cursor
 * advance, the shuffle-bag pop, the arc lock and the play-log row all land in
 * one transaction the moment an episode is handed out — before a single frame
 * plays (docs/scheduler.md). So by the time a viewer leaves halfway through an
 * episode, the schedule has *already* moved past it.
 *
 * A resume that re-tuned through `pickNext` would therefore spend a second
 * schedule step and hand back a different episode than the one being resumed:
 * the sequential cursor would skip an episode, the shuffle bag would lose a
 * unit from its cycle, a three-parter would jump from Part 2 to Part 3, and the
 * play log would show two airings for one episode watched. The resume branch
 * below consequently does not call the scheduler at all — it returns the saved
 * episode, rebuilds its arc context by reading, and leaves every piece of
 * committed state exactly where the original hand-out left it.
 */

import type { NowPlaying } from "@shared/types.js";
import type { Db } from "../db/index.js";
import {
    clearPlaybackState,
    getPlaybackState,
    setPlaybackEpisode,
} from "../db/repositories/playback-state.js";
import { discardReserved, pickNext } from "../scheduler/scheduler.js";
import { buildUnits } from "../scheduler/units.js";
import { toEpisodeView } from "./channels.js";

/**
 * How close to the end a resume is allowed to land.
 *
 * Resuming *at* the end would play a frame and immediately advance, which is a
 * worse answer than the tail of the episode. Deliberately not a "close enough
 * to finished, pick something new" threshold: that would be a second rule about
 * when the schedule moves on, and the schedule already has one.
 */
const RESUME_TAIL_S = 5;

/** An episode to put on air, and where in it to start. */
export interface TunedIn {
    episodeId: number;
    arc: NowPlaying["arc"];
    /** Seconds into the episode to start at; 0 for a freshly picked one. */
    resumeAtS: number;
}

/**
 * Rebuild the arc context for an episode nobody is handing out.
 *
 * A resumed episode arrives without a `Pick`, but the Player still needs to
 * know it is Part 2 of 3 — the banner says so, and `endsPlayableUnit` reads it
 * to decide where the sleep timer may stop. Derived through `buildUnits` rather
 * than from the `episodes` columns directly so it agrees with the scheduler by
 * construction, including the rule that a one-part group is an arc for
 * bookkeeping but has nothing to protect (`planNext`).
 */
function arcContextFor(db: Db, episodeId: number): NowPlaying["arc"] {
    const row = db
        .prepare(`SELECT show_id AS showId FROM episodes WHERE id = ?`)
        .get(episodeId) as { showId: number } | undefined;
    if (!row) return null;
    const unit = buildUnits(db, row.showId).find((candidate) =>
        candidate.episodeIds.includes(episodeId),
    );
    if (unit?.kind !== "arc" || unit.episodeIds.length < 2) return null;
    return {
        title: unit.title,
        partIndex: unit.episodeIds.indexOf(episodeId) + 1,
        partCount: unit.episodeIds.length,
    };
}

/**
 * Where to actually start.
 *
 * Floored, because the offset the renderer displays has to match the `?t=` the
 * stream server was handed exactly, or the timecode reads fractionally wrong
 * for the rest of the episode. A runtime we do not know (0, an unprobed file)
 * resumes from the top rather than guessing.
 */
function resumeOffset(positionS: number, durationS: number): number {
    if (!Number.isFinite(positionS) || positionS <= 0) return 0;
    const latest = durationS - RESUME_TAIL_S;
    if (latest <= 0) return 0;
    return Math.floor(Math.min(positionS, latest));
}

/** Commit a pick and make it the channel's resume point, at the top. */
function freshPick(db: Db, channelId: number): TunedIn | null {
    const pick = pickNext(db, channelId);
    if (!pick) return null;
    setPlaybackEpisode(db, channelId, pick.episodeId);
    return { episodeId: pick.episodeId, arc: pick.arc, resumeAtS: 0 };
}

/**
 * Tune in: resume where this channel was, or draw its next pick.
 *
 * One transaction, so the pick and the resume point it implies land together —
 * a crash between them would leave the channel pointing at the episode
 * *before* the one the schedule had just committed.
 */
export function tuneIn(db: Db, channelId: number): TunedIn | null {
    return db.transaction((): TunedIn | null => {
        const saved = getPlaybackState(db, channelId);
        const episode = saved ? toEpisodeView(db, saved.episodeId) : null;

        if (saved && episode) {
            // Re-tuning supersedes any standby held for this channel: the
            // reservation was planned to follow an episode we are about to
            // restart, and promoting it later would air it out of order.
            discardReserved(db, channelId);
            return {
                episodeId: saved.episodeId,
                arc: arcContextFor(db, saved.episodeId),
                resumeAtS: resumeOffset(saved.positionS, episode.durationS),
            };
        }

        // A row naming an episode the library no longer has — pruned by a scan,
        // or regrouped out from under us. Retire it and fall through, which is
        // the same recovery a channel with no row at all gets.
        if (saved) clearPlaybackState(db, channelId);
        return freshPick(db, channelId);
    })();
}

/**
 * Advance — a skip, or an auto-advance with nothing prewarmed. Always a fresh
 * pick: the episode being left is over either way, and `reportEnded` has
 * already cleared its resume point.
 */
export function advanceChannel(db: Db, channelId: number): TunedIn | null {
    return db.transaction(() => freshPick(db, channelId))();
}

/**
 * The handoff landed: a prewarmed standby is on air, so it — and not the
 * episode it replaced — is where this channel now resumes.
 */
export function notePromoted(
    db: Db,
    channelId: number,
    episodeId: number,
): void {
    setPlaybackEpisode(db, channelId, episodeId);
}
