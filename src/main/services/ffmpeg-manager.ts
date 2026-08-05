/**
 * The managed ffmpeg install (docs/architecture.md, "ffmpeg is external").
 *
 * Rerun TV still never *ships* ffmpeg. What this module adds is the other way to
 * get one: at the user's explicit request it downloads an unmodified build from
 * the publisher who already distributes it, into the app's own data directory,
 * and runs it as a separate process exactly like a system install. Nothing is
 * ever put on `PATH` — the copy is Rerun TV's alone (`paths.ts`).
 *
 * Three properties carry the whole design:
 *
 * - **Nothing partial is ever activated.** Every download lands in a staging
 *   directory, is checked against a sha256 pinned in the manifest, is unpacked,
 *   and then has to actually mux an H.264/AAC fragment (`checkCodecs`) before a
 *   single byte of it becomes reachable. The activation itself is a `rename`
 *   plus a one-line pointer file.
 * - **Updates are side-by-side.** Each version gets its own directory and
 *   `managed.json` says which one is current, so an update never pulls a binary
 *   out from under an encoder that is mid-episode. The old directory is swept up
 *   at the next launch, by which time nothing can still be holding it.
 * - **The manifest is data, not code.** Which builds exist, where they live and
 *   what they hash to is a JSON file in the repo, fetched over HTTPS at check
 *   time with the shipped copy as the fallback. Following a new ffmpeg release
 *   is a commit, not an app release — but a user can still only ever receive
 *   bytes whose hash the repo has vouched for.
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    createReadStream,
    createWriteStream,
    type Dirent,
    mkdirSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { net } from "electron";
import bundledManifest from "../../../resources/ffmpeg-manifest.json";
import type {
    FfmpegInstallProgress,
    FfmpegUpdateCheck,
} from "../../shared/types.js";
import {
    managedFfmpegDir,
    managedFfmpegRecordPath,
    managedFfmpegVersionsDir,
} from "../paths.js";
import {
    checkCodecs,
    type ManagedFfmpegRecord,
    managedVersionDir,
    readManagedRecord,
    resetFfmpegCache,
} from "../stream/ffmpeg.js";

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/**
 * Where the live manifest lives. Raw content off the default branch, so a build
 * bump is one commit and every install picks it up without an app release.
 */
const MANIFEST_URL =
    "https://raw.githubusercontent.com/NathanSMB/rerun-tv/main/resources/ffmpeg-manifest.json";

/** How long the manifest fetch gets before the shipped copy is used instead. */
const MANIFEST_TIMEOUT_MS = 8000;

/** One downloadable file. `binary` names which tool an unpacked-binary part is. */
export interface ManifestPart {
    url: string;
    sha256: string;
    sizeBytes: number;
    /** `binary` is a bare executable rather than an archive (the macOS builds). */
    format: "tar.xz" | "zip" | "binary";
    binary?: "ffmpeg" | "ffprobe";
}

export interface ManifestBuild {
    version: string;
    /** Who publishes it, shown verbatim in Settings. */
    source: string;
    sourceUrl: string;
    parts: ManifestPart[];
}

export interface FfmpegManifest {
    schema: number;
    builds: Record<string, ManifestBuild>;
}

/** `linux-x64`, `win32-arm64`, `darwin-arm64` — the manifest's key. */
export function platformKey(): string {
    return `${process.platform}-${process.arch}`;
}

/**
 * Reject anything that isn't the shape we act on.
 *
 * The manifest is fetched over the network, so it is the one input here that is
 * not ours at read time. This does not make a hostile manifest safe — the sha256
 * it carries is the thing being trusted — it makes a *malformed* one fail as a
 * readable error rather than as a `undefined is not iterable` three steps later.
 */
