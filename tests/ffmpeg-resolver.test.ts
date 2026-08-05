/**
 * Which ffmpeg wins (`main/stream/ffmpeg.ts`).
 *
 * The managed install exists to be *preferred*, and precedence is the one part
 * of that feature with no visible symptom when it is wrong: a machine that has
 * both binaries plays perfectly either way, right up until someone downloads a
 * managed copy specifically because the system one is too old. So the ladder is
 * asserted rung by rung, including the two ways a managed install can be present
 * but unusable — a version directory that isn't there, and a pointer whose
 * version would escape the directory it names.
 *
 * The stubs are ordinary files with the executable bit set, not runnable
 * programs. Everything under test here is about *paths*: `readVersion` spawning
 * them and getting nothing back is the correct outcome for a stub, and it keeps
 * the suite running identically on the Windows runner, where a shebang script
 * cannot be spawned at all.
 */

import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    readManagedRecord,
    resetFfmpegCache,
    resolveFfmpeg,
} from "@main/stream/ffmpeg.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const isWindows = process.platform === "win32";
const exe = (name: string): string => (isWindows ? `${name}.exe` : name);

let dir: string;
let saved: Record<string, string | undefined>;

/** A file that passes the executable check without being a real program. */
function stub(at: string, name: string): string {
    mkdirSync(at, { recursive: true });
    const file = join(at, exe(name));
    writeFileSync(file, "not really a program\n");
    chmodSync(file, 0o755);
    return file;
}

/** Install a managed copy the way `ffmpeg-manager` would, minus the download. */
function installManaged(version: string, tools = ["ffmpeg", "ffprobe"]): void {
    const versionDir = join(dir, "rerun-tv", "ffmpeg", "versions", version);
    for (const tool of tools) stub(versionDir, tool);
    writeManagedRecord(version);
}

function writeManagedRecord(version: string): void {
    const ffmpegDir = join(dir, "rerun-tv", "ffmpeg");
    mkdirSync(ffmpegDir, { recursive: true });
    writeFileSync(
        join(ffmpegDir, "managed.json"),
        JSON.stringify({
            version,
            installedAt: "2026-08-05T00:00:00.000Z",
            platform: process.platform,
            arch: process.arch,
        }),
    );
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rerun-resolver-"));
    saved = {
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        PATH: process.env.PATH,
        RERUN_FFMPEG_PATH: process.env.RERUN_FFMPEG_PATH,
        RERUN_FFPROBE_PATH: process.env.RERUN_FFPROBE_PATH,
    };
    process.env.XDG_DATA_HOME = dir;
    // An empty PATH is the "nothing installed" baseline every case starts from;
    // the ones that want a system binary put one on it explicitly.
    process.env.PATH = join(dir, "empty-path");
    delete process.env.RERUN_FFMPEG_PATH;
    delete process.env.RERUN_FFPROBE_PATH;
    resetFfmpegCache();
});

afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    resetFfmpegCache();
    rmSync(dir, { recursive: true, force: true });
});

describe("precedence", () => {
    it("reports nothing when there is nothing", () => {
        const ff = resolveFfmpeg();
        expect(ff.source).toBe("missing");
        expect(ff.ffmpegPath).toBeNull();
    });

    it("finds a system binary on PATH", () => {
        const systemDir = join(dir, "bin");
        stub(systemDir, "ffmpeg");
        stub(systemDir, "ffprobe");
        process.env.PATH = systemDir;

        const ff = resolveFfmpeg();
        expect(ff.source).toBe("system");
        expect(ff.ffmpegPath).toBe(join(systemDir, exe("ffmpeg")));
        expect(ff.ffprobePath).toBe(join(systemDir, exe("ffprobe")));
    });

    /** The whole point of the feature: the copy we installed outranks the one we found. */
    it("prefers the managed copy over the system one", () => {
        const systemDir = join(dir, "bin");
        stub(systemDir, "ffmpeg");
        stub(systemDir, "ffprobe");
        process.env.PATH = systemDir;
        installManaged("n8.1.2-test");

        const ff = resolveFfmpeg();
        expect(ff.source).toBe("managed");
        expect(ff.ffmpegPath).toContain(join("versions", "n8.1.2-test"));
        expect(ff.ffprobePath).toContain(join("versions", "n8.1.2-test"));
    });

    /**
     * The env override stays the escape hatch — above even the managed copy —
     * because it is what `tests/stream-jobs.test.ts` and a broken install both
     * need to reach past everything else.
     */
    it("lets the env override outrank a managed install", () => {
        installManaged("n8.1.2-test");
        const pinned = stub(join(dir, "pinned"), "ffmpeg");
        process.env.RERUN_FFMPEG_PATH = pinned;

        const ff = resolveFfmpeg();
        expect(ff.source).toBe("system");
        expect(ff.ffmpegPath).toBe(pinned);
        // …but the managed ffprobe still fills the half the override left empty,
        // rather than the app going without one.
        expect(ff.ffprobePath).toContain(join("versions", "n8.1.2-test"));
    });

    it("falls back to PATH when the managed version directory is gone", () => {
        const systemDir = join(dir, "bin");
        stub(systemDir, "ffmpeg");
        process.env.PATH = systemDir;
        // The pointer without the binaries — a hand-deleted directory, or a home
        // folder copied between machines.
        writeManagedRecord("n8.1.2-vanished");

        const ff = resolveFfmpeg();
        expect(ff.source).toBe("system");
        expect(ff.ffmpegPath).toBe(join(systemDir, exe("ffmpeg")));
    });

    it("supplies ffmpeg from a managed copy that has no ffprobe", () => {
        installManaged("n8.1.2-partial", ["ffmpeg"]);

        const ff = resolveFfmpeg();
        expect(ff.source).toBe("managed");
        expect(ff.ffprobePath).toBeNull();
    });
});

describe("the pointer file", () => {
    it("refuses a version that would climb out of the versions directory", () => {
        writeManagedRecord(join("..", "..", "elsewhere"));
        expect(readManagedRecord()).toBeNull();
        expect(resolveFfmpeg().source).toBe("missing");
    });

    it("treats an unparseable pointer as nothing installed", () => {
        mkdirSync(join(dir, "rerun-tv", "ffmpeg"), { recursive: true });
        writeFileSync(
            join(dir, "rerun-tv", "ffmpeg", "managed.json"),
            "{oh no",
        );
        expect(readManagedRecord()).toBeNull();
        expect(resolveFfmpeg().source).toBe("missing");
    });

    it("reads back what an install wrote", () => {
        installManaged("n8.1.2-test");
        expect(readManagedRecord()).toEqual({
            version: "n8.1.2-test",
            installedAt: "2026-08-05T00:00:00.000Z",
            platform: process.platform,
            arch: process.arch,
        });
    });
});

describe("the cache", () => {
    /**
     * The rebind seam. Without the reset an install that lands mid-session is
     * invisible until the next launch — which is exactly the bug the gate would
     * then never close on.
     */
    it("keeps answering 'missing' until it is dropped, then finds the install", () => {
        expect(resolveFfmpeg().source).toBe("missing");
        installManaged("n8.1.2-test");
        expect(resolveFfmpeg().source).toBe("missing");

        resetFfmpegCache();
        expect(resolveFfmpeg().source).toBe("managed");
    });
});
