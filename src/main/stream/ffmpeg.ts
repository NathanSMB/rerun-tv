/**
 * ffmpeg discovery, the startup codec assertion, and the job supervisor
 * (docs/playback.md).
 *
 * Two jobs in one module because they share the same premise: ffmpeg is an
 * external process we do not control. We find it, prove it can produce the one
 * output shape Chromium needs (H.264/AAC in fragmented MP4), and then own every
 * child we spawn hard enough that closing the app — or changing the channel —
 * never leaves an encoder running.
 *
 * Packaging note (docs/architecture.md, "The decisions everything else
 * assumes"): nothing here is ever *shipped* with the app. The binary is either
 * one the machine already had, or one the user asked Rerun TV to fetch from its
 * upstream publisher into the app's own data directory
 * (`services/ffmpeg-manager.ts`) — the "managed" install, which this module
 * prefers over the system copy when it exists and which is never added to
 * `PATH`.
 */

import {
    type ChildProcess,
    spawn as spawnProcess,
    spawnSync,
} from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { FfmpegSource } from "../../shared/types.js";
import { managedFfmpegRecordPath, managedFfmpegVersionsDir } from "../paths.js";

/** Where ffmpeg came from, and what it reported — surfaced verbatim in Settings → System. */
export interface FfmpegBinaries {
    ffmpegPath: string | null;
    ffprobePath: string | null;
    version: string | null;
    source: FfmpegSource;
}

/**
 * What `managed.json` says about the copy Rerun TV installed.
 *
 * `version` doubles as the directory name under `versions/`, which is what makes
 * the pointer a single small file rather than a symlink — symlinks need special
 * care on Windows, and every reader here wants the version string anyway.
 */
export interface ManagedFfmpegRecord {
    version: string;
    /** ISO timestamp of the install, for the Settings line. */
    installedAt: string;
    /** `process.platform`/`process.arch` at install time, to catch a copied profile. */
    platform: string;
    arch: string;
}

/** Names of the two binaries we need, with the platform's executable suffix. */
function exeName(name: string): string {
    return process.platform === "win32" ? `${name}.exe` : name;
}

