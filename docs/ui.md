# The UI

`src/renderer/`. Four screens plus a blackout, all configuration in-app, no
config files.

The original design had a fifth: a standalone **Channels** screen, reached from
its own app-bar tab. It is gone — channel editing now unfolds inside the Guide,
described under *Guide* below.

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

The mark — an amber rewind-loop around a play triangle — exists in two cuts.
The glowing one without a background (`renderer/src/assets/header-icon.png`)
sits left of the wordmark in the app bar. The one on the rounded navy tile is
the application icon, `resources/icon.png` — electron-builder's buildResources
directory and the running window's icon both point at the same file. On Wayland a window cannot present its own icon at all —
the compositor looks one up from a desktop entry matching the window's `app_id`
(`rerun-tv`, derived from the package name) — so boot installs
`~/.local/share/applications/rerun-tv.desktop` pointing at a stable copy of the
tile, the same write-it-ourselves move as the window rule below
(`main/desktop-entry.ts`).

## The recurring signature: the channel banner

A dial number in amber display face, the show title, and an amber-mono line:
`S04E11 · DATA'S DAY · 44 MIN`. It appears on tune-in and on **every episode
handoff** — including mid-arc, where it carries the part indicator, because an
arc starting is the thing the viewer most needs signalled.

It lives in the Player (`.banner` in `global.css`). There was also a
`ChannelBanner` component, whose only other caller was the Guide's preview aside;
removing that aside left it with one consumer, so it was folded back into the
Player rather than kept as shared chrome with a single user.

## State

One Zustand store, `src/renderer/src/store.ts`. Its `screen` field is the router
— there are five screens and no URLs worth having. Components read slices with
`useStore(s => s.x)` and call store actions; they never call `window.rerun`
directly, with the deliberate exception of the screens doing one-off queries
(arc lists, episode lists) that aren't worth caching globally.

`init()` subscribes once to the three main→renderer push channels
(`scanProgress`, `libraryChanged`, `channelsChanged`), which is why the scan pill
ticks and the Library screen refreshes itself while a scan runs.

`startScreen` is read through a coercion (`startScreenOf`) rather than used
directly. Settings are a loose key–value table merged over `DEFAULT_SETTINGS`
(see [data-model.md](data-model.md)), so nothing rejects a value naming a screen
that no longer exists — an install that started on the retired Channels screen
would otherwise boot to a screen the shell cannot render. Unknown values fall
back to the Guide.

## The screens

### Guide — home

The channel lineup, read like a cable listing: big dial numbers, the channel
name, and **what the scheduler actually has on deck** for each — precomputed via
`peekNext`, so tuning in starts instantly and the line you read is the episode
you get. It is one full-width column; there is no preview aside.

Channels are created, edited, deleted and drag-reordered here — this is the only
place channels are managed. Reordering also works from the keyboard (Alt+↑/↓) so
it isn't mouse-only.

#### Hot rows, and the fold-out editor

The design that retired the standalone Channels screen — and the Guide's preview
aside with it, so the lineup is now one full-width surface. Three decisions carry
it:

- **Controls surface under the pointer.** Hovering a row replaces its mono
  show-title block with two buttons: **▶** tunes straight in, **✎** unfolds that
  channel's editor. Any row, one click, no selection step first.
- **The row never changes height.** Titles and controls are placed in the *same*
  grid cell (`Guide.css`) and swapped by visibility, not by adding a box. This is
  the whole point of the design — the list has to stay perfectly still while the
  pointer travels down it, or hovering becomes a hazard rather than a shortcut.
- **Hover is a shortcut, never the only path.** A pointer is one input among
  several, so the same two verbs are on the keyboard: `Enter` tunes the
  highlighted row, `E` unfolds it, `Esc` folds it shut. Below 860px, where hover
  isn't a reliable signal, the controls simply stay visible and the titles yield
  the column.

Those shortcuts are bare letters, which are also ordinary text — so everything
except `Esc` is ignored unless the *row* has focus. Typing "e" into the fold's
library search would otherwise fold the editor shut mid-word. `Esc` is the
exception because the way out shouldn't depend on where focus is sitting: it
closes the fold from anywhere inside it, and controls that want it for themselves
(the rename field abandoning a draft, a non-empty search clearing) stop it
propagating and get first refusal.

