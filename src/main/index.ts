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
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EVENTS } from '../shared/ipc.js'
import {
  currentWindowSystem,
  ozonePlatformOverride,
  recordWindowSystem,
  relaunchPlatform,
  writeBootConfig
} from './boot-config.js'
import { syncKwinPipRule } from './kwin-rule.js'
import type { SystemInfo } from '../shared/types.js'
import { closeDb, openDatabase, setDb } from './db/index.js'
import { getSettings } from './db/repositories/settings.js'
import {
  backupsDir,
  configureAppPaths,
  databasePath,
  stagedImportMetaPath,
  stagedImportPath
} from './paths.js'
import { applyStagedImport, recordRestoreReceipt } from './services/restore.js'
import { Scanner } from './library/scanner.js'
import { LoudnessScanner } from './library/loudness.js'
import { startStreamServer, type StreamServer } from './stream/server.js'
import { checkCodecs, resolveFfmpeg } from './stream/ffmpeg.js'
import { broadcast, registerHandlers } from './ipc/handlers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The window system, chosen before anything else can be.
 *
 * This is the one setting that cannot come from the database: it decides which
 * display server Chromium connects to, and the database is not open until well
 * after that point — deliberately, because the staged-import swap has to happen
 * while nothing holds the file. So the value is mirrored to a small JSON file
 * the moment it changes, and read back here (`boot-config.ts`). Why it matters:
 * a Wayland client cannot raise itself above other windows, so a
 * picture-in-picture window that stays put is only possible through XWayland.
 *
 * **It has to be a relaunch, not a switch.** `app.commandLine.appendSwitch()`
 * is the obvious move and it does nothing at all: Chromium initialises its Ozone
 * platform during browser-process startup, which happens *before* this script
 * runs, so by the time any JavaScript could ask, the connection to the display
 * server is already made. (Measured: the switch applied cleanly, `app` reported
 * what we asked for, and the process was still on Wayland with no X11 window to
 * its name.) The same is true of `ELECTRON_OZONE_PLATFORM_HINT`. What is left is
 * to start again with the flag on the real command line.
 *
 * The cost is one extra process start — no window is created on this pass, and
 * it only happens when the launcher did not already pass the flag. The relaunch
 * cannot loop: `ozonePlatformOverride` returns null the moment an explicit
 * `--ozone-platform` is present, which the new process always has.
 */
/**
 * ...and it may only relaunch when nothing is supervising this process.
 *
 * `electron-vite dev` starts the renderer's dev server, then launches Electron as
 * its child and treats that child exiting as "the app is closed" — so a relaunch
 * takes the dev server down with it, and the replacement comes up pointing at a
 * `localhost` that is no longer listening: a blank window, and a shell prompt
 * back. `ELECTRON_RENDERER_URL` is exactly the signal for that, and already the
 * flag `createWindow` uses to tell dev from production.
 *
 * Passing `--ozone-platform=x11` on the command line still works in dev; it is
 * only the *self*-relaunch that has to sit out.
 */
const wantedOzone = ozonePlatformOverride()
const ozone = relaunchPlatform()
if (wantedOzone !== null && ozone === null) {
  // `npm run dev` normally passes the flag for us (`scripts/dev.mjs`), so this
  // is reached by running `electron-vite dev` directly.
  console.info(
    `[boot] dev: staying on the session default — a relaunch would take the dev ` +
      `server with it. Start with --ozone-platform=${wantedOzone} for window pinning.`
  )
}
const relaunching = ozone !== null
if (relaunching) {
  app.relaunch({ args: [...process.argv.slice(1), `--ozone-platform=${ozone}`] })
  app.exit(0)
}
recordWindowSystem(currentWindowSystem())

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

  const settings = getSettings(db)
  // Re-sync the boot cache with the database now that it is open. Normally a
  // no-op — the handler writes it on every change — but a restored backup
  // arrives with its own value and nothing else would ever reconcile the two.
  writeBootConfig({ pipKeepOnTop: settings.pipKeepOnTop })
  // Likewise the KWin rule, which is the other half of "keep it on top" and the
  // half no window can ask for itself (`kwin-rule.ts`). Idempotent, and a no-op
  // off KDE.
  syncKwinPipRule(settings.pipKeepOnTop)
  const ffmpeg = resolveFfmpeg()

  streamServer = await startStreamServer({ db, getSettings: () => getSettings(db) })

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

  if (settings.watchFolders) scanner.startWatching()
  void scanner.scan().catch((err) => console.error('[scan] initial pass failed:', err))
  // Measuring waits behind the initial scan on its own (`isBusy`), so this only
  // has to be kicked once.
  loudnessScanner.start()
}

// A single instance owns the database and the stream port; a second launch
// should just focus the window that's already running.
//
// Skipped entirely while relaunching onto another window system: this process is
// on its way out and must not take the lock the replacement is about to ask for.
if (relaunching) {
  // Nothing. `app.exit(0)` above ends this process; the flagged one takes over.
} else if (!app.requestSingleInstanceLock()) {
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
