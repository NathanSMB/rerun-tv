/**
 * The scan-time ffprobe call (plan §3, §6).
 *
 * Every file is probed exactly once — on first sight, or after its mtime/size
 * changed — and the answer is written to the episode row. That is what makes
 * tune-in instant: the stream server reads container/codecs out of SQLite and
 * picks direct/remux/transcode without touching the disk.
 *
 * We shell out to the `ffprobe` binary rather than link a native demuxer because
 * the app already depends on ffmpeg for the remux/transcode paths, and one
 * binary resolution story (system PATH, bundled fallback) is enough.
 */

import { execFile } from 'node:child_process'
import { extname } from 'node:path'
import { promisify } from 'node:util'
import { normalizeContainer } from '@shared/playback.js'

const execFileAsync = promisify(execFile)

/**
 * ffprobe names the *demuxer*, not the container, and one demuxer can serve
 * several: an `.mkv` and a `.webm` both come back as `matroska,webm`.
 *
 * `normalizeContainer` resolves that pessimistically (`matroska`, so the file is
 * remuxed rather than handed to a decoder that will refuse it). We can do better
 * at scan time, because we have the path: where the extension names one of the
 * formats ffprobe reported, it is the more precise answer, so a genuine `.webm`
 * still direct-plays instead of paying for a remux it doesn't need.
 *
 * Only genuinely ambiguous multi-format lists are affected; a single-format
 * answer is always taken as-is.
 */
const EXTENSION_FORMATS: Record<string, string> = {
  '.mkv': 'matroska',
  '.webm': 'webm'
}

/** A probe never runs longer than this; a hung ffprobe must not stall a scan. */
const PROBE_TIMEOUT_MS = 30_000

/** ffprobe JSON can be large for files with many streams; give it room. */
const MAX_BUFFER = 8 * 1024 * 1024

export interface ProbeResult {
  /** Container duration in seconds; 0 when ffprobe reports none (rare, streamed). */
  durationS: number
  /** Single normalised container token, e.g. `matroska` or `mp4`. */
  container: string
  /** First video stream's codec, or `none` when the file has no video. */
  vcodec: string
  /** First audio stream's codec, or `none` when the file has no audio. */
  acodec: string
  width: number | null
  height: number | null
}

/** The subset of ffprobe's JSON we care about. */
interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string }
  streams?: FfprobeStream[]
}

/**
 * Probe one file. Throws a descriptive Error on anything that isn't a clean,
 * parseable result — the scanner catches it, records the file as unmatched with
 * the message as the reason, and carries on with the rest of the library.
 *
 * The first video and first audio stream win. Multi-audio files (a commentary
 * track, a second language) are common and the playback decision only depends
 * on the default track, which ffprobe lists first.
 */
export async function probeFile(filePath: string, ffprobePath: string): Promise<ProbeResult> {
  let stdout: string
  try {
    const result = await execFileAsync(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true }
    )
    stdout = result.stdout
  } catch (err) {
    throw new Error(`ffprobe failed for ${filePath}: ${describe(err)}`)
  }

  let parsed: FfprobeOutput
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput
  } catch {
    throw new Error(`ffprobe returned unparseable JSON for ${filePath}`)
  }

  const streams = parsed.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  const formatName = parsed.format?.format_name
  if (!formatName && !video && !audio) {
    throw new Error(`ffprobe found no streams in ${filePath}`)
  }

  const duration = Number(parsed.format?.duration)

  return {
    durationS: Number.isFinite(duration) && duration > 0 ? duration : 0,
    container: resolveContainer(filePath, formatName ?? 'unknown'),
    // `none` rather than a null: the playback decision treats an unknown codec
    // as unsupported and routes to transcode, which is the safe answer.
    vcodec: video?.codec_name?.toLowerCase() ?? 'none',
    acodec: audio?.codec_name?.toLowerCase() ?? 'none',
    width: typeof video?.width === 'number' ? video.width : null,
    height: typeof video?.height === 'number' ? video.height : null
  }
}

/** See `EXTENSION_FORMATS`: prefer the extension when the demuxer is ambiguous. */
function resolveContainer(filePath: string, formatName: string): string {
  const reported = formatName
    .toLowerCase()
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
  if (reported.length > 1) {
    const byExtension = EXTENSION_FORMATS[extname(filePath).toLowerCase()]
    if (byExtension && reported.includes(byExtension)) return byExtension
  }
  return normalizeContainer(formatName)
}

/** execFile rejects with an errno/stderr-bearing object; surface the useful bit. */
function describe(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; message?: string; code?: unknown }
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : ''
    if (stderr) return stderr.split('\n').slice(0, 3).join(' ')
    if (e.message) return e.message
    if (e.code !== undefined) return `exit code ${String(e.code)}`
  }
  return String(err)
}
