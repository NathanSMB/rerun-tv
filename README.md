# Rerun TV

[![CI](https://github.com/NathanSMB/rerun-tv/actions/workflows/ci.yml/badge.svg)](https://github.com/NathanSMB/rerun-tv/actions/workflows/ci.yml)
[![Test coverage](https://img.shields.io/badge/coverage-82.0%25-green)](https://github.com/NathanSMB/rerun-tv/actions/workflows/ci.yml)

Turn a local media library into lean-back TV channels — you build the lineup,
the channel decides what's on. Linux-first (Arch), Electron + ffmpeg.

> Tagged releases publish a Linux AppImage (`chmod +x` it and run it), a macOS
> dmg (arm64 and x64) and a Windows installer to the
> [Releases page](https://github.com/NathanSMB/rerun-tv/releases/latest); you
> can also build your platform's package yourself with `npm run dist`. It is
> developed and tested on CachyOS with KDE/Wayland; other platforms should work
> but are not exercised, and the macOS/Windows builds are unsigned (expect a
> Gatekeeper/SmartScreen prompt). ffmpeg must be installed separately on every
> platform.

Point it at any folder of shows, group some of them into a channel, and tune in.
Shows play in order or on shuffle — down to individual seasons, so you can run
the first eight in order and shuffle the rest — multipart arcs air
start-to-finish without interruption, and the next episode starts on its own.
Nothing to configure in a text file.

## Quick start

```sh
npm install
npm approve-scripts better-sqlite3 electron esbuild   # first install only
npm rebuild

npm run dev        # develop
npm test           # run the suite
npm run lint:fix   # format + lint with Biome (a pre-commit hook checks this)
npm run dist       # package the app for this platform into release/
```

Requires **ffmpeg** on `PATH` (`pacman -S ffmpeg` on Arch) and a C toolchain for
`better-sqlite3`. ffmpeg is used as an external process and is never bundled.

**One gotcha worth knowing before it bites you:** `better-sqlite3` is a native
module, and Electron and Node use different ABIs. `npm test` rebuilds it for
Node, so the next `npm run dev` fails with an ABI error until you run
`npm run rebuild:electron`. Both directions are one command and are explained in
[docs/development.md](docs/development.md).

Then: **Settings → + Add folder** to point at your library, wait for the scan,
then **Guide → + New channel** to build a lineup and tune in. The Guide is both
the lineup and the place channels are edited; there is no separate Channels screen.

## How it works

- **Scan** — folders are walked, `Show/Season 01/Show - S01E03.mkv` filenames are
  parsed, and every file is probed once with ffprobe. Rescans are incremental
  (keyed on mtime + size) and anything that doesn't parse waits in an *Unmatched*
  queue instead of disappearing.
- **Schedule** — each pick draws a show by weight, then a *playable unit* within
  it by mode (per show, or per season where you've overridden it). A unit is
  either one episode or a whole multipart arc, which is what makes arcs
  uninterruptible **and** exactly as likely to air as any single episode.
- **Play** — a loopback HTTP server fronts ffmpeg and picks the cheapest path
  that works: serve the file directly, copy the video into fragmented MP4 and
  encode only the audio if it has to, or re-encode outright. The decision is made
  at scan time, so tuning in is instant. The player feeds those pipes to a
  `MediaSource` it drives itself, which is what keeps a long session from
  stalling, and it double-buffers the next episode so handoffs cut rather than
  pause.
- **Sleep** — press `S` in the player for a dial that runs from off to five hours
  in five-minute steps (drag it, scroll the wheel, or just type the minutes). It
  never cuts you off mid-story: when it expires the episode plays to its end — or
  the whole arc does, if you're inside one — and only then does the channel shut
  down to a black screen, with the way back hidden until you move the mouse.
- **Back up** — channels, lineups and progress are one SQLite file, and Settings
  will both write a copy of it and put one back. Restoring validates the file
  first, keeps an automatic copy of the database it replaces, and swaps it in at
  the next launch so nothing is rewritten underneath a running scan.

## Documentation

| | |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | The three processes, the IPC contract, layering |
| [docs/data-model.md](docs/data-model.md) | The tables, and why progress is split from configuration |
| [docs/scheduler.md](docs/scheduler.md) | Playable units, cursors, shuffle bags, arc locking |
| [docs/playback.md](docs/playback.md) | direct / remux / transcode, hardware encode, loudness, the ffmpeg supervisor |
| [docs/library.md](docs/library.md) | Scanning, filename parsing, arc detection |
| [docs/backup-restore.md](docs/backup-restore.md) | Backing up the database, and importing one back |
| [docs/ui.md](docs/ui.md) | The screens, the sleep timer, and the design language |
| [docs/development.md](docs/development.md) | Setup, scripts, layout, conventions, testing, CI and releases |

These describe how the app works now, and they carry the reasoning with them —
what was measured, what failed first, and which obvious approach was abandoned
and why. The design documents and per-feature plans they grew out of have been
folded in and removed; `git log` has them if you want the archaeology.

## Not in the MVP

Simulated live schedules (the duration data and play log already support them),
interstitials/bumpers, external metadata beyond titles (artwork, descriptions,
air dates), LAN access, and mid-episode
resume. See
[docs/architecture.md](docs/architecture.md#deliberately-out-of-scope).

(Hardware-accelerated transcoding *has* since landed — VAAPI and NVENC, probed
at startup and off by default. See Settings → Playback.)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — the short version is that `main` is
protected, everything lands through a PR, and CI runs lint, typecheck, the test
suite behind a coverage floor, and a production build.

## License

MIT — see [LICENSE](LICENSE). ffmpeg is invoked as a separate program and no
binary is redistributed here, so its licence terms are not inherited by this
project.
