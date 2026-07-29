/**
 * Where Rerun TV keeps its state on disk.
 *
 * One SQLite file under Electron's `userData`, which on Linux resolves to
 * `~/.config/rerun-tv` by default. We override it to the XDG *data* directory
 * (`~/.local/share/rerun-tv`) because a media library index is data, not
 * configuration — and it's the path the Settings screen advertises.
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { app } from 'electron'

export function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const dir = join(xdg, 'rerun-tv')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function databasePath(): string {
  return join(dataDir(), 'library.db')
}

/** Call before `app.whenReady()` so Electron's own caches land alongside it. */
export function configureAppPaths(): void {
  app.setPath('userData', dataDir())
}
