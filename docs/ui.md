# The UI

`src/renderer/` — the implementation of [mockup.html](mockup.html) and
[plan.html](plan.html) §7–8. Five screens, all configuration in-app, no config
files.

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
— there are five screens and no URLs worth having. Components read slices with
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
fullscreen · `Esc` back to the guide · `M` mute.

### Channel editor — where a channel gets its personality

Every scheduling knob from the plan is a visible control: per-show
**Shuffle / In order**, the lottery **weight**, the detected **arcs**, and the
live progress cursor or shuffle bag with a reset link. Counts are shown as
episodes *and* units, so it's visible that a 5-parter like *Awakening* holds
exactly one lottery ticket.

### Library — where files become television

The scan strip reports what's been probed and what was skipped. Each show shows
**how each of its files will play** — DIRECT / REMUX / TRANSCODE counts straight
from the scan-time probe — so you can see what will cost CPU before you tune in.
Anything the parser couldn't read waits in the **Unmatched** queue for manual
assignment. Arcs are reviewed and corrected here: ungroup a false positive, or
group a consecutive run the heuristic missed.

### Settings — every knob in one place

Four cards: where the media lives, how it plays, how the interface behaves, and
what the system underneath is doing (ffmpeg version and path, the startup codec
check, the database and its size, with a backup button).

Post-MVP controls — hardware VAAPI encode — ship **visible but disabled**, so
the settings surface doesn't reshuffle as features land.

## Accessibility

Real `<button>`/`<select>`/`<input>` elements throughout; icon-only controls
carry `aria-label`; toggles are `role="switch"` with `aria-checked`; the scrub
and volume bars are keyboard-operable `role="slider"` widgets, not click-only
divs; the guide's selected row carries `aria-current`. Focus is always visible
(a 2px amber ring). Everything animated is guarded by
`prefers-reduced-motion`.
