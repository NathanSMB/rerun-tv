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

import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate, type Db } from '@main/db/index.js'
import { MIGRATIONS } from '@main/db/schema.js'
import { decidePlaybackPath } from '@shared/playback.js'

/** An in-memory database with the first `version` migrations applied and no more. */
function openAtVersion(version: number): Db {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  for (let i = 0; i < version; i++) db.exec(MIGRATIONS[i])
  db.pragma(`user_version = ${version}`)
  return db
}

interface Fixture {
  container: string
  vcodec: string
  acodec: string
  /** What the *old* decision stored on the row. */
  before: string
}

/**
 * One row per shape the old decision produced, including the two that migration
 * 3 must leave alone: HEVC (video genuinely unplayable) and anything already
 * labelled direct or remux.
 */
const FIXTURES: Fixture[] = [
  // The 328-episode case: playable video, unplayable soundtrack.
  { container: 'matroska', vcodec: 'h264', acodec: 'ac3', before: 'transcode' },
  { container: 'matroska', vcodec: 'h264', acodec: 'eac3', before: 'transcode' },
  { container: 'matroska', vcodec: 'h264', acodec: 'dts', before: 'transcode' },
  { container: 'mp4', vcodec: 'h264', acodec: 'ac3', before: 'transcode' },
  { container: 'matroska', vcodec: 'AVC1', acodec: 'truehd', before: 'transcode' },
  { container: 'matroska', vcodec: 'vp9', acodec: 'ac3', before: 'transcode' },
  { container: 'matroska', vcodec: 'av1', acodec: 'dts', before: 'transcode' },
  // Video Chromium cannot decode — still a full transcode, before and after.
  { container: 'matroska', vcodec: 'hevc', acodec: 'aac', before: 'transcode' },
  { container: 'matroska', vcodec: 'hevc', acodec: 'dts', before: 'transcode' },
  { container: 'matroska', vcodec: 'mpeg2video', acodec: 'mp3', before: 'transcode' },
  // Already on a cheap path; nothing to re-derive.
  { container: 'matroska', vcodec: 'h264', acodec: 'aac', before: 'remux' },
  { container: 'mp4', vcodec: 'h264', acodec: 'aac', before: 'direct' }
]

function seed(db: Db): void {
  db.prepare('INSERT INTO shows (id, title, folder_path, added_at) VALUES (1, ?, ?, 0)').run(
    'Fixtures',
    '/tv/Fixtures'
  )
  const insert = db.prepare(
    `INSERT INTO episodes (show_id, season, episode, path, container, vcodec, acodec, playback_path)
     VALUES (1, 1, ?, ?, ?, ?, ?, ?)`
  )
  FIXTURES.forEach((f, i) => {
    insert.run(i + 1, `/tv/Fixtures/e${i + 1}.mkv`, f.container, f.vcodec, f.acodec, f.before)
  })
}

function labels(db: Db): string[] {
  return (
    db.prepare('SELECT playback_path AS p FROM episodes ORDER BY episode').all() as { p: string }[]
  ).map((r) => r.p)
}

describe('migration 3 — the audio-only transcode path', () => {
  it('re-labels playable video that was only transcoded for its audio', () => {
    const db = openAtVersion(2)
    seed(db)
    expect(labels(db)).toEqual(FIXTURES.map((f) => f.before))

    migrate(db)

    expect(labels(db)).toEqual([
      // Playable video + unplayable audio: now a stream copy plus an AAC encode.
      'remux',
      'remux',
      'remux',
      'remux',
      'remux',
      'remux',
      'remux',
      // HEVC and MPEG-2 stay where they were — the video really does need an encoder.
      'transcode',
      'transcode',
      'transcode',
      // Untouched.
      'remux',
      'direct'
    ])
    db.close()
  })

  it('produces exactly the labels a fresh full rescan would write', () => {
    const db = openAtVersion(2)
    seed(db)
    migrate(db)

    // The one property that makes the migration safe to revert: the labels are
    // re-derivable, so a rollback plus any full rescan lands in the same place.
    const rows = db
      .prepare(
        'SELECT container, vcodec, acodec, playback_path AS stored FROM episodes ORDER BY episode'
      )
      .all() as { container: string; vcodec: string; acodec: string; stored: string }[]

    for (const row of rows) {
      expect(row.stored).toBe(decidePlaybackPath(row.container, row.vcodec, row.acodec))
    }
    db.close()
  })

  it('is idempotent, and lands the same way on a database built from scratch', () => {
    const stepped = openAtVersion(2)
    seed(stepped)
    migrate(stepped)
    const afterOnce = labels(stepped)
    migrate(stepped)
    expect(labels(stepped)).toEqual(afterOnce)

    // A brand-new database is at the head version already; seeding it with the
    // *old* labels and migrating must be a no-op rather than a second pass.
    const fresh = openAtVersion(MIGRATIONS.length)
    seed(fresh)
    migrate(fresh)
    expect(labels(fresh)).toEqual(FIXTURES.map((f) => f.before))

    stepped.close()
    fresh.close()
  })

  it('leaves the CHECK constraint alone — no table rebuild', () => {
    const db = openAtVersion(2)
    const before = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'episodes'`)
      .get() as { sql: string }
    migrate(db)
    const after = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'episodes'`)
      .get() as { sql: string }
    expect(after.sql).toBe(before.sql)
    db.close()
  })
})
