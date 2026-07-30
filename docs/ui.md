# The UI

`src/renderer/` — the implementation of [mockup.html](mockup.html) and
[plan.html](plan.html) §7–8. Five screens plus a blackout, all configuration
in-app, no config files.

## The design language

*Your library, running like it's Saturday, 1994.* The chrome is a tube-black
blue, panels borrow the indigo of the old cable guide channel, and everything
the "broadcast" says to you — channel numbers, episode codes, timecodes —
speaks in phosphor-amber mono, like a VCR's on-screen display.

| Token | Value | Used for |
| --- | --- | --- |
| `--tube` | `#0B0E14` | app background |
| `--panel` / `--panel-2` | `#141A2E` / `#1A2140` | surfaces, active nav |
| `--indigo` / `--indigo-hi` | `#28338F` / `#3A48C4` | selection, segmented control |
| `--amber` | `#FFB454` | the broadcast voice — dial numbers, codes, timecodes |
| `--white` | `#F0EFE6` | primary text (warm, not pure white) |
| `--steel` / `--steel-dim` | `#8D97B8` / `#5A6485` | secondary text, captions |
| `--signal` | `#59D999` | live/ready indicators |

Type: **Bricolage Grotesque** (display — the wordmark and dial numbers), **IBM
Plex Mono** (the broadcast voice), **Instrument Sans** (body). All three are
bundled from `@fontsource` rather than fetched from Google Fonts, so the app
works offline and the renderer's CSP can stay locked to `'self'`.

All of this lives in `src/renderer/src/styles/tokens.css`. Shared chrome — the
app bar, buttons, toggles, the channel banner — lives in `global.css`. **A
component should never contain a hex value**; add a token instead.

## The recurring signature: the channel banner

`components/ChannelBanner.tsx`. A dial number in amber display face, the show
title, and an amber-mono line: `S04E11 · DATA'S DAY · 44 MIN`. It appears in the
Guide's preview panel, on tune-in, and on **every episode handoff** — including
mid-arc, where it carries the part indicator, because an arc starting is the
thing the viewer most needs signalled.

## State

One Zustand store, `src/renderer/src/store.ts`. Its `screen` field is the router
— there are six screens and no URLs worth having. Components read slices with
`useStore(s => s.x)` and call store actions; they never call `window.rerun`
directly, with the deliberate exception of the screens doing one-off queries
(arc lists, episode lists) that aren't worth caching globally.

`init()` subscribes once to the three main→renderer push channels
(`scanProgress`, `libraryChanged`, `channelsChanged`), which is why the scan pill
ticks and the Library screen refreshes itself while a scan runs.

## The screens

### Guide — home

The channel lineup, read like a cable listing: big dial numbers, the channel
name, and **what the scheduler actually has on deck** for each — precomputed via
`peekNext`, so tuning in starts instantly and the line you read is the episode
you get. The right-hand aside previews the selected channel and offers *Tune in*
and *Edit channel*.

Channels are created, deleted and drag-reordered here. Reordering also works
from the keyboard (Alt+↑/↓) so it isn't mouse-only.

### Player — full-bleed video

The OSD — banner, transport, volume, skip, fullscreen — rises on mouse move or
key press and fades after the configured idle time.

Two behaviours are load-bearing plan decisions:

- **Fullscreen wraps the stage, not the video.** `requestFullscreen()` is called
  on a wrapper containing both the `<video>` and the OSD, so swapping the video
  `src` at an episode handoff never drops out of fullscreen.
- **Seeking depends on the playback path.** Direct-play files seek natively via
  `currentTime`; remuxed and transcoded streams are open-ended pipes, so a scrub
  loads a new URL with `?t=` and the player tracks the offset to keep the
  timecode honest.

Auto-advance fires the scheduler on `ended`, shows the banner briefly, and plays
on. In the last 30 seconds an *up next* toast appears while the next stream
pre-warms.

Keyboard map (plan §7): `Space` play/pause · `↑`/`↓` volume · `→` skip · `F`
fullscreen · `Esc` back to the guide · `M` mute · `S` sleep timer.

### The sleep timer

A moon button in the OSD row, or `S`. The first press arms
`settings.sleepTimerDefaultMin`; each press after that moves to the next preset
up — 15, 30, 45, 60, 90, 120 minutes — and past the last one it switches off. An
amber chip beside it counts down.

