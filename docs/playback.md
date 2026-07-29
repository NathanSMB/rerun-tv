# The playback pipeline

`src/main/stream/` and `src/shared/playback.ts` — the implementation of
[plan.html](plan.html) §6. Electron's Chromium plays H.264/AAC natively, so the
stream server picks the cheapest path that yields a playable stream.

## The decision

`decidePlaybackPath(container, vcodec, acodec)` in `src/shared/playback.ts`. It
runs **at scan time**, against ffprobe output, and its answer is stored on the
episode row. Nothing is probed at tune-in — that's what makes a channel change
instant.

| Path | When | How |
| --- | --- | --- |
| **direct** | Chromium-native container *and* codecs — `mp4`/`m4v`/`mov`/`webm` with h264/vp8/vp9/av1 + aac/mp3/opus/vorbis/flac | Serve the file with HTTP range support. Seeking is native. |
| **remux** | Codecs are fine, container isn't — the common MKV case | `ffmpeg -c copy` into a fragmented MP4 pipe. Stream copy is I/O-bound, so it starts in milliseconds. |
| **transcode** | Anything else — HEVC, DTS, 10-bit… | `ffmpeg libx264 -preset veryfast -crf 21` + `aac 192k`, also into an fMP4 pipe. |

It lives in `shared/` because three places need the same answer: the scanner
writes it, the stream server acts on it, and the Library screen renders it as
DIRECT / REMUX / TRANSCODE tags so you can see which files will cost CPU before
you ever tune in.

## The stream server

`src/main/stream/server.ts`. Binds to **127.0.0.1** on an OS-assigned port.

```
GET /stream/:episodeId?t=<seek>&ch=<channelId>
GET /health
```

One URL shape for all three paths — the `<video>` element never knows which one
it's getting.

- `?t=` is the seek position, in seconds. On the piped paths it becomes ffmpeg's
  `-ss`, placed *before* `-i` for a fast keyframe-aligned seek. The MVP accepts
  the resulting coarse seeks (plan §10); most content direct-plays or remuxes,
  where seeking is native anyway.
- `?ch=` names the supervisor's job slot, which is how "never more than one
  ffmpeg job per channel" is enforced.

**Direct** responses implement range requests properly: `Accept-Ranges: bytes`,
`206` with a correct `Content-Range` for a byte range, `416` for an unsatisfiable
one, and HEAD returning headers alone.

**Piped** responses (remux, transcode) send `200` with `Content-Type: video/mp4`,
no `Content-Length` — it's an open-ended pipe — and `Accept-Ranges: none`, so
Chromium doesn't try to range-request a stream that can't satisfy it. The
fragmented-MP4 flags (`frag_keyframe+empty_moov+default_base_moof`) are what let
the muxer emit a playable stream without ever seeking back to write a header,
which is what makes piping possible in the first place.

Security posture: the server takes **episode ids**, never filesystem paths, and
rejects requests whose `Host` isn't loopback.

## The supervisor

`FfmpegSupervisor` in `src/main/stream/ffmpeg.ts` keys jobs by channel. Spawning
a job under a key kills the previous one first — SIGTERM, then SIGKILL after a
grace period — so a skip or channel change never leaves a second encoder
running. Client disconnect kills the job too, and EPIPE on the child's stdout is
swallowed, because it's the normal shape of "the user skipped".

ffmpeg's stderr is kept in a small rolling buffer per job and surfaced when a job
exits non-zero, so a failed stream produces a readable reason rather than a black
screen.

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
  that offset. The player tracks the offset so the timecode and scrub position
  stay correct, and resets it whenever the episode changes.
