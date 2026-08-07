/**
 * The SQLite schema (docs/data-model.md).
 *
 * Eight core tables plus two supporting ones (`scan_roots`, `unmatched_files`).
 * The important split: `channel_shows` is *configuration* (the lineup you built)
 * while `channel_show_state` is *progress* (cursors and shuffle bags) — so
 * "reset progress" never touches the lineup.
 *
 * Migrations are additive and keyed off `PRAGMA user_version`. To change the
 * schema, append a new entry to `MIGRATIONS`; never edit an existing one.
 */

/**
 * The video codecs migration 3 re-labels, frozen as literals.
 *
 * Deliberately *not* derived from `SUPPORTED_VIDEO_CODECS` in
 * `@shared/playback.js`: a migration's text is history, and building it from a
 * live constant means adding a codec there silently rewrites a migration that
 * has already run everywhere. Databases created after such an edit would take a
 * different path through history than databases that migrated before it.
 *
 * Adding a codec to the shared list is still all that's needed for new scans —
 * this list is only about what migration 3 did on the day it shipped.
 */
const MIGRATION_3_VIDEO_CODECS = ["h264", "avc1", "vp8", "vp9", "av1"];
const VIDEO_CODEC_SQL_LIST = MIGRATION_3_VIDEO_CODECS.map(
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
    // The audio-only transcode path (docs/playback.md, "The decision"). Every
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
    // (docs/playback.md, "The background measuring job"). Measuring costs a
    // real audio decode of the whole file, so the answer is stored rather than
    // derived: ffprobe cannot produce it, and no one is waiting minutes at
    // tune-in.
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
    // Hardware encode/decode (docs/playback.md, "Hardware encode & decode").
    // The old `hardwareEncode` boolean shipped visible-but-disabled and was
    // never read by anything, so it is always `false` where it exists; it is
    // replaced by `hardwareAccel`, a three-way choice of backend.
    //
    // Nothing is migrated *into* the new key: `getSettings` merges stored rows
    // over `DEFAULT_SETTINGS`, so an absent key already reads as 'software' — the
    // exact behaviour the dead toggle had. This only stops the stale row from
    // riding along in that spread forever.
    `
  DELETE FROM settings WHERE key = 'hardwareEncode';
  `,
    // -- 6 ---------------------------------------------------------------------
    //
    // An index for `play_log.episode_id`, which carries an ON DELETE CASCADE with
    // nothing behind it. SQLite has to find the referencing rows on every episode
    // delete, and without an index that is a full scan of the log *per row* — the
    // scanner's prune can delete hundreds in one pass after an unmounted root or a
    // renamed folder.
    //
    // The log is also the one table with no upper bound: a row per airing, forever,
    // and only `lastAired` ever reads it. Rows are tiny so this is not urgent, but
    // the index is what stops the growth being felt in the *delete* path.
    `
  CREATE INDEX IF NOT EXISTS idx_playlog_episode ON play_log(episode_id);
  `,
    // -- 7 ---------------------------------------------------------------------
    //
    // Where each channel left off (docs/playback.md, "Resuming a channel").
    //
    // The same split the rest of the channel model insists on, one level down:
    // `channel_show_state` is *scheduling* progress (which unit comes next),
    // this is *playback* progress (where inside the current one we are). They
    // are separate rows because they are reset by different gestures — "reset
    // progress" rewinds a show's cursor and must not also decide where the
    // channel resumes, and leaving mid-episode must not touch the cursor.
    //
    // Keyed by channel, not by episode: a channel resumes where *it* was, and
    // one episode may legitimately sit at two different positions on two
    // channels that both air the show. `ON DELETE CASCADE` on both sides means a
    // deleted channel takes its resume point with it and a pruned episode
    // retires the row rather than leaving it pointing at a file that is gone.
    `
  CREATE TABLE channel_playback_state (
    channel_id INTEGER PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    episode_id INTEGER NOT NULL    REFERENCES episodes(id) ON DELETE CASCADE,
    position_s REAL    NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX idx_playback_state_episode ON channel_playback_state(episode_id);
  `,
    // -- 8 ---------------------------------------------------------------------
    //
    // Provider metadata for show and episode *titles* (docs/library.md, "Show
    // metadata lookup"). A user picks a series on TVmaze and the provider's names
    // are stored here, joined to local files on (season, episode).
    //
    // New columns rather than overwrites of `shows.title`/`episodes.title`,
    // because those two are the scanner's: it rewrites them from the filename on
    // every pass, and the auto-arc heuristic reads `episodes.title` to find
    // `Part N` runs. Writing provider names into them would be clobbered by the
    // next rescan *and* would let "Awakening: Part One" invent an arc. So the
    // scanner keeps its columns, these are the lookup feature's, and the read
    // layer does `COALESCE(display_title, title)` — which is also why they are
    // excluded from both upsert `SET` lists in `repositories/library.ts`.
    //
    // All nullable with no backfill: every existing row is already in the "never
    // looked up" state, which is exactly what all-NULL means. `metadata_source`
    // exists so a second provider is a value rather than another migration, and
    // `metadata_id` is what makes Refresh a re-join instead of a re-search.
    //
    // `metadata_id` is TEXT even though TVmaze ids are integers — provider ids
    // are opaque strings as far as this app is concerned, and the next provider
    // may well not use numbers.
    `
  ALTER TABLE shows    ADD COLUMN display_title   TEXT;
  ALTER TABLE shows    ADD COLUMN metadata_source TEXT;
  ALTER TABLE shows    ADD COLUMN metadata_id     TEXT;
  ALTER TABLE episodes ADD COLUMN metadata_title  TEXT;
  `,
];
