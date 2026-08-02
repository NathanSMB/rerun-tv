/**
 * Unit construction — the abstraction every scheduling structure indexes.
 */

import { openDatabase } from "@main/db/index.js";
import {
    buildUnits,
    unitKeyForArc,
    unitKeyForEpisode,
} from "@main/scheduler/units.js";
import { describe, expect, it } from "vitest";
import { insertEpisode, insertShow, seedArcShow } from "./helpers/db.js";

describe("buildUnits", () => {
    it("collapses a 3-part arc so 8 standalones + one arc yield 9 units", () => {
        const db = openDatabase(":memory:");
        const { showId, groupId, episodeIds } = seedArcShow(db, {
            pilotTitle: "Awakening",
        });

        const units = buildUnits(db, showId);

        expect(units).toHaveLength(9);
        expect(units.filter((u) => u.kind === "arc")).toHaveLength(1);
        expect(units.filter((u) => u.kind === "episode")).toHaveLength(8);

        // The arc sits where its first part sits: after E01–E04, before E08.
        expect(units[4].key).toBe(unitKeyForArc(groupId));
        expect(units[3].key).toBe(unitKeyForEpisode(episodeIds[3]));
        expect(units[5].key).toBe(unitKeyForEpisode(episodeIds[7]));
        expect(units[4].season).toBe(1);
        expect(units[4].episode).toBe(5);
        db.close();
    });

    it("orders arc episodeIds by part_index, not by file order", () => {
        const db = openDatabase(":memory:");
        const showId = insertShow(db, "Babylon 5");
        const a = insertEpisode(db, showId, 1, 1);
        const b = insertEpisode(db, showId, 1, 2);
        const c = insertEpisode(db, showId, 1, 3);
        const groupId = Number(
            db
                .prepare(
                    `INSERT INTO part_groups (show_id, title, source) VALUES (?, 'Chrysalis', 'manual')`,
                )
                .run(showId).lastInsertRowid,
        );
        // Deliberately reversed: part_index is the source of truth.
        const link = db.prepare(
            `UPDATE episodes SET part_group_id = ?, part_index = ? WHERE id = ?`,
        );
        link.run(groupId, 3, a);
        link.run(groupId, 1, b);
        link.run(groupId, 2, c);

        const units = buildUnits(db, showId);

        expect(units).toHaveLength(1);
        expect(units[0].episodeIds).toEqual([b, c, a]);
        expect(units[0].title).toBe("Chrysalis");
        db.close();
    });

    it("titles episode units with the episode title, falling back to its code", () => {
        const db = openDatabase(":memory:");
        const { showId } = seedArcShow(db, { pilotTitle: "Awakening" });

        const units = buildUnits(db, showId);

        expect(units[0].title).toBe("Awakening");
        expect(units[1].title).toBe("S01E02");
        expect(units[4].title).toBe("The Gathering");
        db.close();
    });

    it("keys are stable and shaped ep:<id> / arc:<id>", () => {
        expect(unitKeyForEpisode(12)).toBe("ep:12");
        expect(unitKeyForArc(4)).toBe("arc:4");
    });

    it("orders units by season then episode across seasons", () => {
        const db = openDatabase(":memory:");
        const showId = insertShow(db, "DuckTales");
        insertEpisode(db, showId, 2, 1);
        insertEpisode(db, showId, 1, 10);
        insertEpisode(db, showId, 1, 2);

        const units = buildUnits(db, showId);

        expect(units.map((u) => [u.season, u.episode])).toEqual([
            [1, 2],
            [1, 10],
            [2, 1],
        ]);
        db.close();
    });

    it("returns an empty list for a show with no episodes", () => {
        const db = openDatabase(":memory:");
        const showId = insertShow(db, "Empty");
        expect(buildUnits(db, showId)).toEqual([]);
        db.close();
    });
});
