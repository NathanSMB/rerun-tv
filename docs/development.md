# Development

## Requirements

- **Node** 20+ (developed on 24)
- **ffmpeg / ffprobe** on `PATH` — on Arch, `pacman -S ffmpeg`. The app prefers
  the system binary and falls back to a bundled static build; without either,
  only `direct`-play files work and everything else returns a clear 503.
- A C toolchain, because `better-sqlite3` compiles a native module.

## Setup

```sh
npm install
```

npm 11 defers package install scripts. `better-sqlite3` needs its build step and
`electron` needs its download step, so the first install also requires:

```sh
npm approve-scripts better-sqlite3 electron esbuild
npm rebuild
```

(Once approved, the grants are recorded in `package.json` under `allowScripts`
and subsequent installs are non-interactive.)

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | electron-vite dev server — renderer HMR, main process restarts on change |
| `npm run rebuild:electron` | Recompile `better-sqlite3` for Electron's ABI (needed to *run* the app) |
| `npm run rebuild:node` | Recompile it for plain Node's ABI (needed to run the *tests*) |
| `npm run build` | Typecheck, then build all three targets into `out/` |
| `npm start` | Preview a production build |
| `npm run typecheck` | `tsc --noEmit` over the Node target and the web target |
| `npm test` | Vitest, once |
| `npm run test:watch` | Vitest, watching |
| `npm run soak` | Drive the built app over CDP and fail on playback stalls — see below |
| `npm run dist` | Build and package a Linux **AppImage** into `release/` |

## Project layout

```
src/
  shared/            types + IPC contract + the playback decision
    types.ts         every domain type and view model
    ipc.ts           RerunApi — the single source of truth for the bridge
    playback.ts      decidePlaybackPath, episodeCode, formatDuration
  main/              Node — owns the library, the database, the scheduler
    index.ts         bootstrap and window
    paths.ts         XDG data dir · database, staged-import and backup paths
    db/
      index.ts       open + migrate
      schema.ts      the migration list
      repositories/  all SQL, camel-cased at the boundary
    library/         parse · arcs · ffprobe · scanner
    scheduler/       playable units · what plays next
    stream/          ffmpeg supervisor · loopback HTTP server
    services/        view models the renderer consumes · restore.ts
    ipc/handlers.ts  one handle() per IPC channel
  preload/index.ts   contextBridge — the only thing the renderer can see
  renderer/          React + TypeScript
    src/store.ts     the Zustand store; the `screen` field is the router
    src/screens/     Guide · Player · ChannelEditor · Library · Settings
    src/components/  AppBar · ChannelBanner · ChannelNumber
    src/styles/      tokens.css (design tokens) · global.css (shared chrome)
tests/               Vitest — parser, arcs, units, scheduler, stream, repos, restore
docs/                this documentation, plus the original plan and mockup
```

## Conventions

- **ESM everywhere.** Import local modules with an explicit `.js` extension
  (`./parse.js`), shared modules via `@shared/…js`.
- **The renderer never touches the filesystem.** Everything goes through
  `window.rerun`, which is generated from `RerunApi`. To add a capability: add
  the method to `RerunApi`, then the channel name to `IPC`, then implement it in
  `preload/index.ts` and `main/ipc/handlers.ts`. Both sides fail to typecheck
  until you do.
- **All SQL lives in `db/repositories/`.** Rows are camel-cased there so no
  snake_case ever reaches the renderer.
- **No hardcoded colours in components.** Add a token to
  `renderer/src/styles/tokens.css` instead.
- **Schema changes are append-only.** Add an entry to `MIGRATIONS` in
  `db/schema.ts`; never edit an existing one. `PRAGMA user_version` tracks
  what's applied.

## Where things live at runtime

| | |
| --- | --- |
| Database | `~/.local/share/rerun-tv/library.db` (WAL mode) |
| Automatic backups | `~/.local/share/rerun-tv/backups/` — taken before an import replaces the database, last 5 kept |
| Staged import | `library.db.incoming` (+ `.json`) beside the database, applied and consumed at the next boot |
| Electron caches | the same directory — `userData` is repointed in `paths.ts` |
| Stream server | `http://127.0.0.1:<ephemeral>` — loopback only |

## The one native-module gotcha

`better-sqlite3` is a native module, and Electron and plain Node use **different
ABI versions** (`NODE_MODULE_VERSION` 139 vs 137 here). Only one build can exist
on disk at a time, so:

- **Running the app** needs the Electron build. This is the default — `postinstall`
  runs `electron-builder install-app-deps`. If you see `NODE_MODULE_VERSION`
  complaints at boot, run `npm run rebuild:electron`.