function isExecutable(file: string): boolean {
    try {
        accessSync(file, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** First match for `name` across `PATH`. Done by hand so we never shell out. */
function findOnPath(name: string): string | null {
    const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    for (const dir of dirs) {
        const candidate = join(dir, exeName(name));
        if (isExecutable(candidate)) return candidate;
    }
    return null;
}

/**
 * Directories a bundled static build could live in: electron-builder unpacks
 * extra resources next to the app (`process.resourcesPath`), and a plain
 * unpacked build has them beside the executable.
 */
function bundledDirs(): string[] {
    const dirs: string[] = [];
    const resourcesPath = (
        process as NodeJS.Process & { resourcesPath?: string }
    ).resourcesPath;
    if (resourcesPath) dirs.push(join(resourcesPath, "ffmpeg"), resourcesPath);
    dirs.push(
        join(dirname(process.execPath), "ffmpeg"),
        dirname(process.execPath),
    );
    return dirs;
}

function findBundled(name: string): string | null {
    for (const dir of bundledDirs()) {
        const candidate = join(dir, exeName(name));
        if (isExecutable(candidate)) return candidate;
    }
    return null;
}

/**
 * A version string is about to become a directory name, so it may not be able to
 * leave `versions/`.
 *
 * `managed.json` is written by this app into a directory only this app uses, so
 * a hostile value there is not a threat model anyone is under — but the file is
 * plain JSON in the user's home, and turning whatever it holds into a path
 * without looking is the kind of thing that is only ever noticed afterwards.
 */
function isSafeVersion(version: string): boolean {
    return (
        version.length > 0 &&
        version.length < 128 &&
        !version.includes("/") &&
        !version.includes("\\") &&
        !version.includes("\0") &&
        version !== "." &&
        version !== ".."
    );
}

/** The directory holding one installed version's two binaries. */
export function managedVersionDir(version: string): string {
    return join(managedFfmpegVersionsDir(), version);
}

/**
 * Read the managed install's pointer, or null when there isn't one.
 *
 * Every failure mode — no file, unreadable, not JSON, missing the one field that
 * matters — is the same answer: nothing is installed. A managed copy that cannot
 * be described is a managed copy that cannot be run.
 */
export function readManagedRecord(): ManagedFfmpegRecord | null {
    let parsed: Partial<ManagedFfmpegRecord>;
    try {
        parsed = JSON.parse(
            readFileSync(managedFfmpegRecordPath(), "utf8"),
        ) as Partial<ManagedFfmpegRecord>;
    } catch {
        return null;
    }
    if (typeof parsed.version !== "string" || !isSafeVersion(parsed.version))
        return null;
    return {
        version: parsed.version,
        installedAt:
            typeof parsed.installedAt === "string" ? parsed.installedAt : "",
        platform: typeof parsed.platform === "string" ? parsed.platform : "",
        arch: typeof parsed.arch === "string" ? parsed.arch : "",
    };
}

/**
 * The managed pair, if one is installed *and* still executable.
 *
 * The executability check is what makes the pointer safe to trust: a version
 * directory deleted by hand, or a profile copied between machines, leaves
 * `managed.json` behind describing binaries that are not there. Treating that as
 * "nothing installed" drops the app back to the system copy instead of handing
 * every spawn a path that fails.
 */
function findManaged(): {
    ffmpegPath: string;
    ffprobePath: string | null;
} | null {
    const record = readManagedRecord();
    if (!record) return null;
    const dir = managedVersionDir(record.version);
    const ffmpegPath = join(dir, exeName("ffmpeg"));
    if (!isExecutable(ffmpegPath)) return null;
    const ffprobePath = join(dir, exeName("ffprobe"));
    return {
        ffmpegPath,
        ffprobePath: isExecutable(ffprobePath) ? ffprobePath : null,
    };
}

/** `ffmpeg version n8.1.2 Copyright …` → `n8.1.2`. Null if the binary won't run. */
function readVersion(ffmpegPath: string): string | null {
    try {
        const out = spawnSync(ffmpegPath, ["-hide_banner", "-version"], {
            encoding: "utf8",
            timeout: 5000,
        });
        if (out.status !== 0 || !out.stdout) return null;
        const match = /^ffmpeg version (\S+)/m.exec(out.stdout);
        return match?.[1] ?? out.stdout.split("\n")[0]?.trim() ?? null;
    } catch {
        return null;
    }
}

let cached: FfmpegBinaries | null = null;

/**
 * Resolve the ffmpeg/ffprobe pair once per process.
 *
 * Order:
 *   1. the explicit env override (`RERUN_FFMPEG_PATH` / `RERUN_FFPROBE_PATH`),
 *      the escape hatch for odd installs and the one the tests drive;
 *   2. the **managed** install — the copy the user asked Rerun TV to download,
 *      which wins over the system binary on purpose: someone who went and got a
 *      managed copy did so because the system one was missing or wrong, and the
 *      way to go back to the system binary is to remove the managed one;
 *   3. `PATH`;
 *   4. a build sitting beside the app.
 *
 * Cached because this stats a dozen directories and every stream request asks
 * for it. `resetFfmpegCache()` is what an install, an update or a removal calls
 * to make the next resolve see the new answer.
 *
 * A missing ffprobe is not fatal here — only the scanner needs it, and the two
 * halves are reported separately so Settings can say precisely what is absent.
 * Each half falls down the tiers independently, so a managed install still
 * supplies ffprobe to an ffmpeg pinned by the env override.
 */
export function resolveFfmpeg(): FfmpegBinaries {
    if (cached) return cached;

    const envFfmpeg = process.env.RERUN_FFMPEG_PATH;
    const envFfprobe = process.env.RERUN_FFPROBE_PATH;

    let ffmpegPath: string | null =
        envFfmpeg && isExecutable(envFfmpeg) ? envFfmpeg : null;
    let ffprobePath: string | null =
        envFfprobe && isExecutable(envFfprobe) ? envFfprobe : null;
    // An env-pinned binary is "the system's" as far as Settings is concerned:
    // it's a path the machine supplied, not one we installed.
    let source: FfmpegBinaries["source"] = ffmpegPath ? "system" : "missing";

    const managed = findManaged();
    if (managed) {
        if (!ffmpegPath) {
            ffmpegPath = managed.ffmpegPath;
            source = "managed";
        }
        ffprobePath ??= managed.ffprobePath;
    }

    if (!ffmpegPath) {
        ffmpegPath = findOnPath("ffmpeg");
        if (ffmpegPath) source = "system";
    }
    ffprobePath ??= findOnPath("ffprobe");

    if (!ffmpegPath) {
        // Nothing anywhere else: fall back to whatever sits beside the app.
        ffmpegPath = findBundled("ffmpeg");
        source = ffmpegPath ? "bundled" : "missing";
    }
    ffprobePath ??= findBundled("ffprobe");

    cached = {
        ffmpegPath,
        ffprobePath,
        version: ffmpegPath ? readVersion(ffmpegPath) : null,
        source,
    };
    return cached;
}

/**
 * Drop the cache so the next resolve looks again.
 *
 * Called by the tests that manipulate `PATH`, and — the reason it is no longer
 * only a test hook — by the install manager the moment a managed copy appears
 * or is removed. Everything that re-resolves per use (the stream server, the IPC
 * handlers) picks the new binary up with no further wiring.
 */
export function resetFfmpegCache(): void {
    cached = null;
}

/**
 * Assert at startup that this ffmpeg can actually produce the stream shape the
 * player consumes: H.264 video + AAC audio muxed into a fragmented MP4 on stdout.
 *
 * The asset is generated on the fly by `lavfi` (`testsrc` + `anullsrc`) so no
 * fixture has to ship with the app, and nothing touches disk. A failure is
 * *informational*, never fatal — a broken encoder just means those files stay
 * unplayable, and everything that can direct-play still works. This is the whole
 * mitigation for Electron's codec support drifting under us
 * (docs/architecture.md, "Risks, and what answers them").
 */
export function checkCodecs(
    ffmpegPath: string | null,
): Promise<"ok" | "failed"> {
    if (!ffmpegPath) return Promise.resolve("failed");

    return new Promise((resolve) => {
        const child = spawnProcess(
            ffmpegPath,
            [
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x64:rate=10:duration=0.2",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=48000:cl=stereo",
                "-shortest",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-movflags",
                "frag_keyframe+empty_moov+default_base_moof",
                "-f",
                "mp4",
                "pipe:1",
            ],
            { stdio: ["ignore", "pipe", "ignore"] },
        );

        let bytes = 0;
        let settled = false;
        const finish = (result: "ok" | "failed"): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null && child.signalCode === null)
                child.kill("SIGKILL");
            resolve(result);
        };

        // A hung ffmpeg must not hold up app startup.
        const timer = setTimeout(() => finish("failed"), 15_000);
        timer.unref();

        child.stdout?.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
        });
        child.stdout?.on("error", () => {
            /* stdout is ours alone here; nothing to do but ignore. */
        });
        child.on("error", () => finish("failed"));
        // Muxing succeeded only if ffmpeg exited cleanly *and* actually emitted a file.
        child.on("close", (code) =>
            finish(code === 0 && bytes > 0 ? "ok" : "failed"),
        );
    });
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

