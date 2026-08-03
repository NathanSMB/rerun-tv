# The scheduler

`src/main/scheduler/`. This is
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

### The sleep timer stops here too

Units are also what makes "sleep at the end of an episode or arc, never in the
middle of one" a one-line question, answerable **in the renderer, with no extra
IPC**:

```ts
const endsUnit = arc === null || arc.partIndex >= arc.partCount
```

`NowPlaying.arc` already carries `partIndex`/`partCount` for the banner, and is
null for a standalone episode — including a single-episode part group, since the
lock below only engages when `partCount > 1`. So the unit boundary is on screen
already; the sleep timer just reads it (`endsPlayableUnit` in the store).

Nothing in `src/main/` changed to support the feature. Mid-arc the timer takes no
action at all: the arc lock hands out the next part exactly as it would have, and
the question gets asked again when *that* part ends. See
[ui.md](ui.md#the-sleep-timer).

## The algorithm

```
nextEpisode(channel):
  # 1 · An in-progress arc always wins — arcs are never interrupted
  if channel.active_group_id:
      return nextPart(channel)            # clears arc state after the last part

  # 2 · Pick a show (weighted; weights are per-show sliders in the editor)
  show = weightedRandom(channel.shows, by=weight)

  # 3 · Pick a unit within that show, by its mode plus any per-season overrides
  mode(season) = seasonOverride(channel, show, season) or show.mode
  if no unit's season resolves to shuffle:
      unit = show.units[state.cursor]; state.cursor += 1   # wraps to 0 at the end
  else:  # a dealt bag, so nothing repeats until all units have aired
      if state.shuffle_bag.isEmpty():
          state.shuffle_bag = deal(show.units, mode, avoidFirst=lastAired)
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

## Per-season overrides

A season can override its show's mode (`channel_show_season_modes`, see
[data-model.md](data-model.md)); a season with no row inherits. The motivating
case is the show you want to *start* properly and then let run: seasons 1–8 in
order, everything after that shuffled, on one channel, without splitting the
show in two.

The two clean cases are unchanged — all-sequential walks the cursor,
all-shuffle deals an ordinary bag. The interesting case is **mixed**, and it is
where the design has a real constraint: a cursor and a bag cannot both be the
show's progress, so a show with any shuffled unit is dealt from a bag.

`dealMixedBag()` makes an ordered season survive that:

1. Shuffle **every** unit's slot, ordered seasons included.
2. For each sequential season, collect the slots its units landed in and write
   that season's units back into them **in airing order**.

An ordered season therefore keeps its slots — so it stays interleaved with the
shuffled material at the same frequency — while its own episodes always play
S01E01, S01E02, S01E03 relative to each other. A bag still holds every unit
exactly once, so the no-repeat-until-the-cycle-ends promise is intact, and an
ordered season restarts at its first episode each cycle.

One promise is deliberately weaker here. "A fresh bag never leads with the unit
that just aired" can only be kept by *swapping* the offender to a later slot,
and swapping an ordered season's unit would break the order the override was
asked for. So the swap is attempted only between shuffled units; a mixed show
can open a cycle by repeating an ordered season's episode. That is a rare
cycle-boundary artefact, and the alternative is silently disobeying the setting.

### One resolver, two callers

`planShowModes(db, channelId, showId, showMode, units)` resolves overrides and
returns `usesBag` / `allShuffle`. Both the scheduler and `getChannelDetail()`
call it, because the editor has to *describe* the model the scheduler *keeps* —
if the editor says "shuffle bag: 12 of 40" for a show being walked by a cursor,
the reset link and the progress line are both lying.

The flags are computed over **units**, never over the `episodes` table. Those
disagree: a cross-season arc is one unit under the season of its first part, so
a season whose every episode belongs to such an arc has episodes but no units,
and an override on it changes nothing. Deriving the answer twice is exactly how
those two views drifted apart once already.

## The API

```ts
pickNext(db, channelId, rng?): Pick | null           // commits
peekNext(db, channelId, rng?): Pick | null           // side-effect free
reserveNext(db, channelId, rng?): Pick | null        // plans, holds, commits nothing
promoteReserved(db, channelId, episodeId): void      // commits a held reservation
discardReserved(db, channelId, episodeId?): void     // abandons one, cost-free
resetProgress(db, channelId, showId): void
validateActiveArc(db, channelId): void
```

`peekNext` is what makes the guide's on-deck line and the player's up-next toast
honest: it shows the scheduler's *actual* next pick without consuming it. It
computes against a copy of the state rather than rolling back a transaction, so
there is no window in which a concurrent tune-in could observe the mutation.

The reservation trio serves the gapless handoff. A prewarm needs to know *the*
next episode ~30s early so the standby player can buffer it, but the viewer may
still leave before it airs — so `reserveNext` plans the pick and parks the
mutations in memory, `promoteReserved` applies them (in the usual single
transaction) when the handoff really happens, and a discarded reservation
leaves no trace: no cursor advance, no bag pop, no play-log row, and no arc
lock for a part nobody watched. Reservations are deliberately in-memory — a
crash forgets them, which is the correct recovery, since nothing was committed.
While one is outstanding, `peekNext` reports it and `pickNext` supersedes it.

`rng` is injectable so tests are deterministic; it defaults to `Math.random`.

## Durability

Every state transition — cursor advance, bag pop, arc lock, play-log write — is
a **single SQLite transaction**. `better-sqlite3` is synchronous, so there are
no await points inside a pick for another tune-in to interleave with.

An arc left dangling by a crash mid-airing is caught by `validateActiveArc`,
which runs at tune-in and clears an `active_group_id` pointing at a group that
no longer exists or an out-of-range part index. That is the whole mitigation for
scheduler state corruption
([architecture.md](architecture.md#risks-and-what-answers-them)), implemented
where it's cheapest to check.

Shuffle bags store unit keys rather than episode ids, so regrouping episodes
into an arc doesn't corrupt an in-flight bag: keys that no longer resolve to a
live unit are simply dropped when the bag is read.

## What the editor exposes

Every knob in the algorithm is a visible control in the channel fold-out — the
editor that unfolds under a row in the Guide ([ui.md](ui.md)): the
`sequential | shuffle` segmented control, the weight
stepper, the collapsible **Season overrides** list, and a live progress line —
`Shuffle bag: 31 of 82 units left this cycle` or `Cursor at S01E04` — with a
reset link. Counts are shown as episodes *and* units, so it's visible that a
5-parter holds exactly one ticket.

Changing a mode — the show's or a season's — **clears the shuffle bag** when
overrides are in play, because a bag already dealt under the old rules has its
ordered seasons baked into it. The cursor is left alone: it is an index into the
unit list, still meaningful under either mode, so a show flipped to shuffle and
back resumes where it was.
