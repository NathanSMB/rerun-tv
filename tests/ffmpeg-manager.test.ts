/**
 * The managed ffmpeg install pipeline (`main/services/ffmpeg-manager.ts`).
 *
 * This is the one subsystem in the app that writes an executable to disk and
 * then runs it, so the interesting assertions are all about what happens when
 * something goes wrong: a download that doesn't match its checksum, an archive
 * with no ffmpeg in it, a binary that runs but can't encode, a cancel halfway
 * through. Every one of those must leave the machine exactly as it was — no
 * pointer file, no version directory, no staging left behind.
 *
 * The network and the encode test are injected (`ManagerDeps`), so nothing here
 * touches the internet or needs a real ffmpeg. The manifest's `binary` format —
 * a bare executable rather than an archive, which is how the macOS builds are
 * published — is what most cases use, because it exercises the whole pipeline
 * without depending on the platform's `tar`. Extraction gets its own case.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { join } from "node:path";
import {
    cancelFfmpegInstall,
    checkFfmpegUpdate,
    cleanupManagedFfmpeg,
    type FfmpegManifest,
    installManagedFfmpeg,
    type ManagerDeps,
    platformKey,
    removeManagedFfmpeg,
    resetManifestCache,
    shippedManifest,
} from "@main/services/ffmpeg-manager.js";
import { readManagedRecord, resetFfmpegCache } from "@main/stream/ffmpeg.js";
import type { FfmpegInstallProgress } from "@shared/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const isWindows = process.platform === "win32";

let dir: string;
let savedXdg: string | undefined;
/** Every progress event the install emitted, in order. */
let progress: FfmpegInstallProgress[];

const sha256 = (buf: Buffer): string =>
    createHash("sha256").update(buf).digest("hex");

const ffmpegDir = (): string => join(dir, "rerun-tv", "ffmpeg");
const versionsDir = (): string => join(ffmpegDir(), "versions");

/** The bytes a `binary` part serves — content is irrelevant, its hash is not. */
const FAKE_FFMPEG = Buffer.from("#!/bin/sh\necho fake ffmpeg\n");
const FAKE_FFPROBE = Buffer.from("#!/bin/sh\necho fake ffprobe\n");

/**
 * A manifest offering this machine two bare binaries.
 *
 * Keyed on the real `platformKey()` so the code under test picks it the same way
 * it would in production, rather than through a branch that only exists here.
 */
function binaryManifest(version = "test-1"): FfmpegManifest {
    return {
        schema: 1,
        builds: {
            [platformKey()]: {
                version,
                source: "test fixtures",
                sourceUrl: "https://example.invalid",
                parts: [
                    {
                        url: "https://example.invalid/ffmpeg",
                        sha256: sha256(FAKE_FFMPEG),
                        sizeBytes: FAKE_FFMPEG.length,
                        format: "binary",
                        binary: "ffmpeg",
                    },
                    {
                        url: "https://example.invalid/ffprobe",
                        sha256: sha256(FAKE_FFPROBE),
                        sizeBytes: FAKE_FFPROBE.length,
                        format: "binary",
                        binary: "ffprobe",
                    },
                ],
            },
        },
    };
}

/** Serve a fixed body per URL; anything unlisted is a 404, as the real web is. */
function fakeFetch(
    routes: Record<string, Buffer | (() => Promise<Buffer>)>,
): ManagerDeps["fetch"] {
    return (async (input: string) => {
        const route = routes[String(input)];
        if (route == null)
            return new Response("nope", {
                status: 404,
                statusText: "Not Found",
            });
        const body = typeof route === "function" ? await route() : route;
        return new Response(new Uint8Array(body), { status: 200 });
    }) as ManagerDeps["fetch"];
}

/** The default happy-path wiring: manifest, both binaries, an encoder that works. */
function deps(
    manifest: FfmpegManifest = binaryManifest(),
    overrides: Partial<ManagerDeps> = {},
): ManagerDeps {
    return {
        fetch: fakeFetch({
            "https://raw.githubusercontent.com/NathanSMB/rerun-tv/main/resources/ffmpeg-manifest.json":
                Buffer.from(JSON.stringify(manifest)),
            "https://example.invalid/ffmpeg": FAKE_FFMPEG,
            "https://example.invalid/ffprobe": FAKE_FFPROBE,
        }),
        verify: async () => "ok",
        ...overrides,
    };
}