/** How many stderr lines we keep per job — enough for ffmpeg's actual error, not a leak. */
const STDERR_LINES = 50;

/** SIGTERM lets ffmpeg flush and unlink; SIGKILL is the guarantee it dies anyway. */
const SIGKILL_GRACE_MS = 750;

/** One running ffmpeg, owned by the key it was spawned under (`channel:3:41`). */
export interface StreamJob {
    key: string;
    child: ChildProcess;
    startedAt: number;
}

/** Optional per-job callbacks. The server uses `onExit` to turn a non-zero exit into a real error. */
export interface JobHooks {
    onStderr?: (line: string) => void;
    /** `stderrTail` is the last ~50 stderr lines, joined — the whole point of capturing them. */
    onExit?: (
        code: number | null,
        signal: NodeJS.Signals | null,
        stderrTail: string,
    ) => void;
}

/**
 * The ffmpeg job supervisor.
 *
 * Every spawn is keyed. Spawning under a key that is already busy kills the
 * previous job first, which is exactly the semantics a channel change, a skip
 * or a seek needs — the client just requests the new URL and the old encoder
 * goes away without any explicit teardown call.
 *
 * Keys are grouped by prefix, which is what carries "never more than one job per
 * channel" — and its relaxation for the gapless handoff
 * (docs/playback.md, "Gapless handoffs"). A key is now
 * `channel:<channelId>:<episodeId>`, so one channel can legitimately hold two
 * live jobs for the ~30 seconds while the next episode prewarms behind the
 * current one, and `killByPrefix` retires the whole channel at once. After
 * phase 1 both of those jobs are stream copies, so the overlap costs almost
 * nothing.
 *
 * `trimGroup` is the backstop: the *newest* jobs in a group win, so a client
 * that vanished without its `close` handler firing cannot leave a third encoder
 * running behind a channel forever.
 */
export class FfmpegSupervisor {
    private readonly jobs = new Map<string, StreamJob>();
    /** Per-child ring buffer, weak so a finished job's log is collectable. */
    private readonly stderrByChild = new WeakMap<ChildProcess, string[]>();

