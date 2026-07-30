/**
 * The loopback HTTP stream server (plan §2, §6).
 *
 * Why HTTP instead of `file://` (plan §2): it gives all three playback paths
 * *one URL shape*. The `<video>` element only ever sees
 * `http://127.0.0.1:<port>/stream/<episodeId>` and has no idea whether it is
 * getting a range-served file off disk, a live `-c copy` remux, or a full
 * transcode. ffmpeg pipes fragmented MP4 straight into the response body, so
 * there are no temp files to write, wait for, or clean up — and post-MVP the
 * same seam is what casting to another device on the LAN would use.
 *
 * The route takes an **episode id**, never a path. The renderer cannot ask this
 * server for an arbitrary file; it can only name a row the scanner already put
 * in the database. Combined with binding to 127.0.0.1 and a Host check, that is
 * the whole threat model.
 *
 * Nothing here probes: the playback decision was made at scan time and lives on
 * the episode row (`playback_path`), which is what makes tune-in instant.
 */

import type { ChildProcess } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname } from 'node:path'
import { needsAudioTranscode, normalizeContainer } from '@shared/playback.js'
import type { AppSettings, PlaybackPath } from '@shared/types.js'
import type { Db } from '../db/index.js'
import { FfmpegSupervisor, resolveFfmpeg } from './ffmpeg.js'

export interface StreamServerOptions {
  db: Db
  /**
   * Read at request time, not at construction time, so changing the preset or
   * CRF in Settings takes effect on the very next tune-in without a restart.
   */
  getSettings: () => AppSettings
}

export interface StreamServer {
  port: number
  /** `http://127.0.0.1:<port>/stream/<episodeId>` — the one URL shape the player ever sees. */
  urlFor(episodeId: number, seekS?: number, channelId?: number): string
  /**
   * Kill every ffmpeg job for a channel — on a skip with nothing prewarmed, on a
   * channel change, or on leaving the player. Plural because a channel can hold
   * two jobs during a handoff (see `FfmpegSupervisor`).
   */
  releaseChannel(channelId: number): void
  /**
   * Kill the job for one episode on one channel, leaving the channel's other job
   * alone. This is what a promotion needs: the episode that just finished lets
   * go of its encoder while the prewarmed one plays on.
   */
  releaseEpisode(channelId: number, episodeId: number): void
  /** Live supervisor keys, for tests and diagnostics. */
  activeKeys(): string[]
  close(): Promise<void>
}

/** The only columns the server needs; everything else about the episode is the UI's problem. */
interface EpisodeRow {
  id: number
  path: string
  playback_path: PlaybackPath
  container: string
  /**
   * Read at serve time rather than baked into `playback_path`, because "copy the
   * audio" and "encode the audio to AAC" are the same *path* with a different
   * `-c:a`. Keeping it out of the enum is what lets phase 1 ship without a
   * CHECK-constraint rebuild on a table with hundreds of rows.
   */
  acodec: string
}

/**
 * Containers we might serve straight off disk. Chromium is strict about
 * `Content-Type` on a `<video>` source, so a wrong guess here can fail playback
 * on a file that would otherwise direct-play.
 */
const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  matroska: 'video/x-matroska',
  ogg: 'video/ogg'
}

/**
 * The file extension wins over the stored container, because `container` is
 * whatever ffprobe's `format_name` was at scan time — a comma list
 * (`"mov,mp4,m4a,3gp,3g2,mj2"`) whose first entry is `mov`, which would label a
 * perfectly ordinary `.mp4` as `video/quicktime`. The container list is still
 * consulted (raw tokens first, then the shared normalisation) for the odd file
 * with a wrong or missing extension.
 */
function contentTypeFor(container: string, filePath: string): string {
  const ext = extname(filePath).replace('.', '').toLowerCase()
  const candidates = [
    ext,
    ...container
      .toLowerCase()
      .split(',')
      .map((token) => token.trim()),
    normalizeContainer(container)
  ]
  for (const candidate of candidates) {
    const type = CONTENT_TYPES[candidate]
    if (type) return type
  }
  return 'application/octet-stream'
}

