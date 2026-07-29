/**
 * The main-process side of the IPC contract.
 *
 * One `ipcMain.handle` per channel in `IPC`, in the same order as the
 * `RerunApi` interface. There is deliberately almost no logic here — handlers
 * translate an IPC call into a call on the library, scheduler, or stream
 * subsystem and hand back a view model. Anything that looks like a decision
 * belongs in `services/` or `scheduler/`, not in this file.
 *
 * Every handler is wrapped so a thrown error crosses the bridge as a readable
 * message instead of an opaque `Error invoking remote method`.
 */

import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { copyFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EVENTS, IPC } from '../../shared/ipc.js'
import type {
  AppSettings,
  AssignUnmatchedInput,
  CreateArcInput,
  CreateChannelInput,
  EpisodeView,
  NowPlaying,
  PlayMode,
  ScanStatus,
  SystemInfo,
  UpdateChannelInput
} from '../../shared/types.js'
import type { Db } from '../db/index.js'
import { databasePath } from '../paths.js'
import { getSettings, setSetting } from '../db/repositories/settings.js'
import * as libraryRepo from '../db/repositories/library.js'
import * as channelRepo from '../db/repositories/channels.js'
import { getLibraryOverview, assignUnmatched } from '../services/library.js'
import { getChannelDetail, listChannelSummaries, toEpisodeView } from '../services/channels.js'
import { peekNext, pickNext, resetProgress, validateActiveArc } from '../scheduler/scheduler.js'
import type { Scanner } from '../library/scanner.js'
import type { StreamServer } from '../stream/server.js'
import { resolveFfmpeg } from '../stream/ffmpeg.js'

export interface HandlerContext {
  db: Db
  scanner: Scanner
  stream: StreamServer
  /** Resolved once at startup; `pending` until the check finishes. */
  codecCheck: () => SystemInfo['codecCheck']
}

/** Broadcast a push event to every open window. */
export function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * Assemble a `NowPlaying` from a committed scheduler pick.
 *
 * The `?ch=` parameter is what lets the stream server enforce the plan's
 * "never more than one ffmpeg job per channel" rule — it tells the supervisor
 * which job slot this request belongs to.
 */
function toNowPlaying(ctx: HandlerContext, channelId: number, episodeId: number, arc: NowPlaying['arc']): NowPlaying | null {
  const channel = channelRepo.getChannel(ctx.db, channelId)
  const episode = toEpisodeView(ctx.db, episodeId)
  if (!channel || !episode) return null

  return {
    channelId: channel.id,
    channelNumber: channel.number,
    channelName: channel.name,
    episode,
    // No seek: tuning in always starts an episode from the top (plan §7).
    streamUrl: ctx.stream.urlFor(episodeId, 0, channelId),
    arc
  }
}

