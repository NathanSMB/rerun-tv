# Development

## Requirements

- **Node** 20+ (developed on 24)
- **ffmpeg / ffprobe** on `PATH` — on Arch, `pacman -S ffmpeg`. Without them
  only `direct`-play files work and everything else returns a clear 503.
  (`resolveFfmpeg` will use a static build placed in `resources/` if one is
  there, but no release bundles one — ffmpeg is always the system binary, which
  is also why shipping Rerun TV raises no GPL question.)
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
| `npm run test:coverage` | Vitest with coverage, against the floor in `vitest.config.ts` |
| `npm run soak` | Drive the built app over CDP and fail on playback stalls — see below |
| `npm run dist` | Build and package the app for the current platform (Linux AppImage, macOS dmg+zip, Windows NSIS) into `release/` |
| `npm run release` | The same, publishing to a GitHub release — CI's job, not yours |

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
    library/         parse · arcs · ffprobe · scanner · loudness (the background
                     R128 measuring job, not part of a scan)
    scheduler/       playable units · what plays next
    stream/          ffmpeg supervisor · loopback HTTP server · hwaccel (the three
                     encoder recipes + the startup probe) · loudness (the filter chain)
    services/        view models the renderer consumes · restore.ts
    ipc/handlers.ts  one handle() per IPC channel
  preload/index.ts   contextBridge — the only thing the renderer can see
  renderer/          React + TypeScript
    src/store.ts     the Zustand store; the `screen` field is the router
    src/utils.ts     errorText · plural · useBusyAction (the shared busy lock)
    src/screens/     Guide · Player · Library · Settings (+ Blackout)
    src/components/  AppBar · ChannelFold (the guide's editor) · ChannelNumber
                     AssignPanel · ArcBuilder · AddShowPanel · SeasonModeSeg
                     SleepPanel · Slider · Toggle
    src/hooks/       useTunedSection (the Settings rail's scroll spy)
    src/player/      mse.ts · pip.ts · stage.ts (all DOM-free) · VideoSurface.tsx
    src/styles/      tokens.css (design tokens) · global.css (shared chrome)
.husky/              the pre-commit hook — Biome over the staged files
.github/workflows/   ci.yml · release.yml · pages.yml — see "CI and releases" below
biome.json           formatter + linter config, the one source of style truth
resources/           the application icon — electron-builder's buildResources and the running window's icon
scripts/             soak.mjs (below) · coverage-badge.mjs · verify-native-abi.mjs
site/                the GitHub Pages landing page — static, no build step
tests/               Vitest — parser, arcs, units, scheduler, stream, repos, restore
  renderer/          the DOM suites: the Player's effect decisions, the guide's fold
  helpers/           db fixtures · media clips · the Electron stub (handlers.test.ts)
docs/                this documentation
```

## Conventions

- **ESM everywhere.** Import local modules with an explicit `.js` extension
  (`./parse.js`), shared modules via `@shared/…js`.
- **The renderer never touches the filesystem.** Everything goes through
  `window.rerun`, which is generated from `RerunApi`. To add a capability: add
  the method to `RerunApi`, then the channel name to `IPC`, then implement it in
  `preload/index.ts` and `main/ipc/handlers.ts`. Both sides fail to typecheck
  until you do.
- **All *writes* live in `db/repositories/`,** and rows are camel-cased there so
  no snake_case ever reaches the renderer. Read-model queries — joins written to
  shape one view — live beside their view model in `services/` and `scheduler/`
  rather than becoming one-caller repository functions named after screens.
- **No hardcoded colours in components.** Add a token to
  `renderer/src/styles/tokens.css` instead — including the inks that sit *on* a
  filled surface (`--amber-ink`, `--danger-ink`).
- **Schema changes are append-only.** Add an entry to `MIGRATIONS` in
  `db/schema.ts`; never edit an existing one. `PRAGMA user_version` tracks
  what's applied.
- **Style is not a matter of opinion.** [Biome](https://biomejs.dev) formats and
  lints everything, and the pre-commit hook enforces it — see below.

## The React Compiler

The renderer is built with the [React Compiler](https://react.dev/learn/react-compiler)
(`babel-plugin-react-compiler`, wired into `@vitejs/plugin-react` in
`electron.vite.config.ts`). It memoizes components and hooks automatically at
build time, so a store update no longer re-renders every screen that happens to
be mounted — each component re-renders only when the values it actually reads
change.

Three practical consequences:

- **Don't hand-memoize new code.** New components don't need `useMemo`,
  `useCallback` or `React.memo` for render performance; the compiler inserts the
  caching itself. The existing calls in `Library.tsx`, `ChannelFold.tsx` and
  friends are harmless — the compiler understands and preserves them — they're
  just no longer load-bearing. (`useCallback` can still be *semantically*
  required, e.g. a ref callback that must be stable across renders.)
- **It applies to `npm run dev` and `npm run build` alike**, so what you profile
  in dev is what ships. It does not run over `main/` or `preload/` — those have
  no React in them.
- **Tests run uncompiled.** Vitest transforms `.tsx` with esbuild
  (`vitest.config.ts`), not Babel, so `tests/renderer/` mounts the unmemoized
  components. That is fine — those suites assert which store actions effects
  pick, not render counts — but it means a memoization-dependent behaviour can't
  be pinned by a test there.

The compiler assumes the [Rules of React](https://react.dev/reference/rules).
When a component breaks them it is silently skipped rather than miscompiled, so
a rule violation costs the optimization, not correctness.

## Formatting and linting

One tool does both: **Biome**, configured in `biome.json`. It replaces what a
Prettier + ESLint pair would do, in one binary with no plugin graph, and it is
fast enough (~30ms over the whole repo) that the commit hook is unnoticeable.

The configuration is Biome's own defaults with three deliberate departures:

| | |
| --- | --- |
| `indentStyle: space`, `indentWidth: 4` | House style |
| `quoteStyle: double` | House style |
| `files.includes` excludes `docs` | Prose, not source. Biome has no Markdown handler today, so this changes nothing right now; it is kept so that whatever lands in `docs/` next isn't reformatted by a tool that doesn't know what it is. |
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
  is exactly the stall class [playback.md](playback.md) exists to describe.
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

`handlers.test.ts` is the one suite that loads Electron — as a stub. Vitest
aliases the `electron` module to `tests/helpers/electron.ts`, a recorder for
`ipcMain.handle` and `BrowserWindow.webContents.send` whose `dialog` methods
throw rather than return something plausible. That lets the *real*
`registerHandlers` run against a real in-memory database, which matters because
`handlers.ts` is the only glue between the subsystems and every other suite
either bypasses it or fakes it. Electron is a process boundary, so this is the
same class of fake as the preload bridge — not module mocking, which this repo
does not use anywhere.

`desktop-entry.test.ts` and `kwin-rule.test.ts` are both about writing into
directories that belong to the user's desktop, and both are variations on
*leave everything else exactly as it was*.

`hwaccel.test.ts` and `loudness.test.ts` are both mostly about **arg spelling**,
which sounds trivial and is not: an argument array that composes cleanly in
TypeScript and that ffmpeg then rejects is worth nothing. So the interesting
cases in both run the built command line through a real ffmpeg, and skip
themselves when there isn't one. Around that sit the pure halves — the quality
tier mapping and the device-enumeration order with an injected node lister, the
pre-gain arithmetic and the loudnorm JSON parser, and the measuring job's
stop/restart and back-off behaviour.

`restore.test.ts` is the exception that uses real files in a temp directory,
because the whole point of that module is filesystem behaviour — what survives a
rejected import, what gets copied before a swap, what happens to a stale WAL
sidecar. An in-memory database would test none of it.

`mse.test.ts` drives the MSE pump's box scanner and read/append/evict state
machine against bytes a real ffmpeg produced, with the exact arguments the stream
server uses. That works in Node only because `player/mse.ts` is deliberately
DOM-free and is listed in `tsconfig.node.json`, so a stray DOM reference fails the
build. `stage.test.ts` gets the same treatment for `player/stage.ts`: the
double-buffered handoff is a pure state machine, so the transition that makes a
handoff free — the standby slot keeping its *object identity* through a
promotion, which is what stops React remounting the element and discarding its
buffer — can be asserted directly rather than inferred from two elements in a
DOM harness. `handoff.test.ts` drives the store's schedule-advance logic against the
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

Three other shapes were considered and rejected, and each rejection is why this
one looks the way it does. **Extracting the decision into a DOM-free module** —
the `mse.ts` pattern this repo otherwise reaches for first — would have been
trivially correct while the real effect stayed broken, because the bugs were in
the *wiring*: dependency arrays, ref reads, event-to-state timing. **Booting
Electron in CI** inherits the `better-sqlite3` ABI dance plus a display server,
the two things `npm test` has deliberately stayed free of; real-Chromium
verification already has a home in the soak rig. And **trusting a DOM emulator's
`<video>`** is the trap the whole layer is built to avoid — a fake that fires
`ended` without a preceding `pause` happily passes the broken code. So the
element is *ours*, and the measured orderings live in the harness rather than in
a dependency.

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
[ui.md](ui.md#blackout--where-the-sleep-timer-leaves-you)).

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
file: `settings-rail.test.tsx`, `settings-hwaccel.test.tsx`,
`sleep-panel.test.tsx`, `guide-fold.test.tsx`, `library.test.tsx`.

`guide-fold.test.tsx` covers the Guide's fold-out channel editor
([ui.md](ui.md)) — one fold at a time, the keyboard path hover cannot serve,
and the two-step delete. Two things it does not assert, deliberately:

- **The row's fixed height under hover.** happy-dom lays nothing out, so every
  box is 0×0. That the controls and the show titles share one grid cell is a CSS
  fact and belongs to a real window, not to a DOM test.
- **Anything the fold's mutations do to the scheduler.** Those go over the bridge
  and are `scheduler.test.ts`'s job against a real database.

Two harness details are worth copying rather than rediscovering:

- **Keystrokes go to the focused row**, not to the list. The Guide's handler
  ignores keys whose target isn't a row, so that the fold's own inputs can own
  their `Escape`; a test that fired at the container would prove nothing.
- **React installs its own `value` setter on controlled inputs** and ignores a
  plain assignment, so typing has to call the native setter (`type()` in that
  file) or `onChange` never fires and the form stays empty.

## CI and releases

Three workflows in `.github/workflows/`, each with a different trigger.

**`ci.yml`** runs on every pull request *and* on `main` after a merge. Those are
not redundant: a PR run tests the branch head rather than its merge with `main`,
so two individually-green PRs can still merge into a broken `main`, and the push
run is the only thing watching the branch everyone builds on. It runs lint,
typecheck, the suite with coverage, and a production build, with
`RERUN_REQUIRE_FFMPEG=1` set — several suites skip themselves silently without a
real ffmpeg, and that variable turns the skip into a hard failure so a broken
install can never quietly turn the suite green.

The coverage badge in the README is regenerated by `scripts/coverage-badge.mjs`
and committed onto the PR branch, so the number arrives for review alongside the
code that moved it. Don't edit it by hand. On fork PRs the token is read-only and
the step skips itself, which is expected. The badge is a static shields.io URL
with the number baked in, so the README is self-describing — no gist, branch or
third-party service holds the real value.

**`release.yml`** fires on a `v*.*.*` tag, never on a merge. Cut one with:

```sh
npm version patch|minor|major && git push --follow-tags
```

`npm version` bumps `package.json` and creates the matching tag in one commit,
which is what keeps the two in step — the job refuses to publish if they
disagree, because electron-builder names the artifact from `package.json` and a
typo would otherwise ship a `v0.2.0` release containing a 0.1.0 build. A tag can
point at any commit, including one that never went through PR CI, so the job
re-runs lint, typecheck and the suite before building. The job is a three-OS
matrix: each runner builds and uploads only its own targets (Linux AppImage,
macOS dmg+zip for arm64 and x64, Windows NSIS installer) to the same GitHub
release. The macOS and Windows artifacts are unsigned — there is no developer
certificate in the pipeline — so first launch goes through Gatekeeper's
right-click-Open dance or SmartScreen's "run anyway".

Because `ci.yml` runs only on Ubuntu, this matrix is the first place macOS and
Windows run anything at all — a release can fail on a platform problem no PR
ever saw. The 0.1.2 release hit four of them in a row, and their fixes are now
part of the repo:

- **electron-builder must stay ≥ 26.** Version 25 bundled a node-gyp 9 that
  cannot find Python's `distutils` on the macOS runners (removed in Python
  3.12) or detect Visual Studio on the Windows runners, so `npm ci` itself
  failed. electron-builder 26 ships `@electron/rebuild` 4 with a current
  node-gyp.
- **`.gitattributes` pins LF** for everything git considers text. Without it,
  git's Windows default checks out CRLF and Biome's formatter check fails on
  every file before the tests even run.
- **Platform-specific suites skip themselves where they cannot mean anything.**
  The KWin-rule and desktop-entry suites test code that refuses to act off
  Linux, so they gate on `describe.runIf(process.platform === "linux")`. The
  encoder-job suite (`tests/stream-jobs.test.ts`) is excluded on Windows in
  `vitest.config.ts`: its ffmpeg stand-in is a shebang script, which Windows
  cannot spawn.
- **`verify-native-abi.mjs` names the binary per platform.** electron-builder's
  `packager.executableName` exists only for Linux; the Windows and macOS
  binaries are named after the product (`Rerun TV.exe`, `Rerun TV.app`).

**Check the release page after the run.** electron-builder's GitHub publisher
creates the release if it does not exist and otherwise attaches to it — but two
runners finishing the build at the same moment can *each* create one, and
GitHub happily holds two releases on the same tag, each with a partial asset
set. That happened on 0.1.2. `gh release view` shows only one of them, so
verify with:

```sh
gh api repos/NathanSMB/rerun-tv/releases \
    -q '.[] | .tag_name + " assets=" + (.assets|length|tostring)'
```

A full release has 14 assets: the AppImage, two dmgs, two zips, the installer,
their blockmaps, and `latest.yml`/`latest-mac.yml`/`latest-linux.yml`. If the
tag appears twice, download the smaller release's assets, upload them to the
other via `gh api --input`, and delete the duplicate — the assets are identical
builds, so which release survives does not matter.

**`verify-native-abi.mjs` is the interesting part of that job.** It is an
electron-builder `afterPack` hook that `dlopen`s every packed `.node` addon with
the *packed Electron binary* and fails the build on a `NODE_MODULE_VERSION`
mismatch. It exists because 0.1.0 shipped an AppImage that died on boot with
`ERR_DLOPEN_FAILED`: `npm test` had flipped `better-sqlite3` to the Node ABI,
`@electron/rebuild` read its own stale `.forge-meta` marker, concluded the module
was already built for Electron, and packaged the Node binary. Nothing before
packaging noticed, because every earlier step runs under Node — where the
wrong-ABI binary is the *correct* one. `rebuild:node` now clears that marker, and
this hook is the backstop if one slips through: the last point where a bad build
can still be stopped rather than shipped.

**`pages.yml`** publishes `site/` — a static landing page with no build step — to
GitHub Pages whenever it changes on `main`. It deploys via OIDC rather than
pushing a `gh-pages` branch, so there is no second copy of the page to drift from
the one in the repo.

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
