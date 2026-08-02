/**
 * Migrations.
 *
 * `PRAGMA user_version` is the only thing standing between an existing library
 * and a mislabelled one, so each data-touching migration gets a test that opens
 * a database *at the previous version*, migrates it, and checks the rows.
 *
 * Migration 3 is the interesting one: it re-derives `playback_path` for the
 * audio-only transcode path (docs/stall-fix-plan.html, phase 1) instead of
 * making the user sit through a full rescan to reach the same answer. The
 * assertion that matters is therefore not just "the labels changed" but "they
 * changed to exactly what a fresh scan would have written".
 */

import { type Db, migrate } from "@main/db/index.js";
import { getSettings } from "@main/db/repositories/settings.js";
import { MIGRATIONS } from "@main/db/schema.js";
import { decidePlaybackPath } from "@shared/playback.js";
import { describe, expect, it } from "vitest";
import { openAtVersion } from "./helpers/db.js";

interface Fixture {
    container: string;
    vcodec: string;
    acodec: string;
    /** What the *old* decision stored on the row. */
    before: string;
}

/**
 * One row per shape the old decision produced, including the two that migration
 * 3 must leave alone: HEVC (video genuinely unplayable) and anything already
 * labelled direct or remux.
 */
const FIXTURES: Fixture[] = [
    // The 328-episode case: playable video, unplayable soundtrack.
    {
        container: "matroska",
        vcodec: "h264",
        acodec: "ac3",
        before: "transcode",
    },
    {
        container: "matroska",
        vcodec: "h264",
        acodec: "eac3",
        before: "transcode",
    },
    {
        container: "matroska",
        vcodec: "h264",
        acodec: "dts",
        before: "transcode",
    },
    { container: "mp4", vcodec: "h264", acodec: "ac3", before: "transcode" },
    {
        container: "matroska",
        vcodec: "AVC1",
        acodec: "truehd",
        before: "transcode",
    },
    {
        container: "matroska",
        vcodec: "vp9",
        acodec: "ac3",
        before: "transcode",
    },
    {
        container: "matroska",
        vcodec: "av1",
        acodec: "dts",
        before: "transcode",
    },
    // Video Chromium cannot decode — still a full transcode, before and after.
    {
        container: "matroska",
        vcodec: "hevc",
        acodec: "aac",
        before: "transcode",
    },
    {
        container: "matroska",
        vcodec: "hevc",
        acodec: "dts",
        before: "transcode",
    },
    {
        container: "matroska",
        vcodec: "mpeg2video",
        acodec: "mp3",
        before: "transcode",
    },
    // Already on a cheap path; nothing to re-derive.
    { container: "matroska", vcodec: "h264", acodec: "aac", before: "remux" },
    { container: "mp4", vcodec: "h264", acodec: "aac", before: "direct" },
];

function seed(db: Db): void {
    db.prepare(
        "INSERT INTO shows (id, title, folder_path, added_at) VALUES (1, ?, ?, 0)",
    ).run("Fixtures", "/tv/Fixtures");
    const insert = db.prepare(
        `INSERT INTO episodes (show_id, season, episode, path, container, vcodec, acodec, playback_path)
     VALUES (1, 1, ?, ?, ?, ?, ?, ?)`,
    );
    FIXTURES.forEach((f, i) => {
        insert.run(
            i + 1,
            `/tv/Fixtures/e${i + 1}.mkv`,
            f.container,
            f.vcodec,
            f.acodec,
            f.before,
        );
    });
}

function labels(db: Db): string[] {
    return (
        db
            .prepare("SELECT playback_path AS p FROM episodes ORDER BY episode")
            .all() as { p: string }[]
    ).map((r) => r.p);
}

