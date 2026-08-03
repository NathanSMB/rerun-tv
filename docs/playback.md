# The playback pipeline

`src/main/stream/`, `src/shared/playback.ts` and `src/renderer/src/player/`.
Electron's Chromium plays H.264/AAC natively, so the stream server picks the
cheapest path that yields a playable stream, and the renderer owns the
buffering.

Three fixes out of a 2026-07-30 stall investigation shaped most of what follows,
and they are named where they show up: an **audio-only transcode path**,
**MediaSource playback**, and **true prewarming**. What they replaced is worth
one number — a 159-second pause, measured ten hours into a marathon session, on
a machine with 25× realtime encode headroom to spare.

## The decision

`decidePlaybackPath(container, vcodec, acodec)` in `src/shared/playback.ts`. It
runs **at scan time**, against ffprobe output, and its answer is stored on the
episode row. Nothing is probed at tune-in — that's what makes a channel change
instant.

| Path | When | How |
| --- | --- | --- |
| **direct** | Chromium-native container *and* codecs — `mp4`/`m4v`/`mov`/`webm` with h264/vp8/vp9/av1 + aac/mp3/opus/vorbis/flac (or no audio at all) | Serve the file with HTTP range support. Seeking is native. |
| **remux** | The **video** codec is one Chromium decodes, but something else isn't: the container (the MKV case) or the soundtrack (the AC3 case) | `-c:v copy` into a fragmented MP4 pipe, plus `-c:a aac` only when the audio needs it. Stream copy is I/O-bound, so it starts in milliseconds. |
| **transcode** | The **video** codec itself is unplayable — HEVC, MPEG-2, 10-bit… | `ffmpeg libx264 -preset veryfast -crf 21` + `aac 192k`, also into an fMP4 pipe. Optionally GPU-accelerated — see below. |

**The video codec alone decides between remux and transcode**, because it is the
only stream whose re-encode is expensive. That split is the first of the three
fixes: before it, an AC3 soundtrack dragged a perfectly playable H.264 stream
onto libx264, which in the reference library meant 328 of 386 episodes were being
fully re-encoded for no reason — and a full re-encode is what turns a dropped
connection into a minute of dead air instead of a second. Steady-state ffmpeg
went from a ~1600% burst of one core to under 50% of it.

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

