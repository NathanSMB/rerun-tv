# Data model

One SQLite file at `~/.local/share/rerun-tv/library.db`, WAL mode, foreign keys
on. The schema lives in `src/main/db/schema.ts` as an append-only list of
migrations keyed off `PRAGMA user_version`. All SQL lives in
`src/main/db/repositories/`, which camel-cases rows into the interfaces in
`src/shared/types.ts` — no snake_case ever reaches the renderer.

```
shows ─1:many─ episodes ─0:1─ part_groups          channels ─1:many─ channel_shows
                                                       │                  │
                                                       │              (lineup:
                                                       │               mode, weight)
                                                       │                  │
                                                       │           channel_show_state
                                                       │            (cursor, bag)
                                                       └─1:many─ play_log

settings (k/v)      scan_roots      unmatched_files
```

## The tables

### `shows`
`id · title · folder_path (unique) · added_at`

One row per top-level folder under a scan root. `folder_path` is the identity —
renaming the folder creates a new show, which is the behaviour you want, since
the folder name *is* the show name.

### `episodes`
`id · show_id · season · episode · episode_end · title · path (unique) ·
duration_s · container · vcodec · acodec · width · height · part_group_id ·
part_index · playback_path · mtime_ms · size_bytes`

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
channel — plan §10.

`number` is the dial number the guide renders at 44px; `sort_order` is the
drag-reorder position, kept separate so you can reorder the guide without
renumbering channels.

### `channel_shows` — configuration
`channel_id · show_id · mode · weight · sort_order`

The lineup you built. `mode` is `sequential | shuffle`; `weight` is the lottery
weight (a show with weight 2 is drawn twice as often).

### `channel_show_state` — progress
`channel_id · show_id · cursor_unit_index · shuffle_bag`

Deliberately a **separate table** from the lineup. Cursors and shuffle bags are
progress, not configuration, so "reset progress" is a delete on this table and
never risks touching what you built. `shuffle_bag` is a JSON array of *unit
keys* (see [scheduler.md](scheduler.md)).

### `play_log`
`id · channel_id · episode_id · at · completed`

Every airing. `completed` distinguishes "watched to the end" from "you tuned
away" — the MVP uses it only for honesty, but combined with `episodes.duration_s`
it's exactly what a post-MVP simulated-live schedule needs, which is why both
are recorded now.

### `settings`
`key · value` — JSON-encoded values, merged over `DEFAULT_SETTINGS` on read so a
key added in a later version needs no migration. Every knob the app exposes is a
row here; there are no config files.

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
