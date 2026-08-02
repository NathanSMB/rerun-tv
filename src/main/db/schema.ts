/**
 * The SQLite schema (plan §4).
 *
 * Eight core tables plus two supporting ones (`scan_roots`, `unmatched_files`).
 * The important split: `channel_shows` is *configuration* (the lineup you built)
 * while `channel_show_state` is *progress* (cursors and shuffle bags) — so
 * "reset progress" never touches the lineup.
 *
 * Migrations are additive and keyed off `PRAGMA user_version`. To change the
 * schema, append a new entry to `MIGRATIONS`; never edit an existing one.
 */

import { SUPPORTED_VIDEO_CODECS } from "@shared/playback.js";

/** `'h264','avc1',…` — the video codecs migration 3 re-labels, as a SQL list. */
const VIDEO_CODEC_SQL_LIST = SUPPORTED_VIDEO_CODECS.map(
    (codec) => `'${codec}'`,
).join(", ");

export const MIGRATIONS: string[] = [
    // -- 1 ---------------------------------------------------------------------
    `
  CREATE TABLE shows (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    folder_path TEXT    NOT NULL UNIQUE,
    added_at    INTEGER NOT NULL
  );

  CREATE TABLE part_groups (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    title   TEXT    NOT NULL,
    source  TEXT    NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual'))
  );

  CREATE TABLE episodes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id        INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
    season         INTEGER NOT NULL,
    episode        INTEGER NOT NULL,
    episode_end    INTEGER,
    title          TEXT,
    path           TEXT    NOT NULL UNIQUE,
    duration_s     REAL    NOT NULL DEFAULT 0,
    container      TEXT    NOT NULL DEFAULT 'unknown',
    vcodec         TEXT    NOT NULL DEFAULT 'unknown',
    acodec         TEXT    NOT NULL DEFAULT 'unknown',
    width          INTEGER,
    height         INTEGER,
    part_group_id  INTEGER REFERENCES part_groups(id) ON DELETE SET NULL,
    part_index     INTEGER,
    playback_path  TEXT    NOT NULL DEFAULT 'transcode'
                   CHECK (playback_path IN ('direct','remux','transcode')),
    mtime_ms       INTEGER NOT NULL DEFAULT 0,
    size_bytes     INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX idx_episodes_show   ON episodes(show_id, season, episode);
  CREATE INDEX idx_episodes_group  ON episodes(part_group_id, part_index);

  CREATE TABLE channels (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL,
    number            INTEGER NOT NULL UNIQUE,
    accent            TEXT,
    active_group_id   INTEGER REFERENCES part_groups(id) ON DELETE SET NULL,
    active_part_index INTEGER,
    sort_order        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE channel_shows (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    show_id    INTEGER NOT NULL REFERENCES shows(id)    ON DELETE CASCADE,
    mode       TEXT    NOT NULL DEFAULT 'shuffle' CHECK (mode IN ('sequential','shuffle')),
    weight     REAL    NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, show_id)
  );

  CREATE TABLE channel_show_state (
    channel_id        INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    show_id           INTEGER NOT NULL REFERENCES shows(id)    ON DELETE CASCADE,
    cursor_unit_index INTEGER NOT NULL DEFAULT 0,
    shuffle_bag       TEXT    NOT NULL DEFAULT '[]',
    PRIMARY KEY (channel_id, show_id)
  );

  CREATE TABLE play_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id)  ON DELETE CASCADE,
    episode_id INTEGER NOT NULL REFERENCES episodes(id)  ON DELETE CASCADE,
    at         INTEGER NOT NULL,
    completed  INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX idx_playlog_channel ON play_log(channel_id, at DESC);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE scan_roots (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    path     TEXT    NOT NULL UNIQUE,
    added_at INTEGER NOT NULL
  );

  CREATE TABLE unmatched_files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT    NOT NULL UNIQUE,
    reason     TEXT    NOT NULL DEFAULT 'unparsed',
    mtime_ms   INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL DEFAULT 0
  );
  `,
    // -- 2 ---------------------------------------------------------------------
    `
  CREATE TABLE channel_show_season_modes (
    channel_id INTEGER NOT NULL,
    show_id    INTEGER NOT NULL,
    season     INTEGER NOT NULL,
    mode       TEXT    NOT NULL CHECK (mode IN ('sequential','shuffle')),
    PRIMARY KEY (channel_id, show_id, season),
    FOREIGN KEY (channel_id, show_id)
      REFERENCES channel_shows(channel_id, show_id) ON DELETE CASCADE
  );
  `,
    // -- 3 ---------------------------------------------------------------------
    //
    // The audio-only transcode path (docs/stall-fix-plan.html, phase 1). Every
    // file whose *video* Chromium can decode now goes down the remux pipe, where
    // the video is a byte copy and only the audio is encoded. Previously an AC3
    // soundtrack dragged a perfectly playable H.264 stream onto libx264 — which
    // is what turned a dropped connection into a minute of dead air.
    //
    // Re-derived here rather than left to the next rescan, because a rescan
    // re-probes hundreds of files to reach the same answer this UPDATE knows
    // already. 'remux' is an existing member of the CHECK constraint, so there is
    // no table rebuild, and a later full rescan produces identical labels.
    `
  UPDATE episodes
     SET playback_path = 'remux'
   WHERE playback_path = 'transcode'
     AND LOWER(vcodec) IN (${VIDEO_CODEC_SQL_LIST});
  `,
    // -- 4 ---------------------------------------------------------------------
    //
    // Cached EBU R128 loudness, for the equalization setting
    // (docs/loudness-equalization-plan.html, phase 2). Measuring costs a real
    // audio decode of the whole file, so the answer is stored rather than derived:
    // ffprobe cannot produce it, and no one is waiting minutes at tune-in.
    //
    // Nullable with no default, because "not measured yet" is a state the player
    // has to handle anyway — a library only fills in over time, and until a row is
    // filled the filter chain simply runs without its pre-gain.
    //
    // `loudness_scanned_at` is separate from the values on purpose: it records
    // that we *tried*, so a genuinely silent episode (which measures as `-inf` and
    // stores nulls) is never queued again.
    `
  ALTER TABLE episodes ADD COLUMN loudness_i          REAL;
  ALTER TABLE episodes ADD COLUMN loudness_tp         REAL;
  ALTER TABLE episodes ADD COLUMN loudness_lra        REAL;
  ALTER TABLE episodes ADD COLUMN loudness_thresh     REAL;
  ALTER TABLE episodes ADD COLUMN loudness_scanned_at INTEGER;
  `,
    // -- 5 ---------------------------------------------------------------------
    //
    // Hardware encode/decode (docs/hwaccel-plan.html). The old `hardwareEncode`
    // boolean shipped visible-but-disabled and was never read by anything, so it
    // is always `false` where it exists; it is replaced by `hardwareAccel`, a
    // three-way choice of backend.
    //
    // Nothing is migrated *into* the new key: `getSettings` merges stored rows
    // over `DEFAULT_SETTINGS`, so an absent key already reads as 'software' — the
    // exact behaviour the dead toggle had. This only stops the stale row from
    // riding along in that spread forever.
    `
  DELETE FROM settings WHERE key = 'hardwareEncode';
  `,
];