The fold itself (`components/ChannelFold.tsx`) is the old Channels screen's
content, compressed to one strip per show and given a library-picker column
beside it. **Only one fold is open at a time** — ✎ on another row moves it — and
that is load-bearing rather than tidiness: the store holds a single
`channelDetail`, so two open folds would render one channel's lineup under two
different headings.

Opening a fold also moves the *selection* to that row. Letting the two drift
apart is how `Alt+↑/↓` ends up reordering a channel other than the one on screen.

**+ New channel** creates the channel and unfolds it immediately, since a channel
with no shows cannot air and the lineup is the only useful next step.

Pinned by `tests/renderer/guide-fold.test.tsx`.

### The channel fold-out — where a channel gets its personality

`components/ChannelFold.tsx`, reached with **✎** on a guide row (see *Guide*
above). Not a screen: it unfolds beneath the channel it edits, and every change
is applied immediately — there is no save button and no draft state.

Every scheduling knob from the plan is a visible control: per-show
**Shuffle / In order**, the lottery **weight**, the detected **arcs**, and the
live progress cursor or shuffle bag with a reset link. Counts are shown as
episodes *and* units, so it's visible that a 5-parter like *Awakening* holds
exactly one lottery ticket.

Renaming, renumbering and deleting sit together on one line at the top, because
they are the three things that act on the *channel* rather than on its lineup.
Name and number are click-to-edit pills rather than standing form fields, so the
line reads as a heading until you reach for it.

**Deleting is a two-step, inline.** The button arms a confirm in place —
*Delete for good* / *Keep* — and moves focus onto it, so a stray `Enter` can't
land on the destructive control. It is not a `window.confirm`: Electron doesn't
implement it. It isn't a modal either, since a dialog would cover the lineup the
viewer is being asked to weigh. Deleting closes the fold, and the store drops any
editor left pointing at a channel that no longer exists — a channel can also
vanish underneath an open fold via a `channelsChanged` push after a restore.

**Season overrides** sit behind a `<details>` per show, collapsed by default
with an "N active" badge, because most shows never need them and an always-open
list of 30 seasons would bury the controls that matter. Each season offers three
choices — *Use show*, *Shuffle*, *In order* — where the first is the absence of
an override rather than a third mode, and names the inherited setting inline
(*Use show (In order)*) so the effect is readable without looking up. That is
also why a show with no episodes shows no override list at all.

### Player — full-bleed video

The OSD — banner, transport, volume, skip, fullscreen — rises on mouse move or
key press and fades after the configured idle time.

Two behaviours are load-bearing plan decisions:

- **Fullscreen wraps the stage, not the video.** `requestFullscreen()` is called
  on a wrapper containing both the `<video>` and the OSD, so swapping the video
  `src` at an episode handoff never drops out of fullscreen. The one thing the
  wrapper cannot survive is its own unmount — which is what going dark does — so
  the sleep path hands fullscreen to the document root first; see the Blackout
  section below.
- **Seeking depends on the playback path.** Direct-play files seek natively via
  `currentTime`; remuxed and transcoded streams are open-ended pipes, so a scrub
  loads a new URL with `?t=` and the player tracks the offset to keep the
  timecode honest.
- **Tuning in resumes where the channel was.** Leaving mid-episode and coming
  back returns to the same episode and offset rather than the top of a new one;
  a channel with no saved place still starts fresh. The two seek mechanisms
  above are exactly the two ways a resume is applied, and the offset is what
  keeps the timecode reading the real position on the piped paths. See
  [playback.md](playback.md#resuming-a-channel).

Auto-advance fires the scheduler on `ended`, shows the banner briefly, and plays
on. In the last 30 seconds an *up next* toast appears while the next stream
pre-warms.

Keyboard map: `Space` play/pause · `↑`/`↓` volume · `→` skip · `F`
fullscreen · `Esc` back to the guide · `M` mute · `S` sleep timer · `P`
picture-in-picture.

`Esc` also has a clickable twin: a back chevron beside the channel banner,
shown whenever the banner is — including the tune-in flash, so a mis-dialled
channel can be left the moment the number appears. It follows the same PiP
split as `Esc` (below); the one difference is fullscreen, which it exits *and*
leaves in a single press, where Chromium spends the first `Esc` on fullscreen
alone.

### Picture-in-picture — the channel follows you

A PiP button in the OSD row, or `P`, floats the picture in an always-on-top
window. It is *element* PiP, so
there is no OSD of ours in the floating window; the controls in it are
Chromium's. (Document PiP was broken in Electron 38, which forced that choice;
as of Electron 43 `documentPictureInPicture.requestWindow()` works, so floating
a surface with our own OSD is now an *option* — the element approach below is
simply what is built.)

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

