/**
 * The handful of settings that have to be known *before* the app is an app.
 *
 * ## Why this exists at all
 *
 * Settings live in SQLite (`db/repositories/settings.ts`), and the database is
 * opened inside `bootstrap()` — after `app.whenReady()`, and deliberately after
 * the staged-import swap, which is only safe while nothing holds a handle on the
 * file. That is the right order for every setting but one.
 *
 * Chromium's platform backend is chosen from the command line *before* the app
 * is ready. By the time we could ask the database, the window system has already
 * been picked. So the value is mirrored into a small JSON file that can be read
 * with one synchronous `readFileSync` at module scope, with no Electron, no
 * migrations and no database.
 *
 * The database stays the source of truth — Settings reads and writes it, and
 * this file is a cache written on the way past. It is treated as advisory
 * everywhere: a missing, unreadable or nonsense file falls back to the defaults
 * rather than failing a boot, because the alternative is an app that will not
 * start because of a corrupt convenience.
 *
 * ## The one setting in here
 *
 * `pipKeepOnTop` — whether the picture-in-picture window may pin itself above
 * other windows, which on Linux is really the question "X11 or Wayland?".
 *
 * A Wayland client cannot raise itself above other clients: there is no protocol
 * for it. Chromium asks all the same, and on Wayland the request is a no-op, so
 * the floating window is an ordinary window that any other window can cover —
 * and, having no titlebar, it offers no menu to fix that by hand either. Run the
 * same build through XWayland and the identical window arrives with
 * `_NET_WM_STATE_ABOVE`, `_NET_WM_STATE_STAYS_ON_TOP` and `_NET_WM_STATE_STICKY`
 * already set, which KWin (and every other X11 window manager) honours. Measured
 * both ways on Plasma 6 / Wayland; see docs/ui.md.
 *
 * The cost is real, which is why this is a setting and not a decision made for
 * everyone: XWayland means no per-monitor DPI and blurrier fractional scaling.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface BootConfig {
  /**
   * Run through XWayland so the PiP window can pin itself. Ignored outside a
   * Wayland session, where it is either already true or meaningless.
   */
  pipKeepOnTop: boolean
}

export const DEFAULT_BOOT_CONFIG: BootConfig = {
  pipKeepOnTop: true
}

/**
 * Resolved without `paths.ts` on purpose: this is read before `app` is usable,
 * and `dataDir()` calls `mkdirSync` and is imported alongside Electron. Same
 * directory, same XDG rule, no dependencies.
 */
export function bootConfigPath(): string {
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(xdg, 'rerun-tv', 'boot.json')
}

/** Never throws. A boot config we cannot read is a boot config we do not have. */
export function readBootConfig(path = bootConfigPath()): BootConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_BOOT_CONFIG
    const { pipKeepOnTop } = parsed as Partial<BootConfig>
    return {
      pipKeepOnTop:
        typeof pipKeepOnTop === 'boolean' ? pipKeepOnTop : DEFAULT_BOOT_CONFIG.pipKeepOnTop
    }
  } catch {
    // Absent on a first run, and unreadable only if something else broke. Either
    // way the defaults are a working app.
    return DEFAULT_BOOT_CONFIG
  }
}

/**
 * Mirror the setting out. Also never throws: failing to cache a preference must
 * not fail the write that actually persisted it.
 */
export function writeBootConfig(config: BootConfig, path = bootConfigPath()): void {
  try {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.warn('[boot] could not cache boot config:', error)
  }
}

/**
 * Is this a Wayland session — the only place the switch means anything?
 *
 * Read from the environment rather than from Electron, because this runs before
 * Electron can answer. On an X11 session the app is already where the setting
 * would send it, and on anything else the question does not arise.
 */
export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== 'linux') return false
  return env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY)
}

export type WindowSystem = 'wayland' | 'x11' | 'other'

/**
 * What was decided at boot, remembered rather than recomputed.
 *
 * Recomputing would be wrong the moment it mattered: toggling the setting
 * rewrites the boot config, so a fresh calculation would report the platform of
 * the *next* launch while this one is still running on the old one — and the
 * whole point of showing it is to say what is true now.
 */
let booted: WindowSystem | null = null

/** Called once, from the boot sequence, with the platform actually in force. */
export function recordWindowSystem(value: WindowSystem): void {
  booted = value
}

/**
 * Which window system Chromium is actually talking to.
 *
 * Reported to Settings so it can say what is true rather than what was asked
 * for: a Wayland session running through XWayland is exactly the state the
 * picture-in-picture toggle produces, and the one worth being able to see.
 */
export function currentWindowSystem(argv: string[] = process.argv): WindowSystem {
  if (booted !== null) return booted
  if (process.platform !== 'linux') return 'other'
  const flag = argv.find((arg) => arg.startsWith('--ozone-platform='))
  if (flag) {
    const value = flag.slice('--ozone-platform='.length)
    if (value === 'wayland' || value === 'x11') return value
  }
  // No flag and nothing recorded: Electron chose for itself, and since 36 it
  // prefers Wayland when the session offers one.
  return isWaylandSession() ? 'wayland' : 'x11'
}

/**
 * The Chromium platform to ask for, or null to leave Electron's own choice
 * alone.
 *
 * Electron 36 and later default to Wayland when a session offers it, so this is
 * the difference between a floating window that stays put and one that any
 * other window can bury.
 */
export function ozonePlatformOverride(
  config: BootConfig = readBootConfig(),
  env: NodeJS.ProcessEnv = process.env
): 'x11' | null {
  if (!config.pipKeepOnTop || !isWaylandSession(env)) return null
  // An explicit flag from the user or a launcher wins: someone who typed
  // `--ozone-platform=wayland` meant it.
  if (process.argv.some((arg) => arg.startsWith('--ozone-platform'))) return null
  return 'x11'
}

/**
 * Is something else supervising this process's lifetime?
 *
 * `electron-vite dev` starts the renderer's dev server, launches Electron as its
 * child, and treats that child exiting as "the app was closed". Applying the
 * platform means relaunching (see `index.ts`), and a relaunch under a supervisor
 * takes the dev server down with it — leaving a new window pointed at a
 * `localhost` that has stopped listening, which is to say a blank app.
 *
 * `ELECTRON_RENDERER_URL` is the signal, and already the flag `createWindow`
 * uses to tell a dev run from a real one.
 */
export function isSupervisedRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['ELECTRON_RENDERER_URL'])
}

/**
 * The platform to *relaunch onto*, or null to stay put — the question `index.ts`
 * actually asks. Separate from `ozonePlatformOverride` (what the setting wants)
 * so the difference between the two can be reported to whoever is running the
 * dev server rather than silently ignored.
 */
export function relaunchPlatform(
  config: BootConfig = readBootConfig(),
  env: NodeJS.ProcessEnv = process.env
): 'x11' | null {
  if (isSupervisedRun(env)) return null
  return ozonePlatformOverride(config, env)
}
