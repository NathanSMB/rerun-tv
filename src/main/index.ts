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

import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { rmSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import appIcon from '../../resources/icon.png?asset'
import { EVENTS } from '../shared/ipc.js'
import { ensureDesktopEntry } from './desktop-entry.js'
import { ensureKwinPipRule } from './kwin-rule.js'
import { PENDING_HW_ACCEL, type HwAccelReport, type SystemInfo } from '../shared/types.js'
import { closeDb, openDatabase, setDb, type Db } from './db/index.js'
import { getSettings } from './db/repositories/settings.js'
import {
  backupsDir,
  configureAppPaths,
  dataDir,
  databasePath,
  stagedImportMetaPath,
  stagedImportPath
} from './paths.js'
import { applyStagedImport, recordRestoreReceipt } from './services/restore.js'
import { Scanner } from './library/scanner.js'
import { LoudnessScanner } from './library/loudness.js'
import { startStreamServer, type StreamServer } from './stream/server.js'
import { checkCodecs, resolveFfmpeg } from './stream/ffmpeg.js'
import { probeHardwareAccel } from './stream/hwaccel.js'
import { broadcast, registerHandlers } from './ipc/handlers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The renderer's origin, `app://bundle`.
 *
 * A packaged Electron app would ordinarily load its renderer over `file://`, and
 * this one did. But a `file://` document has an *opaque* origin, and Chromium
 * refuses blob URLs from one — not just for media, for anything: even
 * `fetch(URL.createObjectURL(new Blob(['hi'])))` fails. The MSE pump
 * (`renderer/player/mse.ts`) attaches its `MediaSource` to the `<video>` through
 * exactly such a URL, and Chromium answers with
 * `MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check`.
 *
 * (The `srcObject` route is not an escape: `HTMLMediaElement.srcObject` accepts
 * only a `MediaStream` or a `MediaSourceHandle`, and `MediaSource.handle` is
 * exposed in workers only — while a worker cannot be loaded from `file://`
 * either. Verified against this Electron build, not assumed.)
 *
 * So the renderer gets a real origin. `standard` makes it URL-parseable and
 * origin-bearing, `secure` puts it in a secure context (blob URLs, and everything
 * else that requires one), and `supportFetchAPI`/`corsEnabled` mean the pump's
 * cross-origin `fetch` to the loopback stream server behaves like an ordinary
 * CORS request — which the server answers with `Access-Control-Allow-Origin`.
 *
 * Nothing about the threat model changes: the scheme serves exactly one
 * directory, the bundle we shipped.
 */
const APP_SCHEME = 'app'
const APP_ORIGIN = `${APP_SCHEME}://bundle`

// Must run before `app.ready`, hence module scope rather than inside bootstrap.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

/**
 * Serve the built renderer under `app://bundle/`.
 *
 * The path is resolved and then checked to be inside the bundle directory. A
 * request that escapes it is either a bug or an attack; either way it gets a 404
 * rather than a file. `..` in a `standard` scheme's URL is normalised away by the
 * URL parser before we ever see it, so this is belt and braces — which is the
 * right amount for the one code path that turns a URL into a filesystem read.
 */
function registerRendererProtocol(): void {
  const root = normalize(join(__dirname, '..', 'renderer'))

  protocol.handle(APP_SCHEME, async (request) => {
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname)
    } catch {
      return new Response('bad request', { status: 400 })
    }

    const relative = pathname.replace(/^\/+/, '')
    const target = normalize(join(root, relative === '' ? 'index.html' : relative))
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response('not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
}

let mainWindow: BrowserWindow | null = null
let streamServer: StreamServer | null = null
let scanner: Scanner | null = null
let loudnessScanner: LoudnessScanner | null = null
let codecStatus: SystemInfo['codecCheck'] = 'pending'
/** What the GPU probe found. `pending` until it answers, which reads as software. */
let hwAccelStatus: HwAccelReport = PENDING_HW_ACCEL

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
    // Linux has no bundle to read an icon from, so the window carries its own;
    // packaged builds get the same `resources/icon.png` via electron-builder.
    icon: appIcon,
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

  // Dev already serves the renderer over http://localhost, which is a real origin
  // too; production gets `app://bundle` for the same reason (see APP_SCHEME).
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadURL(`${APP_ORIGIN}/index.html`)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/**
 * Tear everything down and come back up — how a staged import is applied.
 *
 * `app.exit()` rather than `app.quit()`: quitting races the single-instance
 * lock the relaunched process immediately asks for. Exiting skips `will-quit`,
 * which is why the teardown is spelled out here instead.
 */
async function restart(): Promise<void> {
  scanner?.dispose()
  loudnessScanner?.dispose()
  await streamServer?.close() // awaited so ffmpeg children die with us
  closeDb() // checkpoints and removes -wal/-shm
  app.relaunch()
  app.exit(0)
}

/**
 * Clear out what the XWayland era left behind.
 *
 * Keeping the floating window on top used to mean relaunching onto XWayland,
 * chosen by a `pipKeepOnTop` setting and mirrored to a `boot.json` beside the
 * database so it could be read before the database was open. The KWin rule does
 * the whole job now, so both are gone from the code — and nothing else is left
 * to tidy them off disk. Never throws: leftovers are inert, and a failed cleanup
 * must not cost anyone their television.
 */
function removeXwaylandLeftovers(db: Db): void {
  try {
    db.prepare("DELETE FROM settings WHERE key = 'pipKeepOnTop'").run()
  } catch (error) {
    console.warn('[boot] could not drop the stale pipKeepOnTop setting:', error)
  }
  try {
    rmSync(join(dataDir(), 'boot.json'))
  } catch {
    // Absent on every run but the first after upgrading, which is the point.
  }
}

async function bootstrap(): Promise<void> {
  // Before anything opens the database: if an import is staged, this is the one
  // moment nothing holds a handle on the file, so the swap is safe here.
  const receipt = applyStagedImport({
    dbPath: databasePath(),
    stagedPath: stagedImportPath(),
    metaPath: stagedImportMetaPath(),
    backupsDir: backupsDir()
  })

  const db = openDatabase(databasePath())
  setDb(db)
  if (receipt) recordRestoreReceipt(db, receipt)

  removeXwaylandLeftovers(db)

  const settings = getSettings(db)
  // How the picture-in-picture window stays above a full-screen game: a KWin
  // window rule, which is the only thing that can put a window in the overlay
  // layer and works the same whether we are on Wayland or X11 (`kwin-rule.ts`).
  // Idempotent, and a no-op off KDE.
  ensureKwinPipRule()
  // How the taskbar gets an icon on Wayland: a desktop entry matching our
  // `app_id`, installed the same way (`desktop-entry.ts`). The `icon` option on
  // the window below only covers X11.
  ensureDesktopEntry(
    appIcon,
    join(dataDir(), 'icon.png'),
    process.env['APPIMAGE'] ?? `"${process.execPath}" "${app.getAppPath()}"`
  )
  const ffmpeg = resolveFfmpeg()

  streamServer = await startStreamServer({
    db,
    getSettings: () => getSettings(db),
    getHwAccel: () => hwAccelStatus
  })

  scanner = new Scanner({
    db,
    ffprobePath: ffmpeg.ffprobePath ?? 'ffprobe',
    onProgress: (status) => broadcast(EVENTS.scanProgress, status),
    onLibraryChanged: () => {
      broadcast(EVENTS.libraryChanged)
      // New episodes are new work for the measuring job — and a no-op when it
      // is already running or the setting is off.
      loudnessScanner?.start()
    }
  })

  loudnessScanner = new LoudnessScanner({
    db,
    ffmpegPath: ffmpeg.ffmpegPath,
    getSettings: () => getSettings(db),
    // "Busy" is anything the user would hear or watch stutter: a live encoder on
    // any channel, or a library scan already spending the disk.
    isBusy: () =>
      (streamServer?.activeKeys().length ?? 0) > 0 || scanner?.getStatus().state === 'scanning'
  })

  registerHandlers({
    db,
    scanner,
    loudness: loudnessScanner,
    stream: streamServer,
    codecCheck: () => codecStatus,
    hwAccel: () => hwAccelStatus,
    restart
  })

  registerRendererProtocol()
  createWindow()

  // Background work, after the window is on its way.
  void checkCodecs(ffmpeg.ffmpegPath)
    .then((result) => {
      codecStatus = result
    })
    .catch(() => {
      codecStatus = 'failed'
    })

  // Same contract as the codec check: non-fatal, never blocks the window, and
  // until it answers every transcode runs on software (`effectiveAccel`).
  void probeHardwareAccel(ffmpeg.ffmpegPath)
    .then((report) => {
      hwAccelStatus = report
      const found = [
        report.vaapi === 'ok' ? `vaapi (${report.vaapiDevice})` : null,
        report.nvenc === 'ok' ? 'nvenc' : null
      ].filter(Boolean)
      console.log(
        found.length > 0
          ? `[hwaccel] available: ${found.join(', ')}`
          : '[hwaccel] no hardware encoder available; transcodes run on libx264'
      )
    })
    .catch(() => {
      hwAccelStatus = { vaapi: 'failed', nvenc: 'failed', vaapiDevice: null }
    })

  if (settings.watchFolders) scanner.startWatching()
  void scanner.scan().catch((err) => console.error('[scan] initial pass failed:', err))
  // Measuring waits behind the initial scan on its own (`isBusy`), so this only
  // has to be kicked once.
  loudnessScanner.start()
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
    loudnessScanner?.dispose()
    void streamServer?.close()
    closeDb()
  })
}