describe("migration 3 — the audio-only transcode path", () => {
    it("re-labels playable video that was only transcoded for its audio", () => {
        const db = openAtVersion(2);
        seed(db);
        expect(labels(db)).toEqual(FIXTURES.map((f) => f.before));

        migrate(db);

        expect(labels(db)).toEqual([
            // Playable video + unplayable audio: now a stream copy plus an AAC encode.
            "remux",
            "remux",
            "remux",
            "remux",
            "remux",
            "remux",
            "remux",
            // HEVC and MPEG-2 stay where they were — the video really does need an encoder.
            "transcode",
            "transcode",
            "transcode",
            // Untouched.
            "remux",
            "direct",
        ]);
        db.close();
    });

    it("produces exactly the labels a fresh full rescan would write", () => {
        const db = openAtVersion(2);
        seed(db);
        migrate(db);

        // The one property that makes the migration safe to revert: the labels are
        // re-derivable, so a rollback plus any full rescan lands in the same place.
        const rows = db
            .prepare(
                "SELECT container, vcodec, acodec, playback_path AS stored FROM episodes ORDER BY episode",
            )
            .all() as {
            container: string;
            vcodec: string;
            acodec: string;
            stored: string;
        }[];

        for (const row of rows) {
            expect(row.stored).toBe(
                decidePlaybackPath(row.container, row.vcodec, row.acodec),
            );
        }
        db.close();
    });

    it("is idempotent, and lands the same way on a database built from scratch", () => {
        const stepped = openAtVersion(2);
        seed(stepped);
        migrate(stepped);
        const afterOnce = labels(stepped);
        migrate(stepped);
        expect(labels(stepped)).toEqual(afterOnce);

        // A brand-new database is at the head version already; seeding it with the
        // *old* labels and migrating must be a no-op rather than a second pass.
        const fresh = openAtVersion(MIGRATIONS.length);
        seed(fresh);
        migrate(fresh);
        expect(labels(fresh)).toEqual(FIXTURES.map((f) => f.before));

        stepped.close();
        fresh.close();
    });

    it("leaves the CHECK constraint alone — no table rebuild", () => {
        const db = openAtVersion(2);
        const before = episodesDdl(db);
        // This migration only, not `migrate()`: later ones legitimately append
        // columns, and the property being asserted here is that migration 3 rewrites
        // *rows* without touching the table definition.
        db.exec(MIGRATIONS[2]);
        expect(episodesDdl(db)).toBe(before);
        db.close();
    });
});

/**
 * Migration 4 — cached EBU R128 loudness
 * (docs/loudness-equalization-plan.html, phase 2).
 *
 * Five nullable columns and nothing else: no data is derived, because loudness
 * cannot be derived — it takes a full audio decode per file, which is what the
 * background job is for. So what needs proving is that it is genuinely additive.
 */
describe("migration 4 — cached loudness", () => {
    const LOUDNESS_COLUMNS = [
        "loudness_i",
        "loudness_tp",
        "loudness_lra",
        "loudness_thresh",
        "loudness_scanned_at",
    ];

    function columnsOf(db: Db, table: string): string[] {
        return (
            db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as {
                name: string;
            }[]
        ).map((row) => row.name);
    }

    it("adds the five columns, all nullable and unmeasured to start with", () => {
        const db = openAtVersion(3);
        seed(db);
        expect(columnsOf(db, "episodes")).not.toContain("loudness_i");

        migrate(db);

        for (const column of LOUDNESS_COLUMNS)
            expect(columnsOf(db, "episodes")).toContain(column);
        // Every pre-existing row is "not measured yet", which is the state the
        // player already has to handle.
        const unmeasured = db
            .prepare(
                "SELECT COUNT(*) AS n FROM episodes WHERE loudness_scanned_at IS NULL",
            )
            .get() as { n: number };
        expect(unmeasured.n).toBe(FIXTURES.length);
        db.close();
    });

    it("leaves every other column, and the playback labels, exactly as they were", () => {
        const db = openAtVersion(3);
        seed(db);
        const before = labels(db);
        migrate(db);
        expect(labels(db)).toEqual(before);
        // ALTER TABLE ADD COLUMN appends; it must not have rebuilt the table and
        // dropped the CHECK constraint on the way.
        expect(episodesDdl(db)).toContain(
            `CHECK (playback_path IN ('direct','remux','transcode'))`,
        );
        db.close();
    });

    it("is idempotent — a second run adds nothing", () => {
        const db = openAtVersion(3);
        migrate(db);
        const after = columnsOf(db, "episodes");
        migrate(db);
        expect(columnsOf(db, "episodes")).toEqual(after);
        db.close();
    });
});

