# The library: scanning, parsing, arcs

`src/main/library/`.

You add one or more root folders in Settings. The scanner walks them, parses
filenames, probes each file with ffprobe, and writes the result to SQLite.

## Incremental by construction

Files are keyed by `path` + `mtime_ms` + `size_bytes`. A file whose mtime and
size are unchanged is skipped **without spawning ffprobe** — which is the whole
cost of a scan. A rescan of a large library only touches what changed, and the
Library screen says so: *912 of 1,482 files probed · 37 new since last scan ·
unchanged files skipped*.

`rescan(full: true)` from Settings → *Rescan everything* ignores the key and
re-probes unconditionally, for when a file was replaced in place.

The scan runs in two phases so the progress bar is honest: walk every root to
count candidates (`total`), then process them (`done`). Progress is throttled
before it crosses IPC so a fast local disk doesn't flood the renderer.

`pause()` stops the loop between files; `resume()` continues the same pass.

## Filename parsing

`parse.ts`. The MVP grammar:

| Form | Example |
| --- | --- |
| `SxxExx` | `Gargoyles - S01E03 - Enter Macbeth.mkv` |
| `NxNN` | `Gargoyles - 1x03.mkv` |
| Double episodes | `S01E03-E04`, `S01E03E04`, `S01E03-S01E04` |

Case-insensitive. The **show name comes from the top-level folder** under the
scan root, not the filename — `~/TV/Gargoyles/Season 01/…` is *Gargoyles* — with
a trailing year stripped. The **episode title** is whatever trails the episode
code, cleaned of separators and release junk (resolution, codec and group tags),
or null if nothing meaningful remains. The scanner never goes to the network:
numbering always comes from the filename, and better titles are a separate,
manual step (below).

## Metadata lookup

`src/main/services/metadata.ts`. Release-style filenames like
`Gargoyles.S01E05.DVDRip.mkv` carry no title at all, so a show can be linked by
hand to a TVmaze series and borrow its titles. **Titles only** — artwork,
descriptions and air dates stay out of scope.

The flow is three steps, from the metadata card in the Library aside:

1. **Search.** Type a few characters; a debounced, single-flight
   `library.searchMetadata` returns candidates with year, network and status,
   which is what tells *Gargoyles* (1994) from *The Goliath Chronicles* (1996).
2. **Preview.** Picking a candidate calls `library.previewMetadata`, which
   fetches the provider's episode list and joins it against the local episodes
   on `(season, episode)` — the numbers the scanner already parsed. It returns a
   plan and **writes nothing**: the new display title, the title each episode
   would get, and counts of matched / multi-episode / unmatched files. A file
   spanning `S01E05-E06` takes both names joined with `" / "`; a file with no
   provider entry at its number is simply left alone.
3. **Apply.** `library.applyMetadata` writes back the plan the user just looked
   at, in one transaction, and broadcasts `libraryChanged`. No refetch in
   between, so what was previewed is exactly what lands. Apply needs no network,
   so a preview already on screen can always be committed.

The link is remembered (`shows.metadata_source` + `metadata_id`), which makes the
two follow-up actions cheap. **Refresh** re-runs preview + apply against the
stored id — the way episodes scanned after a lookup get their titles, since
scans stay offline and never fetch on their own. **Unlink** is total: all four
metadata columns go null and every title reverts to exactly what the scanner
named, with no partial states in between.

Because it lands in its own columns, a rescan cannot clobber a lookup and a
lookup cannot disturb the scanner — including **auto arc detection, which still
reads the scanner's `episodes.title`** and is therefore provably unaffected by
any provider title. See [data-model.md](data-model.md#episodes) and
[metadata-lookup-plan.html](metadata-lookup-plan.html).

## The Unmatched bucket

A file that doesn't parse lands in `unmatched_files` and shows up in the Library
screen's *Unmatched — N files waiting for a home* queue, where you assign it a
show, season and episode by hand. It is never silently dropped, and it never
blocks the rest of the show from airing — that is the whole mitigation for
"filename chaos in real libraries"
([architecture.md](architecture.md#risks-and-what-answers-them)). The parser
grammar can then grow case by case without anything being lost in the meantime.

## Arc detection

`arcs.ts`. The auto-grouping heuristic: **consecutive** episodes (same season,
contiguous numbers) whose titles match `Part N` / `(N)` / `Pt. N` — including
spelled-out numbers — with the same stem become an arc.

*The Gathering — Part 1* + *The Gathering — Part 2* → an arc titled **The
Gathering**. Parts must number 1..N in order with no gaps, and a run of one is
not an arc.

The heuristic is **only a head start**. `part_groups` is the source of truth,
and the Library screen lets you ungroup a false positive or hand-group any two
or more episodes, including non-consecutive and cross-season parts. Manual arcs
play in normal season/episode order. At rescan, auto arcs are recomputed from
scratch and **manual arcs are never touched** — an episode already in a manual
arc is left alone.

Arcs are why the scheduler needs playable units; see [scheduler.md](scheduler.md).

## ffprobe at scan time

`ffprobe.ts` spawns `ffprobe -v error -print_format json -show_format
-show_streams` once per new or changed file and stores duration, container,
codec pair and dimensions. Two things fall out of that:

1. `decidePlaybackPath()` runs immediately and its answer is stored, which is
   what makes the playback decision instant at tune-in ([playback.md](playback.md)).
2. Durations are recorded for every episode — which is exactly what a post-MVP
   simulated-live schedule will need, at no extra cost now.

## Watching

With *Watch folders for new episodes* on, chokidar watches the scan roots and
new files are parsed and probed as they appear, then broadcast as a
`libraryChanged` event so the open UI updates itself. Writes are debounced
(`awaitWriteFinish`) so a file still being copied isn't probed half-written.

## Pruning

Episodes whose file no longer exists on disk are deleted at the end of a pass,
and a show left with zero episodes is deleted with them.

## The other job in this directory

`loudness.ts` is not part of a scan. It is the background EBU R128 measuring job,
and it lives here only because it walks the library the way the scanner does —
one file at a time, over rows the scanner produced. It never runs inside a scan
pass: measuring an episode is a full audio decode, seconds per file against the
milliseconds an ffprobe costs, so it waits while a scan or any live stream is
using the machine. A `libraryChanged` broadcast wakes it, since new episodes are
new work for it. It is documented with the filter chain it feeds, in
[playback.md](playback.md#the-background-measuring-job).
