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
    paths.ts         XDG data dir + database path
    db/
      index.ts       open + migrate
      schema.ts      the migration list
      repositories/  all SQL, camel-cased at the boundary
    library/         parse · arcs · ffprobe · scanner
    scheduler/       playable units · what plays next
    stream/          ffmpeg supervisor · loopback HTTP server
    services/        view models the renderer consumes
    ipc/handlers.ts  one handle() per IPC channel
  preload/index.ts   contextBridge — the only thing the renderer can see
  renderer/          React + TypeScript
    src/store.ts     the Zustand store; the `screen` field is the router
    src/screens/     Guide · Player · ChannelEditor · Library · Settings
    src/components/  AppBar · ChannelBanner · ChannelNumber
    src/styles/      tokens.css (design tokens) · global.css (shared chrome)
tests/               Vitest — parser, arcs, units, scheduler, stream, repos
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