/**
 * Why a wide-open CORS header on a server whose whole point is that nobody else
 * can reach it (docs/stall-fix-plan.html, phase 2).
 *
 * A `<video src>` fetches media *without* CORS: the element is allowed to load a
 * cross-origin stream it simply cannot read the bytes of. The MSE pump in
 * `renderer/player/mse.ts` uses `fetch()` instead — it has to, because reading
 * the bytes is the entire idea — and that is an ordinary cross-origin request
 * from the renderer's `app://bundle` origin (see `main/index.ts`). Without this
 * header the pump gets an opaque failure and every episode falls back to the
 * plain-`src` path the phase exists to retire.
 *
 * The threat model is unchanged and is not carried by CORS: the listener is
 * bound to 127.0.0.1, `isLoopbackHost` rejects a forged `Host` (DNS rebinding),
 * and the route takes an episode id the scanner wrote — never a path. A page on
 * the open web that guessed the port could already *play* these streams through
 * a `<video>` tag; being able to read the bytes of a file the user already owns
 * adds nothing to that.
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  // Range is the only non-simple header the direct path can attract, and
  // Content-Length/Content-Range are what a reader needs to see on the answer.
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
} as const

/** A parsed single byte range, or the two failure modes we must answer differently. */
type ParsedRange =
  | { kind: 'none' }
  | { kind: 'unsatisfiable' }
  | { kind: 'range'; start: number; end: number }

/**
 * RFC 9110 §14.1.1. We honour a single range only: Chromium never asks for more
 * than one on a media element, and answering a multipart range would mean
 * building a `multipart/byteranges` body for no benefit — an unhandled
 * multi-range simply degrades to a normal 200.
 */
function parseRange(header: string | undefined, size: number): ParsedRange {
  if (!header) return { kind: 'none' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return { kind: 'none' }

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return { kind: 'none' }

  let start: number
  let end: number
  if (rawStart === '') {
    // Suffix range: `bytes=-500` means "the last 500 bytes", clamped to the file.
    const suffix = Number(rawEnd)
    if (suffix <= 0) return { kind: 'unsatisfiable' }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    // Open-ended range: `bytes=1000-` runs to the end of the file.
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { kind: 'none' }
  if (size === 0 || start >= size || start > end) return { kind: 'unsatisfiable' }
  return { kind: 'range', start, end: Math.min(end, size - 1) }
}

/**
 * Reject anything whose `Host` isn't loopback. The listener is already bound to
 * 127.0.0.1, so this is defence against DNS rebinding: a page on the open web
 * can resolve its own hostname to 127.0.0.1 and reach us, but it cannot forge
 * the Host header the browser sends.
 */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  const hostname = host.startsWith('[')
    ? host.slice(1, host.indexOf(']'))
    : (host.split(':')[0] ?? '')
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '0:0:0:0:0:0:0:1' ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  )
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

/**
 * Errors carry the CORS header too, so a failed stream surfaces in the pump as
 * ffmpeg's actual message rather than as an opaque network error.
 */
function sendText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    'Cache-Control': 'no-store'
  })
  res.end(message)
}

/**
 * Start the stream server on an OS-assigned free port, bound to loopback only.
 *
 * Port 0 (rather than a fixed one) because two instances, or any app that
 * already took our number, must not make playback fail; the real port is read
 * back from `address()` and handed to the renderer via `SystemInfo.streamPort`.
 */
