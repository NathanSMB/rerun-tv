/**
 * Where Rerun TV keeps its state on disk.
 *
 * One SQLite file under Electron's `userData`, which on Linux resolves to
 * `~/.config/rerun-tv` by default. We override it to the XDG *data* directory
 * (`~/.local/share/rerun-tv`) because a media library index is data, not
 * configuration — and it's the path the Settings screen advertises.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

/**
 * Where the data directory *is*, without touching the filesystem.
 *
 * Split out from `dataDir()` because the ffmpeg resolver asks for the managed
 * install's path on every cold resolve, including in tests and on machines that
 * have never downloaded one — and a pure question about a path should not leave
 * a directory behind as a side effect.
 */
function dataDirPath(): string {
    const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(xdg, "rerun-tv");
}

export function dataDir(): string {
    const dir = dataDirPath();
    mkdirSync(dir, { recursive: true });
    return dir;
}

export function databasePath(): string {
    return join(dataDir(), "library.db");
}

/**
 * An import that has been validated but not yet applied.
 *
 * It sits beside the live database so the swap can be a single `rename()`
 * within one filesystem — see `services/restore.ts` for why the swap happens at
 * boot rather than while the app is running.
 */
export function stagedImportPath(): string {
    return join(dataDir(), "library.db.incoming");
}

/** What the staged import was made from, so the receipt survives the restart. */
export function stagedImportMetaPath(): string {
    return join(dataDir(), "library.db.incoming.json");
}

/** Safety copies taken automatically before an import replaces the database. */
export function backupsDir(): string {
    const dir = join(dataDir(), "backups");
    mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * The copy of ffmpeg Rerun TV downloads and owns itself.
 *
 * Deliberately inside the app's own data directory and deliberately *not* on
 * `PATH`: nothing outside Rerun TV should find this binary, and the resolver is
 * the only thing that ever looks here (`stream/ffmpeg.ts`).
 *
 * Read-only, like `dataDirPath` — the install manager creates the tree when it
 * actually has something to put in it, so a machine using the system ffmpeg
 * never grows an empty `ffmpeg/` folder.
 */
export function managedFfmpegDir(): string {
    return join(dataDirPath(), "ffmpeg");
}

/** The pointer at the active managed version. Its absence means "none installed". */
export function managedFfmpegRecordPath(): string {
    return join(managedFfmpegDir(), "managed.json");
}

/** One directory per installed version, so an update never overwrites a live binary. */
export function managedFfmpegVersionsDir(): string {
    return join(managedFfmpegDir(), "versions");
}

/** Call before `app.whenReady()` so Electron's own caches land alongside it. */
export function configureAppPaths(): void {
    app.setPath("userData", dataDir());
}