    /**
     * Start `args` under `key`, replacing whatever was there. stdin is closed
     * (`-nostdin` plus `stdio: 'ignore'`) so ffmpeg can never block waiting on a
     * terminal it doesn't have.
     */
    spawn(
        key: string,
        args: string[],
        ffmpegPath: string,
        hooks: JobHooks = {},
    ): ChildProcess {
        this.kill(key);

        const child = spawnProcess(ffmpegPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.jobs.set(key, { key, child, startedAt: Date.now() });

        const lines: string[] = [];
        this.stderrByChild.set(child, lines);

        let partial = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            // ffmpeg separates progress updates with \r, real messages with \n.
            const parts = (partial + chunk).split(/\r\n|\r|\n/);
            partial = parts.pop() ?? "";
            for (const line of parts) {
                if (!line.trim()) continue;
                lines.push(line);
                if (lines.length > STDERR_LINES) lines.shift();
                hooks.onStderr?.(line);
            }
        });
        child.stderr?.on("error", () => {
            /* The log pipe breaking is never worth failing a stream over. */
        });

        // EPIPE on stdout is the *normal* end of a stream: the browser closed the
        // connection mid-episode and our reader went away. Swallow it so it never
        // surfaces as an unhandled 'error' event.
        child.stdout?.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code !== "EPIPE")
                lines.push(`stdout error: ${err.message}`);
        });

        child.on("error", (err) => {
            lines.push(`spawn error: ${err.message}`);
        });

        // 'close' rather than 'exit': it fires after stderr has been fully read (so
        // the tail is complete) and, unlike 'exit', it still fires when the binary
        // could not be spawned at all.
        child.on("close", (code, signal) => {
            // Only clear the slot if we are still the job in it — a replacement may
            // already have taken the key before our exit event landed.
            if (this.jobs.get(key)?.child === child) this.jobs.delete(key);
            hooks.onExit?.(code, signal, lines.join("\n"));
        });

        return child;
    }

    /** Stop the job under `key`, if any. Idempotent. */
    kill(key: string): void {
        const job = this.jobs.get(key);
        if (!job) return;
        this.jobs.delete(key);
        this.terminate(job.child);
    }

    /**
     * Stop `child` only if it is still the job holding `key`. Used by the request
     * handler on client disconnect, so a stale request cannot kill the stream a
     * newer tune-in already started on the same channel.
     */
    killIfCurrent(key: string, child: ChildProcess): void {
        if (this.jobs.get(key)?.child === child) this.kill(key);
    }

    /**
     * Stop every job whose key starts with `prefix` — how a channel is retired
     * now that it can own more than one (`channel:3:` catches both the episode on
     * air and the one prewarming behind it).
     */
    killByPrefix(prefix: string): void {
        for (const key of [...this.jobs.keys()]) {
            if (key.startsWith(prefix)) this.kill(key);
        }
    }

    /**
     * Cap a key group at `limit` live jobs, killing the oldest first.
     *
     * Newest-wins is the only safe rule here: the oldest job under a channel
     * prefix is the episode furthest from being watched — the one just handed off
     * from, or a request whose client went away. Killing the *newest* would take
     * out the stream that was just tuned in.
     *
     * Spawn order comes from the Map's own insertion order rather than from
     * `startedAt`, because two jobs can easily start inside the same millisecond
     * and a tie there would make the choice arbitrary. Re-spawning under an
     * existing key deletes and re-inserts, which correctly makes it the newest.
     */
    trimGroup(prefix: string, limit: number): void {
        const group = [...this.jobs.values()].filter((job) =>
            job.key.startsWith(prefix),
        );
        for (const job of group.slice(0, Math.max(0, group.length - limit)))
            this.kill(job.key);
    }

    /** Called on app quit and on server close — no orphaned encoders, ever. */
    killAll(): void {
        for (const key of [...this.jobs.keys()]) this.kill(key);
    }

    activeKeys(): string[] {
        return [...this.jobs.keys()];
    }

    /** The current job's captured stderr, for diagnostics. */
    stderrTail(key: string): string {
        const job = this.jobs.get(key);
        if (!job) return "";
        return (this.stderrByChild.get(job.child) ?? []).join("\n");
    }

    private terminate(child: ChildProcess): void {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null)
                child.kill("SIGKILL");
        }, SIGKILL_GRACE_MS);
        // Unref'd: a pending grace timer must never keep the event loop (or a test
        // runner) alive after everything else has finished.
        timer.unref();
        child.once("exit", () => clearTimeout(timer));
    }
}