function parseManifest(value: unknown): FfmpegManifest | null {
    if (typeof value !== "object" || value === null) return null;
    const raw = value as Partial<FfmpegManifest>;
    if (typeof raw.builds !== "object" || raw.builds === null) return null;

    const builds: Record<string, ManifestBuild> = {};
    for (const [key, build] of Object.entries(raw.builds)) {
        if (typeof build?.version !== "string" || !Array.isArray(build.parts))
            continue;
        const parts = build.parts.filter(
            (part): part is ManifestPart =>
                typeof part?.url === "string" &&
                part.url.startsWith("https://") &&
                typeof part.sha256 === "string" &&
                /^[0-9a-f]{64}$/.test(part.sha256) &&
                (part.format === "tar.xz" ||
                    part.format === "zip" ||
                    part.format === "binary"),
        );
        if (parts.length === 0) continue;
        builds[key] = {
            version: build.version,
            source:
                typeof build.source === "string" ? build.source : "upstream",
            sourceUrl:
                typeof build.sourceUrl === "string" ? build.sourceUrl : "",
            parts,
        };
    }
    return { schema: typeof raw.schema === "number" ? raw.schema : 1, builds };
}

/** The copy compiled into the app — what a first install uses when offline. */
export function shippedManifest(): FfmpegManifest {
    const parsed = parseManifest(bundledManifest);
    if (!parsed)
        throw new Error(
            "the bundled ffmpeg manifest is malformed — this is a bug",
        );
    return parsed;
}

/**
 * The last manifest a fetch actually produced.
 *
 * Held for the process because the gate polls `getFfmpegState` every five
 * seconds while it is open, and that asks whether a build exists for this
 * machine — a question that must not become an HTTP request per tick. A failed
 * fetch is deliberately *not* cached, so the next caller tries again rather than
 * being stuck on the shipped copy for the session.
 */
let fetchedManifest: FfmpegManifest | null = null;

/**
 * The live manifest, falling back to the shipped one.
 *
 * A failed fetch is deliberately not an error: the shipped manifest is a
 * perfectly good answer, and "you have no internet" is about to be discovered
 * again, far more usefully, by the download itself.
 *
 * `force` is the user pressing "Check for updates" — the one moment where a
 * cached answer would be exactly the wrong one.
 */
export async function loadManifest(
    deps: ManagerDeps = defaultDeps,
    signal?: AbortSignal,
    force = false,
): Promise<FfmpegManifest> {
    if (fetchedManifest && !force) return fetchedManifest;
    try {
        const response = await deps.fetch(MANIFEST_URL, {
            signal: signal ?? AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = parseManifest(await response.json());
        if (parsed && Object.keys(parsed.builds).length > 0) {
            fetchedManifest = parsed;
            return parsed;
        }
    } catch {
        // Offline, rate-limited, or serving something that isn't our manifest.
    }
    return shippedManifest();
}

/** Drop the memo — for the tests, which hand a different manifest to each case. */
export function resetManifestCache(): void {
    fetchedManifest = null;
}

// ---------------------------------------------------------------------------
// Injection seam
// ---------------------------------------------------------------------------

/**
 * The two things this module reaches outside itself for.
 *
 * Injected rather than imported directly so the install pipeline can be driven
 * end to end in Node against a fixture archive and a fake network — the parts
 * worth testing (checksum mismatch, cancel mid-download, an archive with no
 * ffmpeg in it) are all about what happens when those two misbehave.
 */
export interface ManagerDeps {
    fetch: typeof globalThis.fetch;
    /** Proves a candidate binary can produce the stream shape the player needs. */
    verify: (ffmpegPath: string) => Promise<"ok" | "failed">;
}

const defaultDeps: ManagerDeps = {
    // Electron's fetch rather than Node's: it follows the app's proxy settings,
    // which is the difference between working and not on a corporate machine.
    fetch: (input, init) => net.fetch(input as string, init),
    verify: checkCodecs,
};

// ---------------------------------------------------------------------------
// Download and verify
// ---------------------------------------------------------------------------

async function sha256Of(file: string): Promise<string> {
    const hash = createHash("sha256");
    await pipeline(createReadStream(file), hash);
    return hash.digest("hex");
}

/** Progress across a whole install, not one part — the UI shows one bar. */
interface ByteTally {
    received: number;
    total: number;
}

async function downloadPart(
    part: ManifestPart,
    dest: string,
    tally: ByteTally,
    deps: ManagerDeps,
    report: (progress: FfmpegInstallProgress) => void,
    version: string,
    signal: AbortSignal,
): Promise<void> {
    const response = await deps.fetch(part.url, { signal });
    if (!response.ok)
        throw new Error(
            `${part.url} answered HTTP ${response.status} — the pinned build may have been withdrawn`,
        );
    if (!response.body) throw new Error(`${part.url} returned an empty body`);

    const out = createWriteStream(dest);
    const reader = response.body.getReader();
    let sinceReport = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (signal.aborted) throw abortError();
            await new Promise<void>((resolve, reject) => {
                out.write(value, (err) => (err ? reject(err) : resolve()));
            });
            tally.received += value.byteLength;
            sinceReport += value.byteLength;
            // One event per ~1 MB rather than per chunk: a progress bar cannot
            // show more than that, and each event crosses the IPC bridge.
            if (sinceReport >= 1_000_000) {
                sinceReport = 0;
                report({
                    phase: "downloading",
                    receivedBytes: tally.received,
                    totalBytes: tally.total,
                    version,
                    message: null,
                });
            }
        }
    } finally {
        await new Promise<void>((resolve) => out.end(resolve));
    }

    report({
        phase: "verifying",
        receivedBytes: tally.received,
        totalBytes: tally.total,
        version,
        message: null,
    });
    const digest = await sha256Of(dest);
    if (digest !== part.sha256)
        throw new Error(
            `the download did not match its published checksum — expected ` +
                `${part.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…. ` +
                `Nothing was installed.`,
        );
}