function install(managerDeps: ManagerDeps = deps()): Promise<string> {
    return installManagedFfmpeg({
        onProgress: (p) => progress.push(p),
        onInstalled: () => progress.push({ ...LAST_PHASE, phase: "done" }),
        deps: managerDeps,
    });
}

/** A filler so `onInstalled` can be recorded in the same list as the phases. */
const LAST_PHASE: FfmpegInstallProgress = {
    phase: "done",
    receivedBytes: null,
    totalBytes: null,
    version: null,
    message: "onInstalled",
};

const phases = (): string[] => progress.map((p) => p.phase);

/** Staging directories left behind — the assertion every failure case makes. */
function stagingLeftovers(): string[] {
    try {
        return readdirSync(ffmpegDir()).filter((name) =>
            name.startsWith(".staging-"),
        );
    } catch {
        return [];
    }
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rerun-ffmpeg-mgr-"));
    savedXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    progress = [];
    resetFfmpegCache();
    // Each case hands the loader a different manifest, so the process-lifetime
    // memo must not carry the previous one over.
    resetManifestCache();
});

afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedXdg;
    resetFfmpegCache();
    rmSync(dir, { recursive: true, force: true });
});

describe("a successful install", () => {
    it("lands both binaries, writes the pointer, and reports every phase", async () => {
        const version = await install();

        expect(version).toBe("test-1");
        expect(readManagedRecord()).toMatchObject({
            version: "test-1",
            platform: process.platform,
            arch: process.arch,
        });
        const installed = join(versionsDir(), "test-1");
        expect(
            existsSync(join(installed, isWindows ? "ffmpeg.exe" : "ffmpeg")),
        ).toBe(true);
        expect(
            existsSync(join(installed, isWindows ? "ffprobe.exe" : "ffprobe")),
        ).toBe(true);
        expect(
            readFileSync(join(installed, isWindows ? "ffmpeg.exe" : "ffmpeg")),
        ).toEqual(FAKE_FFMPEG);

        // The order is the contract the two progress UIs render against.
        expect(phases()).toEqual([
            "manifest",
            "downloading",
            "verifying",
            "verifying",
            "extracting",
            "testing",
            "done",
            "done",
        ]);
        expect(stagingLeftovers()).toEqual([]);
    });

    it("reinstalling the same version replaces it rather than failing", async () => {
        await install();
        progress = [];
        await expect(install()).resolves.toBe("test-1");
        expect(readdirSync(versionsDir())).toEqual(["test-1"]);
    });

    it("keeps the superseded version until the next launch sweeps it", async () => {
        await install();
        await install(deps(binaryManifest("test-2")));

        // Both on disk: an encoder spawned from test-1 may still be mid-episode.
        expect(readdirSync(versionsDir()).sort()).toEqual(["test-1", "test-2"]);
        expect(readManagedRecord()?.version).toBe("test-2");

        cleanupManagedFfmpeg();
        expect(readdirSync(versionsDir())).toEqual(["test-2"]);
    });
});

