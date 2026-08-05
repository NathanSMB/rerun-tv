# Data model

One SQLite file at `~/.local/share/rerun-tv/library.db`, WAL mode, foreign keys
on. The schema lives in `src/main/db/schema.ts` as an append-only list of
migrations keyed off `PRAGMA user_version`. All SQL lives in
`src/main/db/repositories/`, which camel-cases rows into the interfaces in
`src/shared/types.ts` — no snake_case ever reaches the renderer.

Everything the app knows except the media files is in this one file, which is
what makes [backing it up and putting it back](backup-restore.md) a complete
answer rather than half of one.

```
shows ─1:many─ episodes ─0:1─ part_groups          channels ─1:many─ channel_shows
                                                       │                  │
                                                       │              (lineup:
                                                       │               mode, weight)
                                                       │                  │
                                                       │                  ├─ channel_show_season_modes
                                                       │                  │   (per-season mode override)
                                                       │                  │
                                                       │                  └─ channel_show_state
                                                       │                      (cursor, bag)
                                                       └─1:many─ play_log

settings (k/v)      scan_roots      unmatched_files
```

## The migrations, so far

Append-only: add an entry, never edit one that has shipped, and never build one
out of a live constant (migration 3 freezes its codec list as literals for exactly
that reason — a migration's text is history, and a database created after such an
edit would take a different path through it than one that migrated before).

| | |
| --- | --- |
| 1 | The ten tables above |
| 2 | `channel_show_season_modes` — per-season mode overrides |
| 3 | Re-derive `playback_path` for the audio-only transcode split, in one `UPDATE` rather than a rescan |
| 4 | The five `loudness_*` columns on `episodes` |
| 5 | Delete the dead `hardwareEncode` settings row, replaced by `hardwareAccel` |
| 6 | An index on `play_log(episode_id)` |

Note what 5 does *not* do: nothing is migrated *into* the new key. `getSettings`
merges stored rows over `DEFAULT_SETTINGS`, so an absent key already reads as the
default — the migration only stops a stale row riding along in that spread
forever. Every settings change works this way, which is why the settings table
needs a migration roughly never.

## The tables

### `shows`
`id · title · folder_path (unique) · added_at`

One row per top-level folder under a scan root. `folder_path` is the identity —
renaming the folder creates a new show, which is the behaviour you want, since
the folder name *is* the show name.

### `episodes`
`id · show_id · season · episode · episode_end · title · path (unique) ·
duration_s · container · vcodec · acodec · width · height · part_group_id ·
part_index · playback_path · mtime_ms · size_bytes · loudness_i · loudness_tp ·
loudness_lra · loudness_thresh · loudness_scanned_at`

- `episode_end` is non-null only for a file holding a double episode
  (`S01E03-E04`), so `episodeCode()` can render `S01E03-E04`.
- `playback_path` is `direct | remux | transcode`, **decided once at scan time**
  from the probed codecs. This is what makes tune-in instant: nothing is probed
  when a channel changes. It's also what the Library screen's DIRECT/REMUX/
  TRANSCODE tags count.
- `mtime_ms` + `size_bytes` are the **rescan key**. A file whose mtime and size
  are unchanged is skipped without spawning ffprobe, which is what makes a
  rescan of a large library cheap.
- `part_group_id` / `part_index` are arc membership. Null for a standalone
  episode; `part_index` is 1-based within the arc.