export function registerHandlers(ctx: HandlerContext): void {
  const { db } = ctx

  const handle = (channel: string, fn: (...args: never[]) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await (fn as (...a: unknown[]) => unknown)(...args)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[ipc] ${channel} failed:`, err)
        throw new Error(message)
      }
    })
  }

  const ffprobePath = (): string => {
    const { ffprobePath: path } = resolveFfmpeg()
    if (!path) throw new Error('ffprobe not found — install ffmpeg (pacman -S ffmpeg)')
    return path
  }

  // ---- library ------------------------------------------------------------

  handle(IPC.library.getOverview, () => getLibraryOverview(db))
  handle(IPC.library.listShows, () => libraryRepo.listShows(db))
  handle(IPC.library.listEpisodes, (showId: number) => libraryRepo.listEpisodes(db, showId))
  handle(IPC.library.listRoots, () => libraryRepo.listScanRoots(db))

  handle(IPC.library.addRoot, (path: string) => {
    libraryRepo.addScanRoot(db, path)
    void ctx.scanner.scan()
    ctx.scanner.startWatching()
    return libraryRepo.listScanRoots(db)
  })

  handle(IPC.library.removeRoot, (rootId: number) => {
    libraryRepo.removeScanRoot(db, rootId)
    broadcast(EVENTS.libraryChanged)
    return libraryRepo.listScanRoots(db)
  })

  // Fire-and-forget: the scan reports itself through the progress event, so the
  // renderer's button doesn't sit disabled for the length of a full pass.
  handle(IPC.library.rescan, (full?: boolean) => {
    void ctx.scanner.scan(full ?? false)
  })
  handle(IPC.library.pauseScan, () => ctx.scanner.pause())
  handle(IPC.library.resumeScan, () => ctx.scanner.resume())
  handle(IPC.library.getScanStatus, (): ScanStatus => ctx.scanner.getStatus())

  handle(IPC.library.assignUnmatched, async (input: AssignUnmatchedInput) => {
    await assignUnmatched(db, input, ffprobePath())
    broadcast(EVENTS.libraryChanged)
  })

  handle(IPC.library.dismissUnmatched, (fileId: number) => {
    libraryRepo.removeUnmatched(db, fileId)
    broadcast(EVENTS.libraryChanged)
  })

  handle(IPC.library.listArcs, (showId: number) => libraryRepo.listArcs(db, showId))

  handle(IPC.library.createArc, (input: CreateArcInput) => {
    const arc = libraryRepo.createArc(db, input.showId, input.title, input.episodeIds, 'manual')
    broadcast(EVENTS.libraryChanged)
    return arc
  })

  handle(IPC.library.deleteArc, (groupId: number) => {
    libraryRepo.deleteArc(db, groupId)
    broadcast(EVENTS.libraryChanged)
  })

  // ---- channels -----------------------------------------------------------

  const channelsChanged = <T>(value: T): T => {
    broadcast(EVENTS.channelsChanged)
    return value
  }

  handle(IPC.channels.list, () => listChannelSummaries(db))
  handle(IPC.channels.get, (channelId: number) => getChannelDetail(db, channelId))

  handle(IPC.channels.create, (input: CreateChannelInput) =>
    channelsChanged(channelRepo.createChannel(db, input.name, input.number))
  )
  handle(IPC.channels.update, (channelId: number, patch: UpdateChannelInput) =>
    channelsChanged(channelRepo.updateChannel(db, channelId, patch))
  )
  handle(IPC.channels.remove, (channelId: number) => {
    ctx.stream.releaseChannel(channelId)
    channelRepo.deleteChannel(db, channelId)
    channelsChanged(null)
  })
  handle(IPC.channels.reorder, (channelIds: number[]) =>
    channelsChanged(channelRepo.reorderChannels(db, channelIds))
  )

  handle(IPC.channels.addShow, (channelId: number, showId: number) => {
    channelRepo.addChannelShow(db, channelId, showId)
    return channelsChanged(getChannelDetail(db, channelId))
  })
  handle(IPC.channels.removeShow, (channelId: number, showId: number) => {
    channelRepo.removeChannelShow(db, channelId, showId)
    return channelsChanged(getChannelDetail(db, channelId))
  })
  handle(IPC.channels.setMode, (channelId: number, showId: number, mode: PlayMode) => {
    channelRepo.setChannelShowMode(db, channelId, showId, mode)
    return channelsChanged(getChannelDetail(db, channelId))
  })
  handle(
    IPC.channels.setSeasonMode,
    (channelId: number, showId: number, season: number, mode: PlayMode | null) => {
      channelRepo.setChannelShowSeasonMode(db, channelId, showId, season, mode)
      return channelsChanged(getChannelDetail(db, channelId))
    }
  )
  handle(IPC.channels.setWeight, (channelId: number, showId: number, weight: number) => {
    channelRepo.setChannelShowWeight(db, channelId, showId, weight)
    return channelsChanged(getChannelDetail(db, channelId))
  })
  handle(IPC.channels.resetProgress, (channelId: number, showId: number) => {
    resetProgress(db, channelId, showId)
    return channelsChanged(getChannelDetail(db, channelId))
  })

  // ---- player -------------------------------------------------------------

  handle(IPC.player.tune, (channelId: number): NowPlaying | null => {
    // An arc left dangling by a crash mid-airing is validated (and cleared if
    // stale) here, at tune-in — plan §10.
    validateActiveArc(db, channelId)
    ctx.stream.releaseChannel(channelId)
    const pick = pickNext(db, channelId)
    if (!pick) return null
    return toNowPlaying(ctx, channelId, pick.episodeId, pick.arc)
  })

  handle(IPC.player.next, (channelId: number): NowPlaying | null => {
    // Kill the outgoing job the moment the channel advances, so a skip never
    // leaves a second ffmpeg running.
    ctx.stream.releaseChannel(channelId)
    const pick = pickNext(db, channelId)
    if (!pick) return null
    return toNowPlaying(ctx, channelId, pick.episodeId, pick.arc)
  })

  handle(IPC.player.peekNext, (channelId: number): EpisodeView | null => {
    const pick = peekNext(db, channelId)
    return pick ? toEpisodeView(db, pick.episodeId) : null
  })

  handle(IPC.player.reportEnded, (channelId: number, episodeId: number, completed: boolean) => {
    channelRepo.markLastAiringCompleted(db, channelId, episodeId, completed)
  })

  // ---- settings -----------------------------------------------------------

  handle(IPC.settings.getAll, () => getSettings(db))
  handle(IPC.settings.set, (key: keyof AppSettings, value: never) => {
    const settings = setSetting(db, key, value)
    // Toggling folder watching takes effect immediately rather than at restart.
    if (key === 'watchFolders') {
      if (settings.watchFolders) ctx.scanner.startWatching()
      else ctx.scanner.stopWatching()
    }
    return settings
  })

  // ---- system -------------------------------------------------------------

  handle(IPC.system.getInfo, (): SystemInfo => {
    const ff = resolveFfmpeg()
    const dbPath = databasePath()
    let dbSizeBytes = 0
    try {
      dbSizeBytes = statSync(dbPath).size
    } catch {
      // The file may not exist yet on a very first run.
    }
    return {
      appVersion: app.getVersion(),
      ffmpegPath: ff.ffmpegPath,
      ffprobePath: ff.ffprobePath,
      ffmpegVersion: ff.version,
      ffmpegSource: ff.source,
      codecCheck: ctx.codecCheck(),
      dbPath,
      dbSizeBytes,
      streamPort: ctx.stream.port
    }
  })

  handle(IPC.system.pickFolder, async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: 'Add a library folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle(IPC.system.backupDb, async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = await dialog.showSaveDialog(win, {
      title: 'Back up the library database',
      defaultPath: join(app.getPath('home'), 'rerun-tv-library.db')
    })
    if (result.canceled || !result.filePath) return null
    // WAL checkpoint first, so the copy is a complete database on its own.
    db.pragma('wal_checkpoint(TRUNCATE)')
    copyFileSync(databasePath(), result.filePath)
    return result.filePath
  })
}
