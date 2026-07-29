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
  `
]