**It stops at the end of a playable unit, never mid-story.** Reaching the
deadline changes nothing on screen: the episode plays to its natural end, and if
that episode is part 2 of a three-parter, so do parts 2 and 3. Only then does the
channel shut down and the screen go black. Past the deadline the chip stops
counting and says where it will stop instead — *after this episode*, or *after
part 3* — because that is the question a viewer actually has at that point. See
[scheduler.md](scheduler.md#the-sleep-timer-stops-here-too) for why the renderer
can answer it without asking the main process.

Three consequences worth knowing:

- **The prewarm is suppressed** once the timer is due to stop after the current
  episode. Prewarming commits a real schedule step, and committing one for an
  episode nobody will watch means releasing it again a minute later. Cancel
  during that window and the prewarm fires late but still in time, so the handoff
  stays gapless.
- **Expiring while paused stops immediately**, since nothing is playing towards a
  boundary and a viewer who paused and didn't come back is the case the timer is
  for. This is the one path that stops mid-episode.
- **Leaving the player disarms it.** A timer that survived into the guide would
  fire against whatever you tuned into next.

The deadline is wall-clock (`sleepUntil`, epoch ms), compared at the moments that
matter rather than counted down, so Chromium's background-timer throttling can't
make it drift. The one-second interval exists only to repaint the chip, and only
runs while something is armed. Nothing is persisted: an armed countdown
surviving a restart would be a surprise, not a convenience.

### Blackout — where the sleep timer leaves you

`screens/Blackout.tsx`. Full window, no app bar, `#000` rather than `--tube`,
because the point is for an OLED to draw nothing and a dark room to stay dark.

By the time it mounts the channel is fully released — no video, no encoder, no
wake lock (the app has no `powerSaveBlocker`) — so the OS display-sleep policy
takes over. That inertness *is* the feature; a merely dark screen would hold the
display awake all night.

The one affordance, *Back to channels*, is hidden until the pointer moves, on the
same reveal-then-idle pattern the OSD uses and tuned by the same
`osdHideAfterS`. It is `tabIndex={-1}` and `aria-hidden` while hidden, so focus
can't land on an invisible control, and the cursor hides with it. `Esc` and
`Enter` do the same thing, so the exit is never mouse-only.

### Channel editor — where a channel gets its personality

Every scheduling knob from the plan is a visible control: per-show
**Shuffle / In order**, the lottery **weight**, the detected **arcs**, and the
live progress cursor or shuffle bag with a reset link. Counts are shown as
episodes *and* units, so it's visible that a 5-parter like *Awakening* holds
exactly one lottery ticket.

**Season overrides** sit behind a `<details>` per show, collapsed by default
with an "N active" badge, because most shows never need them and an always-open
list of 30 seasons would bury the controls that matter. Each season offers three
choices — *Use show*, *Shuffle*, *In order* — where the first is the absence of
an override rather than a third mode, and names the inherited setting inline
(*Use show (In order)*) so the effect is readable without looking up. That is
also why a show with no episodes shows no override list at all.

### Library — where files become television

The scan strip reports what's been probed and what was skipped. Each show shows
**how each of its files will play** — DIRECT / REMUX / TRANSCODE counts straight
from the scan-time probe — so you can see what will cost CPU before you tune in.
Anything the parser couldn't read waits in the **Unmatched** queue for manual
assignment. Arcs are reviewed and corrected here: ungroup a false positive, or
group any two or more episodes the heuristic missed, even across gaps or seasons.

### Settings — every knob in one place

Four cards: where the media lives, how it plays, how the interface behaves, and
what the system underneath is doing (ffmpeg version and path, the startup codec
check, the database and its size, with **Back up…** and **Import…** beside it).

Importing replaces everything, so the confirmation is a native dialog with
Cancel as the default button — and it's raised from the main process, because
that's the only side that can quote the counts and the missing-media check from
inside the file you picked. Afterwards the app restarts, which takes the status
banner with it, so the Database row grows a line saying what was restored and
where the previous database was saved. See
[backup-restore.md](backup-restore.md).

Post-MVP controls — hardware VAAPI encode — ship **visible but disabled**, so
the settings surface doesn't reshuffle as features land.

## Accessibility

Real `<button>`/`<select>`/`<input>` elements throughout; icon-only controls
carry `aria-label`; toggles are `role="switch"` with `aria-checked`; the scrub
and volume bars are keyboard-operable `role="slider"` widgets, not click-only
divs; the guide's selected row carries `aria-current`. Focus is always visible
(a 2px amber ring). Everything animated is guarded by
`prefers-reduced-motion`.