describe("a failed install", () => {
    it("discards a download that does not match its checksum", async () => {
        const wrong = binaryManifest();
        wrong.builds[platformKey()].parts[0].sha256 = "0".repeat(64);

        await expect(install(deps(wrong))).rejects.toThrow(
            /did not match its published checksum/,
        );
        expect(readManagedRecord()).toBeNull();
        expect(existsSync(versionsDir())).toBe(false);
        expect(stagingLeftovers()).toEqual([]);
        expect(progress.at(-1)?.phase).toBe("error");
    });

    /** The last gate: it downloaded, it hashed, it runs — and it still can't encode. */
    it("discards a binary that cannot produce the stream shape", async () => {
        await expect(
            install(deps(binaryManifest(), { verify: async () => "failed" })),
        ).rejects.toThrow(/could not produce the H.264\/AAC stream/);
        expect(readManagedRecord()).toBeNull();
        expect(stagingLeftovers()).toEqual([]);
    });

    it("says so when the manifest offers nothing for this machine", async () => {
        // A manifest that is perfectly valid and simply doesn't cover us — an
        // architecture we haven't pinned a build for yet. Note it must not be
        // *empty*: an empty one is treated as a bad response and falls back to
        // the shipped manifest, which is the offline behaviour, not this one.
        const elsewhere = binaryManifest();
        elsewhere.builds = {
            "sunos-sparc": elsewhere.builds[platformKey()],
        };

        await expect(install(deps(elsewhere))).rejects.toThrow(
            /no managed ffmpeg build is published/,
        );
        expect(readManagedRecord()).toBeNull();
    });

    it("reports a withdrawn artifact as an HTTP failure, not a crash", async () => {
        const missing = binaryManifest();
        missing.builds[platformKey()].parts[0].url =
            "https://example.invalid/gone";

        await expect(install(deps(missing))).rejects.toThrow(/HTTP 404/);
        expect(readManagedRecord()).toBeNull();
    });

    it("cleans up when cancelled mid-download", async () => {
        // A body that never arrives until the cancel has definitely been asked for.
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const slow = deps(binaryManifest(), {
            fetch: fakeFetch({
                "https://raw.githubusercontent.com/NathanSMB/rerun-tv/main/resources/ffmpeg-manifest.json":
                    Buffer.from(JSON.stringify(binaryManifest())),
                "https://example.invalid/ffmpeg": async () => {
                    cancelFfmpegInstall();
                    await held;
                    return FAKE_FFMPEG;
                },
                "https://example.invalid/ffprobe": FAKE_FFPROBE,
            }),
        });

        const running = install(slow);
        release();
        await expect(running).rejects.toThrow(/cancelled/i);

        expect(readManagedRecord()).toBeNull();
        expect(stagingLeftovers()).toEqual([]);
        expect(progress.at(-1)?.phase).toBe("cancelled");
    });

    it("refuses a second install while one is running", async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const slow = deps(binaryManifest(), {
            fetch: fakeFetch({
                "https://raw.githubusercontent.com/NathanSMB/rerun-tv/main/resources/ffmpeg-manifest.json":
                    Buffer.from(JSON.stringify(binaryManifest())),
                "https://example.invalid/ffmpeg": async () => {
                    await held;
                    return FAKE_FFMPEG;
                },
                "https://example.invalid/ffprobe": FAKE_FFPROBE,
            }),
        });

        const first = install(slow);
        await expect(install()).rejects.toThrow(/already running/);
        release();
        await first;
    });
});

describe("extraction", () => {
    /**
     * The archive path, which the platform's own `tar` does. Skipped on Windows,
     * where the runner's bsdtar cannot *create* the `.tar` this fixture needs —
     * the code it covers is the same on every platform, and Windows' own format
     * (a zip through the same `tar -xf`) is exercised by the release build.
     */
    it.skipIf(isWindows)(
        "finds ffmpeg nested inside an unpacked archive",
        async () => {
            // The shape upstream actually ships: everything under a versioned
            // directory with a `bin/` inside it.
            const staging = mkdtempSync(join(tmpdir(), "rerun-tar-"));
            const nested = join(staging, "ffmpeg-n8.1.2-static", "bin");
            mkdirSync(nested, { recursive: true });
            writeFileSync(join(nested, "ffmpeg"), FAKE_FFMPEG);
            writeFileSync(join(nested, "ffprobe"), FAKE_FFPROBE);
            const archive = join(staging, "build.tar");
            execFileSync("tar", [
                "-cf",
                archive,
                "-C",
                staging,
                "ffmpeg-n8.1.2-static",
            ]);
            const bytes = readFileSync(archive);

            const manifest: FfmpegManifest = {
                schema: 1,
                builds: {
                    [platformKey()]: {
                        version: "tar-1",
                        source: "test fixtures",
                        sourceUrl: "https://example.invalid",
                        parts: [
                            {
                                url: "https://example.invalid/build.tar",
                                sha256: sha256(bytes),
                                sizeBytes: bytes.length,
                                format: "tar.xz",
                            },
                        ],
                    },
                },
            };

            await install(
                deps(manifest, {
                    fetch: fakeFetch({
                        "https://raw.githubusercontent.com/NathanSMB/rerun-tv/main/resources/ffmpeg-manifest.json":
                            Buffer.from(JSON.stringify(manifest)),
                        "https://example.invalid/build.tar": bytes,
                    }),
                }),
            );

            const installed = join(versionsDir(), "tar-1");
            expect(readFileSync(join(installed, "ffmpeg"))).toEqual(
                FAKE_FFMPEG,
            );
            expect(readFileSync(join(installed, "ffprobe"))).toEqual(
                FAKE_FFPROBE,
            );
            rmSync(staging, { recursive: true, force: true });
        },
    );

    it.skipIf(isWindows)(
        "rejects an archive with no ffmpeg in it",
        async () => {
            const staging = mkdtempSync(join(tmpdir(), "rerun-tar-"));
            mkdirSync(join(staging, "junk"), { recursive: true });
            writeFileSync(join(staging, "junk", "README"), "nothing here");
            const archive = join(staging, "junk.tar");
            execFileSync("tar", ["-cf", archive, "-C", staging, "junk"]);
            const bytes = readFileSync(archive);

            const manifest: FfmpegManifest = {
                schema: 1,
                builds: {
                    [platformKey()]: {
                        version: "empty-1",
                        source: "test fixtures",
                        sourceUrl: "https://example.invalid",
                        parts: [
                            {
                                url: "https://example.invalid/junk.tar",
                                sha256: sha256(bytes),
                                sizeBytes: bytes.length,
                                format: "tar.xz",
                            },
                        ],
                    },
                },
            };

            await expect(
                install(
                    deps(manifest, {
                        fetch: fakeFetch({
                            "https://raw.githubusercontent.com/NathanSMB/rerun-tv/main/resources/ffmpeg-manifest.json":
                                Buffer.from(JSON.stringify(manifest)),
                            "https://example.invalid/junk.tar": bytes,
                        }),
                    }),
                ),
            ).rejects.toThrow(/unpacked without an ffmpeg binary/);
            expect(readManagedRecord()).toBeNull();
            rmSync(staging, { recursive: true, force: true });
        },
    );
});