- The five `loudness_*` columns cache one EBU R128 measurement, filled in by a
  background job rather than by the scanner (ffprobe cannot produce them, and
  nobody is waiting minutes at tune-in). All nullable with no default, because
  "not measured yet" is a state the player has to handle anyway. `scanned_at` is
  separate from the values on purpose: it records that we *tried*, so a genuinely
  silent episode — which measures as `-inf` and stores nulls — is never queued
  again. They are the one set of columns `upsertEpisode` protects conditionally:
  invalidated only when the mtime/size pair actually moved, so a full rescan
  doesn't throw away hours of measuring to learn nothing. See
  [playback.md](playback.md#loudness-equalization).

### `part_groups` (arcs)
`id · show_id · title · source`

`source` is `auto` (the Part-N heuristic) or `manual` (you grouped it in the
Library screen). The distinction matters at rescan: auto arcs are recomputed
from scratch, manual arcs are never touched. **This table is the source of
truth the scheduler obeys** — the heuristic is only a head start.

### `channels`
`id · name · number (unique) · accent · active_group_id · active_part_index ·
sort_order`

`active_group_id` / `active_part_index` are the **arc lock**. While they're set,
the channel is airing a multipart arc and nothing may interrupt it. They're
validated (and cleared if stale) at tune-in, so a crash mid-arc can't wedge a
channel — see [architecture.md](architecture.md#risks-and-what-answers-them).

`number` is the dial number the guide renders at 44px; `sort_order` is the
drag-reorder position, kept separate so you can reorder the guide without
renumbering channels.

### `channel_shows` — configuration
`channel_id · show_id · mode · weight · sort_order`

The lineup you built. `mode` is `sequential | shuffle`; `weight` is the lottery
weight (a show with weight 2 is drawn twice as often).

### `channel_show_season_modes` — per-season overrides
`channel_id · show_id · season · mode`

Also configuration. **Absence is the default**: a season with no row here
inherits `channel_shows.mode`, so an untouched show behaves exactly as it did
before this table existed and "inherit" is never a value that has to be stored.
Rows cascade away with the lineup entry, so dropping a show from a channel takes
its overrides with it.

This is what lets one channel run *The Simpsons* seasons 1–8 in order while the
rest of the show shuffles. The override is per **channel**, not per show — the
same show can be ordered on one channel and shuffled on another, which is the
whole point of keeping it out of `shows`.

Note the granularity mismatch this table has with the scheduler: overrides are
keyed by season, but the scheduler picks *units*, and a cross-season arc is one
unit belonging to the season of its first part. A season whose every episode
sits in such an arc contributes no unit of its own, so its override has nothing
to apply to. `planShowModes()` in `scheduler.ts` is the single place that
resolves this, precisely so the editor and the scheduler cannot disagree about
it — see [scheduler.md](scheduler.md).

### `channel_show_state` — progress
`channel_id · show_id · cursor_unit_index · shuffle_bag`

Deliberately a **separate table** from the lineup. Cursors and shuffle bags are
progress, not configuration, so "reset progress" is a delete on this table and
never risks touching what you built. `shuffle_bag` is a JSON array of *unit
keys* (see [scheduler.md](scheduler.md)).

### `channel_playback_state` — where the channel is
`channel_id · episode_id · position_s · updated_at`

One row per channel: the episode on air and how far into it the viewer got, so
tuning back in is continuous ([playback.md](playback.md#resuming-a-channel)).

The same split one level down. `channel_show_state` is *scheduling* progress —
which unit comes next — while this is *playback* progress: where inside the
current one we are. They are separate rows because different gestures reset
them. "Reset progress" rewinds a show's cursor and clears any resume point
belonging to that show, while leaving mid-episode writes here and must not
disturb a cursor at all.

Keyed by channel rather than by episode, because a channel resumes where *it*
was: the same episode may legitimately sit at two positions on two channels that
both air the show. Both foreign keys cascade, so a deleted channel takes its
resume point with it and a pruned episode retires the row instead of leaving it
pointing at a file that is gone. Migration 7.

### `play_log`
`id · channel_id · episode_id · at · completed`

Every airing. `completed` distinguishes "watched to the end" from "you tuned
away" — the MVP uses it only for honesty, but combined with `episodes.duration_s`
it's exactly what a post-MVP simulated-live schedule needs, which is why both
are recorded now.

The distinction is easy to break by accident and hard to notice: falling asleep
at the end of an episode records `true` (it finished), while leaving, skipping,
or a timer expiring while paused records `false`. See
[playback.md](playback.md#two-things-chromium-does-around-ended) for the Chromium
event ordering that got this backwards once.

This is the one table with no upper bound — a row per airing, forever — and only
`lastAired` ever reads it. Rows are tiny, so the growth is not the problem; the
*delete* path was. `episode_id` carries an `ON DELETE CASCADE` with nothing behind
it, so SQLite had to find the referencing rows on every episode delete, and
without an index that is a full scan of the log **per row** — and the scanner's
prune can delete hundreds in one pass after an unmounted root or a renamed
folder. Migration 6 is the index that stops it.

### `settings`
`key · value` — JSON-encoded values, merged over `DEFAULT_SETTINGS` on read so a
key added in a later version needs no migration. Every knob the app exposes is a
row here; there are no config files.

One row isn't a knob: `lastRestore` records where this database came from if it
arrived via an import, and is written outside `AppSettings` so that type stays a
list of things a user can actually set. See
[backup-restore.md](backup-restore.md).

### `scan_roots`
`id · path (unique) · added_at` — the library folders from Settings.

### `unmatched_files`
`id · path (unique) · reason · mtime_ms · size_bytes`

Files the parser couldn't read. They wait here for manual assignment instead of
silently disappearing, and the rest of the show keeps scheduling normally.

## The key abstraction: the playable unit

Not a table — a derived structure, built by `src/main/scheduler/units.ts`:

> A unit is either a standalone episode or an entire multipart arc. Cursors,
> shuffle bags and the weighted lottery all operate on units, never on raw
> episodes.

This one decision is what makes arcs uninterruptible *and* exactly as likely to
air as any single episode. It falls out of the model instead of being
special-cased. See [scheduler.md](scheduler.md).
