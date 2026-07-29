/**
 * Importing a database — the other half of "Back up…".
 *
 * The awkward part isn't reading the file, it's *when* the swap can happen.
 * `bootstrap()` hands the `Db` object by value to the stream server, the
 * scanner, and the IPC handlers, so `setDb()` would change nothing; worse, the
 * stream server holds a prepared statement bound to that handle and the
 * scanner's prune step deletes episode rows whose paths it didn't see this
 * pass. A scan that began on one database and finished on another would delete
 * real data.
 *
 * So an import happens in two moves. `inspectAndStage()` validates the picked
 * file and writes a clean copy next to the live database while the app runs
 * normally; `applyStagedImport()` swaps it in at the next boot, before anything
 * has the database open. The swap itself is one `rename()` within a single
 * directory — atomic, so a crash at any point leaves either the old database
 * untouched or the import still pending, never something half-written.
 *
 * Electron is deliberately not imported here (paths are passed in) so the whole
 * module is drivable from Vitest.
 */

import Database from 'better-sqlite3'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync
} from 'node:fs'
import { basename, join } from 'node:path'
import type { RestoreReceipt } from '../../shared/types.js'
import { MIGRATIONS } from '../db/schema.js'
import { openDatabase, type Db } from '../db/index.js'

/** Every SQLite file on earth starts with this. */
const SQLITE_MAGIC = 'SQLite format 3\0'

/** Tables that make a SQLite file *ours* rather than some other app's. */
const REQUIRED_TABLES = ['shows', 'episodes', 'channels', 'settings']

/** Enough sampled paths to be representative without stat-ing a whole library. */
const PATH_SAMPLE_SIZE = 200

/** Safety copies kept in the backups directory before older ones are pruned. */
const DEFAULT_KEEP = 5

const BACKUP_PREFIX = 'library-pre-restore-'

/** What we learned about a candidate file, shown in the confirm dialog. */
export interface ImportInspection {
  sourcePath: string
  /** `user_version` of the source, *before* it was migrated forward. */
  sourceSchemaVersion: number
  /** `user_version` after staging — always `MIGRATIONS.length`. */
  schemaVersion: number
  shows: number
  episodes: number
  channels: number
  /** How many episode paths we checked on disk. */
  sampled: number
  /** How many of those weren't there. */
  missing: number
}

/** Written beside the staged file so the receipt survives the restart. */
interface StagedMeta {
  sourcePath: string
  stagedAt: string
  shows: number
  episodes: number
  channels: number
}

export interface ApplyOptions {
  dbPath: string
  stagedPath: string
  metaPath: string
  backupsDir: string
  /** How many pre-restore copies to keep. */
  keep?: number
}

function count(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return row.n
}

/** Read the first bytes of a file without slurping a multi-megabyte database. */
function readMagic(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(SQLITE_MAGIC.length)
    const read = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, read).toString('binary')
  } finally {
    closeSync(fd)
  }
}

/**
 * Validate a candidate database and stage it for the next boot.
 *
 * Throws a message meant for a human — it goes straight to the Settings status
 * banner via the IPC error wrapper.
 */
export function inspectAndStage(
  sourcePath: string,
  stagedPath: string,
  metaPath: string
): ImportInspection {
  const stat = (() => {
    try {
      return statSync(sourcePath)
    } catch {
      throw new Error(`${basename(sourcePath)} could not be read.`)
    }
  })()

  if (!stat.isFile()) throw new Error(`${basename(sourcePath)} is not a file.`)
  if (stat.size === 0) throw new Error(`${basename(sourcePath)} is empty.`)

  if (readMagic(sourcePath) !== SQLITE_MAGIC) {
    throw new Error(`${basename(sourcePath)} is not a SQLite database.`)
  }

  // Read-only: a candidate file is never written to, so picking the wrong thing
  // costs nothing.
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  let sourceSchemaVersion: number
  try {
    const integrity = source.pragma('integrity_check', { simple: true }) as string
    if (integrity !== 'ok') {
      throw new Error(`${basename(sourcePath)} is corrupt and cannot be imported.`)
    }

    sourceSchemaVersion = source.pragma('user_version', { simple: true }) as number
    if (sourceSchemaVersion === 0) {
      throw new Error(`${basename(sourcePath)} is not a Rerun TV database.`)
    }
    if (sourceSchemaVersion > MIGRATIONS.length) {
      throw new Error(
        `${basename(sourcePath)} was made by a newer version of Rerun TV ` +
          `(schema ${sourceSchemaVersion}, this version understands ${MIGRATIONS.length}). ` +
          'Update Rerun TV, then import it again.'
      )
    }

    const tables = new Set(
      (
        source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string
        }[]
      ).map((row) => row.name)
    )
    const missingTable = REQUIRED_TABLES.find((name) => !tables.has(name))
    if (missingTable != null) {
      throw new Error(
        `${basename(sourcePath)} is a SQLite database, but not a Rerun TV one ` +
          `(no \`${missingTable}\` table).`
      )
    }

    // VACUUM INTO rather than a file copy: it merges any unmerged WAL, writes a
    // defragmented self-contained file with no sidecars, and fails loudly on a
    // source that integrity_check somehow let through.
    rmSync(stagedPath, { force: true })
    source.prepare('VACUUM INTO ?').run(stagedPath)
  } finally {
    source.close()
  }

  // From here on the staged file exists, so any failure has to clean it up.
  try {
    // Opening runs `migrate()`, bringing an older backup up to today's schema.
    const staged = openDatabase(stagedPath)
    try {
      const shows = count(staged, 'shows')
      const episodes = count(staged, 'episodes')
      const channels = count(staged, 'channels')

      const paths = (
        staged.prepare('SELECT path FROM episodes LIMIT ?').all(PATH_SAMPLE_SIZE) as {
          path: string
        }[]
      ).map((row) => row.path)
      const missing = paths.filter((path) => !existsSync(path)).length

      const meta: StagedMeta = {
        sourcePath,
        stagedAt: new Date().toISOString(),
        shows,
        episodes,
        channels
      }
      writeFileSync(metaPath, JSON.stringify(meta, null, 2))

      return {
        sourcePath,
        sourceSchemaVersion,
        schemaVersion: staged.pragma('user_version', { simple: true }) as number,
        shows,
        episodes,
        channels,
        sampled: paths.length,
        missing
      }
    } finally {
      staged.close()
    }
  } catch (err) {
    rmSync(stagedPath, { force: true })
    rmSync(metaPath, { force: true })
    throw err
  }
}

