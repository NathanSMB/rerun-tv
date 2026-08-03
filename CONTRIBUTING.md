# Contributing

Thanks for looking. This is a small, opinionated project — a television, not a
media manager — so the most useful thing before writing code is a quick issue
describing what you want to change and why.

## Getting set up

```sh
npm install
npm approve-scripts better-sqlite3 electron esbuild   # first install only
npm rebuild

npm run dev
```

You need **Node 20+** (CI runs 24; there's an `.nvmrc`), **ffmpeg** on `PATH`,
and a C toolchain for `better-sqlite3`.

**The one gotcha.** `better-sqlite3` is native, and Electron and Node use
different ABIs. `npm test` runs `npm rebuild better-sqlite3` to put it on the
Node ABI; `npm run dev` then fails until you run `npm run rebuild:electron`.
This is not a broken install — it is the price of testing main-process code in
plain Node, and `docs/development.md` explains it at length.

## Before you open a PR

```sh
npm run lint:fix    # Biome; a pre-commit hook checks (but never rewrites) staged files
npm run typecheck
npm test
npm run build
```

CI runs all four, plus coverage. `main` is protected: everything lands through a
pull request, and the merge is gated on a coverage floor (currently 75%,
configured in `vitest.config.ts`). The floor is a regression stop, not a target
— it moves up as coverage does, and it is not an invitation to write tests that
only touch lines.

The coverage badge in the README is committed automatically onto your PR branch
by CI, so don't update it by hand. (For fork PRs the token is read-only and the
step is skipped — that's expected.)

## How this codebase expects to be worked on

A few conventions carry more weight here than usual. They're all visible in the
code, but they're easier to follow if someone says them out loud:

- **Comments explain *why*, with evidence.** Nearly every non-obvious decision
  in this repo carries the measurement or the failure that motivated it — which
  Chromium behaviour was observed, what the encoder actually did, why the
  obvious approach was abandoned. This is the project's main onboarding asset.
  If you change such a decision, update the reasoning; if you add one, write the
  reasoning down. A PR that deletes a rationale comment along with the code it
  described will be asked to put it back somewhere.

- **Tests use no module mocking.** There is not a single `vi.mock` or `vi.fn` in
  the suite, and that's deliberate: it's what lets behaviour-preserving
  refactors happen without a test rewrite. Fakes exist only at genuine process
  boundaries — the preload bridge (`tests/renderer/bridge.ts`), Electron itself
  (`tests/helpers/electron.ts`), the media element and PiP models in
  `tests/renderer/harness.tsx`, and ffmpeg via real fixture clips. Inside those
  boundaries, tests run the real code against a real SQLite database, a real
  HTTP listener, and real ffmpeg output.

- **Renderer tests speak the harness's vocabulary.** `tests/renderer/harness.tsx`
  models measured browser behaviour (media element event ordering, PiP session
  transitions, fullscreen). Tests never hand-fire raw DOM events; they call the
  harness's verbs. If you need a new one, add it to the harness with a note on
  what was measured.

- **The tsconfig split is load-bearing.** `tsconfig.node.json` deliberately
  includes four renderer files (`player/mse.ts`, `player/stage.ts`, `store.ts`,
  `player/pip.ts`) to *enforce* that they stay free of DOM types — that's what
  lets the trickiest playback logic be tested in Node. If you add a DOM
  reference to one of those, the typecheck failure is the design telling you
  something, not a config bug.

- **State that several surfaces share lives in the store; a mutation only one
  screen makes is called on `window.rerun` by that screen, which then calls the
  matching `refresh…` action.** The re-read is what keeps the guide and the app
  bar from drifting away from an edit. See the header of
  `src/renderer/src/store.ts`.

- **Migrations are history.** Append to `MIGRATIONS` in
  `src/main/db/schema.ts`; never edit an entry that has shipped, and never build
  one out of a live constant.

## Layout

`docs/architecture.md` is the map. In short: `src/main` (Node — database,
scanner, scheduler, ffmpeg, the loopback stream server), `src/preload` (the one
typed bridge), `src/renderer` (React), `src/shared` (the IPC contract and the
playback decision both processes agree on).

## Reporting bugs

Include your distribution and desktop (especially if it's not KDE/Wayland),
whether the file plays in `mpv`, and the output of `npm run dev` with
`RERUN_DEBUG=1` if the problem is playback-related. `ffprobe` output for a file
that misbehaves is usually the fastest route to a fix.
