/**
 * The background loudness measuring job
 * (docs/loudness-equalization-plan.html, phase 2).
 *
 * Measuring an episode means decoding its whole soundtrack — seconds per file,
 * not the milliseconds a probe costs — so it can never sit in the scanner's
 * per-file path, and it can never be something a tune-in waits on. It runs here
 * instead: one file at a time, only while the setting is on, and only while
 * nothing more important is using the machine.
 *
 * Everything about it is optional by construction. The feature works without a
 * single measurement (loudnorm's dynamic mode is the whole of phase 1); a
 * measurement only removes the convergence wobble at the start of an episode and
 * after every seek. So a pass that is paused forever, or that fails on half the
 * library, degrades to exactly phase 1 rather than to a broken feature.
 */

import type { AppSettings } from "@shared/types.js";
import type { Db } from "../db/index.js";
import {
    listEpisodesNeedingLoudness,
    loudnessCoverage,
    saveLoudness,
} from "../db/repositories/library.js";
import { measureLoudness } from "../stream/loudness.js";

/**
 * Where the job's progress lines go.
 *
 * Only here so the suite can silence it. The job narrates itself at every step —
 * that narration is how a slow first launch is explained to whoever is reading
 * the log — but in a test run it is a wall of `[loudness]` lines interleaved with
 * the reporter's output, obscuring the failures the run exists to show. The
 * default is the console, so production says exactly what it always said.
 */
export interface LoudnessLog {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, err: unknown): void;
}

const CONSOLE_LOG: LoudnessLog = {
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message, err) => console.error(message, err),
};

export interface LoudnessScannerOptions {
    db: Db;
    /** Null when no ffmpeg was found; the job then simply never runs. */
    ffmpegPath: string | null;
    /** Read at every step, so switching the setting off stops the pass mid-list. */
    getSettings: () => AppSettings;
    /**
     * True while the machine is busy with something the user can perceive —
     * playback, or a library scan. Checked before every file, and again while
     * waiting, so a measuring pass never competes with an encoder feeding a player.
     */
    isBusy: () => boolean;
    /** Overridable so tests aren't paced by a background job's politeness. */
    busyRecheckMs?: number;
    betweenFilesMs?: number;
    /** Defaults to the console; tests pass a silent one. */
    log?: LoudnessLog;
}

/** How long to wait before re-checking a machine that was busy. */
const BUSY_RECHECK_MS = 15_000;

/** A breather between files, so the job is never a solid block of CPU. */
const BETWEEN_FILES_MS = 1_000;

export class LoudnessScanner {
    readonly #db: Db;
    readonly #ffmpegPath: string | null;
    readonly #getSettings: () => AppSettings;
    readonly #isBusy: () => boolean;
    readonly #busyRecheckMs: number;
    readonly #betweenFilesMs: number;
    readonly #log: LoudnessLog;

    #running = false;
    #disposed = false;
    /**
     * Passes run one after another rather than concurrently.
     *
     * A chain rather than a "busy" flag, because the interesting case is `stop()`
     * immediately followed by `start()` — the setting switched off and straight
     * back on. A flag would see the aborted pass still unwinding, call itself
     * already running, and drop the restart on the floor; queuing behind it always
     * lands. Re-entering with nothing to do costs one query.
     */
    #queue: Promise<void> = Promise.resolve();
    /** Aborts the in-flight ffmpeg and the sleep between files. */
    #abort: AbortController | null = null;
    /**
     * Files that failed *this session*. Deliberately not persisted: a failure is
     * usually about the moment (an unmounted drive, a file mid-copy) rather than
     * the file, so it should be retried on the next launch — but retried inside
     * one session it would spin.
     */
    readonly #failed = new Set<number>();

    constructor(opts: LoudnessScannerOptions) {
        this.#db = opts.db;
        this.#ffmpegPath = opts.ffmpegPath;
        this.#getSettings = opts.getSettings;
        this.#isBusy = opts.isBusy;
        this.#busyRecheckMs = opts.busyRecheckMs ?? BUSY_RECHECK_MS;
        this.#betweenFilesMs = opts.betweenFilesMs ?? BETWEEN_FILES_MS;
        this.#log = opts.log ?? CONSOLE_LOG;
    }