- **Running the tests** needs the Node build, so `npm test` runs
  `npm run rebuild:node` first. That leaves the module on the Node ABI, so run
  `npm run rebuild:electron` before launching the app again.

There is no way around this short of running the suite under Electron itself,
which would drag a display server into what are otherwise pure logic tests.

## Testing

Tests are Node-target Vitest and never boot Electron. The database ones open
`openDatabase(':memory:')` and insert fixtures with raw SQL, so they exercise
the real schema and the real migrations. The stream tests start a real HTTP
server on an ephemeral port; the cases that need ffmpeg skip themselves when it
isn't installed.

`restore.test.ts` is the exception that uses real files in a temp directory,
because the whole point of that module is filesystem behaviour — what survives a
rejected import, what gets copied before a swap, what happens to a stale WAL
sidecar. An in-memory database would test none of it.

`mse.test.ts` drives the MSE pump's box scanner and read/append/evict state
machine against bytes a real ffmpeg produced, with the exact arguments the stream
server uses. That works in Node only because `player/mse.ts` is deliberately
DOM-free and is listed in `tsconfig.node.json`, so a stray DOM reference fails the
build. `handoff.test.ts` drives the store's schedule-advance logic against the
real scheduler over a real database, with only the IPC hop faked — the one thing
worth that much scaffolding, because getting it wrong double-spends the schedule.

## The soak harness

`scripts/soak.mjs` is deliberately *not* part of `npm test`: it needs a real
library, a display, and minutes rather than milliseconds. It launches the built
app with `--remote-debugging-port`, tunes a channel, plays several episodes at an
accelerated `playbackRate`, and fails on any stall over three seconds, on
sustained over-budget encoder counts, or on an episode airing twice.

```
npm run build && npm run rebuild:electron   # it drives the real app in out/
npm run soak                                # 6 episodes at 8x on channel 1
node scripts/soak.mjs --episodes 4 --rate 12 --channel 2
node scripts/soak.mjs --help
```

The `rebuild:electron` is not optional: `npm test` leaves `better-sqlite3` on the
Node ABI, and the app will not boot on that (see the native-module gotcha above).

### Reading the output

```
[soak] episode 1/4 — id 317
[soak]   buffered ahead 4–66s · peak encoders 1
[soak] PASS — no stalls, no phantom encoders, no repeats
```

**`peak encoders` is the number that matters.** One encoder for a whole episode is
the fix working. Two is legal during a handoff — the episode on air plus the one
prewarming behind it. A *sustained* three or more is the original bug back: a
stream was dropped and silently re-requested, which is invisible from inside the
page and shows up only as a second ffmpeg. For reference, the investigation
measured 14 encoders across 6 episodes.

`buffered ahead` should sit roughly in the 15–60s band the pump aims for, plus one
fragment of overshoot at the top (a single fragment can be several seconds, and the
read decision is made before the append) and a low reading on the first poll after
a swap.

### Running it against a throwaway library

The soak plays real episodes and advances real schedule state, so point it at a
copy:

```
mkdir -p /tmp/soak/rerun-tv
cp ~/.local/share/rerun-tv/library.db /tmp/soak/rerun-tv/
XDG_DATA_HOME=/tmp/soak npm run soak
```

`XDG_DATA_HOME` is what `dataDir()` in `main/paths.ts` reads. It does **not** copy
anything for you — an empty directory means an empty library, and the run fails
with `no channel numbered 1`.

### The debugging mode

`--eval '<expression>'` attaches to the renderer, evaluates one expression
(awaiting it if it returns a promise), prints the result as JSON, and exits. It is
the more valuable half of this script: bisecting an MSE initialisation segment
inside the real app is how all three Chromium constraints in
[playback.md](playback.md) were found, and none of them were guessable from the
spec.

```
node scripts/soak.mjs --eval "globalThis.__rerunStore.getState().nowPlaying"
```

`globalThis.__rerunStore` is exposed in `renderer/src/main.tsx` precisely so the
harness can drive the app through the store instead of poking at the DOM. To
attach to an app you already have running, stop the harness launching a second
copy:

```
RERUN_SOAK_BIN=/bin/true node scripts/soak.mjs --port 9223 --eval '…'
```

### One trap it handles for you

The harness strips `ELECTRON_RUN_AS_NODE` from the child environment. If that
variable is set — some shells and tool wrappers export it — the Electron binary
boots as a plain Node interpreter: no window, no renderer, no debugger port, and
nothing that says so.
