# Rerun TV

Turn a local media library into lean-back TV channels — you build the lineup,
the channel decides what's on. Linux-first (Arch), Electron + ffmpeg.

## Planning documents

- **[docs/plan.html](docs/plan.html)** — MVP architecture plan: locked decisions,
  system architecture, data model, the scheduler ("playable units": arcs air
  uninterrupted and hold exactly one lottery ticket), playback pipeline
  (direct / remux / transcode), player behavior, build order, and risks.
- **[docs/mockup.html](docs/mockup.html)** — UI design mock: the Guide, the
  Player, and the Channel Editor, in the "Saturday, 1994" broadcast direction.

Open either file directly in a browser (the mock pulls its fonts from Google
Fonts; everything else is self-contained).
