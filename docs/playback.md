# The playback pipeline

`src/main/stream/`, `src/shared/playback.ts` and `src/renderer/src/player/` — the
implementation of [plan.html](plan.html) §6, as amended by
[stall-fix-plan.html](stall-fix-plan.html). Electron's Chromium plays H.264/AAC
natively, so the stream server picks the cheapest path that yields a playable
stream, and the renderer owns the buffering.

## The decision

`decidePlaybackPath(container, vcodec, acodec)` in `src/shared/playback.ts`. It
runs **at scan time**, against ffprobe output, and its answer is stored on the
episode row. Nothing is probed at tune-in — that's what makes a channel change
instant.

| Path | When | How |
| --- | --- | --- |
| **direct** | Chromium-native container *and* codecs — `mp4`/`m4v`/`mov`/`webm` with h264/vp8/vp9/av1 + aac/mp3/opus/vorbis/flac (or no audio at all) | Serve the file with HTTP range support. Seeking is native. |
| **remux** | The **video** codec is one Chromium decodes, but something else isn't: the container (the MKV case) or the soundtrack (the AC3 case) | `-c:v copy` into a fragmented MP4 pipe, plus `-c:a aac` only when the audio needs it. Stream copy is I/O-bound, so it starts in milliseconds. |
| **transcode** | The **video** codec itself is unplayable — HEVC, MPEG-2, 10-bit… | `ffmpeg libx264 -preset veryfast -crf 21` + `aac 192k`, also into an fMP4 pipe. |

**The video codec alone decides between remux and transcode**, because it is the
only stream whose re-encode is expensive. That split is phase 1 of the stall fix:
before it, an AC3 soundtrack dragged a perfectly playable H.264 stream onto
libx264, which in the reference library meant 328 of 392 episodes were being
fully re-encoded for no reason — and a full re-encode is what turns a dropped
connection into a minute of dead air instead of a second.

`needsAudioTranscode(acodec)` is the audio half of the same answer, deliberately
*not* baked into the path enum: "copy the audio" and "encode the audio to AAC" are
the same path with a different `-c:a`, and keeping it out of the enum is what let
the change ship without rebuilding a `CHECK` constraint on a table of hundreds of
rows. Migration 3 re-derives the stored labels in one `UPDATE`, so no rescan is
needed; a later full rescan produces identical labels.

All of this lives in `shared/` because three places need the same answer: the
scanner writes it, the stream server acts on it, and the Library screen renders it
as DIRECT / REMUX / TRANSCODE tags — with `· N → AAC` on the remux count — so you
can see what a file will cost before you ever tune in.

## The stream server

`src/main/stream/server.ts`. Binds to **127.0.0.1** on an OS-assigned port.

```
GET /stream/:episodeId?t=<seek>&ch=<channelId>
GET /health
```

One URL shape for all three paths — the player never has to know which one it's
getting until it decides how to read it.

- `?t=` is the seek position, in seconds. On the piped paths it becomes ffmpeg's
  `-ss`, placed *before* `-i` for a fast keyframe-aligned seek. The MVP accepts
  the resulting coarse seeks (plan §10).
- `?ch=` names the supervisor's job group, which is how the per-channel encoder
  budget is enforced.

**Direct** responses implement range requests properly: `Accept-Ranges: bytes`,
`206` with a correct `Content-Range` for a byte range, `416` for an unsatisfiable
one, and HEAD returning headers alone.

**Piped** responses (remux, transcode) send `200` with `Content-Type: video/mp4`,
no `Content-Length` — it's an open-ended pipe — and `Accept-Ranges: none`. The
fragmented-MP4 flags (`frag_keyframe+empty_moov+default_base_moof`) are what let
the muxer emit a playable stream without ever seeking back to write a header,
which is what makes piping possible in the first place — and, not by coincidence,
exactly the shape MediaSource wants.

Every response carries `Access-Control-Allow-Origin: *`. A `<video src>` fetches
media without CORS; the renderer's pump uses `fetch()` from a `file://` origin and
is gated where the element was not. This does not widen the threat model: the
listener is loopback-only, the `Host` check stops DNS rebinding, and the route
takes **episode ids**, never filesystem paths.

