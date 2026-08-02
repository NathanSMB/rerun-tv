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

`npm install` also runs `prepare`, which is `husky` — that is what points
`core.hooksPath` at `.husky/` and arms the pre-commit hook below. A fresh clone
has no hook until someone has installed once.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | electron-vite dev server — renderer HMR, main process restarts on change |
| `npm run rebuild:electron` | Recompile `better-sqlite3` for Electron's ABI (needed to *run* the app) |
| `npm run rebuild:node` | Recompile it for plain Node's ABI (needed to run the *tests*) |
| `npm run build` | Typecheck, then build all three targets into `dist/` |
| `npm start` | Preview a production build |
| `npm run typecheck` | `tsc --noEmit` over the Node target and the web target |
| `npm run lint` | Biome — formatting, import order and lint rules, no writes |
| `npm run lint:fix` | The same, applying every safe fix |
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
    kwin-rule.ts     the KWin overlay rule that keeps PiP above full-screen windows
    desktop-entry.ts rerun-tv.desktop, installed at boot — the taskbar icon on Wayland
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
    src/screens/     Guide · Player · Library · Settings (+ Blackout)
    src/components/  AppBar · ChannelFold (the guide's editor) · ChannelNumber
    src/styles/      tokens.css (design tokens) · global.css (shared chrome)
.husky/              the pre-commit hook — Biome over the staged files
biome.json           formatter + linter config, the one source of style truth
resources/           the application icon — electron-builder's buildResources and the running window's icon
tests/               Vitest — parser, arcs, units, scheduler, stream, repos, restore
  renderer/          the DOM suites: the Player's effect decisions, the guide's fold
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
- **Style is not a matter of opinion.** [Biome](https://biomejs.dev) formats and
  lints everything, and the pre-commit hook enforces it — see below.

## Formatting and linting

One tool does both: **Biome**, configured in `biome.json`. It replaces what a
Prettier + ESLint pair would do, in one binary with no plugin graph, and it is
fast enough (~30ms over the whole repo) that the commit hook is unnoticeable.

The configuration is Biome's own defaults with three deliberate departures:

| | |
| --- | --- |
| `indentStyle: space`, `indentWidth: 4` | House style |
| `quoteStyle: double` | House style |
| `files.includes` excludes `docs/**` | Those are standalone plan and mockup documents, not source. They are hand-written HTML that happens to contain script tags, and formatting them would rewrite artefacts nobody imports. |
| `overrides` turns off `noNonNullAssertion` under `tests/` | A `!` in a test asserts a fixture invariant. If the invariant breaks the test fails loudly, which is the point — rewriting 55 of them into guards would add noise and hide nothing. It stays on for `src/`. |

Everything else — the `recommended` rule set, including the a11y and
`useExhaustiveDependencies` groups — is on, and the tree is clean under it.

**Suppressions carry their reason.** Where a rule genuinely fights a decision
this app has already made, the code says so in a
`// biome-ignore lint/<rule>: <why>` comment rather than the rule being switched
off globally. There are only a handful, and each is load-bearing:

- `VideoSurface.tsx` and `Player.tsx` narrow their effect dependency lists on
  purpose. That effect owns an ffmpeg process; widening it to what
  `useExhaustiveDependencies` wants restarts the encoder on every render, which
  is exactly the stall documented in [stall-fix-plan.html](stall-fix-plan.html).
- The guide's channel row is a `role="button"` div rather than a `<button>`,
  because a real button synthesises a click from Enter and Space and the list's
  key handler already spends those on "tune in" — the row would activate twice.
  Its keys live on the list so `Escape` still reaches it from inside an open
  fold, which is a sibling of the row rather than a child.
- The `<video>` has no `<track kind="captions">` because there is nothing to
  point one at: the stream server publishes one video and one audio track.

### The pre-commit hook

Installed by [husky](https://typicode.github.io/husky/), which `npm install`
arms via the `prepare` script. `.husky/pre-commit` is one line:

```sh
npx biome check --staged --no-errors-on-unmatched
```

Staged files only, and **check-only** — a hook that rewrote files mid-commit
would leave the staged snapshot and the working tree disagreeing about what you
just committed. When it fails, run `npm run lint:fix`, read the diff, stage it.

`npm test` is deliberately *not* in the hook: it rebuilds `better-sqlite3` for
the Node ABI and would leave the app unable to boot until `npm run
rebuild:electron` (see the native-module gotcha above). That is a fine thing to
opt into; it is not a fine thing to do to someone making a commit.

To bypass in a genuine emergency: `git commit --no-verify`.

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
ABI versions** (`NODE_MODULE_VERSION` 148 vs 137 here). Only one build can exist
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

Tests are Node-target Vitest and never boot Electron — no display server, no
Electron ABI, seconds end to end. The one exception is `tests/renderer/`, which
opts itself into `happy-dom` per file (below) so React can mount; it still needs
neither. The database ones open
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

### The renderer layer: `tests/renderer/`

`handoff.test.ts` starts one step after the bugs that motivated this layer. It
calls `advance()` and `sleepNow()` directly; the bugs were in *which of the two
the Player asked for*, and that decision lives in a React effect fed by
media-element events. Nothing in `npm test` rendered the Player at all, so both
shipped past a green suite.

`player-decisions.test.tsx` closes that gap and nothing wider. It mounts the
real `<Player/>` and asserts **which store action its effects picked** — the
paused branch versus the `ended` handler, and whether a prewarm was asked for.
Everything between the two seams is production code: the Player, `VideoSurface`
(including the rule that events are forwarded only while a surface is active),
and the store with its `serialize()` queue.

The two seams are the ones the repo already treats as contracts:

- **The media elements.** `happy-dom` supplies DOM globals so `react-dom` can
  mount; its `<video>` is an inert stub, so `harness.tsx` replaces `paused`,
  `ended`, `play()` and `pause()` with the orderings measured in the real app.
  With no `MediaSource` in happy-dom, `VideoSurface` takes its plain-`src`
  branch — the pump that branch skips is DOM-free and pinned by `mse.test.ts`.
- **The preload bridge**, over a fixed deck of episodes rather than a database
  (`fixtures.tsx`). It keeps the one scheduler distinction the handoff rests on:
  `prewarmNext` reserves, `promoteNext` commits.

The harness also models the two Chromium APIs happy-dom lacks entirely, each
carrying the measured rule the Player is built around rather than merely
allowing what it asks for: **picture-in-picture** (a fresh entry needs a
gesture, a transfer does not, and a transfer's `leavepictureinpicture` precedes
the new element's enter) and **fullscreen** (same gesture rule, a detached
element reports as no fullscreen at all, and `Esc` is swallowed by the browser
on its way out — the facts the blackout's fullscreen handoff turns on, see
[blackout-fullscreen-plan.html](blackout-fullscreen-plan.html)).

**What it deliberately does not cover.** Real Chromium semantics. This layer
*encodes* what the soak harness measured; it cannot discover anything new about
a media element, and a fake that fires `ended` without a preceding `pause` would
happily pass the broken code. Ground truth stays with `scripts/soak.mjs --eval`
and [playback.md](playback.md#two-things-chromium-does-around-ended). Nor does
it cover what the *scheduler* picks: that is `handoff.test.ts`'s job over the
real database, and these files are SQLite-free so they stay ownable by
`tsconfig.web.json` (which has no Node types — `tsconfig.node.json` excludes
them for the same reason, keeping its no-DOM guarantee intact).

**Writing the next one.** Compose the harness vocabulary; tests never hand-fire
raw events, so the measured orderings live in exactly one place:

```tsx
const sc = await openPlayer(arcDeck(3))   // mount, tune, first part on air
await sc.prewarm()                         // T−30s: reserve into the standby
await sc.pauseForEnd()                     // Chromium's pause, `ended` already true
await sc.ended()                           // …stopping inside the promotion window
await sc.expireSleep()                     // the countdown reaching its deadline
await sc.settle()
expect(sc.actions).toEqual(['advance(true)'])
```

`sc.actions` is which store action the Player chose; `sc.calls` is the bridge
log, which is what the play log is made of. Also available: `at(seconds)` to
enter the up-next window, `viewerPause()`/`viewerPlay()` (the real OSD button —
the only thing that clears `wantsPlayRef`), `armSleep()`, and `endEpisode()` for
the pause-then-ended pair in one step.

If a new case needs a media behaviour the harness doesn't model yet — a seek's
reload, a stream error, a `waiting`/`stalled` cycle — **measure it live first**
with `soak.mjs --eval`, record it in `playback.md`, then teach `harness.tsx`.
Inventing the ordering is how a harness ends up passing broken code.

Finally: each test names the mutation that must turn it red, and the guard those
mutations attack is `Player.tsx`'s "Expiry while paused". That ritual is the
point — a harness whose tests cannot fail on the original bugs is decoration.

#### The screen suites

`harness.tsx` is the *Player's* rig, and most of what it models — media-element
orderings, PiP and fullscreen activation rules — is meaningless anywhere else.
Its shell mounts one other screen: the Blackout, because inheriting fullscreen
across the Player's unmount (`blackout-fullscreen.test.tsx`) is a property of
the swap between them, invisible with either half missing. Other screens are
mounted directly with `createRoot`, with only the preload bridge scripted per
file: `settings-rail.test.tsx`, `sleep-panel.test.tsx`, `guide-fold.test.tsx`.

`guide-fold.test.tsx` covers the Guide's fold-out channel editor
([ui.md](ui.md)) — one fold at a time, the keyboard path hover cannot serve,
and the two-step delete. Two things it does not assert, deliberately:

- **The row's fixed height under hover.** happy-dom lays nothing out, so every
  box is 0×0. That the controls and the show titles share one grid cell is a CSS
  fact and belongs to the mockup and a real window, not to a DOM test.
- **Anything the fold's mutations do to the scheduler.** Those go over the bridge
  and are `scheduler.test.ts`'s job against a real database.

Two harness details are worth copying rather than rediscovering:

- **Keystrokes go to the focused row**, not to the list. The Guide's handler
  ignores keys whose target isn't a row, so that the fold's own inputs can own
  their `Escape`; a test that fired at the container would prove nothing.
- **React installs its own `value` setter on controlled inputs** and ignores a
  plain assignment, so typing has to call the native setter (`type()` in that
  file) or `onChange` never fires and the form stays empty.

## The soak harness

`scripts/soak.mjs` is deliberately *not* part of `npm test`: it needs a real
library, a display, and minutes rather than milliseconds. It launches the built
app with `--remote-debugging-port`, tunes a channel, plays several episodes at an
accelerated `playbackRate`, and fails on any stall over three seconds, on
sustained over-budget encoder counts, or on an episode airing twice.

```
npm run build && npm run rebuild:electron   # it drives the real app in dist/
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

Because the expression is awaited, one `--eval` can be a whole scenario: arm
something, drive `playbackRate` up, poll the store until a screen changes, and
return a trace. That is how the sleep timer was verified end to end — a timer
armed for five seconds against episodes played at 16×, checking that expiry
mid-episode changes nothing, that a mid-arc expiry still hands off to the next
part, and that the blackout only arrives at the unit boundary. Both Chromium
behaviours in [playback.md](playback.md#two-things-chromium-does-around-ended)
came out of that run, and neither was reachable from `tests/`.

Two rules for a long run, both learned the hard way:

- **Don't touch native modules while it's running.** `npm test` rebuilds
  `better-sqlite3` for the Node ABI, and replacing the `.node` file under a live
  Electron segfaults it mid-run. Wait for the run to finish.
- **Sandbox the library** (below) if the scenario advances the schedule, which
  anything playing to an `ended` does.

### One trap it handles for you

The harness strips `ELECTRON_RUN_AS_NODE` from the child environment. If that
variable is set — some shells and tool wrappers export it — the Electron binary
boots as a plain Node interpreter: no window, no renderer, no debugger port, and
nothing that says so.