/** Throw away a staged import — the user cancelled at the confirm. */
export function discardStagedImport(stagedPath: string, metaPath: string): void {
  rmSync(stagedPath, { force: true })
  rmSync(metaPath, { force: true })
}

/**
 * Swap a staged import into place. Call at boot, before the database is opened.
 *
 * Returns the receipt to record, or null when there was nothing staged (the
 * overwhelmingly common case) or when the swap failed and we left the existing
 * database alone.
 */
export function applyStagedImport(opts: ApplyOptions): RestoreReceipt | null {
  const { dbPath, stagedPath, metaPath, backupsDir, keep = DEFAULT_KEEP } = opts
  if (!existsSync(stagedPath)) return null

  const meta = readMeta(metaPath)
  const backupPath = backupCurrent(dbPath, backupsDir)

  try {
    // The live database is closed at this point, so these exist only if the
    // last run was killed. Either way they must not survive to be reconciled
    // against a different main file.
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
    renameSync(stagedPath, dbPath)
  } catch (err) {
    // Keep the staged file for diagnosis and boot on the untouched database.
    console.error('[restore] could not apply the staged import:', err)
    try {
      renameSync(stagedPath, `${stagedPath}.failed`)
    } catch {
      /* Nothing more to try; the staged file stays where it is. */
    }
    return null
  }

  prune(backupsDir, keep)
  rmSync(metaPath, { force: true })

  return {
    sourcePath: meta?.sourcePath ?? '(unknown)',
    restoredAt: new Date().toISOString(),
    backupPath,
    shows: meta?.shows ?? 0,
    episodes: meta?.episodes ?? 0,
    channels: meta?.channels ?? 0
  }
}

function readMeta(metaPath: string): StagedMeta | null {
  try {
    return JSON.parse(readFileSync(metaPath, 'utf8')) as StagedMeta
  } catch {
    // A missing or hand-mangled sidecar shouldn't block the import itself.
    return null
  }
}

/**
 * Copy the database being replaced into the backups directory.
 *
 * `VACUUM INTO` is the good path: it produces one self-contained file and
 * recovers a WAL left behind by a crash. If the database is too damaged for
 * that — which is a very good reason to be importing in the first place — fall
 * back to copying the raw files so nothing is thrown away.
 */
function backupCurrent(dbPath: string, backupsDir: string): string | null {
  if (!existsSync(dbPath)) return null

  mkdirSync(backupsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(backupsDir, `${BACKUP_PREFIX}${stamp}.db`)

  try {
    const current = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      current.prepare('VACUUM INTO ?').run(target)
      return target
    } finally {
      current.close()
    }
  } catch (err) {
    console.error('[restore] clean backup failed, copying raw files instead:', err)
    rmSync(target, { force: true })
    try {
      copyFileSync(dbPath, target)
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${dbPath}${suffix}`)) copyFileSync(`${dbPath}${suffix}`, `${target}${suffix}`)
      }
      return target
    } catch (copyErr) {
      console.error('[restore] raw backup failed too:', copyErr)
      return null
    }
  }
}

/** Keep the newest `keep` pre-restore copies; drop the rest. */
function prune(backupsDir: string, keep: number): void {
  // Nothing was backed up — a first run with no database to replace.
  if (!existsSync(backupsDir)) return
  try {
    const files = readdirSync(backupsDir)
      .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.db'))
      // The stamp is ISO-8601 with `:` and `.` swapped for `-`, so it sorts
      // lexicographically in chronological order.
      .sort()
    for (const name of files.slice(0, Math.max(0, files.length - keep))) {
      rmSync(join(backupsDir, name), { force: true })
      rmSync(join(backupsDir, `${name}-wal`), { force: true })
      rmSync(join(backupsDir, `${name}-shm`), { force: true })
    }
  } catch (err) {
    console.error('[restore] could not prune old backups:', err)
  }
}

/**
 * Record how this database arrived.
 *
 * Written straight to the `settings` table rather than through `setSetting()`,
 * so `AppSettings` stays a list of user-facing knobs.
 */
export function recordRestoreReceipt(db: Db, receipt: RestoreReceipt): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run('lastRestore', JSON.stringify(receipt))
}

export function getRestoreReceipt(db: Db): RestoreReceipt | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('lastRestore') as
    | { value: string }
    | undefined
  if (!row) return null
  try {
    return JSON.parse(row.value) as RestoreReceipt
  } catch {
    return null
  }
}