Three smaller decisions, each of which someone will otherwise rediscover:

- **A dead stream exits PiP.** A failed episode in the floating window is a
  frozen frame with no explanation, because the Retry/Skip card is drawn in the
  main window where nobody is looking. So a stream error with PiP active brings
  the picture home first.
- **Chromium's own overlay pause has to count as a human pause.** It drives the
  same element without going through our OSD, so it must clear `wantsPlayRef`
  through the `pause` event path — otherwise the sleep timer's
  expired-while-paused rule can't see it. Both close buttons (`✕` and "back to
  tab") are likewise indistinguishable to us: they fire the same
  `leavepictureinpicture`, so there is one rule for both, and no attempt to guess
  intent.
- **Auto-PiP on minimize is deliberately not built.** The renderer cannot do it —
  a fresh entry needs a gesture. The main process *could* fake one
  (`webContents.executeJavaScript(code, /* userGesture */ true)` on the minimize
  event), and that is written down here so nobody rediscovers it as a clever
  idea: shipping a synthetic-gesture workaround for a Chromium policy is the kind
  of cleverness this codebase has learned to distrust.

Window geometry is Chromium's: it sizes the float from the video's aspect ratio
and remembers a resize per origin, so there is nothing for us to persist.

#### Staying on top: one window rule

A floating window that anything can bury is not picture-in-picture, and
**nothing the app can say from inside itself fixes that**. On Wayland a client
cannot raise itself above other clients at all — there is no protocol for it, so
Chromium asks and the request is silently dropped. On X11 it can ask, and
`_NET_WM_STATE_ABOVE` lands it in KWin's "keep above" layer — which an *active*
full-screen window still outranks, so a game covers it anyway. Either way the
layers that beat a full-screen window are assignable only by the compositor,
from a **window rule**. The floating window has no titlebar either, so there is
not even a window menu to fix it by hand.

So on KDE the app writes the rule itself, on every boot (`main/kwin-rule.ts`):

| Field | Value |
|---|---|
| Window class (application) | Unimportant |
| Window types | Normal window |
| Window title | Exact match → `Picture in picture` |
| Layer | Force → Overlay |

Because KWin enforces the rule rather than the client requesting it, **it works
the same on Wayland and on X11** — which is why it is the whole mechanism, with
no setting attached. There is nothing to turn on and nothing to restart for.

> An earlier build also relaunched itself onto XWayland with
> `--ozone-platform=x11`, chosen by a "Keep picture-in-picture above other
> windows" setting mirrored to `~/.local/share/rerun-tv/boot.json`. It bought
> `_NET_WM_STATE_ABOVE` — a strict subset of what the rule already does — and
> cost per-monitor DPI and crisp fractional scaling for it. All of it is gone;
> boot deletes the stale setting row and `boot.json` on the way past. If
> Chromium ever ships the xdg-pip protocol KWin has supported since Plasma 6.5,
> the rule goes too and PiP is kept above natively.

Matching is by title because Chromium's PiP window carries **no `WM_CLASS` and
no window role** under XWayland — measured. That is slightly broad: another
Chromium-based browser's PiP window shares the title and would be lifted too.

The rule is one group in `~/.config/kwinrulesrc` with a fixed id, so writing it
is idempotent; every other rule in the file is preserved byte-for-byte, and the
removal half round-trips exactly (`tests/kwin-rule.test.ts` pins both). KWin is
asked to reload over D-Bus, so it applies without logging out. Off KDE, none of
this happens — and with no XWayland fallback left, a non-KDE Wayland compositor
gets an ordinary floating window.

To remove or edit it: System Settings → Window Management → Window Rules, where
it appears as "Rerun TV — picture-in-picture above full-screen windows". The app
will write it again on its next start. Adding one by hand instead is the same
screen → Add New…; there is no titlebar to right-click, so the usual route
(right-click → Configure Special Window Settings) does not exist for this
window.