// ---------------------------------------------------------------------------
// Unpack
// ---------------------------------------------------------------------------

function abortError(): Error {
    return Object.assign(new Error("cancelled"), { name: "AbortError" });
}

/**
 * Unpack with the system `tar`.
 *
 * Every platform we download an archive for already has one that reads it: GNU
 * tar on Linux, and the bsdtar that ships as `tar.exe` in Windows 10 and later —
 * which also reads zip, the format the Windows build comes in. macOS never gets
 * here at all; its builds are bare binaries. Deliberately no new dependency for
 * something the OS does correctly.
 */
function untar(
    archive: string,
    into: string,
    signal: AbortSignal,
): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(
            "tar",
            ["-xf", archive, "-C", into],
            { signal, timeout: 300_000, maxBuffer: 1 << 20 },
            (err) => {
                if (!err) return resolve();
                if (signal.aborted) return reject(abortError());
                reject(
                    new Error(
                        `could not unpack the download with the system tar (${err.message}). ` +
                            `Install ffmpeg yourself, or report this with your OS version.`,
                    ),
                );
            },
        );
    });
}

/** Depth-first hunt for a named executable inside an unpacked tree. */
function findInTree(dir: string, name: string, depth = 0): string | null {
    if (depth > 6) return null;
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const entry of entries) {
        if (entry.isFile() && entry.name === name) return join(dir, entry.name);
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = findInTree(join(dir, entry.name), name, depth + 1);
        if (found) return found;
    }
    return null;
}

function exeName(name: string): string {
    return process.platform === "win32" ? `${name}.exe` : name;
}

// ---------------------------------------------------------------------------
// The install
// ---------------------------------------------------------------------------

/** The install in flight, so a second request is refused and Cancel has a target. */
let inFlight: AbortController | null = null;

export function ffmpegInstallInFlight(): boolean {
    return inFlight !== null;
}

/** Abort the running install. Idempotent, and a no-op when nothing is running. */
export function cancelFfmpegInstall(): void {
    inFlight?.abort();
}

export interface InstallOptions {
    /** Every phase change and download tick, on its way to `EVENTS.ffmpegProgress`. */
    onProgress: (progress: FfmpegInstallProgress) => void;
    /** Called once, after the new binary is live and the resolver cache is dropped. */
    onInstalled: () => void;
    deps?: ManagerDeps;
}

/**
 * Download, verify and activate the build the manifest offers for this machine.
 *
 * Resolves with the installed version. Throws — after cleaning up — on any
 * failure, including cancellation, and the message is written to be shown to a
 * person rather than logged.
 */