/**
 * Migration 5 retires the dead `hardwareEncode` toggle (docs/hwaccel-plan.html).
 *
 * The replacement key is *not* written by the migration, and that is the point:
 * `getSettings` merges stored rows over `DEFAULT_SETTINGS`, so an absent
 * `hardwareAccel` already reads as `'software'` — which is exactly what the old
 * disabled toggle did. All the migration has to do is stop the stale row from
 * riding along in that spread forever.
 */
describe("migration 5 — the hardware acceleration setting", () => {
    function settingsOf(db: Db): Record<string, string> {
        const rows = db.prepare("SELECT key, value FROM settings").all() as {
            key: string;
            value: string;
        }[];
        return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    }

    it("drops the dead toggle and leaves every other setting alone", () => {
        const db = openAtVersion(4);
        const insert = db.prepare(
            "INSERT INTO settings (key, value) VALUES (?, ?)",
        );
        insert.run("hardwareEncode", "false");
        insert.run("volume", "0.4");
        insert.run("loudnessEq", "true");

        migrate(db);

        const after = settingsOf(db);
        expect(after).not.toHaveProperty("hardwareEncode");
        expect(after.volume).toBe("0.4");
        expect(after.loudnessEq).toBe("true");
        db.close();
    });

    it("reads as software afterwards, which is what the dead toggle did", () => {
        const db = openAtVersion(4);
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
            "hardwareEncode",
            "false",
        );
        migrate(db);
        expect(getSettings(db).hardwareAccel).toBe("software");
        db.close();
    });

    it("is a no-op on a database that never had the toggle", () => {
        const db = openAtVersion(4);
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
            "volume",
            "0.9",
        );
        expect(() => migrate(db)).not.toThrow();
        expect(settingsOf(db)).toEqual({ volume: "0.9" });
        db.close();
    });

    /**
     * Migration 6 exists for the delete path, not the read path: `play_log`'s
     * `episode_id` carries an ON DELETE CASCADE, and without an index SQLite
     * scans the whole log once per deleted episode — which the scanner's prune
     * does hundreds of times after an unmounted root.
     */
    it("indexes play_log.episode_id when upgrading an existing library", () => {
        const db = openAtVersion(5);

        migrate(db);

        const indexes = (
            db.prepare("PRAGMA index_list(play_log)").all() as {
                name: string;
            }[]
        ).map((i) => i.name);
        expect(indexes).toContain("idx_playlog_episode");
        expect(db.pragma("user_version", { simple: true })).toBe(
            MIGRATIONS.length,
        );
        db.close();
    });

    /**
     * The downgrade case: a library written by a newer build, or a `.db` copied
     * in by hand past the version check in `services/restore.ts`. Migrating is a
     * no-op there, which would leave this build reading a schema it doesn't know
     * and failing somewhere arbitrary later.
     */
    it("refuses to open a database from a newer version", () => {
        const db = openAtVersion(MIGRATIONS.length);
        db.pragma(`user_version = ${MIGRATIONS.length + 1}`);

        expect(() => migrate(db)).toThrow(/newer version of Rerun TV/);
        db.close();
    });

    it("preserves a hardwareAccel a newer version already stored", () => {
        const db = openAtVersion(4);
        const insert = db.prepare(
            "INSERT INTO settings (key, value) VALUES (?, ?)",
        );
        insert.run("hardwareEncode", "false");
        insert.run("hardwareAccel", '"nvenc"');

        migrate(db);

        expect(getSettings(db).hardwareAccel).toBe("nvenc");
        db.close();
    });
});

function episodesDdl(db: Db): string {
    const row = db
        .prepare(
            `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'episodes'`,
        )
        .get() as { sql: string };
    return row.sql;
}
