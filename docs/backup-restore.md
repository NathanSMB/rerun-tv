# Backup and restore

`src/main/services/restore.ts` — Settings → System → Database.

**Back up…** writes a copy of the database wherever you point it. **Import…**
puts one back. Everything in the app except the media files themselves lives in
that one SQLite file, so these two buttons are the whole disaster-recovery story:
channels, lineups, per-season overrides, cursors, shuffle bags, play log.

Import is a **full replace**, not a merge. Merging two libraries would need
conflict rules for duplicate channel numbers, show folders and progress cursors,
and any rule you pick silently discards someone's data in some case. Replace is
what "restore from backup" means, and it's the only option with a defined result.

## Why the swap happens at boot

The obvious implementation — swap the file, reopen the database — is unsafe
here, for three specific reasons:

- `bootstrap()` hands the `Db` **object** to the stream server, the scanner and
  the IPC handlers. `setDb()` would change nothing; they all still hold the old
  one.
- The stream server holds the app's only long-lived prepared statement, bound to
  that handle. Closing the database behind it breaks every later request.
- The scanner's prune step deletes episode rows whose paths it didn't see during
  the current pass. A scan that *began* on one database and *finished* on another
  would delete real data.

So an import happens in two moves, and the file swap happens at the quietest
moment in the process lifecycle:

```
running app                          next boot, before anything opens the db
───────────                          ──────────────────────────────────────
pick a file                          back up the current database
validate it                          delete stale -wal / -shm
VACUUM INTO library.db.incoming      rename library.db.incoming → library.db
confirm, then relaunch               open, migrate, record the receipt
```

Nothing on disk is mutated while a subsystem is live. The swap itself is a single
`rename()` within one directory, which is atomic — so a crash at any point leaves
either the old database intact or the import still pending, never a database
that's half one thing and half another. A stray scanner write racing the restart
is harmless for the same reason: it lands in the old file, which is about to be
backed up and replaced anyway.

The restart is `app.relaunch()` then `app.exit(0)` — not `quit()`, which races
the single-instance lock the new process immediately asks for. `exit()` skips
`will-quit`, so `restart()` in `index.ts` spells the teardown out itself.

## What a candidate file has to survive

In order, cheapest first, all before anything is asked of the user:

1. Exists, is a regular file, is not empty.
2. Starts with the bytes `SQLite format 3\0`. Catches a picked `.mp4` instantly.
3. `PRAGMA integrity_check` returns `ok`.
4. `user_version` is not 0 (that's a SQLite file that was never ours) and not
   greater than `MIGRATIONS.length` (a backup from a **newer** version of the app,
   whose schema this build doesn't understand — refused rather than guessed at).
5. Contains `shows`, `episodes`, `channels` and `settings` — a valid SQLite
   database belonging to some other program gets no further.

An **older** backup is accepted and migrated forward: staging opens the copy with
`openDatabase()`, which runs the same `migrate()` every normal boot runs.

Staging is `VACUUM INTO` rather than a file copy. It merges any unmerged WAL,
writes one self-contained file with no sidecars, and fails loudly on a source
that `integrity_check` somehow let through. If anything fails after the staged
file exists, it's unlinked — a rejected import never leaves debris behind.

## Not losing the database you already had

Before the rename, the database being replaced is copied to
`~/.local/share/rerun-tv/backups/library-pre-restore-<timestamp>.db`. The last
five are kept. This is automatic and not optional: the single most likely way to
lose a library is to restore the wrong file into it.

That copy is itself a valid import, so rolling back a mistaken restore is the
same operation in the other direction.

It's taken with `VACUUM INTO` too, which recovers a WAL left behind by a crash.
If *that* fails — a database already too damaged to read, which is an excellent
reason to be importing something in the first place — it falls back to copying
the raw `.db`/`-wal`/`-shm` so nothing is thrown away.

If the rename fails anyway, the staged file is set aside as
`library.db.incoming.failed` and the app boots on the untouched old database.

## Media paths, and the confirmation

Backups store **absolute** media paths, so a database imported from another
machine can reference files that aren't here. Staging samples up to 200 episode
paths and stats them, and the confirmation dialog reports the result — *412 of
500 sampled episode files were not found on this machine* — alongside both
databases' show/episode/channel counts and where the safety copy is going.

That dialog is native, in the main process, with **Cancel** as the default
button. It's the only place that can quote real numbers from inside the file
being imported, which is why the renderer doesn't do its own `confirm()`.

Missing files aren't an error and don't block the import — the next scan
reconciles the library, and those episodes drop out of the schedule.

## The receipt

The restart takes the Settings status banner with it, which would leave you with
no idea where the replaced database went. So after the swap, `bootstrap()` writes
a `lastRestore` record into the imported database — source, timestamp, backup
path, counts. It surfaces on `SystemInfo`, and the Database row reads:

> Restored from before.db on 7/29/2026, 8:02 PM · previous database saved at
> ~/.local/share/rerun-tv/backups/library-pre-restore-2026-07-29T18-02-11-515Z.db

It lives in the `settings` table but is deliberately not part of `AppSettings`,
which stays a list of user-facing knobs.