`nexttrack`, `play` and `pause` are registered as Media Session actions, which is
what puts a skip button in the floating window's controls and, on Linux, wires
the keyboard's media keys through MPRIS.

### The sleep timer

A moon button in the OSD row, or `S`, which opens the **sleep panel**
(`components/SleepPanel.tsx`). An amber chip beside the moon counts down whenever
something is armed.

It replaced a press-to-cycle button over six presets, where arming two hours cost
five presses and anything above two hours or between presets was unreachable. The
dial makes all 61 durations one gesture, and the first press still arms the
configured default, so the fast path survived the change.

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

**A fullscreen viewer stays fullscreen.** Fullscreen belongs to the Player's
stage wrapper, and going dark unmounts the Player — removing the fullscreen
element is itself enough to drop fullscreen, which would hand a dark room its
taskbar back. So `goDark` re-targets fullscreen to the document root *before*
flipping the screen (legal without a gesture while a session exists — the same
allowance PiP transfers rely on), and the blackout inherits it. The Player's
teardown still exits fullscreen when leaving for the guide, but only when the
stage is still the fullscreen element, so it cannot undo the handoff.

The bug this fixes had two sufficient causes, which is why the fix is in two
places: removing the fullscreen element from the DOM makes Chromium exit
fullscreen on its own (spec behaviour, not a bug), *and* the Player's cleanup
called `exitFullscreen()` unconditionally on unmount. Both are pinned from both
sides — `tests/handoff.test.ts` asserts the store asks for the handoff while the
screen is still `player`, and `tests/renderer/blackout-fullscreen.test.tsx`
mounts both screens across the swap. The fallback, had Chromium refused the
gesture-less re-target, was window fullscreen from the main process; it was never
needed, and it would have mixed the app's two fullscreen systems.

The one affordance, *Back to channels*, is hidden until the pointer moves, on the
same reveal-then-idle pattern the OSD uses and tuned by the same
`osdHideAfterS`. It is `tabIndex={-1}` and `aria-hidden` while hidden, so focus
can't land on an invisible control, and the cursor hides with it. `Esc` and
`Enter` do the same thing, so the exit is never mouse-only. Leaving drops
fullscreen on the way out — the guide is a windowed screen — with one asymmetry
inherited from Chromium: in fullscreen the browser swallows `Esc` to exit
fullscreen (as on the Player), so `Esc` out of a fullscreen blackout takes two
presses where `Enter` or the button take one.

### Library — where files become television

The scan strip reports what's been probed and what was skipped. Each show shows
**how each of its files will play** — DIRECT / REMUX / TRANSCODE counts straight
from the scan-time probe — so you can see what will cost CPU before you tune in.
Anything the parser couldn't read waits in the **Unmatched** queue for manual
assignment. Arcs are reviewed and corrected here: ungroup a false positive, or
group any two or more episodes the heuristic missed, even across gaps or seasons.

### Settings — every knob in one place

Four sections — where the media lives, how it plays, how the interface behaves,
and what the system underneath is doing (ffmpeg version and path, the startup
codec check, the database and its size, with **Back up…** and **Import…** beside
it) — laid out as stops on a **tuning rail**: numbered 01–04 down a sticky dial
on the left, one flat column of rows on the right. They used to be four cards in
a two-column grid, which stopped working once Playback grew to twice the height
of Library: no arrangement of quadrants hides that, one column always ends early
and leaves a hole in the page. A single column has no such seam.

Two other layouts were drawn before the rail won: **menu pages**, where each
section is its own page behind a tab strip, and a **program log**, one long
scroll with each section collapsed to a summary line until opened. Both hide
rows behind a click, which is the wrong trade for a screen whose job is to show
every knob at once.

The rail lights the section you're reading and jumps to one on click. Its spy is
scroll-position based rather than an `IntersectionObserver`, for the sake of the
last stop: System is shorter than the window, so it never reaches the reading
line and an observer leaves the dial stuck on 03 with System filling the screen.
Reaching the end of the scroll *is* the arrival signal, and only a scroll
position can say that — guarded on the page actually scrolling, since on a window
tall enough to hold everything the end of the scroll is also the top of the page.
Under the numbers sits the one line of system state worth seeing from every
section: ffmpeg missing or a failed codec check, the two faults that stop
playback outright. Pinned by `tests/renderer/settings-rail.test.tsx`.

