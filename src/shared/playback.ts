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

/** Video codecs Chromium decodes in official Electron builds. */
const SUPPORTED_VIDEO = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av1'])

/** Audio codecs Chromium decodes in official Electron builds. */
const SUPPORTED_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])

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
 * - **direct** — a Chromium-native container *and* codec pair: serve the file
 *   with HTTP range support, seeking is native.
 * - **remux** — codecs are fine but the container isn't (the common MKV case):
 *   `ffmpeg -c copy` into a fragmented MP4 pipe, starts in milliseconds.
 * - **transcode** — anything else (HEVC, DTS, 10-bit …): re-encode to
 *   H.264 + AAC.
 */
export function decidePlaybackPath(
  container: string,
  vcodec: string,
  acodec: string
): PlaybackPath {
  const codecsOk = isVideoSupported(vcodec) && isAudioSupported(acodec)
  if (!codecsOk) return 'transcode'
  return DIRECT_CONTAINERS.has(normalizeContainer(container)) ? 'direct' : 'remux'
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
