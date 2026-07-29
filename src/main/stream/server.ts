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
import { normalizeContainer } from '@shared/playback.js'
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
  /** `http://127.0.0.1:<port>/stream/<episodeId>` — the one URL shape the `<video>` element ever sees. */
  urlFor(episodeId: number, seekS?: number, channelId?: number): string
  /** Kill the ffmpeg job serving a channel, e.g. on skip or channel change. */
  releaseChannel(channelId: number): void
  close(): Promise<void>
}

/** The only columns the server needs; everything else about the episode is the UI's problem. */
interface EpisodeRow {
  id: number
  path: string
  playback_path: PlaybackPath
  container: string
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
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

function sendText(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
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
    'SELECT id, path, playback_path, container FROM episodes WHERE id = ?'
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
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' })
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
    const key = channelId !== null ? channelKey(channelId) : `episode:${row.id}`

    if (row.playback_path === 'direct') {
      await serveFile(req, res, row)
      return
    }
    servePipe(req, res, row, seekS, key)
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
    key: string
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
        ? remuxArgs(row.path, seekS)
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
      supervisor.kill(channelKey(channelId))
    },
    async close(): Promise<void> {
      supervisor.killAll()
      await closeServer(server)
    }
  }
}

/** The supervisor slot for a channel — one running job per channel, by construction. */
function channelKey(channelId: number): string {
  return `channel:${channelId}`
}

/**
 * Remux: no re-encoding at all, so this starts in milliseconds and costs almost
 * no CPU — the expected path for a typical H.264/AAC MKV library.
 *
 * `-ss` goes *before* `-i` for a fast keyframe-aligned seek (plan §10 accepts
 * the resulting coarse seek in the MVP). Streams are mapped explicitly because
 * ffmpeg's default selection would also pick up a subtitle track that MP4
 * cannot hold, which would fail the whole mux; the audio map is optional (`?`)
 * so a silent file still plays.
 */
function remuxArgs(file: string, seekS: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    ...(seekS > 0 ? ['-ss', String(seekS)] : []),
    '-i',
    file,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1'
  ]
}

/**
 * Transcode: the fallback for HEVC, DTS, 10-bit and friends. Sized for one
 * stream at a time — preset/CRF/audio bitrate come from Settings, and
 * `-pix_fmt yuv420p` forces 8-bit 4:2:0 because that is what Chromium's H.264
 * decoder accepts.
 */
function transcodeArgs(file: string, seekS: number, settings: AppSettings): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    ...(seekS > 0 ? ['-ss', String(seekS)] : []),
    '-i',
    file,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    settings.transcodePreset,
    '-crf',
    String(settings.transcodeCrf),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    settings.transcodeAudioBitrate,
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1'
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
