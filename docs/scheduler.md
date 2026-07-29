# The scheduler

`src/main/scheduler/` — the implementation of [plan.html](plan.html) §5. This is
the heart of the app: when a channel needs its next episode (tune-in,
auto-advance, or skip), the scheduler runs a two-stage pick over the channel's
lineup.

## Playable units

`units.ts` builds a show's unit list:

> A unit is either **one standalone episode** or **an entire multipart arc**.

Episodes belonging to a `part_group` collapse into a single `arc` unit,
positioned at the arc's first part, holding its episode ids in `part_index`
order. Every other episode becomes its own `episode` unit. Units carry a stable
`key` — `ep:<id>` or `arc:<groupId>` — which is what shuffle bags and cursors
store, not episode ids.

### Why the lottery is over units, not episodes

If shuffle drew raw episodes, a three-part arc would hold three tickets. It
would start almost three times as often as any standalone episode — and could
start at Part 2.

| Sample show: 8 standalone episodes + one 3-part arc | Per-episode | Per-unit |
| --- | ---: | ---: |
| "The Gathering" arc (3 parts) | 27.3% (3 of 11) | **11.1%** (1 of 9) |
| Each standalone episode (×8) | 9.1% (1 of 11) | **11.1%** (1 of 9) |

Drawing units gives the whole arc exactly one ticket. `tests/scheduler.test.ts`
asserts this property directly against a seeded RNG.

## The algorithm

```
nextEpisode(channel):
  # 1 · An in-progress arc always wins — arcs are never interrupted
  if channel.active_group_id:
      return nextPart(channel)            # clears arc state after the last part

  # 2 · Pick a show (weighted; weights are per-show sliders in the editor)
  show = weightedRandom(channel.shows, by=weight)

  # 3 · Pick a unit within that show, by the show's mode
  if show.mode == sequential:
      unit = show.units[state.cursor]; state.cursor += 1   # wraps to 0 at the end
  else:  # shuffle — a dealt bag, so nothing repeats until all units have aired
      if state.shuffle_bag.isEmpty():
          state.shuffle_bag = shuffled(show.units, avoidFirst=lastAired)
      unit = state.shuffle_bag.pop()

  # 4 · Arcs enter as one unit and lock the channel until they finish
  if unit.isArc: channel.active_group_id = unit.id

  log(channel, unit.firstEpisode); return unit.firstEpisode
```

- **Sequential shows** keep a cursor over their unit list in season/episode
  order — after S01E03 airs, the next pick of that show is S01E04. The cursor
  wraps back to the pilot after the finale.
- **Shuffle shows** deal from a bag: every unit airs once before any repeats,
  and a freshly refilled bag never leads with the unit that just aired.
- **Skip** during an arc advances to the arc's next part (the arc still
  completes); skip otherwise triggers a fresh pick. Both are instant, because
  the decision needs no probing — the playback path is already on the row.

## The API

```ts
pickNext(db, channelId, rng?): Pick | null       // commits
peekNext(db, channelId, rng?): Pick | null       // side-effect free
resetProgress(db, channelId, showId): void
validateActiveArc(db, channelId): void
```

`peekNext` is what makes the guide's on-deck line and the player's up-next toast
honest: it shows the scheduler's *actual* next pick without consuming it. It
computes against a copy of the state rather than rolling back a transaction, so
there is no window in which a concurrent tune-in could observe the mutation.

`rng` is injectable so tests are deterministic; it defaults to `Math.random`.

## Durability

Every state transition — cursor advance, bag pop, arc lock, play-log write — is
a **single SQLite transaction**. `better-sqlite3` is synchronous, so there are
no await points inside a pick for another tune-in to interleave with.

An arc left dangling by a crash mid-airing is caught by `validateActiveArc`,
which runs at tune-in and clears an `active_group_id` pointing at a group that
no longer exists or an out-of-range part index. That's plan §10's mitigation,
implemented where it's cheapest to check.

Shuffle bags store unit keys rather than episode ids, so regrouping episodes
into an arc doesn't corrupt an in-flight bag: keys that no longer resolve to a
live unit are simply dropped when the bag is read.

## What the editor exposes

Every knob in the algorithm is a visible control on the Channel Editor
([ui.md](ui.md)): the `sequential | shuffle` segmented control, the weight
stepper, and a live progress line — `Shuffle bag: 31 of 82 units left this
cycle` or `Cursor at S01E04` — with a reset link. Counts are shown as episodes
*and* units, so it's visible that a 5-parter holds exactly one ticket.
