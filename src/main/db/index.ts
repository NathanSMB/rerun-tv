/**
 * Database handle and migration runner.
 *
 * One SQLite file at `~/.local/share/rerun-tv/library.db` (XDG data dir, or
 * whatever Electron reports as `userData`). better-sqlite3 is synchronous,
 * which is exactly what we want in the main process: every scheduler state
 * transition is a single transaction with no await points to interleave.
 *
 * Tests open an in-memory database with `openDatabase(':memory:')`.
 */

import Database from "better-sqlite3";
import { MIGRATIONS } from "./schema.js";

export type Db = Database.Database;

let instance: Db | null = null;

/** Apply any migrations the file hasn't seen yet. Idempotent. */
export function migrate(db: Db): void {
    const current = db.pragma("user_version", { simple: true }) as number;
    // A file from a newer build: downgraded app, or a `.db` copied in by hand
    // past the version check in `services/restore.ts`. The loop below would do
    // nothing and leave this build reading a schema it doesn't know, failing
    // later somewhere arbitrary — say so here instead.
    if (current > MIGRATIONS.length) {
        throw new Error(
            `This library was created by a newer version of Rerun TV ` +
                `(database version ${current}, this build understands ${MIGRATIONS.length}). ` +
                `Update Rerun TV to open it.`,
        );
    }
    for (let version = current; version < MIGRATIONS.length; version++) {
        const sql = MIGRATIONS[version];
        db.transaction(() => {
            db.exec(sql);
            db.pragma(`user_version = ${version + 1}`);
        })();
    }
}

/**
 * Open (and migrate) a database. Pass `':memory:'` for tests; the default path
 * is resolved by the caller so this module stays free of Electron imports.
 */
export function openDatabase(file: string): Db {
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate(db);
    return db;
}

/** The process-wide handle, set once during main-process bootstrap. */
export function setDb(db: Db): void {
    instance = db;
}

export function getDb(): Db {
    if (!instance)
        throw new Error("Database not initialised — call setDb() first");
    return instance;
}

export function closeDb(): void {
    instance?.close();
    instance = null;
}