export async function installManagedFfmpeg(
    options: InstallOptions,
): Promise<string> {
    if (inFlight) throw new Error("an ffmpeg download is already running");

    const deps = options.deps ?? defaultDeps;
    const controller = new AbortController();
    inFlight = controller;
    const { signal } = controller;

    const report = (progress: FfmpegInstallProgress): void => {
        options.onProgress(progress);
    };
    const staging = join(managedFfmpegDir(), `.staging-${randomUUID()}`);

    try {
        report({
            phase: "manifest",
            receivedBytes: null,
            totalBytes: null,
            version: null,
            message: null,
        });

        // Forced too: the user has just asked for bytes, so this is the moment to
        // be sure the URLs and checksums are the current ones.
        const manifest = await loadManifest(deps, signal, true);
        const build = manifest.builds[platformKey()];
        if (!build)
            throw new Error(
                `no managed ffmpeg build is published for ${platformKey()} — ` +
                    `install ffmpeg yourself and Rerun TV will find it`,
            );

        const downloads = join(staging, "downloads");
        const unpacked = join(staging, "unpacked");
        const out = join(staging, "out");
        mkdirSync(downloads, { recursive: true });
        mkdirSync(unpacked, { recursive: true });
        mkdirSync(out, { recursive: true });

        const tally: ByteTally = {
            received: 0,
            total: build.parts.reduce(
                (sum, part) => sum + (part.sizeBytes || 0),
                0,
            ),
        };
        report({
            phase: "downloading",
            receivedBytes: 0,
            totalBytes: tally.total,
            version: build.version,
            message: null,
        });

        // Sequential rather than parallel: two 120 MB transfers race each other
        // for the same link and finish no sooner, and one bar over one file is
        // the only progress a person can actually read.
        const archives: { part: ManifestPart; file: string }[] = [];
        for (const [index, part] of build.parts.entries()) {
            if (signal.aborted) throw abortError();
            const file = join(downloads, `part-${index}`);
            await downloadPart(
                part,
                file,
                tally,
                deps,
                report,
                build.version,
                signal,
            );
            archives.push({ part, file });
        }

        report({
            phase: "extracting",
            receivedBytes: null,
            totalBytes: null,
            version: build.version,
            message: null,
        });

        for (const { part, file } of archives) {
            if (signal.aborted) throw abortError();
            if (part.format === "binary") {
                // Already the executable itself — the macOS builds are published
                // this way, one file per tool.
                copyFileSync(file, join(out, exeName(part.binary ?? "ffmpeg")));
            } else {
                await untar(file, unpacked, signal);
            }
        }

        for (const name of ["ffmpeg", "ffprobe"] as const) {
            const target = join(out, exeName(name));
            if (fileExists(target)) continue;
            const found = findInTree(unpacked, exeName(name));
            if (found) copyFileSync(found, target);
        }

        const ffmpegPath = join(out, exeName("ffmpeg"));
        if (!fileExists(ffmpegPath))
            throw new Error(
                "the download unpacked without an ffmpeg binary in it — the " +
                    "pinned build may have changed shape upstream",
            );
        // Windows infers executability from the extension; everywhere else it is
        // a bit we have to set, and an unset one is the whole failure.
        for (const name of ["ffmpeg", "ffprobe"] as const) {
            const file = join(out, exeName(name));
            if (fileExists(file)) chmodSync(file, 0o755);
        }

        report({
            phase: "testing",
            receivedBytes: null,
            totalBytes: null,
            version: build.version,
            message: null,
        });
        if (signal.aborted) throw abortError();
        if ((await deps.verify(ffmpegPath)) !== "ok")
            throw new Error(
                "the downloaded ffmpeg ran but could not produce the H.264/AAC " +
                    "stream Rerun TV needs, so it was discarded",
            );

        // ---- activate ----
        //
        // Everything above this line happened inside the staging directory and
        // could be thrown away without consequence. From here the new version is
        // reachable, which is why nothing before it wrote outside staging.
        if (signal.aborted) throw abortError();
        const versionDir = managedVersionDir(build.version);
        mkdirSync(managedFfmpegVersionsDir(), { recursive: true });
        rmSync(versionDir, { recursive: true, force: true });
        renameSync(out, versionDir);

        const record: ManagedFfmpegRecord = {
            version: build.version,
            installedAt: new Date().toISOString(),
            platform: process.platform,
            arch: process.arch,
        };
        writeFileSync(
            managedFfmpegRecordPath(),
            `${JSON.stringify(record, null, 2)}\n`,
            "utf8",
        );

        resetFfmpegCache();
        options.onInstalled();

        report({
            phase: "done",
            receivedBytes: null,
            totalBytes: null,
            version: build.version,
            message: `ffmpeg ${build.version} installed from ${build.source}`,
        });
        return build.version;
    } catch (err) {
        const cancelled =
            signal.aborted || (err as Error | undefined)?.name === "AbortError";
        const message = cancelled
            ? "Download cancelled."
            : err instanceof Error
              ? err.message
              : String(err);
        report({
            phase: cancelled ? "cancelled" : "error",
            receivedBytes: null,
            totalBytes: null,
            version: null,
            message,
        });
        throw new Error(message);
    } finally {
        rmSync(staging, { recursive: true, force: true });
        inFlight = null;
    }
}

