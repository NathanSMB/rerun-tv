/**
 * Database import tests.
 *
 * Everything here runs against real files in a real temp directory, because the
 * whole point of this module is filesystem behaviour: what survives a rejected
 * import, what gets copied before a swap, and what happens to a WAL sidecar.
 * An in-memory database would test none of it.
 */

import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@main/db/index.js";
import { MIGRATIONS } from "@main/db/schema.js";
import {
    applyStagedImport,
    discardStagedImport,
    getRestoreReceipt,
    inspectAndStage,
    recordRestoreReceipt,
} from "@main/services/restore.js";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let dbPath: string;
let stagedPath: string;
let metaPath: string;
let backupsDir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rerun-restore-"));
    dbPath = join(dir, "library.db");
    stagedPath = join(dir, "library.db.incoming");
    metaPath = join(dir, "library.db.incoming.json");
    backupsDir = join(dir, "backups");
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** A complete, current-schema Rerun TV database at `path`. */
function seedDatabase(
    path: string,
    seed: (db: ReturnType<typeof openDatabase>) => void = () => undefined,
): void {
    const db = openDatabase(path);
    seed(db);
    db.close();
}

function apply(keep?: number): ReturnType<typeof applyStagedImport> {
    return applyStagedImport({
        dbPath,
        stagedPath,
        metaPath,
        backupsDir,
        keep,
    });
}

function backupFiles(): string[] {
    return existsSync(backupsDir)
        ? readdirSync(backupsDir).filter(
              (n) => n.startsWith("library-pre-restore-") && n.endsWith(".db"),
          )
        : [];
}

describe("inspectAndStage — rejection", () => {
    it("rejects a file that is not a database", () => {
        const source = join(dir, "notes.txt");
        writeFileSync(source, "this is definitely not a database");

        expect(() => inspectAndStage(source, stagedPath, metaPath)).toThrow(
            /not a SQLite database/,
        );
        expect(existsSync(stagedPath)).toBe(false);
    });

    it("rejects an empty file", () => {
        const source = join(dir, "empty.db");
        writeFileSync(source, "");

        expect(() => inspectAndStage(source, stagedPath, metaPath)).toThrow(
            /empty/,
        );
    });

    it("rejects a file that does not exist", () => {
        expect(() =>
            inspectAndStage(join(dir, "nope.db"), stagedPath, metaPath),
        ).toThrow(/could not be read/);
    });

    it("rejects a SQLite database that was never a Rerun TV one", () => {
        const source = join(dir, "someone-elses.db");
        const other = new Database(source);
        other.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
        other.close();

        expect(() => inspectAndStage(source, stagedPath, metaPath)).toThrow(
            /not a Rerun TV database/,
        );
        expect(existsSync(stagedPath)).toBe(false);
    });

    it("rejects a Rerun-shaped database made by a newer version", () => {
        const source = join(dir, "from-the-future.db");
        seedDatabase(source);
        const bumped = new Database(source);
        bumped.pragma(`user_version = ${MIGRATIONS.length + 1}`);
        bumped.close();

        expect(() => inspectAndStage(source, stagedPath, metaPath)).toThrow(
            /newer version of Rerun TV/,
        );
        expect(existsSync(stagedPath)).toBe(false);
    });

    it("rejects a versioned database missing our tables", () => {
        // Right `user_version`, wrong contents — a foreign app that also uses it.
        const source = join(dir, "impostor.db");
        const impostor = new Database(source);
        impostor.exec("CREATE TABLE shows (id INTEGER PRIMARY KEY)");
        impostor.pragma("user_version = 1");
        impostor.close();

        expect(() => inspectAndStage(source, stagedPath, metaPath)).toThrow(
            /not a Rerun TV one/,
        );
        expect(existsSync(stagedPath)).toBe(false);
        expect(existsSync(metaPath)).toBe(false);
    });
});

