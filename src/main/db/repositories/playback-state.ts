/**
 * Where each channel left off — every read and write of
 * `channel_playback_state` (docs/data-model.md).
 *
 * One row per channel: the episode that was on air and how far into it the
 * viewer got. Two writers, and the difference between them is the whole point
 * of this module:
 *
 * - **`setPlaybackEpisode`** runs when the scheduler hands out a pick. It is
 *   unconditional, because that pick supersedes whatever the row said.
 * - **`savePlaybackPosition`** runs on the renderer's autosave and at every
 *   graceful exit. It carries the episode it was measured against and refuses
 *   to write over a row that has already moved on, so a save still in flight
 *   across an episode boundary cannot wind the channel backwards.
 *
 * Positions are seconds, as the player counts them: the slot offset a URL seek
 * left behind plus the element's own `currentTime`.
 */

import type { Db } from "../index.js";

/** A channel's resume point. */
export interface PlaybackState {
    channelId: number;
    episodeId: number;
    positionS: number;
    /** Epoch ms of the last write. Recorded for debugging; resume never reads it. */
    updatedAt: number;
}

interface PlaybackStateRow {
    channel_id: number;
    episode_id: number;
    position_s: number;
    updated_at: number;
}

/** Null when the channel has never played anything, or was cleared. */
export function getPlaybackState(
    db: Db,
    channelId: number,
): PlaybackState | null {
    const row = db
        .prepare(`SELECT * FROM channel_playback_state WHERE channel_id = ?`)
        .get(channelId) as PlaybackStateRow | undefined;
    return row
        ? {
              channelId: row.channel_id,
              episodeId: row.episode_id,
              positionS: row.position_s,
              updatedAt: row.updated_at,
          }
        : null;
}

/**
 * Point the channel at a freshly handed-out episode, at the top.
 *
 * Called wherever the scheduler commits a pick — tune-in, advance, and the
 * promotion of a prewarmed standby — so a crash a second later still resumes
 * the episode that was genuinely on air rather than the one before it.
 */
export function setPlaybackEpisode(
    db: Db,
    channelId: number,
    episodeId: number,
): void {
    db.prepare(
        `INSERT INTO channel_playback_state (channel_id, episode_id, position_s, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT (channel_id)
     DO UPDATE SET episode_id = excluded.episode_id,
                   position_s = 0,
                   updated_at = excluded.updated_at`,
    ).run(channelId, episodeId, Date.now());
}

/**
 * Record the playhead.
 *
 * The `WHERE` on the conflict branch is the stale-write guard: a row naming a
 * different episode has already been moved on by a newer pick, and this save —
 * measured against the previous one — refuses rather than overwriting it.
 *
 * The insert branch is not redundant. `reportEnded` clears the row on the way
 * out of an episode, and the save that follows it in `leavePlayer` is what puts
 * the resume point back; without an insert, leaving would save nothing.
 */
export function savePlaybackPosition(
    db: Db,
    channelId: number,
    episodeId: number,
    positionS: number,
): void {
    // A NaN or negative position would sit in the row looking like a resume
    // point and send the next tune-in somewhere it cannot play from.
    if (!Number.isFinite(positionS) || positionS < 0) return;
    db.prepare(
        `INSERT INTO channel_playback_state (channel_id, episode_id, position_s, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (channel_id)
     DO UPDATE SET position_s = excluded.position_s,
                   updated_at = excluded.updated_at
              WHERE channel_playback_state.episode_id = excluded.episode_id`,
    ).run(channelId, episodeId, positionS, Date.now());
}

/**
 * Forget where a channel was.
 *
 * With an `episodeId`, only when the row still names it — the same guard
 * `savePlaybackPosition` applies, so a late report about a finished episode
 * cannot wipe the resume point a newer pick has already written.
 */
export function clearPlaybackState(
    db: Db,
    channelId: number,
    episodeId?: number,
): void {
    if (episodeId === undefined) {
        db.prepare(
            `DELETE FROM channel_playback_state WHERE channel_id = ?`,
        ).run(channelId);
        return;
    }
    db.prepare(
        `DELETE FROM channel_playback_state WHERE channel_id = ? AND episode_id = ?`,
    ).run(channelId, episodeId);
}

/**
 * Drop a resume point that belongs to one show — the playback half of "reset
 * progress".
 *
 * Scoped to the show rather than clearing the channel outright: resetting
 * *Gargoyles* on a channel that also airs *Batman* has nothing to say about a
 * Batman episode the viewer is halfway through.
 */
export function clearPlaybackStateForShow(
    db: Db,
    channelId: number,
    showId: number,
): void {
    db.prepare(
        `DELETE FROM channel_playback_state
      WHERE channel_id = ?
        AND episode_id IN (SELECT id FROM episodes WHERE show_id = ?)`,
    ).run(channelId, showId);
}