**One setting overrides the stored answer at serve time.** `effectivePlaybackPath()`
demotes a `direct` file to `remux` while loudness equalization is on, because a
filter needs an encoder and a direct file never meets ffmpeg at all. It is a
separate function from `decidePlaybackPath` deliberately: the stored label
describes the *file*, which is what the Library screen keeps showing, while the
effective path describes how one setting is serving it right now. Both the stream
server and `services/channels.ts` call it, because the renderer reads the answer
too — pointing a plain `<video src>` at an open-ended pipe is precisely the stall
the MSE pump exists to prevent. See [Loudness equalization](#loudness-equalization).

## The stream server

`src/main/stream/server.ts`. Binds to **127.0.0.1** on an OS-assigned port.

```
GET /stream/:episodeId?k=<per-boot key>&t=<seek>&ch=<channelId>
GET /health
```

`k` is minted at startup, never persisted, and handed only to our own renderer
through `urlFor`. Without it the route answers `403` — before it looks the
episode up, so a caller cannot even learn which ids exist. `/health` is open;
it carries nothing.

One URL shape for all three paths — the player never has to know which one it's
getting until it decides how to read it.

- `?t=` is the seek position, in seconds. On the piped paths it becomes ffmpeg's
  `-ss`, placed *before* `-i` for a fast keyframe-aligned seek. The resulting
  coarse seeks are an accepted tradeoff — see
  [architecture.md](architecture.md#risks-and-what-answers-them).
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
media without CORS; the renderer's pump uses `fetch()` from the renderer's
`app://bundle` origin and is gated where the element was not.

The threat model is carried by four things, not by that header: the listener is
loopback-only, the `Host` check stops DNS rebinding, the route takes **episode
ids** rather than filesystem paths, and every URL carries a **per-boot key**
(`?k=`) minted at startup and handed only to our own renderer. The key is what
keeps out the callers loopback cannot exclude — another process on the machine,
or a page in the user's browser, whose `Host` is legitimately loopback.

## The supervisor

`FfmpegSupervisor` in `src/main/stream/ffmpeg.ts` keys jobs
`channel:<channelId>:<episodeId>`. Spawning under a key kills the previous job
first — SIGTERM, then SIGKILL after a grace period — so a *seek* (same channel,
same episode) replaces its own encoder without any explicit teardown call.

Keys are grouped by prefix, which carries the per-channel budget:

- `killByPrefix('channel:3:')` retires a whole channel.
- `trimGroup(prefix, 2)` caps a channel at **two** live jobs — the episode on air
  plus the one prewarming behind it. Oldest-first, by spawn order rather than by a
  millisecond clock, because two jobs can start inside the same millisecond and a
  tie would occasionally kill the stream that was just tuned in.

Client disconnect kills the job too, and EPIPE on the child's stdout is swallowed,
because it's the normal shape of "the user skipped". ffmpeg's stderr is kept in a
small rolling buffer per job and surfaced when a job exits non-zero, so a failed
stream produces a readable reason rather than a black screen.

## The renderer: MediaSource, not `src`

`src/renderer/src/player/mse.ts` and `player/VideoSurface.tsx`. This is the second
of the three fixes, and it exists because of one specific Chromium behaviour.

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
  `avc1.PPCCLL`, `esds` → `mp4a.40.N` / `mp4a.6b`, and the bare sample-entry
  fourccs `Opus` / `fLaC` → `opus` / `flac` (which are complete codec strings on
  their own, so the `dOps`/`dfLa` boxes are never parsed). Anything it cannot name returns null, and that episode falls back to a
  plain `<video src>` — worse than the pump, but no worse than before it existed.
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

The third fix, and what finally makes the `prewarmNext` setting honest — it used
to gate only the "up next" toast.

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
thing that happens when the app dies mid-episode, and accepted for the same
reason ([architecture.md](architecture.md#risks-and-what-answers-them)). Going
to sleep does the same, with one difference that matters: the episode that *finished* is
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

## Picture-in-picture across a handoff

The floating window shows *one element*, and a handoff swaps which of the two
stacked surfaces is on air — so the session has to move with it. Three facts,
all measured against Electron 38.8.6 by a throwaway spike rather than taken from
the spec:

**Document PiP does not work.** `documentPictureInPicture.requestWindow()` throws
`InvalidStateError: Internal error: no window`. That ruled out floating the whole
stage — our OSD included — and forced the per-element approach everything below
is shaped around. (No longer true on Electron 43: the call succeeds behind a
user gesture. The design stands, but the constraint that produced it is gone.)

**A fresh entry needs user activation; a transfer does not.**
`video.requestPictureInPicture()` outside a gesture throws `NotAllowedError:
Must be handling a user gesture if there isn't already an element in
Picture-in-Picture` — but while a session exists, *another* element may take it
over with no activation at all. So the handoff transfers, and the rule that
falls out of it is the one `player/pip.ts` is built to keep: **never exit before
requesting.** Exit first and the gesture-free window closes with the session; the
picture could not come back until the viewer pressed something.

**A transfer fires `leavepictureinpicture` on the old element**, before the new
element's `enterpictureinpicture` and before the promise resolves — measured
`enter:a`, `promise:a`, `leave:a`, `enter:b`, `promise:b`. Read naively that
middle event is the viewer closing the window, and reading it that way hauls the
picture back inline in the middle of every handoff. The controller's
`requesting` phase is that disambiguation; it is the same shape as `wantsPlayRef`
above, and for the same reason — the event does not carry intent, so the state
around it has to.

A `src` swap on the element in PiP keeps the session, so seeks, Retry and the
one-episode-channel reload all survive. As with `ended`, none of this is
discoverable from `tests/`: happy-dom has no PiP at all, so the controller is
DOM-free and driven by these orderings in `tests/pip.test.ts`, while
`tests/renderer/pip.test.tsx` models them — including the gesture rule — and
holds the Player's wiring to them.

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
**non-fatal**: anything unplayable simply routes to the transcode path. That is
the whole mitigation for Electron's codec support drifting under us — see
[architecture.md](architecture.md#risks-and-what-answers-them). The result
surfaces in Settings → System.

## Hardware encode & decode

The `hardwareAccel` setting — `software` | `vaapi` | `nvenc` — chooses the
encoder for the **transcode** path only. A `direct` file never meets ffmpeg and a
`remux` copies its video stream byte-for-byte, so neither has an encoder to
accelerate. `stream/hwaccel.ts` owns the three recipes, and exactly two segments
of the command line move: the decode prefix ahead of `-i`, and the video branch.
The seek, the stream maps, the AAC chain (there is no hardware audio encoder) and
the fMP4 mux are identical on all three — which is what makes `software` provably
the command line the app shipped with.

| | Decode prefix | Video branch |
| --- | --- | --- |
| **software** | *(none)* | `-c:v libx264 -preset <p> -crf <q> -pix_fmt yuv420p` |
| **vaapi** | `-init_hw_device vaapi=va:<node> -hwaccel vaapi -hwaccel_output_format vaapi -filter_hw_device va` | `-vf format=nv12\|vaapi,hwupload,scale_vaapi=format=nv12 -c:v h264_vaapi -rc_mode CQP -qp <q>` |
| **nvenc** | `-hwaccel cuda` | `-c:v h264_nvenc -preset p<N> -rc vbr -cq <q> -b:v 0 -pix_fmt yuv420p` |

On the reference library the setting reaches 476 of 878 episodes — 293 HEVC web
rips and 183 MPEG-4 ASP DVD rips. Measured on 60 seconds of the hardest case in
it (10-bit HEVC 1080p, an RTX 5080 plus an AMD iGPU), through the production
fMP4 arg shape:

| Backend | CPU per stream | Catch-up speed | Output bitrate |
| --- | ---: | ---: | ---: |
| software · libx264 veryfast CRF 21 | 1.39 cores | 12.6× | 8.6 Mb/s |
| nvenc · p4 CQ 21, CUDA decode | 0.16 cores | 22.9× | 11.2 Mb/s |
| vaapi · QP 20, full-GPU path | 0.03 cores | 6.2× | 5.8 Mb/s |

Steady-state playback is throttled to 1× by TCP backpressure, so the CPU column
is the real per-stream cost; the speed multiple is how fast the encoder refills
the buffer after a seek or a prewarm. NVENC's CPU share is mostly the 10-bit→8-bit
conversion on download, which is the price of the decode fallback below; VAAPI
keeps frames on the GPU end to end and pays 3% of one core for it.

Three things carry the feature past "it works on my machine":

- **The probe enumerates, it does not guess.** `probeHardwareAccel()` runs a real
  test encode per backend at startup, and for VAAPI it tries *every*
  `/dev/dri/renderD*` node until one passes. The device is not conventional: on a
  machine with a discrete NVIDIA card and an AMD iGPU, `renderD128` is the NVIDIA
  — whose VAAPI driver exposes decode but **no H.264 encode entrypoint** — while
  `renderD129` is the iGPU that works. Hardcoding renderD128, as every VAAPI
  example does, would report "unavailable" on a machine with a working encoder in
  it. `RERUN_VAAPI_DEVICE` overrides the search.
- **Both chains tolerate a software decode.** VAAPI's
  `format=nv12|vaapi,hwupload` accepts frames from either kind of decoder, and
  `scale_vaapi=format=nv12` folds 10-bit P010 down to the 8-bit surface
  `h264_vaapi` requires. NVENC deliberately omits `-hwaccel_output_format cuda`,
  so frames land in system memory and a codec NVDEC can't decode (every XviD rip)
  still hardware-*encodes*.
- **A wrong selection can never break playback.** `effectiveAccel()` degrades a
  backend the probe didn't prove — `pending` included, so a tune-in during the
  first seconds after launch starts on a path that certainly works. Past that,
  `servePipe` retries once on software if a hardware job exits non-zero *before
  its first byte*, which the existing first-fragment gate makes safe: nothing has
  been promised to the client yet. Failures after the first byte are left alone —
  the pump's reconnect requests a fresh URL, and that request gets the fallback
  logic again.

### The quality tiers, and why VAAPI's column was calibrated

Settings offers four quality tiers spelled as an x264 preset plus a CRF, and each
backend has to interpret that intent through its own rate control. `qualityTier()`
keys off the **CRF**, not the preset: CRF is the quality half of the pair, while
the preset only says how much CPU x264 may spend reaching it, which means nothing
to a fixed-function encoder.

| Settings tier | libx264 | h264_nvenc | h264_vaapi |
| --- | --- | --- | --- |
| ultrafast · CRF 23 | `-preset ultrafast -crf 23` | `-preset p2 -cq 23` | `-qp 22` |
| **veryfast · CRF 21** (default) | `-preset veryfast -crf 21` | `-preset p4 -cq 21` | `-qp 20` |
| fast · CRF 20 | `-preset fast -crf 20` | `-preset p5 -cq 20` | `-qp 19` |
| medium · CRF 19 | `-preset medium -crf 19` | `-preset p6 -cq 19` | `-qp 18` |

CRF, CQ and QP are three different scales that happen to share a range, so the two
hardware columns were measured against libx264's real bitrate on real content
rather than assumed. VAAPI's first cut put the default tier at **QP 24**, on the
theory that a fixed-function encoder wants a few points of slack. Against three
scenes of dark, grainy 10-bit HEVC — picked by sweeping the episode for luma and
motion, not by eye — that ran 45–59% *below* libx264 for the same tier, and the
missing bits showed up as visible blocking in shadow. QP 20 lands within ~10% and
restores the detail; the whole column shifted four points so the tiers stay
ordered against each other. NVENC needed no correction: it tracked within +39%,
erring generous, which is the harmless direction.

The residual spread at QP 20 — −22% to +10% depending on the scene — is inherent
rather than a mis-calibration. x264's CRF is *adaptive*, spending per frame
according to complexity; VAAPI's CQP is a constant quantizer with no such
feedback, so no single QP tracks CRF across all content. An unknown CRF —
hand-edited, or from a future version — answers the default tier rather than
refusing to play.

## Loudness equalization

`src/main/stream/loudness.ts` and `src/main/library/loudness.ts`, behind the
`loudnessEq` setting (Settings → Playback, **off** by default).

Two complaints, one filter chain. **Across episodes**, a library is mastered by
whoever ripped it: web downloads land near modern streaming targets, disc rips sit
5–8 LU quieter, broadcast captures are anywhere at all — so the volume knob is
wrong every time the schedule crosses a source boundary. **Within one episode**,
dialogue sits 10–15 LU below the action peaks, which no single gain change can fix
because it moves the whole curve at once.

`loudnorm` in its **dynamic** mode answers both: it measures continuously and
adapts its gain toward the target, so a quiet rip comes up, a hot one comes down,
and inside an episode the soft scenes are lifted while the loud ones are held near
target. Everything funnels through `aacArgs()`, which builds the one `-af` chain:

```
volume=<pre-gain>dB → loudnorm=I=-16:TP=-1.5:LRA=11:dual_mono=true:linear=false
                    → aresample=48000 → aformat=channel_layouts=…
```

Four things about it are load-bearing:

- **−16 LUFS / −1.5 dBTP / LRA 11.** −16 is the streaming convention and the right
  target for near-field listening; broadcast's −23 assumes a cinema-ish playback
  chain and would leave everything sounding quiet on a desk or a TV's own speakers.
  −1.5 dBTP keeps headroom for the AAC encoder, whose reconstructed waveform can
  overshoot the samples it was given. LRA 11 is conservative: enough levelling to
  rescue dialogue, not so much that everything is squashed flat.
- **`dual_mono=true`** matters for a rerun library specifically. R128 measures a
  mono track ~3 LU quieter than the identical material dual-mono'd across two
  speakers, so without it every genuinely mono episode — anything old enough —
  would be normalised 3 LU too loud.
- **`aresample=48000`**, because loudnorm resamples internally and emits 192 kHz
  double-precision audio, which the AAC encoder neither wants nor can name.
- **`aformat` stays last**, so the channel-layout guarantee Chromium's MSE AAC
  parser needs still holds at the encoder input. The whole chain is appended into
  the *existing* `-af` string for the same reason a second `-af` would silently
  replace the first.

The one thing dynamic mode cannot do is **start correct**: it converges over the
first few seconds from an assumption, and since a seek respawns ffmpeg, that
opening wobble is paid again on every scrub. The `volume=` pre-gain removes it —
the input arrives already at target, so frame one is right and loudnorm's dynamic
gain sits near unity doing only the within-episode work.

Not by handing the measurements to loudnorm as `measured_I`/`measured_TP`/…, which
is the obvious-looking alternative. Those options exist to enable **linear** mode —
one scale factor over the whole file — which solves the across-episode half and
throws the within-episode half away; and in dynamic mode ffmpeg ignores them
entirely. Hence the explicit `linear=false`, and the pre-gain carried by `volume`.

`preGainDb()` is deliberately **not** clamped against the source's true peak,
which is the tempting mistake. A quiet-but-peaky master — whispered dialogue under
gunshots — genuinely cannot reach −16 LUFS without its peaks crossing the ceiling,
but that is a property of the target, not of how the gain is applied: hold the
pre-gain back and loudnorm's dynamic stage applies the very same gain a few
seconds later through the very same limiter. All the clamp would buy is the
convergence wobble the measurement exists to remove. Nothing clips in the
meantime — after `volume` the chain is floating point all the way to that limiter.
It *is* clamped to ±24 dB, because real material lives inside ±10 dB of target and
a 40 dB lift on a mismeasured episode is a much worse outcome than one that stays
quiet.

### What it costs, per path

A filter needs an encoder, so switching this on can move an episode onto a more
expensive path. On the reference library, where ~85% of files are H.264 + AC3, it
mostly costs nothing:

| Path | Off | On | Cost |
| --- | --- | --- | --- |
| remux, audio already re-encoded (~85%) | video copy + AAC encode | same encode, plus filters | ≈ none |
| remux, full `-c copy` (AAC/MP3/Opus audio) | `-c copy` | `-c:v copy` + AAC encode | small |
| direct play | raw bytes, no ffmpeg | demoted to remux at serve time | small |
| full transcode | libx264 + AAC encode | same, plus filters | ≈ none |

A filter cannot ride a stream copy, which is why `remuxArgs()` gives up its copy
whenever a chain is present, and why `effectivePlaybackPath()` demotes a direct
file. Both cost an audio-only AAC encode — well under one core — and only while
the toggle is on. A silent episode is excluded outright (`loudnessEqApplies`):
there is nothing to weigh, and dragging it onto the encode path to filter an audio
stream it hasn't got would be pure waste.

Settings are read per request, so the toggle takes effect on the next tune-in with
no restart. Toggling it also drops any prewarmed standby, which is already
encoding with the old audio args — otherwise the next handoff would be an audible
jump.

### The background measuring job

`src/main/library/loudness.ts`. Measuring an episode means decoding its whole
soundtrack — seconds per file, against the milliseconds an ffprobe costs — so it
can never sit in the scanner's per-file path and nothing may ever wait on it. It
runs as its own job instead: one file at a time, `-threads 1`, only while the
setting is on, and paused whenever a stream is live or a library scan is running
(`isBusy` in `index.ts`). Only the audio stream is mapped, so the video is never
decoded at all.

Everything about it is optional by construction. The feature works with zero
measurements — dynamic `loudnorm` is the whole of it — so a pass that is paused
forever, or that fails on half the library, degrades to a slightly wobbly first
few seconds rather than to a broken feature. Four details make that hold:

- **Passes queue rather than flag.** The interesting case is `stop()` immediately
  followed by `start()` — the setting switched off and straight back on. A "busy"
  flag would see the aborted pass still unwinding, call itself already running, and
  drop the restart; queuing behind it always lands. Re-entering with nothing to do
  costs one query.
- **Failures are remembered for the session, not persisted.** A failure is usually
  about the moment — an unmounted drive, a file mid-copy — so it should be retried
  on the next launch; retried inside one session it would spin.
- **A silent file is a real answer.** Digital silence measures as `-inf`, which is
  not a number to offset from, so the row stores nulls but still stamps
  `loudness_scanned_at`. That is what stops it being decoded again every launch.
- **A full rescan does not discard it.** `upsertEpisode` invalidates the cached
  columns only when the stat pair actually moved. A file whose bytes changed has a
  loudness we no longer know; a file that was merely re-probed must not cost hours
  of measuring to learn nothing.

The measuring command and the playback chain share the same `loudnorm` spelling
from one module, so the numbers stored are the numbers the filter would have
measured itself. See [data-model.md](data-model.md) for the five columns and
[library.md](library.md) for where this sits relative to the scanner.

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