Importing replaces everything, so the confirmation is a native dialog with
Cancel as the default button — and it's raised from the main process, because
that's the only side that can quote the counts and the missing-media check from
inside the file you picked. Afterwards the app restarts, which takes the status
banner with it, so the Database row grows a line saying what was restored and
where the previous database was saved. See
[backup-restore.md](backup-restore.md).

**Hardware encode & decode** is a three-way choice — Software (libx264), VAAPI,
NVENC — and it only affects episodes on the transcode path; direct and remux
playback never re-encode video. Each option is annotated with what the startup
probe found ("available", "not detected"), but every option stays *selectable*:
a probe can be wrong, and a backend this machine can't honour simply falls back
to software at stream time. The System section reports both backends' verdicts
and the render node VAAPI proved out. See
[playback.md](playback.md#hardware-encode--decode).

**The ffmpeg rows** answer three questions in order: which binary is running
(version, path, and whether it is the managed copy, the system one, or nothing),
whether a managed copy exists, and whether there is a newer one. The two are
reported separately because they can disagree — a managed copy is installed and
`RERUN_FFMPEG_PATH` is pinning something else — and a card that showed only the
winner would tell someone with an update on disk that nothing was installed.
Download / Reinstall / Check for updates / ✕ sit on the managed row, with an
inline progress line while one runs. The download deliberately does **not** take
the screen's shared busy lock, unlike every other action here: nobody should be
unable to change their transcode preset for the three minutes a 120 MB transfer
takes. Removing the managed copy is the only destructive one and asks first.

**Loudness equalization** is the one Playback toggle that changes what a file
costs rather than only how it is encoded: turning it on takes direct-play files
down the remux pipe and gives up the audio stream copy on the rest, because a
filter needs an encoder. It is off by default for that reason. The hint says
what it does in the terms a viewer has — evening out volume across episodes and
between quiet and loud scenes — and mentions that episodes are measured in the
background while nothing is playing, since that measuring is the only visible
sign the feature is doing anything before the audio changes. See
[playback.md](playback.md#loudness-equalization).

### The ffmpeg gate — the one modal

The app's only modal, and the only thing that ever blocks the window. It appears
when the resolver reports no ffmpeg at all, because that is the one state no
screen can usefully render: the guide would list channels that cannot be tuned
and the library would find nothing to scan.

Three decisions:

- **It overlays rather than replaces.** The shell keeps rendering behind the
  scrim, boot proceeds normally, and nothing about the app's structure is
  special-cased on "no ffmpeg" — mounting it is one line in `App`.
- **It closes by itself.** There is no dismiss button, because the problem is
  real. But it re-checks every five seconds *and* on window focus, so a
  `pacman -S ffmpeg` in another terminal makes the modal go away without anyone
  coming back to tell it. Alt-tabbing in from a package manager is exactly the
  moment the answer changed, which is why focus is the second trigger.
- **Both routes are offered, in that order.** "Download it for me" fetches the
  managed copy with a progress bar and a Cancel; "Install it myself" opens
  ffmpeg.org in the real browser. The download button disables itself, with an
  explanation, on a platform the manifest has no build for.

The phases with no byte count of their own — unpacking, the encode test — get an
indeterminate sweep rather than a bar frozen at 100%, which reads as a hang.
Pinned by `tests/renderer/ffmpeg-gate.test.tsx`, including the case that matters
most: the gate must not flash up while the *first* answer is still in flight,
since most machines have ffmpeg and a modal that appears and vanishes on every
launch would be worse than none.

## Accessibility

Real `<button>`/`<select>`/`<input>` elements throughout; icon-only controls
carry `aria-label`; toggles are `role="switch"` with `aria-checked`; the scrub
and volume bars are keyboard-operable `role="slider"` widgets, not click-only
divs; the guide's selected row carries `aria-current`. Focus is always visible
(a 2px amber ring). Everything animated is guarded by
`prefers-reduced-motion`.

The guide's rows are a plain `role="list"` with a roving tabindex, **not** a
`listbox`. They were one until the editor moved in: an `option` may not contain
interactive children, and these rows now carry two buttons and an expandable
editor. The arrow-key handling that made it feel like a single composite widget
is kept by hand, and the ✎ button carries `aria-expanded`/`aria-controls` so the
fold is announced as what it is.
