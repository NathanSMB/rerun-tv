/**
 * Settings are a key–value table, not a config file (mockup Screen 05: "no
 * config files"). Values are stored JSON-encoded so booleans and numbers
 * round-trip, and reads are merged over `DEFAULT_SETTINGS` so a key added in a
 * later version has a sane value without a migration.
 */

import { type AppSettings, DEFAULT_SETTINGS } from "../../../shared/types.js";
import type { Db } from "../index.js";

export function getSettings(db: Db): AppSettings {
    const rows = db.prepare("SELECT key, value FROM settings").all() as {
        key: string;
        value: string;
    }[];

    const stored: Record<string, unknown> = {};
    for (const row of rows) {
        try {
            stored[row.key] = JSON.parse(row.value);
        } catch {
            // A hand-corrupted row shouldn't take the app down; fall back to default.
        }
    }

    return { ...DEFAULT_SETTINGS, ...stored } as AppSettings;
}

export function setSetting<K extends keyof AppSettings>(
    db: Db,
    key: K,
    value: AppSettings[K],
): AppSettings {
    db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, JSON.stringify(value));
    return getSettings(db);
}