export async function startStreamServer(opts: StreamServerOptions): Promise<StreamServer> {
  const { db, getSettings } = opts
  const supervisor = new FfmpegSupervisor()

  const selectEpisode = db.prepare<[number], EpisodeRow>(
    'SELECT id, path, playback_path, container, acodec FROM episodes WHERE id = ?'
  )

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) sendText(res, 500, `stream error: ${message}`)
      else res.destroy()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A client vanishing mid-stream surfaces as an error on the response; it is
    // routine here, and an unhandled one would take the main process down.
    res.on('error', () => {
      /* ignore — `req.on('close')` is where teardown actually happens. */
    })

    if (!isLoopbackHost(req.headers.host)) {
      sendText(res, 403, 'forbidden')
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }

    const match = /^\/stream\/(\d+)$/.exec(url.pathname)
    if (!match) {
      sendText(res, 404, 'not found')
      return
    }
    // A same-origin-ish `fetch()` for a stream sends no non-simple headers, so
    // Chromium never actually preflights the pump. Answering anyway costs three
    // lines and means a future caller that *does* preflight isn't a mystery.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...CORS_HEADERS, 'Content-Length': 0 })
      res.end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...CORS_HEADERS, Allow: 'GET, HEAD' })
      res.end()
      return
    }

    const episodeId = Number(match[1])
    const row = selectEpisode.get(episodeId)
    if (!row) {
      sendText(res, 404, `no episode ${episodeId}`)
      return
    }

    // `?t=` is a seek in seconds; `?ch=` names the channel whose single job slot
    // this stream occupies, so the supervisor can enforce one ffmpeg per channel.
    const seekS = Math.max(0, Number(url.searchParams.get('t') ?? 0) || 0)
    const rawChannel = url.searchParams.get('ch')
    const channelId = rawChannel !== null && /^\d+$/.test(rawChannel) ? Number(rawChannel) : null
    const key = channelId !== null ? channelKey(channelId, row.id) : `episode:${row.id}`

    if (row.playback_path === 'direct') {
      await serveFile(req, res, row)
      return
    }
    servePipe(req, res, row, seekS, key, channelId)
  }

  /**
   * Direct path: the file is already something Chromium can demux, so we just
   * serve bytes with full range support and let the player seek natively —
   * which is why `?t=` is ignored here.
   */
  async function serveFile(
    req: IncomingMessage,
    res: ServerResponse,
    row: EpisodeRow
  ): Promise<void> {
    let size: number
    try {
      const info = await stat(row.path)
      if (!info.isFile()) throw new Error('not a file')
      size = info.size
    } catch {
      // The row exists but the file moved or was deleted since the last scan.
      sendText(res, 404, 'file missing on disk')
      return
    }

    const contentType = contentTypeFor(row.container, row.path)
    const range = parseRange(req.headers.range, size)

    if (range.kind === 'unsatisfiable') {
      res.writeHead(416, {
        ...CORS_HEADERS,
        'Content-Range': `bytes */${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': 0
      })
      res.end()
      return
    }

    const start = range.kind === 'range' ? range.start : 0
    const end = range.kind === 'range' ? range.end : Math.max(0, size - 1)
    const length = size === 0 ? 0 : end - start + 1

    const headers: Record<string, string | number> = {
      ...CORS_HEADERS,
      'Content-Type': contentType,
      'Content-Length': length,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    }
    if (range.kind === 'range') headers['Content-Range'] = `bytes ${start}-${end}/${size}`

    res.writeHead(range.kind === 'range' ? 206 : 200, headers)

    // HEAD must produce exactly these headers and no body — Chromium uses it to
    // learn the length before it starts range-requesting.
    if (req.method === 'HEAD' || length === 0) {
      res.end()
      return
    }

    const stream = createReadStream(row.path, { start, end })
    stream.on('error', () => res.destroy())
    // Abandoned download (skip, channel change, seek) — stop reading immediately.
    req.on('close', () => stream.destroy())
    stream.pipe(res)
  }

  /**
   * Remux and transcode: ffmpeg's stdout *is* the response body.
   *
   * The output is fragmented MP4 (`frag_keyframe+empty_moov+default_base_moof`)
   * because a normal MP4 puts its index at the end of the file, which a live
   * pipe can never produce. There is no `Content-Length` — the body is an
   * open-ended pipe — and `Accept-Ranges: none` tells Chromium not to try
   * range-requesting something that isn't seekable; the player turns timeline
   * scrubs into a fresh request with `?t=` instead.
   */
  function servePipe(
    req: IncomingMessage,
    res: ServerResponse,
    row: EpisodeRow,
    seekS: number,
    key: string,
    channelId: number | null
  ): void {
    const { ffmpegPath, source } = resolveFfmpeg()
    if (!ffmpegPath || source === 'missing') {
      sendText(
        res,
        503,
        `This episode needs ffmpeg to play (${row.playback_path}), but no ffmpeg binary was found. ` +
          'Install it (pacman -S ffmpeg) and restart Rerun TV.'
      )
      return
    }

    const headers = {
      ...CORS_HEADERS,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-store'
    }

    // A HEAD on a piped path would spawn an encoder to answer a question we can
    // answer for free: it is an MP4 stream of unknown length.
    if (req.method === 'HEAD') {
      res.writeHead(200, headers)
      res.end()
      return
    }

    const args =
      row.playback_path === 'remux'
        ? remuxArgs(row.path, seekS, !needsAudioTranscode(row.acodec), getSettings())
        : transcodeArgs(row.path, seekS, getSettings())

    let headersSent = false
    const child: ChildProcess = supervisor.spawn(key, args, ffmpegPath, {
      onExit: (code, signal, stderrTail) => {
        if (signal !== null) {
          // We killed it: a skip, a channel change, or the client disconnecting.
          if (!headersSent && !res.writableEnded) res.destroy()
          return
        }
        if (code === 0) {
          if (!headersSent) sendText(res, 500, `ffmpeg produced no output\n${stderrTail}`)
          return
        }
        const error = new Error(
          `ffmpeg ${row.playback_path} job exited ${code} for episode ${row.id} ` +
            `(${row.path})\n${stderrTail}`
        )
        console.error(error.message)
        // Failing before the first byte is still reportable over HTTP; failing
        // mid-stream can only be a truncated body.
        if (!headersSent) sendText(res, 500, error.message)
        else if (!res.writableEnded) res.destroy()
      }
    })

    // Cap the channel after the spawn, never before: whatever was just asked for
    // is by definition the job to keep, and anything above the cap is a leftover
    // whose client went away without us hearing about it.
    if (channelId !== null) supervisor.trimGroup(channelPrefix(channelId), MAX_JOBS_PER_CHANNEL)

    const stdout = child.stdout
    if (!stdout) {
      sendText(res, 500, 'ffmpeg produced no stdout')
      return
    }

    // Hold the response open until ffmpeg actually emits its first fragment, so
    // an immediate failure (bad file, unsupported copy) surfaces as a 500 with
    // ffmpeg's own stderr rather than a zero-byte 200.
    stdout.once('data', (first: Buffer) => {
      stdout.pause()
      headersSent = true
      res.writeHead(200, headers)
      res.write(first)
      // pipe() also ends the response when ffmpeg's stdout ends, which is the
      // normal end of an episode.
      stdout.pipe(res)
    })

    // The client going away — skip, channel change, window closed — is the
    // signal to stop encoding. `killIfCurrent` so a stale request can't kill the
    // stream a newer tune-in already started on this channel's slot.
    req.on('close', () => supervisor.killIfCurrent(key, child))
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // 127.0.0.1 only: never reachable from the LAN.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('stream server did not bind to a TCP port')
  }
  const port = address.port

  return {
    port,
    urlFor(episodeId: number, seekS?: number, channelId?: number): string {
      const url = new URL(`http://127.0.0.1:${port}/stream/${episodeId}`)
      if (seekS !== undefined && seekS > 0) url.searchParams.set('t', String(seekS))
      if (channelId !== undefined) url.searchParams.set('ch', String(channelId))
      return url.toString()
    },
    releaseChannel(channelId: number): void {
      supervisor.killByPrefix(channelPrefix(channelId))
    },
    releaseEpisode(channelId: number, episodeId: number): void {
      supervisor.kill(channelKey(channelId, episodeId))
    },
    activeKeys(): string[] {
      return supervisor.activeKeys()
    },
    async close(): Promise<void> {
      supervisor.killAll()
      await closeServer(server)
    }
  }
}

/**
 * How many encoders one channel may own at once.
 *
 * Two, not one (docs/stall-fix-plan.html, phase 3): the episode on air, plus the
 * next one prewarming behind it for the last ~30 seconds of a handoff. After
 * phase 1 both are stream copies, so the overlap is nearly free.
 */
const MAX_JOBS_PER_CHANNEL = 2

/** Every supervisor key belonging to one channel shares this prefix. */
function channelPrefix(channelId: number): string {
  return `channel:${channelId}:`
}

/**
 * The supervisor slot for one episode on one channel. Keyed by episode as well as
 * channel so the current stream and the prewarming one occupy different slots,
 * while a *seek* — same channel, same episode — correctly replaces its own job.
 */
function channelKey(channelId: number, episodeId: number): string {
  return `${channelPrefix(channelId)}${episodeId}`
}

/** Everything before the input, shared by both piped paths. */
function inputArgs(file: string, seekS: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    // `-ss` before `-i` for a fast keyframe-aligned seek (plan §10 accepts the
    // resulting coarse seek in the MVP).
    ...(seekS > 0 ? ['-ss', String(seekS)] : []),
    '-i',
    file
  ]
}