describe("inspectAndStage — acceptance", () => {
    it("stages a current database and reports its contents", () => {
        const source = join(dir, "backup.db");
        seedDatabase(source, (db) => {
            db.prepare(
                "INSERT INTO shows (title, folder_path, added_at) VALUES (?, ?, 0)",
            ).run("Frasier", "/media/frasier");
            db.prepare("INSERT INTO channels (name, number) VALUES (?, ?)").run(
                "Comfort",
                1,
            );
        });

        const report = inspectAndStage(source, stagedPath, metaPath);

        expect(report.shows).toBe(1);
        expect(report.channels).toBe(1);
        expect(report.episodes).toBe(0);
        expect(report.schemaVersion).toBe(MIGRATIONS.length);
        expect(existsSync(stagedPath)).toBe(true);
        expect(JSON.parse(readFileSync(metaPath, "utf8")).sourcePath).toBe(
            source,
        );
    });

    it("migrates an older backup forward while staging it", () => {
        // A database as it looked at schema 1: only the first migration applied.
        const source = join(dir, "old.db");
        const old = new Database(source);
        old.exec(MIGRATIONS[0]);
        old.pragma("user_version = 1");
        old.close();

        const report = inspectAndStage(source, stagedPath, metaPath);

        expect(report.sourceSchemaVersion).toBe(1);
        expect(report.schemaVersion).toBe(MIGRATIONS.length);

        const staged = new Database(stagedPath);
        const tables = (
            staged
                .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
                .all() as {
                name: string;
            }[]
        ).map((row) => row.name);
        staged.close();

        expect(tables).toContain("channel_show_season_modes");
    });

    it("samples episode paths and counts the ones missing from this machine", () => {
        const present = join(dir, "here.mkv");
        writeFileSync(present, "x");

        const source = join(dir, "backup.db");
        seedDatabase(source, (db) => {
            const showId = db
                .prepare(
                    "INSERT INTO shows (title, folder_path, added_at) VALUES (?, ?, 0)",
                )
                .run("Frasier", "/media/frasier").lastInsertRowid as number;
            const insert = db.prepare(
                "INSERT INTO episodes (show_id, season, episode, path) VALUES (?, 1, ?, ?)",
            );
            insert.run(showId, 1, present);
            insert.run(showId, 2, "/gone/s01e02.mkv");
            insert.run(showId, 3, "/gone/s01e03.mkv");
        });

        const report = inspectAndStage(source, stagedPath, metaPath);

        expect(report.episodes).toBe(3);
        expect(report.sampled).toBe(3);
        expect(report.missing).toBe(2);
    });

    it("replaces a staged import left over from an earlier attempt", () => {
        writeFileSync(stagedPath, "stale leftovers");

        const source = join(dir, "backup.db");
        seedDatabase(source);
        inspectAndStage(source, stagedPath, metaPath);

        const staged = new Database(stagedPath);
        expect(staged.pragma("user_version", { simple: true })).toBe(
            MIGRATIONS.length,
        );
        staged.close();
    });
});

describe("discardStagedImport", () => {
    it("removes both files and tolerates their absence", () => {
        const source = join(dir, "backup.db");
        seedDatabase(source);
        inspectAndStage(source, stagedPath, metaPath);

        discardStagedImport(stagedPath, metaPath);
        expect(existsSync(stagedPath)).toBe(false);
        expect(existsSync(metaPath)).toBe(false);

        expect(() => discardStagedImport(stagedPath, metaPath)).not.toThrow();
    });
});