    /**
     * Queue a pass over whatever is unmeasured.
     *
     * Safe to call on anything that might have added work: startup, the setting
     * being switched on, a library change. Calling it during a pass queues another
     * one behind it, which is how episodes added mid-pass get picked up.
     */
    start(): void {
        if (this.#disposed || !this.#ffmpegPath) return;
        if (!this.#getSettings().loudnessEq) return;
        this.#queue = this.#queue.then(() => this.#run());
    }

    /** Stop the pass and kill the in-flight measurement. Idempotent. */
    stop(): void {
        this.#abort?.abort();
        this.#abort = null;
    }

    dispose(): void {
        this.#disposed = true;
        this.stop();
    }

    /** Whether a pass is in flight — for tests and diagnostics. */
    get running(): boolean {
        return this.#running;
    }

    async #run(): Promise<void> {
        // Re-checked here rather than only in `start`: a queued pass may have been
        // waiting behind a long one while the setting was switched off.
        if (this.#disposed || !this.#getSettings().loudnessEq) return;

        this.#running = true;
        const controller = new AbortController();
        this.#abort = controller;

        try {
            await this.#pass(controller.signal);
        } catch (err) {
            this.#log.error("[loudness] pass failed:", err);
        } finally {
            this.#running = false;
            if (this.#abort === controller) this.#abort = null;
        }
    }

    /**
     * One pass over everything unmeasured.
     *
     * The work list is taken once at the start rather than re-queried per file:
     * measuring is slow enough that the query cost is irrelevant either way, but a
     * fixed list is what makes "skip the ones that failed" terminate. Anything
     * added while the pass runs is picked up by the `#stale` loop above.
     */
    async #pass(signal: AbortSignal): Promise<void> {
        const ffmpegPath = this.#ffmpegPath;
        if (!ffmpegPath) return;

        const pending = listEpisodesNeedingLoudness(this.#db).filter(
            (row) => !this.#failed.has(row.id),
        );
        if (pending.length === 0) return;

        const coverage = loudnessCoverage(this.#db);
        this.#log.info(
            `[loudness] measuring ${pending.length} episode(s) — ` +
                `${coverage.measured}/${coverage.total} of the library already done`,
        );

        for (const episode of pending) {
            if (signal.aborted || this.#disposed) return;
            // Re-read rather than captured: the toggle is the stop button for a pass
            // that may run for an hour.
            if (!this.#getSettings().loudnessEq) return;

            if (!(await this.#waitUntilIdle(signal))) return;

            const result = await measureLoudness(
                ffmpegPath,
                episode.path,
                signal,
            );
            if (signal.aborted) return;

            if (result.error !== null) {
                this.#failed.add(episode.id);
                this.#log.warn(
                    `[loudness] skipped ${episode.path}: ${result.error}`,
                );
                continue;
            }

            saveLoudness(this.#db, episode.id, result.measurement, Date.now());
            if (result.measurement === null) {
                this.#log.info(
                    `[loudness] ${episode.path}: no measurable audio`,
                );
            }

            await sleep(this.#betweenFilesMs, signal);
        }

        this.#log.info("[loudness] pass complete");
    }

    /** Block while the machine is busy. False means we were told to stop. */
    async #waitUntilIdle(signal: AbortSignal): Promise<boolean> {
        while (this.#isBusy()) {
            if (signal.aborted || this.#disposed) return false;
            if (!this.#getSettings().loudnessEq) return false;
            await sleep(this.#busyRecheckMs, signal);
        }
        return !signal.aborted && !this.#disposed;
    }
}

/** Abortable sleep: a pending timer must never hold up a quit. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        timer.unref?.();
        signal.addEventListener("abort", done, { once: true });
        function done(): void {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }
    });
}