/**
 * Exactly one video track and at most one audio track — nothing else.
 *
 * The two `-map`s are explicit because ffmpeg's default selection would also pick
 * up a subtitle track that MP4 cannot hold, which would fail the whole mux; the
 * audio map is optional (`?`) so a silent file still plays.
 *
 * `-map_chapters -1` is not covered by either of those, and it matters more than
 * it looks. The mov muxer copies a source's chapters into a **third track** — a
 * `text` track with a `gmhd`, plus `tref` boxes on the other two pointing at it.
 * Chromium's progressive demuxer shrugs at that; its *MediaSource* parser rejects
 * the whole initialisation segment with
 * `CHUNK_DEMUXER_ERROR_APPEND_FAILED: RunSegmentParserLoop: stream parsing failed`,
 * which takes down every episode ripped with chapter markers. There is no use for
 * a chapter track here — nothing in the app reads one — so it is dropped at the
 * source rather than tolerated downstream.
 */
const MAP_ARGS = ['-map', '0:v:0', '-map', '0:a:0?', '-map_chapters', '-1']

/**
 * The fragmented-MP4 pipe. `frag_keyframe+empty_moov+default_base_moof` is what
 * lets the muxer emit a playable stream without ever seeking back to write a
 * header — and, not by coincidence, is exactly the shape MediaSource wants.
 */