describe("applyStagedImport", () => {
    it("does nothing when no import is staged", () => {
        seedDatabase(dbPath);
        const before = readFileSync(dbPath);

        expect(apply()).toBeNull();
        expect(readFileSync(dbPath).equals(before)).toBe(true);
        expect(backupFiles()).toHaveLength(0);
    });

    it("backs up the current database, swaps in the import, and clears the sidecars", () => {
        seedDatabase(dbPath, (db) => {
            db.prepare("INSERT INTO channels (name, number) VALUES (?, ?)").run(
                "Current",
                7,
            );
        });
        // A WAL left behind by a crash: it must not survive to meet the new file.
        writeFileSync(`${dbPath}-wal`, "stale wal");
        writeFileSync(`${dbPath}-shm`, "stale shm");

        const source = join(dir, "backup.db");
        seedDatabase(source, (db) => {
            db.prepare("INSERT INTO channels (name, number) VALUES (?, ?)").run(
                "Imported",
                42,
            );
        });
        inspectAndStage(source, stagedPath, metaPath);

        const receipt = apply();

        expect(receipt).not.toBeNull();
        expect(receipt?.sourcePath).toBe(source);
        expect(receipt?.channels).toBe(1);
        expect(existsSync(stagedPath)).toBe(false);
        expect(existsSync(metaPath)).toBe(false);
        expect(existsSync(`${dbPath}-wal`)).toBe(false);
        expect(existsSync(`${dbPath}-shm`)).toBe(false);

        const live = new Database(dbPath);
        const channel = live.prepare("SELECT name FROM channels").get() as {
            name: string;
        };
        live.close();
        expect(channel.name).toBe("Imported");

        // And the database that was replaced is still recoverable.
        expect(receipt?.backupPath).not.toBeNull();
        const saved = new Database(receipt!.backupPath!);
        const savedChannel = saved
            .prepare("SELECT name FROM channels")
            .get() as { name: string };
        saved.close();
        expect(savedChannel.name).toBe("Current");
    });

    it("has no backup to make on a first run with no database yet", () => {
        const source = join(dir, "backup.db");
        seedDatabase(source);
        inspectAndStage(source, stagedPath, metaPath);

        const receipt = apply();

        expect(receipt?.backupPath).toBeNull();
        expect(existsSync(dbPath)).toBe(true);
    });

    it("prunes older safety copies down to the keep limit", () => {
        const source = join(dir, "backup.db");
        seedDatabase(source);

        for (let i = 0; i < 5; i++) {
            seedDatabase(dbPath);
            inspectAndStage(source, stagedPath, metaPath);
            apply(2);
        }

        expect(backupFiles().length).toBeLessThanOrEqual(2);
    });
});

describe("the boot sequence", () => {
    it("applies, opens, and records the receipt the way bootstrap() does", () => {
        seedDatabase(dbPath, (db) => {
            db.prepare("INSERT INTO channels (name, number) VALUES (?, ?)").run(
                "Current",
                7,
            );
        });

        const source = join(dir, "backup.db");
        seedDatabase(source, (db) => {
            db.prepare(
                "INSERT INTO shows (title, folder_path, added_at) VALUES (?, ?, 0)",
            ).run("Frasier", "/media/frasier");
            db.prepare("INSERT INTO channels (name, number) VALUES (?, ?)").run(
                "Imported",
                42,
            );
        });
        inspectAndStage(source, stagedPath, metaPath);

        // Exactly what src/main/index.ts does, in order.
        const receipt = apply();
        const db = openDatabase(dbPath);
        if (receipt) recordRestoreReceipt(db, receipt);

        const channel = db.prepare("SELECT name FROM channels").get() as {
            name: string;
        };
        expect(channel.name).toBe("Imported");

        // ...and what the Settings screen reads back out through getInfo.
        const stored = getRestoreReceipt(db);
        expect(stored?.sourcePath).toBe(source);
        expect(stored?.shows).toBe(1);
        expect(stored?.channels).toBe(1);
        expect(existsSync(stored!.backupPath!)).toBe(true);

        db.close();

        // A second boot finds nothing staged and leaves the receipt alone.
        expect(apply()).toBeNull();
        const again = openDatabase(dbPath);
        expect(getRestoreReceipt(again)?.sourcePath).toBe(source);
        again.close();
    });
});

describe("restore receipt", () => {
    it("round-trips through the settings table", () => {
        seedDatabase(dbPath);
        const db = openDatabase(dbPath);

        expect(getRestoreReceipt(db)).toBeNull();

        recordRestoreReceipt(db, {
            sourcePath: "/tmp/before.db",
            restoredAt: "2026-07-29T12:00:00.000Z",
            backupPath: "/tmp/backups/library-pre-restore-x.db",
            shows: 3,
            episodes: 40,
            channels: 2,
        });

        expect(getRestoreReceipt(db)?.sourcePath).toBe("/tmp/before.db");
        expect(getRestoreReceipt(db)?.episodes).toBe(40);
        db.close();
    });
});
