# Architecture

Everything lives in one Electron app. The main process owns the library, the
database, the scheduler and a loopback HTTP stream server that fronts ffmpeg; the
renderer is a plain web UI whose `<video>` element points at that server. **The
renderer never touches the filesystem.**

```
┌─ Renderer · Chromium ───────────┐      ┌─ Main · Node ──────────────────┐
│                                 │      │                                │
│  React UI                       │      │  Library scanner               │
│    Guide · Player · Channels    │      │    walk · parse SxxExx ·       │
│    Library · Settings           │      │    ffprobe · chokidar watch    │
│    state: Zustand store         │      │                                │
│                                 │ IPC  │  Scheduler                     │
│  Preload bridge  ───────────────┼─────►│    units · cursors · bags ·    │
│    contextBridge → window.rerun │      │    active arcs                 │
│                                 │      │                                │
│  <video>                        │      │  SQLite        Stream server   │
│    src = http://127.0.0.1:PORT  │◄─────┤  better-       loopback HTTP   │
│          /stream/<episodeId>    │ fMP4 │  sqlite3            │          │
│                                 │      │                     ▼          │
└─────────────────────────────────┘      │  ffmpeg / ffprobe supervisor   │
                                         │    spawn · kill on skip ·      │
                                         │    one job per channel         │
                                         └────────────┬───────────────────┘
                                                      │ read-only
                                                      ▼
                                                  ~/TV/…
```

## The decisions everything else assumes

Settled before any code was written, and still true. Each one is load-bearing
enough that changing it would be a rewrite rather than a refactor.

| Axis | Decision | Why |
| --- | --- | --- |
| App shell | **Electron desktop app** | A single-window native app on Arch. Official Electron builds ship the H.264/AAC decoders, and the Node main process can spawn ffmpeg and own the database — one runtime covers both halves. |
| Playback | **ffmpeg remux / transcode** | Plays anything in the library. Files are probed once at scan time; most MKVs need only a lossless remux, so full re-encodes are the rare path. |
| Library | **Folder scan + filename parsing** | `Show/Season 01/Show - S01E03.mkv` parses on its own; a fix-up UI handles the oddballs. Numbering always comes from the filename; titles can be overlaid from a provider afterwards, on request. |
| Channel model | **Lean-back playlist** | Tuning in resumes where that channel left off, or starts the next episode from the top if it has no place saved, and auto-plays forever. Durations and a play log are recorded anyway, so a simulated-live schedule can layer on later without rework. |
| Storage | **SQLite (`better-sqlite3`)** | One file, a synchronous API in the main process, trivial backup. The synchronous part is what makes every scheduler transition atomic without await points. |
| UI stack | **React + TypeScript + Vite** | Fast iteration in the renderer, typed IPC through a preload bridge. |
| Packaging | **AppImage (electron-builder)** | Runs on Arch without a package-manager dance. Never bundles ffmpeg — see below. |
| ffmpeg supply | **System binary, or a managed download** | The app ships no ffmpeg and distributes none. It prefers a copy it fetched, at the user's request, from the publisher who already distributes it (`services/ffmpeg-manager.ts`), then falls back to whatever is on `PATH`. Both are spawned as separate processes, so shipping this still raises no GPL question. |

## The three processes

### Main (`src/main/`)

Node, synchronous, single-threaded. It holds the only handle to SQLite —
`better-sqlite3` is synchronous by design, which is what lets every scheduler
state transition be one transaction with no await points for another tune-in to
interleave with.

Boot order in `index.ts` is deliberate: XDG data dir → **apply a staged database
import, if one is waiting** → open and migrate the database → install the desktop
entry and, on KDE, the picture-in-picture window rule → sweep the managed-ffmpeg
leftovers → resolve ffmpeg and start the stream server → construct the scanner
and the background loudness job → register IPC handlers → open the window. The
codec check and the hardware-encoder probe both run *after* the window is on its
way, because a failure in either is non-fatal: anything unplayable just routes to
the transcode path, and an unavailable backend degrades to software.

The import step comes first because it's the only moment nothing holds a handle
on the database file — see [backup-restore.md](backup-restore.md). The ffmpeg
sweep comes before anything resolves against it for the same class of reason: it
is the only moment nothing from the previous session can still be holding a
binary open.

### Which ffmpeg runs

`resolveFfmpeg()` picks one, once per process, in this order:

1. `RERUN_FFMPEG_PATH` / `RERUN_FFPROBE_PATH` — the escape hatch, and what the
   test suites drive;