const FMP4_OUTPUT_ARGS = [
  '-movflags',
  'frag_keyframe+empty_moov+default_base_moof',
  '-f',
  'mp4',
  'pipe:1'
]

/**
 * Channel layouts AAC can name with a standard `channelConfiguration`, in
 * ffmpeg's spelling. Everything else is remapped to the nearest of these.
 *
 * This is not about how many speakers anyone has. AAC's AudioSpecificConfig can
 * describe these seven layouts with a single 4-bit `channelConfiguration`; for
 * anything else it must set that field to 0 and append a **Program Config
 * Element**, and Chromium's MediaSource AAC parser rejects `channelConfiguration
 * = 0` outright. The result was a whole class of episode that appended its video
 * track fine and then failed the init segment on its audio.
 *
 * The layout that actually triggers it is ordinary: a disc rip carrying AC3
 * `5.1(side)`. AAC's standard 5.1 is *back*-based, so the side variant has no
 * configuration number and ffmpeg reaches for a PCE. Constraining the layout
 * turns that into plain `5.1` — a relabel, not a downmix, and still six channels.
 * Surround survives; a 26-byte AudioSpecificConfig becomes a 5-byte one.
 *
 * A file that already has one of these layouts is unaffected, and a file with no
 * audio at all is fine too — the filter simply goes unused.
 */
const AAC_CHANNEL_LAYOUTS = 'mono|stereo|3.0|4.0|5.0|5.1|7.1'

/** Encode the soundtrack to AAC at the Settings bitrate, in a layout AAC can name. */
function aacArgs(settings: AppSettings): string[] {
  return [
    '-c:a',
    'aac',
    '-b:a',
    settings.transcodeAudioBitrate,
    '-af',
    `aformat=channel_layouts=${AAC_CHANNEL_LAYOUTS}`
  ]
}

/**
 * Remux: the video stream is always a byte copy, so this starts in milliseconds
 * and costs almost no CPU — the path for the overwhelming majority of a typical
 * library.
 *
 * `audioCodecOk` is the one knob. When the soundtrack is something Chromium
 * decodes it is copied too (`-c copy`, exactly as before). When it isn't — AC3,
 * E-AC3, DTS, TrueHD, PCM: the common case for anything ripped from a disc — only
 * the *audio* is encoded, to AAC at the Settings bitrate, while `-c:v copy`
 * keeps the expensive half free. That is the whole of phase 1: the same fMP4
 * pipe, the same `-ss` keyframe seek, roughly 1/50th of the CPU of the full
 * transcode these files used to get.
 *
 * The channel count is left alone deliberately: a 5.1 AC3 track becomes 5.1 AAC
 * rather than being silently folded to stereo.
 */
export function remuxArgs(
  file: string,
  seekS: number,
  audioCodecOk: boolean,
  settings: AppSettings
): string[] {
  return [
    ...inputArgs(file, seekS),
    ...MAP_ARGS,
    // `-af` cannot coexist with a stream copy, which is exactly why the filter
    // lives on the encode branch only.
    ...(audioCodecOk ? ['-c', 'copy'] : ['-c:v', 'copy', ...aacArgs(settings)]),
    ...FMP4_OUTPUT_ARGS
  ]
}

/**
 * Transcode: the fallback for HEVC, MPEG-2, 10-bit and friends — the files whose
 * *video* Chromium genuinely cannot decode. Sized for one stream at a time —
 * preset/CRF/audio bitrate come from Settings, and `-pix_fmt yuv420p` forces
 * 8-bit 4:2:0 because that is what Chromium's H.264 decoder accepts.
 */
export function transcodeArgs(file: string, seekS: number, settings: AppSettings): string[] {
  return [
    ...inputArgs(file, seekS),
    ...MAP_ARGS,
    '-c:v',
    'libx264',
    '-preset',
    settings.transcodePreset,
    '-crf',
    String(settings.transcodeCrf),
    '-pix_fmt',
    'yuv420p',
    ...aacArgs(settings),
    ...FMP4_OUTPUT_ARGS
  ]
}

/**
 * `server.close()` only stops new connections; a `<video>` element holding a
 * keep-alive socket would leave the promise pending forever, so tear the live
 * ones down too.
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.()
    server.close((err) => (err ? reject(err) : resolve()))
  })
}
