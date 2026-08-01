# Architecture

The implementation of [plan.html](plan.html) §2. Everything lives in one
Electron app. The main process owns the library, the database, the scheduler and
a loopback HTTP stream server that fronts ffmpeg; the renderer is a plain web UI
whose `<video>` element points at that server. **The renderer never touches the
filesystem.**

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

## The three processes

### Main (`src/main/`)

Node, synchronous, single-threaded. It holds the only handle to SQLite —
`better-sqlite3` is synchronous by design, which is what lets every scheduler
state transition be one transaction with no await points for another tune-in to
interleave with.

Boot order in `index.ts` is deliberate: XDG data dir → **apply a staged database
import, if one is waiting** → open and migrate the database → install the desktop
entry and, on KDE, the picture-in-picture window rule → resolve ffmpeg and
start the stream server → construct the scanner → register IPC handlers → open
the window. The codec check runs *after* the window is on its way, because per
plan §10 a failure is non-fatal: anything unplayable just routes to the transcode
path.

The import step comes first because it's the only moment nothing holds a handle
on the database file — see [backup-restore.md](backup-restore.md).

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
`Host` headers, and takes episode **ids** — never filesystem paths — from the
client. Responses carry `Access-Control-Allow-Origin: *`, because the renderer
reads stream bytes itself now (see below).

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

## Further reading

- [data-model.md](data-model.md) — the eight tables and why state is split from configuration
- [scheduler.md](scheduler.md) — playable units, cursors, shuffle bags, arc locking
- [playback.md](playback.md) — direct / remux / transcode, seeking, the supervisor
- [library.md](library.md) — scanning, filename parsing, arc detection
- [backup-restore.md](backup-restore.md) — backing up the database, and importing one back
- [ui.md](ui.md) — the four screens and the design language
