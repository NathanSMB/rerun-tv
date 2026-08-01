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
fullscreen · `Esc` back to the guide · `M` mute · `S` sleep timer · `P`
picture-in-picture.

### Picture-in-picture — the channel follows you

A PiP button in the OSD row, or `P`, floats the picture in an always-on-top
window (designed in [pip-plan.html](pip-plan.html)). It is *element* PiP —
Document PiP is not implemented in Electron 38, so there is no way to put our own
OSD in the floating window; the controls in it are Chromium's.

Three consequences are worth knowing before touching any of it:

- **Entering needs a user gesture; moving does not.** The request lives inside
  the click/key handler for that reason. A fresh entry outside a gesture throws
  `NotAllowedError`, which is why the session is *transferred* between the two
  stacked surfaces at a handoff and never closed and reopened —
  `player/pip.ts` exists to keep that invariant, and its `transferring` phase is
  what tells a transfer's `leavepictureinpicture` (fired on the old element)
  apart from the viewer closing the window.
- **Esc becomes "go and browse".** With the picture floating, leaving the player
  screen no longer stops the channel: `App.tsx` keeps the Player mounted and
  off-stage (`opacity: 0`, never `display: none` — a displayless element stops
  decoding, and the floating window is fed by that decoder), so streams,
  handoffs and the sleep timer all run on. Closing the window brings the picture,
  and the viewer, back to the player. `Esc` with nothing floating still leaves.
- **Chromium paints its own "Playing in picture-in-picture" over the blanked
  element**, outside the DOM and beyond styling. Our placard therefore says
  something else — which channel is in the window, and what can be done from
  here — rather than repeating it.

Both the button and `P` are refused nothing else: fullscreen and PiP are
mutually exclusive states of the same picture, so asking for one leaves the
other. A blackout closes the window — a floating window is a light source too.

#### Staying on top, and the Wayland problem

A floating window that anything can bury is not picture-in-picture, and on
Wayland that is exactly what it is: **a Wayland client cannot raise itself above
other clients** — there is no protocol for it. Chromium asks anyway and the
request is silently dropped; the window also has no titlebar, so there is no
window menu to fix it by hand either. Run the identical build through XWayland
and the same window arrives with `_NET_WM_STATE_ABOVE`, `STAYS_ON_TOP` and
`STICKY` already set, which KWin honours. Measured both ways on Plasma 6.

So **Settings → Interface → "Keep picture-in-picture above other windows"**
(Wayland sessions only, on by default) chooses the platform, and the app
**relaunches itself** with `--ozone-platform=x11` to apply it. The relaunch is
not a stylistic choice: Chromium initialises its Ozone platform during
browser-process startup, *before* the main script runs, so
`app.commandLine.appendSwitch('ozone-platform', …)` and
`ELECTRON_OZONE_PLATFORM_HINT` are both too late to have any effect from inside
the app. The setting is mirrored to `~/.local/share/rerun-tv/boot.json`
(`main/boot-config.ts`) because it must be readable before the database opens.
Turning it off costs the pinning and buys back native Wayland rendering.

**In `npm run dev` the app does not relaunch — the dev script picks the platform
instead** (`scripts/dev.mjs`). It has to be that way round: `electron-vite dev`
owns the Electron process and treats it exiting as the app closing, so a
relaunch takes the dev server down and leaves the new window pointed at a
`localhost` that has stopped listening — a blank app. The script reads the same
`boot.json` and forwards `--ozone-platform=x11` after `--`, which is how
electron-vite passes arguments through to Electron. Two things that look like
they should work and do not: appending the flag before `--` (electron-vite
rejects options it does not know) and `ELECTRON_OZONE_PLATFORM_HINT=x11`
(ignored outright by Electron 38.8.6 — measured; the flag is the only lever).

#### Beating a full-screen window

Pinning is not enough on its own: KWin stacks an *active* full-screen window
above everything in the "keep above" layer, so a full-screen game covers the
floating window anyway. Nothing a client can ask for escapes that — the layers
that outrank it are assignable only from a **window rule**.

So on KDE the app writes one (`main/kwin-rule.ts`), tied to the same setting:

| Field | Value |
|---|---|
| Window class (application) | Unimportant |
| Window types | Normal window |
| Window title | Exact match → `Picture in picture` |
| Layer | Force → Overlay |

Matching is by title because Chromium's PiP window carries **no `WM_CLASS` and
no window role** — measured. That is slightly broad: another Chromium-based
browser's PiP window shares the title and would be lifted too.

The rule is one group in `~/.config/kwinrulesrc` with a fixed id, so writing it
is idempotent; every other rule in the file is preserved byte-for-byte, and
switching the setting off removes ours and nothing else (`tests/kwin-rule.test.ts`
pins the round trip). KWin is asked to reload over D-Bus, so it applies without
logging out. Off KDE, none of this happens.

Doing it by hand instead: System Settings → Window Management → Window Rules →
Add New… There is no titlebar to right-click, so the usual route (right-click →
Configure Special Window Settings) does not exist for this window.

`nexttrack`, `play` and `pause` are registered as Media Session actions, which is
what puts a skip button in the floating window's controls and, on Linux, wires
the keyboard's media keys through MPRIS.

### The sleep timer

A moon button in the OSD row, or `S`, which opens the **sleep panel**
(`components/SleepPanel.tsx`, designed in
[sleep-dial-plan.html](sleep-dial-plan.html)). An amber chip beside the moon
counts down whenever something is armed.

The panel is a dial from off to five hours (`SLEEP_MAX_MIN`) in five-minute
detents, so any bedtime is one drag away rather than a preset it happens to land
on. Its readout says what the number *means* — "1h 35m · off around 12:09 AM —
lets the episode finish" — because the wall-clock time is the thing a viewer
actually has in mind.

| Input | Does |
|---|---|
| `S` / moon click | Opens the panel, arming `settings.sleepTimerDefaultMin` if the timer was off — so "give me the usual" is still one press. Again to close. |
| Wheel over moon, chip or panel | ±5 minutes, without opening anything. |
| Drag on the dial | Any duration; the left edge disarms. |
| `←`/`→` | ±5 minutes (the dial's own step). |
| `↑`/`↓` | ±30 minutes. |
| `0`–`9` | Typed minutes, committed after ~900 ms or as soon as no further digit could change the answer. `0` switches it off. |
| Chips | Off · After this ep · 30m · 1h · 2h · 3h · 5h. |
| `Enter` / `Esc` | Close. There is nothing to cancel — see below. |

Three things about the panel are deliberate:

- **Edits commit live and closing never discards**, exactly like the volume
  track. The armed timer is the state; an editing buffer with a confirm step
  would be a second source of truth for a number already on screen.
- **The dial reads time *remaining*, not the figure the timer was armed with.**
  `adjustSleep` shifts the deadline for the same reason: a viewer forty minutes
  into an armed hour who scrolls up wants five more minutes of television, not a
  deadline recomputed from the original hour and therefore already in the past.
- **"After this ep" arms zero minutes** — an already-due timer — so the stop is
  produced by the ordinary unit boundary below rather than by a second code path.
  Pressed mid-arc it still plays the arc out, which is why it is not special-cased
  into "stop here".

Arrow keys reach the dial rather than the player because the panel handles them
first: `→` is skip-episode in the player's own map, and the window-level handler
already ignores anything with a `[role="slider"]` in its target chain.

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
  fire against whatever you tuned into next. The panel goes with the rest of the
  chrome when the OSD fades, for the same reason.

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