describe("removal and housekeeping", () => {
    it("drops the pointer first, then the binaries", async () => {
        await install();
        let notified = false;

        removeManagedFfmpeg(() => {
            notified = true;
            // The callback runs *after* the pointer is gone, which is what makes an
            // interrupted removal leave the app on a correct answer.
            expect(readManagedRecord()).toBeNull();
        });

        expect(notified).toBe(true);
        expect(existsSync(versionsDir())).toBe(false);
    });

    it("sweeps abandoned staging directories at launch", () => {
        mkdirSync(join(ffmpegDir(), ".staging-abandoned", "downloads"), {
            recursive: true,
        });
        cleanupManagedFfmpeg();
        expect(stagingLeftovers()).toEqual([]);
    });

    it("does nothing, loudly or otherwise, when nothing is installed", () => {
        expect(() => cleanupManagedFfmpeg()).not.toThrow();
    });
});

describe("the update check", () => {
    it("says up to date when the manifest matches what is installed", async () => {
        await install();
        const check = await checkFfmpegUpdate(deps());
        expect(check).toMatchObject({
            installed: "test-1",
            latest: "test-1",
            updateAvailable: false,
        });
    });

    it("flags a manifest pointing somewhere else", async () => {
        await install();
        const check = await checkFfmpegUpdate(deps(binaryManifest("test-9")));
        expect(check).toMatchObject({
            installed: "test-1",
            latest: "test-9",
            updateAvailable: true,
        });
    });

    it("is not an update when nothing is installed yet", async () => {
        const check = await checkFfmpegUpdate(deps());
        expect(check.installed).toBeNull();
        expect(check.updateAvailable).toBe(false);
    });

    /** Offline is not an error: the shipped manifest is a perfectly good answer. */
    it("falls back to the shipped manifest when the fetch fails", async () => {
        const offline = deps(binaryManifest(), {
            fetch: (async () => {
                throw new Error("getaddrinfo ENOTFOUND");
            }) as ManagerDeps["fetch"],
        });
        const check = await checkFfmpegUpdate(offline);
        expect(check.latest).toBe(
            shippedManifest().builds[platformKey()]?.version ?? null,
        );
    });
});

describe("the shipped manifest", () => {
    /**
     * It is data, and it is the thing a first install runs on when the fetch
     * fails — so it has to survive the same validation a fetched one does, with
     * every URL https and every checksum a real sha256.
     */
    it("passes its own validation and covers the platforms we build for", () => {
        const manifest = shippedManifest();
        for (const key of [
            "linux-x64",
            "win32-x64",
            "darwin-arm64",
            "darwin-x64",
        ]) {
            const build = manifest.builds[key];
            expect(build, `no build for ${key}`).toBeDefined();
            expect(build.parts.length).toBeGreaterThan(0);
            for (const part of build.parts) {
                expect(part.url.startsWith("https://")).toBe(true);
                expect(part.sha256).toMatch(/^[0-9a-f]{64}$/);
            }
        }
    });
});