## The supervisor

`FfmpegSupervisor` in `src/main/stream/ffmpeg.ts` keys jobs
`channel:<channelId>:<episodeId>`. Spawning under a key kills the previous job
first — SIGTERM, then SIGKILL after a grace period — so a *seek* (same channel,
same episode) replaces its own encoder without any explicit teardown call.

Keys are grouped by prefix, which carries the per-channel budget:

- `killByPrefix('channel:3:')` retires a whole channel.
- `killByPrefixExcept` spares the job being promoted in a handoff.
- `trimGroup(prefix, 2)` caps a channel at **two** live jobs — the episode on air
  plus the one prewarming behind it. Oldest-first, by spawn order rather than by a
  millisecond clock, because two jobs can start inside the same millisecond and a
  tie would occasionally kill the stream that was just tuned in.

Client disconnect kills the job too, and EPIPE on the child's stdout is swallowed,
because it's the normal shape of "the user skipped". ffmpeg's stderr is kept in a
small rolling buffer per job and surfaced when a job exits non-zero, so a failed
stream produces a readable reason rather than a black screen.

## The renderer: MediaSource, not `src`

`src/renderer/src/player/mse.ts` and `player/VideoSurface.tsx`. This is phase 2 of
the stall fix, and it exists because of one specific Chromium behaviour.

A plain `<video src>` hands buffering policy to Chromium's progressive loader.
When its buffer fills, the loader stops reading; the socket sits zero-window; and
Chromium eventually **drops the connection itself and silently re-requests the
same URL**. Against a static file a re-fetch costs milliseconds. Against a live
transcode it restarts ffmpeg at 0:00, so playback freezes until the fresh encode
catches back up to the playhead — measured at 159 seconds deep into an episode.

So the renderer fetches the pipe itself and feeds a `MediaSource`:

- **Scanner** — reassembles the byte stream into an initialisation segment
  (`ftyp` + `moov`) and media segments (`moof` + `mdat` pairs), tolerating
  arbitrary chunk boundaries and skipping the trailing `mfra` ffmpeg writes when
  it closes the file.
- **Codec strings** — derived from the `stsd` sample descriptions: `avcC` →
  `avc1.PPCCLL`, and `esds`/`dOps`/`dfLa` → `mp4a.40.N`, `mp4a.6b`, `opus`,
  `flac`. Anything it cannot name returns null, and that episode falls back to a
  plain `<video src>` — worse than the pump, but no worse than before phase 2.
- **Read policy** — read until 60s are buffered ahead of the playhead, then stop
  reading. TCP backpressure throttles ffmpeg exactly as it did before; the
  difference is that *we* are the one not reading, so nobody drops the connection.
  Resume below 15s. Evict past 120s behind the playhead so renderer memory stays
  flat, and on `QuotaExceededError` evict harder and retry rather than failing.
- **End of stream** — ffmpeg closing the pipe becomes `endOfStream()`, so the
  element's own `ended` fires and the channel advances.

`mse.ts` is deliberately **DOM-free** — it talks to structural interfaces the real
DOM types satisfy — which is what lets the scanner, the codec derivation and the
whole read/append/evict state machine be unit-tested in Node against real
ffmpeg-generated bytes and a scripted reader (`tests/mse.test.ts`). It is listed in
`tsconfig.node.json` so a stray DOM reference fails the build. The DOM-touching
half is `VideoSurface.tsx` alone.

The `direct` path keeps plain `src` and native range seeking. Chromium's
progressive loader is *correct* for a seekable file; the bug it causes exists only
against an unseekable pipe.

## Gapless handoffs

Phase 3, and what finally makes the `prewarmNext` setting honest — it used to gate
only the "up next" toast.

Thirty seconds before an episode ends, the store calls `player.prewarmNext`, which
runs the same **committing** `pickNext` as an ordinary advance and returns a full
`NowPlaying`. The Player has two stacked `<video>` elements; the hidden one starts
a capped pump (~15s of buffer, muted, paused) on that pick. On `ended` the store
*promotes* the stashed pick and the stage flips which surface is on top — the
already-buffered element just plays.

