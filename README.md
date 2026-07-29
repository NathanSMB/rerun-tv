# Rerun TV

Turn a local media library into lean-back TV channels — you build the lineup,
the channel decides what's on. Linux-first (Arch), Electron + ffmpeg.

Point it at `~/TV`, group some shows into a channel, and tune in. Shows play in
order or on shuffle, multipart arcs air start-to-finish without interruption,
and the next episode starts on its own. Nothing to configure in a text file.

## Quick start

```sh
npm install
npm approve-scripts better-sqlite3 electron esbuild   # first install only
npm rebuild

npm run dev        # develop
npm run dist       # build a Linux AppImage into release/
```

Requires **ffmpeg** on `PATH` (`pacman -S ffmpeg` on Arch) and a C toolchain for
`better-sqlite3`. See [docs/development.md](docs/development.md).

Then: **Settings → + Add folder** to point at your library, wait for the scan,
**Channels** to build a lineup, **Guide** to tune in.

## How it works

- **Scan** — folders are walked, `Show/Season 01/Show - S01E03.mkv` filenames are
  parsed, and every file is probed once with ffprobe. Rescans are incremental
  (keyed on mtime + size) and anything that doesn't parse waits in an *Unmatched*
  queue instead of disappearing.
- **Schedule** — each pick draws a show by weight, then a *playable unit* within
  it by mode. A unit is either one episode or a whole multipart arc, which is
  what makes arcs uninterruptible **and** exactly as likely to air as any single
  episode.
- **Play** — a loopback HTTP server fronts ffmpeg and picks the cheapest path
  that works: serve the file directly, remux losslessly into fragmented MP4, or
  transcode. The decision is made at scan time, so tuning in is instant.

## Documentation

| | |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The three processes, the IPC contract, layering |
| [docs/data-model.md](docs/data-model.md) | The tables, and why progress is split from configuration |
| [docs/scheduler.md](docs/scheduler.md) | Playable units, cursors, shuffle bags, arc locking |
| [docs/playback.md](docs/playback.md) | direct / remux / transcode, seeking, the ffmpeg supervisor |
| [docs/library.md](docs/library.md) | Scanning, filename parsing, arc detection |
| [docs/ui.md](docs/ui.md) | The five screens and the design language |
| [docs/development.md](docs/development.md) | Setup, scripts, layout, conventions |

## Planning documents

The originals this was built from:

- **[docs/plan.html](docs/plan.html)** — MVP architecture plan: locked decisions,
  system architecture, data model, the scheduler, playback pipeline, player
  behavior, build order, and risks.
- **[docs/mockup.html](docs/mockup.html)** — UI design mock: the Guide, the
  Player, the Channel Editor, the Library and Settings, in the "Saturday, 1994"
  broadcast direction.

Open either directly in a browser.

## Not in the MVP

Simulated live schedules (the duration data and play log already support them),
interstitials/bumpers, external metadata lookups, LAN access, VAAPI hardware
transcoding, and mid-episode resume.

## License

MIT — see [LICENSE](LICENSE).
