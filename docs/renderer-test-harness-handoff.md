# Handoff: a renderer test harness

**For the implementing agent.** You have fresh context; this document is your
brief. The mission: give this repo a way to catch renderer-side bugs — React
effects reacting to media-element state — in `npm test`, where today they are
invisible. Two such bugs shipped past a fully green suite during the sleep-timer
feature (July 2026) and were caught only by driving the real app. Plan the
approach yourself; this document gives you the evidence, the constraints, and
the acceptance bar.

Read first: `docs/development.md` (testing + the native-module gotcha),
`docs/playback.md` § "Two things Chromium does around `ended`",
`docs/ui.md` § "The sleep timer". The feature that motivated this is documented
in `docs/sleep-timer-plan.html` § "As built".

## The two bugs that motivate this

Both lived in one effect in `src/renderer/src/screens/Player.tsx`. Both were
invisible to all 300 passing tests. Both produced silently wrong data rather
than anything visible on screen.

The sleep timer has a "paused" branch: if the countdown expires while playback
is paused, stop immediately (nothing is playing toward a boundary). The naive
implementation keyed on the element's `paused` state:

```ts
useEffect(() => {
  if (!sleepExpired || !paused || failed) return
  void sleepNow()
}, [sleepExpired, paused, failed, sleepNow])
```

**Bug 1 — Chromium fires `pause` immediately before `ended`.** Measured in the
real app: same millisecond, and the element's `ended` property is already true
when the `pause` event fires. So at the close of *every* episode, `paused`
flipped true for an instant and this effect raced the `ended` handler
(`handleEnded` → `advance(true)`). When it won, the episode was torn down via
`sleepNow()`, which reports `completed: false` — a fully-watched episode logged
as abandoned. That flag is what shuffle bags read to avoid repeats
(`docs/data-model.md` § `play_log`), so the damage is real and deferred.

**Bug 2 — a promoted standby is paused for an instant.** The gapless handoff
(`docs/playback.md` § "Gapless handoffs") flips a hidden, buffered `<video>`
element to active; it is `paused` until `play()` takes effect, with
`ended` false. So a sleep timer that expired mid-arc hit the same effect at the
handoff into part 2 and blacked out — the *exact* behaviour the unit boundary
exists to prevent (the requirement is "finish the episode or the whole arc,
never stop mid-story"). The play log showed part 2 picked (a committed schedule
step) and abandoned within the same half-second. A seek's URL-reload produces
the same transient-pause shape.

**The fix** (current code, `Player.tsx` ~line 480): key on viewer *intent*
rather than element state. `wantsPlayRef` is set false only in `togglePlay` —
the one place a human asks to pause — and every transient pause leaves it true:

```ts
useEffect(() => {
  if (!sleepExpired || !paused || failed) return
  if (wantsPlayRef.current) return
  void sleepNow()
}, [sleepExpired, paused, failed, sleepNow])
```

Nothing in `npm test` exercises this guard. Delete the `wantsPlayRef` check, or
revert to keying on `paused` alone, and the suite stays green. That is the gap
you are closing.

## Why the existing suite cannot see these

The store's transition logic is thoroughly tested — `tests/handoff.test.ts`
drives the real scheduler over a real in-memory SQLite database with only the
IPC hop faked, including seven sleep-timer cases. But those tests call
`store.advance()` / `store.sleepNow()` *directly*. The bugs were in **which of
those two actions the Player decides to call**, and that decision lives in a
React effect fed by media-element events. The store tests start where the bug
ends.

The suite is Node-target Vitest (`vitest.config.ts`: `environment: 'node'`,
`include: tests/**/*.test.ts`) and never boots Electron or a DOM. That is a
deliberate, documented choice (`docs/development.md` § Testing) — don't discard
it lightly for the existing tests; whatever you add must coexist with it.

## What a harness must be able to express

Concretely, these scenarios, as automated regression tests:

1. **End-of-episode event ordering.** With the timer expired and an episode
   playing: fire `pause` (with `ended` already true on the element), then
   `ended`, in the same tick. Assert the path taken is `advance(true)` — never
   `sleepNow()`. This is bug 1; keying the paused branch on raw `paused` must
   turn this test red.
2. **Transient pause at a handoff.** With the timer expired mid-arc: promote a
   standby (active element briefly `paused`, `ended` false, while
   `wantsPlayRef` is true). Assert `sleepNow()` is not called and playback
   continues into the next part. This is bug 2.