The invariant that matters: **one play-log entry per episode watched.** Because
the pick was committed early, the advance must promote rather than ask again;
calling `next` there would spend a second schedule step, skipping an episode from
a sequential cursor or a part from a multipart arc, silently. Every playback
transition therefore runs through a serialising queue in the store, and
`tests/handoff.test.ts` drives the real scheduler over a real database to check
prewarm-then-ended, prewarm-then-skip, prewarm-then-leave, the skip-during-prewarm
race, and a full arc.

Leaving the player or changing channel discards the pending pick and releases the
channel's encoders. The committed play-log entry simply stays incomplete — the same
thing that happens when the app dies mid-episode (plan §10). Going to sleep does
the same, with one difference that matters: the episode that *finished* is
reported `completed: true`, because it was genuinely watched.

## Two things Chromium does around `ended`

Both were found by driving the real app with `--eval` (below), and both are the
kind of thing that reads as a logic bug for hours. Anything keying off "the video
is paused" has to know them.

**`pause` fires immediately before `ended`.** Same millisecond, with the element's
`ended` already true. So a handler that treats "paused" as a viewer action runs at
the close of *every* episode, racing the `ended` handler. The sleep timer's
pause branch hit this and logged fully-watched episodes as `completed: false` —
invisible on screen, and exactly the flag a shuffle bag reads to avoid repeats.

**A promoted standby is paused for an instant.** During a gapless handoff the
newly-active element is paused until `play()` takes, so "paused" is briefly true
mid-channel with `ended` false. A seek's reload has the same shape. This is why
the Player keys its pause branch on `wantsPlayRef` — cleared only in
`togglePlay`, where a human actually asked — rather than on the `paused` flag.
Keyed on `paused`, a sleep timer that expired mid-arc stopped at the handoff into
the next part, which is the one thing the unit boundary exists to prevent.

Neither is *discoverable* from `tests/`: they are properties of Chromium's media
element, not of our state machine, and a live run is the only thing that can
measure them. What `tests/renderer/` does is encode the two orderings above and
hold the Player's decisions to them, so the guard cannot be quietly removed
again (see [development.md](development.md#the-renderer-layer-testsrenderer)).
Change what this section says and that harness has to be taught the new
behaviour by hand.

## Finding ffmpeg

`resolveFfmpeg()` prefers the **system binary** — on Arch that's
`pacman -S ffmpeg`, which keeps the AppImage small and the codec support fresh —
and falls back to a bundled static build shipped next to the app. If neither
exists, requests that need ffmpeg return 503 with a message that says so, and
the Settings screen shows a red dot with the install hint. Direct-play files
keep working.

## Codec check

`checkCodecs()` asserts H.264/AAC support at startup against a tiny generated
test asset. It runs in the background after the window opens and a failure is
**non-fatal** — per plan §10, anything unplayable simply routes to the transcode
path. The result surfaces in Settings → System.

## Seeking in the player

The renderer translates a scrub into whichever mechanism the path supports:

- `direct` → set `video.currentTime`; the server's range support does the rest.
- `remux` / `transcode` → load a new stream URL with `?t=`, restarting ffmpeg at
  that offset and tearing down the old pump. The player tracks the offset so the
  timecode and scrub position stay correct, and resets it whenever the episode
  changes. The MediaSource is told `episode.durationS - offset`, so the scrub bar
  no longer has to guess at the length of a pipe.

## The soak harness

`scripts/soak.mjs` is the rig that found the stall bug, kept as a regression test.
It drives the real app over the DevTools protocol: tunes a channel, plays several
episodes at an accelerated `playbackRate`, and fails on any stall over three
seconds, on more concurrent encoders than the two-per-channel budget allows, or on
an episode airing twice. It is not part of `npm test` — it needs a real library, a
display, and minutes rather than milliseconds.

```
npm run build && npm run rebuild:electron
npm run soak                                  # 6 episodes at 8x, channel 1
node scripts/soak.mjs --episodes 12 --rate 4 --channel 3
```

`peak encoders 1` in its per-episode line is the fix working; a sustained three or
more is the bug back. Its `--eval` mode attaches to the real renderer and is how
the three constraints above were found. Full usage, including how to sandbox the
library it plays against, is in
[development.md](development.md#the-soak-harness).