2. the **managed** install under `~/.local/share/rerun-tv/ffmpeg/`, the copy the
   user asked the app to download. It outranks the system binary deliberately:
   someone who went and got one did so because the system copy was missing or
   wrong, and removing the managed copy is how you go back;
3. `PATH`;
4. a build sitting beside the app (nothing ships one).

The managed directory is never added to `PATH` — only this resolver looks there.
The answer is cached; an install, update or removal drops that cache, and
everything that resolves per use (the stream server, the IPC handlers) picks up
the new binary with no further wiring. The two consumers constructed once at boot
— the scanner and the loudness job — take a *getter* rather than a captured path
for exactly this reason, so "there was no ffmpeg at boot" never hardens into
"there is no ffmpeg this session".

Installing is staged and atomic: download → sha256 against a checksum pinned in
`resources/ffmpeg-manifest.json` → unpack → prove the binary can actually mux
H.264/AAC (`checkCodecs`) → `rename` into `versions/<version>/` → write the
one-line pointer. Nothing outside the staging directory is touched until every
one of those has passed. Updates land side by side and the superseded version is
swept at the *next* launch, so an update can never pull a binary out from under
an encoder that is mid-episode. See [managed-ffmpeg-plan.html](managed-ffmpeg-plan.html).

### Preload (`src/preload/index.ts`)

Exposes exactly one global, `window.rerun`, satisfying the `RerunApi` interface
from `src/shared/ipc.ts`. Every method is a one-line `ipcRenderer.invoke` — no
logic, deliberately. `contextIsolation` is on, `nodeIntegration` is off, and the
renderer runs sandboxed.

### Renderer (`src/renderer/`)

React 19 + TypeScript. No router: the store's `screen` field is the router,
because there are five screens and no URLs worth having. Components read store
slices and call store actions; only the Player talks to the DOM directly, since
it owns a `<video>` element whose state changes every frame.

Two screens take the whole window with no app bar around them, for opposite
reasons: the **Player**, so a fullscreen handoff never has to escape a layout
wrapper, and the **blackout** the sleep timer ends on, because an app bar is a
light source and that screen exists to emit nothing.

## The IPC contract

`src/shared/ipc.ts` is the seam. `RerunApi` declares what the renderer may ask
for; `IPC` maps each method to a channel name. Adding a capability means editing
the interface first — after which both the preload bridge and the main-process
handler map fail to typecheck until they implement it. That's the point.

