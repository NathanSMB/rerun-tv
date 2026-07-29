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

/**
 * An import that has been validated but not yet applied.
 *
 * It sits beside the live database so the swap can be a single `rename()`
 * within one filesystem — see `services/restore.ts` for why the swap happens at
 * boot rather than while the app is running.
 */
export function stagedImportPath(): string {
  return join(dataDir(), 'library.db.incoming')
}

/** What the staged import was made from, so the receipt survives the restart. */
export function stagedImportMetaPath(): string {
  return join(dataDir(), 'library.db.incoming.json')
}

/** Safety copies taken automatically before an import replaces the database. */
export function backupsDir(): string {
  const dir = join(dataDir(), 'backups')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Call before `app.whenReady()` so Electron's own caches land alongside it. */
export function configureAppPaths(): void {
  app.setPath('userData', dataDir())
}
