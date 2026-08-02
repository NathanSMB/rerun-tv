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
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
import { openAtVersion } from "./helpers/db.js";

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

    it("rejects a database that passes the magic-header check but is corrupt inside", () => {
        // The header check is only the first 16 bytes, so a database truncated or
        // scribbled on by a dying disk sails straight past it. `integrity_check` is
        // the thing that actually catches it, and it has to catch it *here* — a
        // corrupt file that reaches `applyStagedImport` replaces a working library
        // with rubble.
        const source = join(dir, "rotten.db");
        seedDatabase(source, (db) => {
            // Enough rows that the `shows` b-tree spans several pages, so there is
            // something past the schema to damage.
            const insert = db.prepare(
                "INSERT INTO shows (title, folder_path, added_at) VALUES (?, ?, 0)",
            );
            for (let i = 0; i < 2000; i++) insert.run(`Show ${i}`, `/tv/${i}`);
        });

        const bytes = readFileSync(source);
        expect(bytes.length).toBeGreaterThan(64 * 1024);
        // Leave the 16-byte SQLite magic — and the whole first page, so the file
        // still opens and still looks like ours — then shred a data page behind it.
        bytes.fill(0x5a, 32 * 1024, 34 * 1024);
        writeFileSync(source, bytes);

        expect(() => inspectAndStage(source, stagedPath, metaPath)).toThrow(
            /corrupt/,
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
        openAtVersion(1, source).close();

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

    it("keeps the old database when the swap itself fails", () => {
        // The whole design rests on `rename()` being atomic, but it can still fail
        // outright — a read-only directory, a cross-device staged file, the case
        // simulated here. When it does, the rule is: boot on the database we
        // already have, and keep the staged file around (renamed `.failed`) so the
        // import can be diagnosed instead of silently evaporating.
        // Renaming a file over a non-empty directory fails on every platform we
        // ship to, which makes it the cheapest way to reproduce the branch.
        mkdirSync(dbPath);
        writeFileSync(join(dbPath, "occupied"), "the old state");

        const source = join(dir, "backup.db");
        seedDatabase(source, (db) => {
            db.prepare("INSERT INTO channels (name, number) VALUES (?, ?)").run(
                "Imported",
                42,
            );
        });
        inspectAndStage(source, stagedPath, metaPath);

        const receipt = apply();

        // Null, so bootstrap() records no receipt and simply opens what is there.
        expect(receipt).toBeNull();
        // The staged file is set aside for diagnosis rather than deleted …
        expect(existsSync(stagedPath)).toBe(false);
        expect(existsSync(`${stagedPath}.failed`)).toBe(true);
        // … and nothing that was in place got clobbered on the way past.
        expect(readFileSync(join(dbPath, "occupied"), "utf8")).toBe(
            "the old state",
        );
    });

    it("falls back to a raw file copy when the database is too damaged to VACUUM", () => {
        // The most likely reason somebody is importing at all is that their library
        // died. `VACUUM INTO` cannot read a corrupt database, so if that were the
        // only backup path the damaged file — which may still be partly
        // recoverable — would be thrown away by the very act of replacing it.
        writeFileSync(dbPath, " not a database at all, just garbage bytes");

        const source = join(dir, "backup.db");
        seedDatabase(source, (db) => {
            db.prepare("INSERT INTO channels (name, number) VALUES (?, ?)").run(
                "Imported",
                42,
            );
        });
        inspectAndStage(source, stagedPath, metaPath);

        const receipt = apply();

        // The import went through …
        expect(receipt).not.toBeNull();
        const live = new Database(dbPath);
        expect(
            (
                live.prepare("SELECT name FROM channels").get() as {
                    name: string;
                }
            ).name,
        ).toBe("Imported");
        live.close();

        // … and the unreadable original was still copied out, byte for byte.
        expect(receipt?.backupPath).not.toBeNull();
        expect(existsSync(receipt!.backupPath!)).toBe(true);
        expect(readFileSync(receipt!.backupPath!).toString()).toBe(
            " not a database at all, just garbage bytes",
        );
    });

    it("imports anyway when the meta sidecar has gone missing", () => {
        // The sidecar only carries what the *receipt* says. Losing it (a crash
        // between staging and the next boot, someone tidying the folder) must not
        // cost the user their import — the staged database is the valuable part.
        seedDatabase(dbPath);
        const source = join(dir, "backup.db");
        seedDatabase(source, (db) => {
            db.prepare("INSERT INTO channels (name, number) VALUES (?, ?)").run(
                "Imported",
                42,
            );
        });
        inspectAndStage(source, stagedPath, metaPath);
        rmSync(metaPath);

        const receipt = apply();

        expect(receipt).not.toBeNull();
        // Honest placeholders rather than invented numbers.
        expect(receipt?.sourcePath).toBe("(unknown)");
        expect(receipt?.shows).toBe(0);
        expect(receipt?.episodes).toBe(0);
        expect(receipt?.channels).toBe(0);
        // The swap itself still happened.
        const live = new Database(dbPath);
        expect(
            (
                live.prepare("SELECT name FROM channels").get() as {
                    name: string;
                }
            ).name,
        ).toBe("Imported");
        live.close();
    });

    it("prunes older safety copies down to the keep limit, keeping the newest", () => {
        const source = join(dir, "backup.db");
        seedDatabase(source);

        const made: string[] = [];
        for (let i = 0; i < 5; i++) {
            // A backup is named for the millisecond it was taken, so two rounds
            // inside one tick would land on the same filename and this would end up
            // measuring the clock instead of the pruner. Wait one out.
            const tick = Date.now();
            while (Date.now() === tick) {
                /* spin — a millisecond at most */
            }
            seedDatabase(dbPath);
            inspectAndStage(source, stagedPath, metaPath);
            made.push(basename(apply(2)!.backupPath!));
        }

        // Five distinct copies really were taken, so the pruner had something to do.
        expect(new Set(made).size).toBe(5);
        // Exactly the limit, and exactly the *newest* two. The old assertion was
        // `toBeLessThanOrEqual(2)`, which a pruner that deleted everything, or one
        // that kept the two oldest copies and threw away the database the user was
        // actually about to want back, would both have satisfied.
        expect(backupFiles().sort()).toEqual(made.slice(-2).sort());
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
