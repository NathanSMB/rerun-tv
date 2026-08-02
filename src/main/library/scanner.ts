/**
 * The library scanner (plan §3).
 *
 * Walks the configured scan roots, parses filenames, probes what changed, and
 * writes episodes to SQLite. Two properties matter more than anything else here:
 *
 * - **Incremental.** A file is keyed by `path + mtime + size`. A rescan of a
 *   library that hasn't changed spawns zero ffprobe processes, which is what
 *   makes "rescan on launch" and the folder watcher affordable.
 * - **Interruptible.** Scanning a cold library is minutes of work, so the pass
 *   is a plain loop that checks a pause flag between files and reports progress
 *   through a throttled callback rather than one event per file.
 *
 * Failure is always local: a file that won't parse or won't probe lands in the
 * unmatched bucket and the pass continues. A single bad file can never stop a
 * library from being usable.
 */

import { type Dirent, type Stats, statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { decidePlaybackPath } from "@shared/playback.js";
import type { ScanStatus } from "@shared/types.js";
import { type FSWatcher, watch } from "chokidar";
import type { Db } from "../db/index.js";
import {
    addUnmatched,
    clearAutoArcs,
    createArc,
    deleteEmptyShows,
    deleteEpisodesByPaths,
    findEpisodeByPath,
    listArcs,
    listEpisodePaths,
    listEpisodes,
    listScanRoots,
    listUnmatched,
    removeUnmatchedByPath,
    upsertEpisode,
    upsertShow,
} from "../db/repositories/library.js";
import { type ArcCandidate, detectArcs } from "./arcs.js";
import { type ProbeResult, probeFile } from "./ffprobe.js";
import { deriveShowTitle, isVideoFile, parseEpisodeFilename } from "./parse.js";

export interface ScannerOptions {
    db: Db;
    /** Resolved ffprobe binary — system PATH or the bundled fallback. */
    ffprobePath: string;
    /** Throttled progress sink; wired to the `scanProgress` IPC event. */
    onProgress: (status: ScanStatus) => void;
    /** Fired when the library actually changed, so the UI can refetch. */
    onLibraryChanged: () => void;
    /**
     * Injectable for tests; defaults to the real `ffprobe` subprocess.
     *
     * Everything else in this file — the walk, the stat fast path, the pruner,
     * the arc refresh — is testable without a media file, and spawning ffprobe is
     * the only reason it wouldn't be.
     */
    probe?: (filePath: string, ffprobePath: string) => Promise<ProbeResult>;
}

/** Emit at most one progress event per this many files… */
const PROGRESS_EVERY_FILES = 10;
/** …or per this many milliseconds, whichever comes first. */
const PROGRESS_EVERY_MS = 200;

/** A file is only ingested once it has been quiet this long (still-copying guard). */
const WRITE_SETTLE_MS = 2000;

const IDLE_STATUS: ScanStatus = {
    state: "idle",
    total: 0,
    done: 0,
    probed: 0,
    currentRoot: null,
    error: null,
};

interface Candidate {
    path: string;
    root: string;
}

export class Scanner {
    readonly #db: Db;
    readonly #ffprobePath: string;
    readonly #onProgress: (status: ScanStatus) => void;
    readonly #onLibraryChanged: () => void;
    readonly #probe: (
        filePath: string,
        ffprobePath: string,
    ) => Promise<ProbeResult>;

    #status: ScanStatus = { ...IDLE_STATUS };
    #scanning = false;
    #paused = false;
    #disposed = false;
    /** Resolvers held while paused; `resume()` drains them to unblock the loop. */
    #waiters: (() => void)[] = [];

    #lastEmitAt = 0;
    #lastEmitDone = 0;

    #watcher: FSWatcher | null = null;
    /**
     * The roots the watcher is currently subscribed to. Held as a field rather
     * than captured in the event closures so `startWatching()` can reconcile it
     * when a root is added or removed while the app is running.
     */
    #watchRoots: string[] = [];
    /** Serialises watcher events so two probes never race on the same pass. */
    #watchQueue: Promise<void> = Promise.resolve();

    constructor(opts: ScannerOptions) {
        this.#db = opts.db;
        this.#ffprobePath = opts.ffprobePath;
        this.#onProgress = opts.onProgress;
        this.#onLibraryChanged = opts.onLibraryChanged;
        this.#probe = opts.probe ?? probeFile;
    }

    /** A snapshot — callers must not be able to mutate the scanner's state. */
    getStatus(): ScanStatus {
        return { ...this.#status };
    }

    /**
     * Run one pass over every scan root.
     *
     * `full` re-probes files whose mtime and size are unchanged, which is the
     * escape hatch for a library whose metadata went stale (a codec fix-up, or a
     * grammar change in the parser).
     *
     * Concurrent calls are dropped rather than queued: two passes over the same
     * roots would only fight over the same rows, and the UI's rescan button is
     * easy to double-click.
     */
    async scan(full = false): Promise<void> {
        if (this.#scanning || this.#disposed) return;
        this.#scanning = true;
        this.#paused = false;
        this.#status = { ...IDLE_STATUS, state: "scanning" };
        this.#emit(true);

        try {
            const roots = listScanRoots(this.#db);
            const candidates = await this.#collect(roots.map((r) => r.path));
            this.#status.total = candidates.length;
            this.#emit(true);

            const seen = new Set<string>();
            const dirty = new Set<number>();
            let currentShowId: number | null = null;

            for (const candidate of candidates) {
                if (this.#disposed) return;
                await this.#waitWhilePaused();
                if (this.#disposed) return;

                const showId = await this.#ingest(
                    candidate.path,
                    candidate.root,
                    full,
                    seen,
                    dirty,
                );

                // Files come off the walk in directory order, so a show's files are
                // contiguous: when the show changes, the previous one is finished and
                // its arcs can be redetected without waiting for the whole pass.
                if (showId !== currentShowId) {
                    if (currentShowId !== null && dirty.has(currentShowId)) {
                        this.#refreshAutoArcs(currentShowId);
                        dirty.delete(currentShowId);
                    }
                    currentShowId = showId;
                }

                this.#status.done++;
                this.#emit();
            }

            for (const showId of dirty) this.#refreshAutoArcs(showId);

            this.#prune(seen);
        } catch (err) {
            this.#status.error =
                err instanceof Error ? err.message : String(err);
        } finally {
            this.#scanning = false;
            this.#paused = false;
            this.#status.state = "idle";
            this.#status.currentRoot = null;
            this.#emit(true);
            this.#onLibraryChanged();
        }
    }

    /**
     * Stop between files. The in-flight `scan()` promise stays pending — pausing
     * suspends the pass, it doesn't abandon it — so `resume()` picks up exactly
     * where it left off with the same file list and counters.
     */
    pause(): void {
        if (!this.#scanning || this.#paused) return;
        this.#paused = true;
        this.#status.state = "paused";
        this.#emit(true);
    }

    resume(): void {
        if (!this.#paused) return;
        this.#paused = false;
        this.#status.state = "scanning";
        this.#emit(true);
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const wake of waiters) wake();
    }

    /**
     * Watch the scan roots so an episode dropped in while the app is open shows
     * up without a manual rescan.
     *
     * `ignoreInitial` because the scan already covered what exists, and
     * `awaitWriteFinish` because a file still being copied would otherwise be
     * probed at whatever length it had reached.
     *
     * Safe to call again after the root list changes: an existing watcher is
     * reconciled in place rather than left subscribed to the old set, so a root
     * added from Settings is watched immediately instead of at the next launch.
     */
    startWatching(): void {
        if (this.#disposed) return;
        const roots = listScanRoots(this.#db).map((r) => r.path);

        if (this.#watcher) {
            const current = new Set(this.#watchRoots);
            const next = new Set(roots);
            for (const root of next)
                if (!current.has(root)) this.#watcher.add(root);
            for (const root of current)
                if (!next.has(root)) this.#watcher.unwatch(root);
            this.#watchRoots = roots;
            // chokidar keeps a watcher alive with nothing subscribed; closing it
            // means the next added root builds a fresh one with correct options.
            if (roots.length === 0) this.stopWatching();
            return;
        }

        if (roots.length === 0) return;
        this.#watchRoots = roots;

        const watcher = watch(roots, {
            ignoreInitial: true,
            ignorePermissionErrors: true,
            awaitWriteFinish: {
                stabilityThreshold: WRITE_SETTLE_MS,
                pollInterval: 200,
            },
        });
        // `this.#watchRoots`, not the captured `roots`, so an event from a root
        // added later still resolves to an owning root.
        watcher.on("add", (path) =>
            this.#enqueue(() => this.#ingestWatched(path, this.#watchRoots)),
        );
        watcher.on("change", (path) =>
            this.#enqueue(() => this.#ingestWatched(path, this.#watchRoots)),
        );
        watcher.on("unlink", (path) => this.#enqueue(() => this.#forget(path)));
        watcher.on("error", (err) => {
            this.#status.error =
                err instanceof Error ? err.message : String(err);
            this.#emit(true);
        });
        this.#watcher = watcher;
    }

    stopWatching(): void {
        void this.#watcher?.close();
        this.#watcher = null;
        this.#watchRoots = [];
    }

    /** Release the watcher and unblock a paused pass so shutdown can't hang. */
    dispose(): void {
        this.#disposed = true;
        this.stopWatching();
        this.#paused = false;
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const wake of waiters) wake();
    }

    // -------------------------------------------------------------------------
    // Pass internals
    // -------------------------------------------------------------------------

    /** Phase one: walk every root and collect the video files worth looking at. */
    async #collect(roots: string[]): Promise<Candidate[]> {
        const out: Candidate[] = [];
        // Real paths already walked, so a symlink pointing back up a tree can't
        // send the walk into an infinite loop.
        const visited = new Set<string>();
        for (const root of roots) {
            if (this.#disposed) break;
            this.#status.currentRoot = root;
            this.#emit(true);
            await this.#walk(root, root, out, visited);
        }
        this.#status.currentRoot = null;
        return out;
    }

    async #walk(
        dir: string,
        root: string,
        out: Candidate[],
        visited: Set<string>,
    ): Promise<void> {
        if (this.#disposed) return;
        let real: string;
        try {
            real = await realpath(dir);
        } catch {
            return; // unreadable or dangling — nothing to scan
        }
        if (visited.has(real)) return;
        visited.add(real);

        let entries: Dirent[];
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
            this.#status.error = `Cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`;
            return;
        }

        for (const entry of entries) {
            // Dot-directories are editor/DE bookkeeping (`.stfolder`, `.Trash-1000`),
            // never a show.
            if (entry.name.startsWith(".")) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await this.#walk(full, root, out, visited);
            } else if (entry.isSymbolicLink()) {
                // Follow links to both files and folders — a library made of symlinks
                // into other drives is a normal setup.
                try {
                    const info = await stat(full);
                    if (info.isDirectory())
                        await this.#walk(full, root, out, visited);
                    else if (info.isFile() && isVideoFile(full))
                        out.push({ path: full, root });
                } catch {}
            } else if (entry.isFile() && isVideoFile(full)) {
                out.push({ path: full, root });
            }
        }
    }

    /**
     * Phase two, one file: skip it, or parse + probe + upsert it.
     * Returns the show id it landed in, or null when it couldn't be placed.
     */
    async #ingest(
        filePath: string,
        root: string,
        full: boolean,
        seen: Set<string>,
        dirty: Set<number>,
    ): Promise<number | null> {
        seen.add(filePath);

        let info: Stats;
        try {
            info = await stat(filePath);
        } catch {
            return null; // vanished between the walk and now
        }
        const mtimeMs = Math.round(info.mtimeMs);
        const sizeBytes = info.size;

        const existing = findEpisodeByPath(this.#db, filePath);
        // The incremental fast path: identical stat pair means identical content,
        // so the stored probe is still true and we skip the subprocess entirely.
        if (
            existing &&
            !full &&
            existing.mtimeMs === mtimeMs &&
            existing.sizeBytes === sizeBytes
        ) {
            return existing.showId;
        }

        const parsed = parseEpisodeFilename(basename(filePath));
        if (!parsed) {
            addUnmatched(this.#db, filePath, "unparsed", mtimeMs, sizeBytes);
            return null;
        }

        let probe: ProbeResult;
        try {
            probe = await this.#probe(filePath, this.#ffprobePath);
            this.#status.probed++;
        } catch (err) {
            addUnmatched(
                this.#db,
                filePath,
                err instanceof Error ? err.message : String(err),
                mtimeMs,
                sizeBytes,
            );
            return null;
        }

        const showTitle = deriveShowTitle(root, filePath);
        const show = upsertShow(
            this.#db,
            showTitle,
            showFolderFor(root, filePath, showTitle),
        );

        upsertEpisode(this.#db, {
            showId: show.id,
            season: parsed.season,
            episode: parsed.episode,
            episodeEnd: parsed.episodeEnd,
            title: parsed.title,
            path: filePath,
            durationS: probe.durationS,
            container: probe.container,
            vcodec: probe.vcodec,
            acodec: probe.acodec,
            width: probe.width,
            height: probe.height,
            // Arc membership is owned by `createArc`/`deleteArc`; the upsert leaves
            // whatever is already stored alone.
            partGroupId: null,
            partIndex: null,
            playbackPath: decidePlaybackPath(
                probe.container,
                probe.vcodec,
                probe.acodec,
            ),
            mtimeMs,
            sizeBytes,
        });

        // A file that now parses must not stay in the fix-up bucket — this is the
        // "user renamed it properly" path.
        removeUnmatchedByPath(this.#db, filePath);

        dirty.add(show.id);
        return show.id;
    }

    /**
     * Re-run the Part-N heuristic for one show.
     *
     * Only `auto` groups are rewritten, and episodes already inside a *manual*
     * group are withheld from the detector — the user's grouping is the source of
     * truth (plan §3) and a rescan must never quietly re-cut it.
     */
    #refreshAutoArcs(showId: number): void {
        const manualMembers = new Set<number>();
        for (const arc of listArcs(this.#db, showId)) {
            if (arc.source === "manual")
                for (const id of arc.episodeIds) manualMembers.add(id);
        }

        clearAutoArcs(this.#db, showId);

        const candidates: ArcCandidate[] = listEpisodes(this.#db, showId)
            .filter((e) => !manualMembers.has(e.id))
            .map((e) => ({
                id: e.id,
                season: e.season,
                episode: e.episode,
                title: e.title,
            }));

        for (const arc of detectArcs(candidates)) {
            try {
                createArc(this.#db, showId, arc.title, arc.episodeIds, "auto");
            } catch (err) {
                // A detection the repository rejects (a run the heuristic thought was
                // contiguous but isn't, once double episodes are accounted for) is a
                // missed arc, never a failed scan.
                this.#status.error =
                    err instanceof Error ? err.message : String(err);
            }
        }
    }

    /**
     * Drop rows whose file is gone. Existence is checked against the filesystem
     * rather than "wasn't seen this pass", so an unreadable or temporarily
     * unmounted root doesn't wipe a show — and with it the channel lineups that
     * reference it.
     */
    #prune(seen: Set<string>): void {
        const missing: string[] = [];
        for (const row of listEpisodePaths(this.#db)) {
            if (seen.has(row.path)) continue;
            if (!existsOnDisk(row.path)) missing.push(row.path);
        }
        if (missing.length > 0) deleteEpisodesByPaths(this.#db, missing);

        for (const file of listUnmatched(this.#db)) {
            if (!seen.has(file.path) && !existsOnDisk(file.path)) {
                removeUnmatchedByPath(this.#db, file.path);
            }
        }

        deleteEmptyShows(this.#db);
    }

    // -------------------------------------------------------------------------
    // Watcher internals
    // -------------------------------------------------------------------------

    /** Chain watcher work onto a single promise so events process in order. */
    #enqueue(task: () => Promise<void>): void {
        this.#watchQueue = this.#watchQueue.then(task).catch((err: unknown) => {
            this.#status.error =
                err instanceof Error ? err.message : String(err);
        });
    }

    async #ingestWatched(filePath: string, roots: string[]): Promise<void> {
        if (this.#disposed || !isVideoFile(filePath)) return;
        const root = owningRoot(filePath, roots);
        if (!root) return;

        const showId = await this.#ingest(
            filePath,
            root,
            false,
            new Set(),
            new Set(),
        );
        if (showId === null) {
            // Still worth telling the UI: the file landed in the unmatched bucket.
            this.#onLibraryChanged();
            return;
        }
        this.#refreshAutoArcs(showId);
        this.#onLibraryChanged();
    }

    async #forget(filePath: string): Promise<void> {
        if (this.#disposed) return;
        const episode = findEpisodeByPath(this.#db, filePath);
        const removed = deleteEpisodesByPaths(this.#db, [filePath]);
        removeUnmatchedByPath(this.#db, filePath);
        if (removed > 0) {
            deleteEmptyShows(this.#db);
            if (episode) this.#refreshAutoArcsIfShowRemains(episode.showId);
        }
        this.#onLibraryChanged();
    }

    #refreshAutoArcsIfShowRemains(showId: number): void {
        const show = this.#db
            .prepare("SELECT 1 FROM shows WHERE id = ?")
            .get(showId);
        if (show) this.#refreshAutoArcs(showId);
    }

    // -------------------------------------------------------------------------
    // Progress
    // -------------------------------------------------------------------------

    /**
     * Throttled progress. A cold scan of a few thousand files would otherwise put
     * a few thousand IPC messages (and React renders) on the wire for a progress
     * bar nobody can read at that rate. State changes pass `force`.
     */
    #emit(force = false): void {
        const now = Date.now();
        const enough =
            this.#status.done - this.#lastEmitDone >= PROGRESS_EVERY_FILES ||
            now - this.#lastEmitAt >= PROGRESS_EVERY_MS;
        if (!force && !enough) return;
        this.#lastEmitAt = now;
        this.#lastEmitDone = this.#status.done;
        this.#onProgress(this.getStatus());
    }

    /** Blocks while paused; `resume()` (or `dispose()`) wakes every waiter. */
    async #waitWhilePaused(): Promise<void> {
        while (this.#paused && !this.#disposed) {
            await new Promise<void>((resolve) => this.#waiters.push(resolve));
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The folder that identifies a show (`shows.folder_path`, which is unique).
 *
 * Normally that's the top-level folder under the root. For a file sitting loose
 * in the root there is no such folder, so the derived title is appended to make
 * a stable, unique key — the row still points at a sensible location, and two
 * loose files from different shows can't collide onto one row.
 */
function showFolderFor(root: string, filePath: string, title: string): string {
    const rel = relative(root, filePath);
    const segments = rel.split(sep).filter((s) => s.length > 0 && s !== ".");
    return segments.length > 1 ? join(root, segments[0]) : join(root, title);
}

/** Which scan root a watched path belongs to — longest match wins for nested roots. */
function owningRoot(filePath: string, roots: string[]): string | null {
    let best: string | null = null;
    for (const root of roots) {
        if (filePath === root) continue;
        if (!filePath.startsWith(root.endsWith(sep) ? root : root + sep))
            continue;
        if (!best || root.length > best.length) best = root;
    }
    return best;
}

/**
 * Existence check for the pruner. Deliberately synchronous: pruning runs as one
 * uninterrupted synchronous db pass, and interleaving awaits there would let a
 * watcher event insert a row the pruner is about to decide is missing.
 */
function existsOnDisk(path: string): boolean {
    try {
        return statSync(path, { throwIfNoEntry: false }) !== undefined;
    } catch {
        return false;
    }
}
