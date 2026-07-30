/**
 * The playback decision (plan §6).
 *
 * Electron's Chromium plays H.264/AAC natively, so we pick the cheapest path
 * that yields a playable stream. This runs at *scan* time against ffprobe
 * output and the answer is stored on the episode row, which is what makes
 * tune-in instant — nothing is probed when a channel changes.
 *
 * Lives in `shared/` because the scanner writes the decision and the stream
 * server acts on it, and the Library screen renders it as DIRECT/REMUX/TRANSCODE
 * tags.
 */

import type { PlaybackPath } from './types.js'

/** Containers Chromium can demux directly. */
const DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm'])

/**
 * Video codecs Chromium decodes in official Electron builds.
 *
 * Exported as an array because `db/schema.ts` interpolates it into migration 3's
 * `UPDATE`, and `services/library.ts` into the Library aggregate — one list, so
 * the SQL and the decision can never disagree about what "playable" means.
 */
export const SUPPORTED_VIDEO_CODECS = ['h264', 'avc1', 'vp8', 'vp9', 'av1'] as const

/** Audio codecs Chromium decodes in official Electron builds. */
export const SUPPORTED_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac'] as const

const SUPPORTED_VIDEO: ReadonlySet<string> = new Set(SUPPORTED_VIDEO_CODECS)
const SUPPORTED_AUDIO: ReadonlySet<string> = new Set(SUPPORTED_AUDIO_CODECS)

/** ffprobe reports a stream-less track as `none` (see `library/ffprobe.ts`). */
const NO_STREAM = 'none'

/**
 * ffprobe names the *demuxer*, not the container, and reports it as a
 * comma-separated list (`"mov,mp4,m4a,3gp,3g2,mj2"`, `"matroska,webm"`).
 * Reduce it to a single token we can reason about.
 *
 * The ambiguous lists get an explicit answer rather than "first match wins",
 * because the naive rule is actively dangerous: `matroska,webm` would resolve
 * to `webm` — a Chromium-native container — and route every MKV in the library
 * to direct play, which Chromium cannot demux. **Ambiguity resolves to the
 * pessimistic member**, so an unrecognised `.mkv` is remuxed (cheap, a stream
 * copy) rather than handed to a decoder that will refuse it.
 *
 * A caller that can do better should: `library/ffprobe.ts` disambiguates with
 * the file extension first, so a genuine `.webm` is still direct-played.
 */
const AMBIGUOUS_FORMATS: { member: string; resolvesTo: string }[] = [
  // Matroska before WebM: WebM is a Matroska subset, so the demuxer can't tell
  // them apart, and only one of the two is safe to assume.
  { member: 'matroska', resolvesTo: 'matroska' },
  // The whole mov/mp4/m4a family is direct-playable; `mp4` is the canonical
  // name and the one that yields the right Content-Type.
  { member: 'mp4', resolvesTo: 'mp4' }
]

export function normalizeContainer(formatName: string): string {
  const names = formatName
    .toLowerCase()
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)

  if (names.length > 1) {
    const ambiguous = AMBIGUOUS_FORMATS.find((f) => names.includes(f.member))
    if (ambiguous) return ambiguous.resolvesTo
  }

  const direct = names.find((n) => DIRECT_CONTAINERS.has(n))
  return direct ?? names[0] ?? 'unknown'
}

export function isVideoSupported(vcodec: string): boolean {
  return SUPPORTED_VIDEO.has(vcodec.toLowerCase())
}

export function isAudioSupported(acodec: string): boolean {
  return SUPPORTED_AUDIO.has(acodec.toLowerCase())
}

/**
 * Does the audio stream have to be re-encoded on the way into the MP4 pipe?
 *
 * A file with no audio at all answers *no*: there is nothing to encode, and the
 * REMUX tag in the Library would otherwise promise an AAC conversion that never
 * happens.
 */
export function needsAudioTranscode(acodec: string): boolean {
  const codec = acodec.toLowerCase()
  if (codec === NO_STREAM) return false
  return !SUPPORTED_AUDIO.has(codec)
}

/**
 * - **direct** — a Chromium-native container *and* codec pair: serve the file
 *   with HTTP range support, seeking is native.
 * - **remux** — the video codec is one Chromium decodes, but something else
 *   isn't: the container (the common MKV case) or the audio codec (the even
 *   more common AC3 case). ffmpeg copies the video stream into a fragmented MP4
 *   pipe and, when it has to, encodes *only* the audio to AAC. Either way the
 *   expensive half — the video — is a byte copy, so this starts in
 *   milliseconds and costs a few percent of one core.
 * - **transcode** — the video codec itself is unplayable (HEVC, MPEG-2,
 *   10-bit …): re-encode to H.264 + AAC.
 *
 * The video codec alone decides between remux and transcode, because it is the
 * only stream whose re-encode is expensive. Before this split, 328 of the 386
 * episodes in the reference library were being fully re-encoded purely because
 * they carried AC3 audio — and a full re-encode is what makes a dropped
 * connection cost a minute of dead air instead of a second (see
 * `docs/stall-fix-plan.html`).
 */
export function decidePlaybackPath(
  container: string,
  vcodec: string,
  acodec: string
): PlaybackPath {
  if (!isVideoSupported(vcodec)) return 'transcode'
  const containerOk = DIRECT_CONTAINERS.has(normalizeContainer(container))
  // `needsAudioTranscode` rather than `isAudioSupported`, so a genuinely silent
  // file direct-plays instead of being remuxed for an audio track it hasn't got.
  return containerOk && !needsAudioTranscode(acodec) ? 'direct' : 'remux'
}

/** `S04E11`, or `S01E03-E04` for a file holding a double episode. */
export function episodeCode(
  season: number,
  episode: number,
  episodeEnd?: number | null
): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const base = `S${pad(season)}E${pad(episode)}`
  return episodeEnd && episodeEnd !== episode ? `${base}-E${pad(episodeEnd)}` : base
}

/** `44:00` / `1:04:22` — used by the OSD timecode and the guide. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}