3. **A genuine viewer pause.** `togglePlay()` then expiry. Assert `sleepNow()`
   *is* called — the guard must not be so strong the paused branch never fires.
4. **Prewarm suppression.** Enter the T−30s window with the timer expired on a
   unit-final episode: `prewarm()` must not be called. Cancel the timer inside
   the window: `prewarm()` must then fire (the deliberately-unset
   `prewarmedAfterRef`, `Player.tsx` ~line 430).

If the harness can express these four, it can express the next bug of this
class. Design for the class, not just these cases.

## Constraints and repo facts you need

- **The ABI dance.** `better-sqlite3` can be built for the Node ABI or the
  Electron ABI, not both (`docs/development.md` § "The one native-module
  gotcha"). `npm test` rebuilds for Node. Any approach that boots Electron in
  CI inherits this dance plus a display-server requirement — the repo has so
  far kept `npm test` free of both. The soak harness (`scripts/soak.mjs`)
  exists for real-Electron verification and its `--eval` mode can run whole
  scripted scenarios; "promote soak scenarios to a checked-in, runnable pack"
  is a legitimate *complement*, but the primary deliverable should run in
  `npm test` on a headless machine in seconds.
- **The store is DOM-free on purpose** (`store.ts` header comment): that is
  what lets `handoff.test.ts` run in Node. Don't break that property.
- **`Player.tsx` is one 900-line component** whose effects read refs
  (`wantsPlayRef`, `advancingRef`, `prewarmedAfterRef`) and media state
  (`paused`, `failed`, `sleepExpired`). You may restructure it — e.g. extract
  the decision logic into a testable unit — if that is your judgment; the
  four decisions in its file-header comment are load-bearing and documented,
  so preserve behaviour and the comment style (comments explain *why*, never
  narrate the diff).
- **`VideoSurface` owns the MSE pump** (`src/renderer/src/player/`);
  `mse.test.ts` already tests the pump in Node because `player/mse.ts` is
  deliberately DOM-free and listed in `tsconfig.node.json`. That is the repo's
  existing pattern for "make it testable by making it DOM-free" — consider
  whether the Player's decision logic can follow it before reaching for a DOM
  emulator. Both have costs: extraction risks a translation gap between the
  extracted logic and the real effect wiring (the wiring *was* the bug);
  jsdom/happy-dom risks faking media-element semantics wrongly — a fake
  `<video>` that fires `ended` without a preceding `pause` would happily pass
  bug 1's broken code. If you emulate, encode the *measured* Chromium ordering
  (pause-then-ended, same tick, `ended` already true during the pause
  handler), and cite `docs/playback.md` for it.
- **Versions:** React 19, TypeScript ~5.9, Vitest 3.2, `type: "module"`,
  electron-vite. Path aliases `@shared`/`@main` exist in `vitest.config.ts`;
  there is no `@renderer` alias there yet — `handoff.test.ts` imports the
  store by relative path.
- **No lint config exists.** `npm run typecheck` (both tsconfigs) and
  `npm test` are the gates. `tsconfig.web.json` covers `src/renderer`; if you
  add renderer tests under `tests/`, decide deliberately which tsconfig owns
  them so `noUnusedLocals` etc. still apply.

## Acceptance bar

- The four scenarios above exist as tests and run green in `npm test` on a
  headless machine, in seconds, with no Electron and no display.
- **Mutation check, performed and stated in your summary:** temporarily revert
  the paused-branch guard to key on `paused` without `wantsPlayRef` — bug 1's
  and bug 2's tests must go red; restore it — green. A harness whose tests
  cannot fail on the original bugs is decoration.
- Existing suite untouched and green; typecheck clean.
- `docs/development.md` § Testing updated to describe the new layer: what it
  covers, what it deliberately does not (real Chromium semantics stay with the
  soak harness), and how to write the next test in it.
- New dependencies are fine if justified; prefer the smallest set that meets
  the bar. Consistent with repo conventions throughout.

## Verification commands

```sh
npm test                      # full suite, Node ABI (rebuilds better-sqlite3)
npm run typecheck             # both tsconfigs
# Optional live cross-check (needs display; rebuilds for Electron ABI):
npm run build && npm run rebuild:electron
# sandbox a library copy first — see docs/development.md § "Running it against
# a throwaway library" — then drive scenarios via scripts/soak.mjs --eval
```