function fileExists(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Update check, removal, housekeeping
// ---------------------------------------------------------------------------

/**
 * Is there a newer build than the installed one?
 *
 * Deliberately string inequality rather than a version comparison. Upstream
 * names releases `n8.1.2-34-g9b6c8969e0`, which no semver parser has an opinion
 * about, and the honest question here is "is the manifest pointing somewhere
 * else than where you installed from?" — for which "different" is the right and
 * only answer.
 */
export async function checkFfmpegUpdate(
    deps: ManagerDeps = defaultDeps,
): Promise<FfmpegUpdateCheck> {
    // Forced: this is the one call that exists to go and look.
    const manifest = await loadManifest(deps, undefined, true);
    const build = manifest.builds[platformKey()];
    const installed = readManagedRecord()?.version ?? null;
    return {
        installed,
        latest: build?.version ?? null,
        updateAvailable:
            build != null && installed != null && build.version !== installed,
        source: build?.source ?? null,
    };
}

/** Is a managed build offered for this machine at all? */
export async function managedFfmpegAvailable(
    deps: ManagerDeps = defaultDeps,
): Promise<boolean> {
    // The shipped manifest is enough to answer this: a platform the app was
    // built knowing about does not stop being one because the network is down.
    if (shippedManifest().builds[platformKey()] != null) return true;
    const manifest = await loadManifest(deps);
    return manifest.builds[platformKey()] != null;
}

/**
 * Delete the managed copy entirely.
 *
 * The pointer goes first: from the moment it is gone the resolver reports the
 * system binary again, so an interrupted removal leaves the app on a correct
 * answer rather than pointing at a half-deleted directory.
 */
export function removeManagedFfmpeg(onRemoved: () => void): void {
    rmSync(managedFfmpegRecordPath(), { force: true });
    resetFfmpegCache();
    onRemoved();
    rmSync(managedFfmpegVersionsDir(), { recursive: true, force: true });
}

/**
 * Sweep up at boot: abandoned staging directories, and version directories that
 * are no longer the active one.
 *
 * This is the other half of side-by-side updates. Deleting the old version at
 * update time would risk pulling a binary out from under a running encoder;
 * doing it at the next launch cannot, because nothing from the last session is
 * still alive. Never throws — leftovers are inert, and a failed tidy-up must not
 * cost anyone their television.
 */
export function cleanupManagedFfmpeg(): void {
    const active = readManagedRecord()?.version ?? null;
    try {
        for (const entry of readdirSync(managedFfmpegDir(), {
            withFileTypes: true,
        })) {
            if (entry.isDirectory() && entry.name.startsWith(".staging-")) {
                rmSync(join(managedFfmpegDir(), entry.name), {
                    recursive: true,
                    force: true,
                });
            }
        }
    } catch {
        // No managed directory at all, which is the common case.
    }
    try {
        for (const entry of readdirSync(managedFfmpegVersionsDir(), {
            withFileTypes: true,
        })) {
            if (!entry.isDirectory() || entry.name === active) continue;
            rmSync(join(managedFfmpegVersionsDir(), entry.name), {
                recursive: true,
                force: true,
            });
        }
    } catch {
        // Likewise: nothing installed, nothing to sweep.
    }
}
