/**
 * Main-process bootstrap.
 *
 * Boot order matters and is deliberate:
 *   1. point Electron at the XDG data dir, so the database and Electron's own
 *      caches live together;
 *   2. open and migrate SQLite — everything downstream needs it;
 *   3. resolve ffmpeg and start the loopback stream server, so a `streamUrl`
 *      can be handed out the instant the renderer tunes in;
 *   4. start the scanner (and, if enabled, the folder watcher);
 *   5. register IPC handlers, then finally open the window.
 *
 * The codec check runs in the background: it must never delay the window, and
 * per plan §10 a failure is non-fatal — anything unplayable simply routes to
 * the transcode path.
 */

import { app, BrowserWindow, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENTS } from '../shared/ipc.js'
import type { SystemInfo } from '../shared/types.js'
import { closeDb, openDatabase, setDb } from './db/index.js'
import { getSettings } from './db/repositories/settings.js'
import { configureAppPaths, databasePath } from './paths.js'
import { Scanner } from './library/scanner.js'
import { startStreamServer, type StreamServer } from './stream/server.js'
import { checkCodecs, resolveFfmpeg } from './stream/ffmpeg.js'
import { broadcast, registerHandlers } from './ipc/handlers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let streamServer: StreamServer | null = null
let scanner: Scanner | null = null
let codecStatus: SystemInfo['codecCheck'] = 'pending'

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Matches --tube so there's no white flash before the renderer paints.
    backgroundColor: '#0b0e14',
    title: 'Rerun TV',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // The renderer is a local UI, never a browser: external links open in the
  // user's actual browser and in-window navigation is refused outright.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

async function bootstrap(): Promise<void> {
  const db = openDatabase(databasePath())
  setDb(db)

  const settings = getSettings(db)
  const ffmpeg = resolveFfmpeg()

  streamServer = await startStreamServer({ db, getSettings: () => getSettings(db) })

  scanner = new Scanner({
    db,
    ffprobePath: ffmpeg.ffprobePath ?? 'ffprobe',
    onProgress: (status) => broadcast(EVENTS.scanProgress, status),
    onLibraryChanged: () => broadcast(EVENTS.libraryChanged)
  })

  registerHandlers({
    db,
    scanner,
    stream: streamServer,
    codecCheck: () => codecStatus
  })

  createWindow()

  // Background work, after the window is on its way.
  void checkCodecs(ffmpeg.ffmpegPath)
    .then((result) => {
      codecStatus = result
    })
    .catch(() => {
      codecStatus = 'failed'
    })

  if (settings.watchFolders) scanner.startWatching()
  void scanner.scan().catch((err) => console.error('[scan] initial pass failed:', err))
}

// A single instance owns the database and the stream port; a second launch
// should just focus the window that's already running.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  configureAppPaths()

  void app.whenReady().then(() => {
    void bootstrap().catch((err) => {
      console.error('[boot] failed:', err)
      app.quit()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('will-quit', () => {
    scanner?.dispose()
    void streamServer?.close()
    closeDb()
  })
}