The seam is also where outbound network access lives. The renderer's CSP allows
`connect-src` to itself and the loopback stream server only, so the metadata
lookup's two TVmaze calls are made by a main-process service
(`services/metadata.ts`, on Electron's `net.fetch`) and reach the Library screen
as four `library.*` IPC methods — search, preview, apply, unlink. Same rule as
the filesystem: the renderer asks, the main process goes.

Three push channels go the other way: `scanProgress` (throttled, drives the scan
pill and the Library progress bar), `libraryChanged` and `channelsChanged`. The
store subscribes to all three once, in `init()`.

## Why a loopback HTTP server instead of `file://`

- **One URL shape for all three playback paths.** The `<video>` element never
  knows whether it's getting a range-served file, a live remux, or a transcode.
  Everything is `http://127.0.0.1:PORT/stream/<episodeId>`.
- **ffmpeg pipes fragmented MP4 straight into the HTTP response** — no temp
  files, no cleanup, no disk churn.
- **It's already the seam for casting** to another device on the LAN, post-MVP.

The server binds to `127.0.0.1` on an OS-assigned port, rejects non-loopback
`Host` headers, takes episode **ids** — never filesystem paths — from the
client, and requires a random per-boot key (`?k=`) on every stream URL.
Responses carry `Access-Control-Allow-Origin: *`, because the renderer reads
stream bytes itself now (see below) — which is exactly why the key exists:
loopback and the `Host` check keep the open web out, but say nothing about
another process on the machine, or a page in the user's own browser.

## Why the renderer has its own scheme instead of `file://`

The renderer is served from `app://bundle`, a scheme registered as `standard` and
`secure` and backed by a `protocol.handle` that serves exactly one directory — the
built bundle.

It used to load over `file://`, which works right up until something needs a real
origin. A `file://` document has an **opaque** origin, and Chromium refuses blob
URLs from one — not only for media, for anything; even
`fetch(URL.createObjectURL(new Blob(['hi'])))` fails. The MSE pump
(`renderer/player/mse.ts`) attaches its `MediaSource` to the `<video>` element
through exactly such a URL, so on `file://` every remuxed and transcoded episode
died with `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`. The
`srcObject` route is no escape either: it accepts only a `MediaStream` or a
`MediaSourceHandle`, and `MediaSource.handle` exists in workers alone — while a
worker cannot be loaded from `file://` in the first place.

A real origin also makes the stream server's CORS story ordinary rather than
special-cased. Nothing about the threat model changes: `will-navigate` is still
refused, external links still open in the user's browser, and the scheme serves
only the bundle we shipped.

## Layering

```
ipc/handlers.ts        translate IPC → subsystem call → view model. No decisions.
services/              view models: LibraryOverview, ChannelSummary, ChannelDetail
                       plus restore.ts — validate, stage and swap a database
scheduler/ library/ stream/    the actual behaviour
db/repositories/       all SQL, camel-cased at the boundary
db/index.ts            open + migrate
```

A handler that starts to look like it's deciding something belongs in
`services/` or `scheduler/` instead.

## Risks, and what answers them

The five things most likely to go wrong were named up front, each with the
mitigation it would get. All five shipped; this table is where the rest of the
docs point when they say a behaviour is an accepted tradeoff rather than a bug.

| Risk | What answers it |
| --- | --- |
| **Seek latency on transcoded streams** | Keyframe-aligned `-ss` *before* the input, which is a fast seek and a coarse one. Coarse is accepted: most content direct-plays or remuxes, where seeking is native anyway. See [playback.md](playback.md#the-stream-server). |
| **Filename chaos in real libraries** | The Unmatched bucket plus manual assignment, so a bad parse never blocks a show from airing and the parser grammar can grow case by case. See [library.md](library.md#the-unmatched-bucket). |
| **The transition gap between episodes** | Pre-resolve the next unit and warm its stream during the last 30 seconds; the channel banner covers the handoff moment. This started as "warm the URL" and became the real double-buffered handoff — see [playback.md](playback.md#gapless-handoffs). |
| **Electron codec drift** | Codec support is asserted at startup against a tiny generated asset, and a failure is non-fatal: anything unplayable routes to the transcode path. See [playback.md](playback.md#codec-check). |
| **Scheduler state corruption (a crash mid-arc)** | Every state transition is a single SQLite transaction, and an orphaned active arc is validated — and cleared if stale — at tune-in. See [scheduler.md](scheduler.md#durability). |

Two consequences of the last one are visible in normal use rather than only after
a crash: an episode left mid-play logs as incomplete, and a schedule step
committed by a prewarm that nobody watched is simply spent. Both are the same
tradeoff, taken deliberately — the alternative is a rollback path that has to be
correct across a process death.

## Deliberately out of scope

Not "not yet built" so much as "not what this is". The data model already
supports the first two, which is why the durations and the play log are recorded
now:

- **Simulated live schedules** — a per-channel virtual clock, so tuning in drops
  you mid-episode rather than at the top of one.
- **Interstitials** — bumpers and commercials from a clips folder, between
  episodes.
- **External metadata artwork** (posters, descriptions, air dates), movies as
  channel filler, LAN or TV-browser access, and multi-user profiles. Metadata
  *titles* have since come into scope — see below.

Two things on this list have since landed. Hardware-accelerated transcoding —
VAAPI and NVENC, probed at startup, off by default
([playback.md](playback.md#hardware-encode--decode)). And **mid-episode resume**:
each channel now remembers the episode and offset it was last watching, so
leaving and coming back is continuous
([playback.md](playback.md#resuming-a-channel)). That is per-channel resume, not
the simulated-live virtual clock above — a channel picks up where *you* left it,
not where it would have got to had it been broadcasting all night.

A third has landed narrowly: **show metadata lookup**. A show can be linked, by
hand, to a TVmaze series, which gives it a clean display title and gives its
episodes their real titles ([library.md](library.md#metadata-lookup),
[metadata-lookup-plan.html](metadata-lookup-plan.html)). That reverses the
*titles* half of the bullet above and nothing else: artwork, descriptions and
air dates are still not fetched, and the scanner itself never touches the
network.

## Further reading

- [data-model.md](data-model.md) — the eight tables and why state is split from configuration
- [scheduler.md](scheduler.md) — playable units, cursors, shuffle bags, arc locking
- [playback.md](playback.md) — direct / remux / transcode, hardware encode,
  loudness, the supervisor
- [library.md](library.md) — scanning, filename parsing, arc detection
- [backup-restore.md](backup-restore.md) — backing up the database, and importing one back
- [ui.md](ui.md) — the four screens and the design language
- [development.md](development.md) — setup, scripts, conventions, testing,
  CI and releases
