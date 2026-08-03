/**
 * Loudness equalization (docs/playback.md, "Loudness equalization").
 *
 * Three layers, and the middle one is the reason this file exists at all:
 *
 * 1. the arithmetic and the parsing, which are pure;
 * 2. **the filter string, run through a real ffmpeg** — a chain that composes
 *    beautifully in a unit test and that ffmpeg rejects is worth nothing, and
 *    the specific ways this one can be wrong (a second `-af` silently replacing
 *    the first, a filter on a stream copy, 192 kHz reaching the AAC encoder) all
 *    look fine until something actually runs them;
 * 3. the background job, whose whole contract is "never gets in the way".
 *
 * The ffmpeg-backed cases skip themselves on a machine without one, like the
 * rest of the suite.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDatabase } from "@main/db/index.js";
import {
    listEpisodesNeedingLoudness,
    loudnessCoverage,
    saveLoudness,
} from "@main/db/repositories/library.js";
import { type LoudnessLog, LoudnessScanner } from "@main/library/loudness.js";
import { resolveFfmpeg } from "@main/stream/ffmpeg.js";
import {
    LOUDNESS_TARGET_I,
    measureArgs,
    measureLoudness,
    parseLoudnessJson,
    planLoudness,
    preGainDb,
} from "@main/stream/loudness.js";
import {
    remuxArgs,
    type StreamServer,
    startStreamServer,
    transcodeArgs,
} from "@main/stream/server.js";
import { effectivePlaybackPath, loudnessEqApplies } from "@shared/playback.js";
import {
    type AppSettings,
    DEFAULT_SETTINGS,
    type LoudnessMeasurement,
} from "@shared/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegMissing } from "./ffmpeg-guard.js";
import { makeClip } from "./helpers/media.js";

const ffmpeg = resolveFfmpeg();
const noFfmpeg = ffmpegMissing(ffmpeg.ffmpegPath !== null, "loudness");

const ON: AppSettings = { ...DEFAULT_SETTINGS, loudnessEq: true };
const OFF: AppSettings = { ...DEFAULT_SETTINGS, loudnessEq: false };

/**
 * The job narrates every file it touches, which is right in the app log and
 * wrong in a test report: a dozen `[loudness]` lines per case, interleaved with
 * the reporter's, and one of these cases deliberately feeds ffmpeg a broken file
 * so a scary-looking warning is the *expected* result. Injecting silence keeps
 * the run readable; production still gets `console`.
 */
const SILENT: LoudnessLog = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

/** A plausible quiet disc rip: 6.8 LU below target, peaks with room to spare. */
const QUIET: LoudnessMeasurement = {
    i: -22.8,
    tp: -3.1,
    lra: 15.2,
    thresh: -33.1,
};

let dir: string;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rerun-loudness-"));
});

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------

describe("preGainDb", () => {
    it("lifts a quiet episode exactly to target", () => {
        expect(preGainDb(QUIET)).toBeCloseTo(LOUDNESS_TARGET_I - QUIET.i, 2);
    });

    it("pulls a loud one down", () => {
        expect(
            preGainDb({ i: -11, tp: -0.2, lra: 6, thresh: -21 }),
        ).toBeCloseTo(-5, 2);
    });

    /**
     * The tempting mistake, asserted against: holding the pre-gain back because
     * the source's peaks are already near full scale. A quiet-but-peaky master
     * (whispered dialogue under gunshots) cannot reach −16 LUFS *by any route*
     * without its peaks crossing the ceiling — so a true-peak clamp here would not
     * avoid the limiter, it would only hand the same gain to loudnorm's dynamic
     * stage a few seconds later, restoring the wobble the measurement exists to
     * remove.
     */
    it("lifts a quiet-but-peaky master the full distance anyway", () => {
        const peaky: LoudnessMeasurement = {
            i: -24,
            tp: -0.5,
            lra: 20,
            thresh: -34,
        };
        expect(preGainDb(peaky)).toBeCloseTo(LOUDNESS_TARGET_I - peaky.i, 2);
    });

    it("never moves a soundtrack absurdly far on one measurement", () => {
        expect(
            preGainDb({ i: -70, tp: -60, lra: 1, thresh: -80 }),
        ).toBeLessThanOrEqual(24);
        expect(
            preGainDb({ i: 12, tp: 6, lra: 1, thresh: 2 }),
        ).toBeGreaterThanOrEqual(-24);
    });
});

describe("parseLoudnessJson", () => {
    const REAL_OUTPUT = `
[Parsed_loudnorm_0 @ 0x55f0a8]
{
	"input_i" : "-22.80",
	"input_tp" : "-3.10",
	"input_lra" : "15.20",
	"input_thresh" : "-33.10",
	"output_i" : "-16.02",
	"output_tp" : "-1.50",
	"output_lra" : "10.90",
	"output_thresh" : "-26.30",
	"normalization_type" : "dynamic",
	"target_offset" : "0.02"
}
`;

    it("reads the input measurements out of ffmpeg’s stderr", () => {
        expect(parseLoudnessJson(REAL_OUTPUT)).toEqual({
            i: -22.8,
            tp: -3.1,
            lra: 15.2,
            thresh: -33.1,
        });
    });

    it("takes the last block, so log noise before it is harmless", () => {
        const noisy = `[info] { "not" : "it" }\n${REAL_OUTPUT}`;
        expect(parseLoudnessJson(noisy)?.i).toBe(-22.8);
    });

    /** Digital silence measures as `-inf`, which is not something to offset from. */
    it("answers null for an unmeasurable track", () => {
        const silent = REAL_OUTPUT.replace('"-22.80"', '"-inf"');
        expect(parseLoudnessJson(silent)).toBeNull();
    });

    it("answers null rather than throwing on junk", () => {
        expect(parseLoudnessJson("")).toBeNull();
        expect(parseLoudnessJson("ffmpeg: no such file")).toBeNull();
        expect(parseLoudnessJson("{ this is not json")).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

describe("planLoudness", () => {
    it("is null when the setting is off — the whole feature stays out of the way", () => {
        expect(planLoudness(OFF, "ac3", QUIET)).toBeNull();
    });

    it("is null for a silent file, which has nothing to equalize", () => {
        expect(planLoudness(ON, "none", null)).toBeNull();
        expect(loudnessEqApplies("none", true)).toBe(false);
    });

    it("is dynamic loudnorm alone until the episode has been measured", () => {
        const filters = planLoudness(ON, "ac3", null);
        expect(filters).not.toBeNull();
        expect(filters?.some((f) => f.startsWith("volume="))).toBe(false);
        expect(filters?.[0]).toContain("loudnorm=I=-16:TP=-1.5:LRA=11");
    });

    /**
     * `linear=false` is not a default being restated. Handing loudnorm the
     * measured values would flip it into linear mode — one gain for the whole
     * file, which fixes the across-episode half and abandons the within-episode
     * half. The measurement is carried by `volume` for exactly that reason.
     */
    it("keeps loudnorm dynamic, and carries the measurement as a pre-gain", () => {
        const filters = planLoudness(ON, "ac3", QUIET) ?? [];
        expect(filters[0]).toBe("volume=6.80dB");
        expect(filters[1]).toContain("linear=false");
        expect(filters.join(",")).not.toContain("measured_I");
    });

    it("resamples after loudnorm, which emits 192 kHz the AAC encoder cannot use", () => {
        expect(planLoudness(ON, "ac3", QUIET)?.at(-1)).toBe("aresample=48000");
    });

    it("skips an inaudible pre-gain rather than spending a filter on it", () => {
        const onTarget: LoudnessMeasurement = {
            i: -16.02,
            tp: -2,
            lra: 8,
            thresh: -26,
        };
        expect(
            planLoudness(ON, "ac3", onTarget)?.some((f) =>
                f.startsWith("volume="),
            ),
        ).toBe(false);
    });
});

describe("arg builders with loudness on", () => {
    const filters = planLoudness(ON, "ac3", QUIET);

    /**
     * The failure this guards against is silent: ffmpeg takes only the last `-af`
     * for a stream, so a second one would not add the loudness filters — it would
     * drop the channel-layout guard that keeps Chromium's MSE parser from
     * rejecting the init segment.
     */
    it("puts every filter in one -af, with the layout guard still last", () => {
        const args = remuxArgs("/tv/ep.mkv", 0, false, ON, filters);
        expect(args.filter((a) => a === "-af")).toHaveLength(1);
        const chain = args[args.indexOf("-af") + 1].split(",");
        expect(chain.at(-1)).toBe(
            "aformat=channel_layouts=mono|stereo|3.0|4.0|5.0|5.1|7.1",
        );
        expect(chain.slice(0, -1)).toEqual(filters);
    });

    /**
     * A filter cannot ride a stream copy, so an episode whose audio would have
     * been copied verbatim has to be encoded instead. The expensive half is
     * untouched: still `-c:v copy`, still no video encoder.
     */
    it("gives up the audio stream copy, and only that", () => {
        const args = remuxArgs("/tv/ep.mp4", 0, true, ON, filters);
        expect(args.join(" ")).toContain("-c:v copy");
        expect(args.join(" ")).toContain("-c:a aac");
        expect(args).not.toContain("libx264");
    });

    it("still copies both streams when the setting is off", () => {
        const args = remuxArgs(
            "/tv/ep.mp4",
            0,
            true,
            OFF,
            planLoudness(OFF, "aac", QUIET),
        );
        expect(args.join(" ")).toContain("-c copy");
        expect(args).not.toContain("-af");
    });

    it("applies on the transcode path too", () => {
        const chain = transcodeArgs("/tv/ep.mkv", 0, ON, filters);
        expect(chain.join(" ")).toContain("loudnorm=");
        expect(chain.join(" ")).toContain("-c:v libx264");
    });
});

describe("effectivePlaybackPath", () => {
    /**
     * A direct file never meets ffmpeg, so it is the one path the filter cannot
     * reach — it has to be served down the pipe instead. Both halves of the app
     * read this: the server to pick `servePipe`, and `EpisodeView` so the renderer
     * uses the MediaSource pump rather than pointing a plain `<video src>` at an
     * open-ended stream.
     */
    it("sends a direct file down the remux pipe while the setting is on", () => {
        expect(effectivePlaybackPath("direct", "aac", true)).toBe("remux");
        expect(effectivePlaybackPath("direct", "aac", false)).toBe("direct");
    });

    it("leaves a silent direct file alone — nothing to equalize, nothing to pay", () => {
        expect(effectivePlaybackPath("direct", "none", true)).toBe("direct");
    });

    it("never changes the other two paths, which already run through ffmpeg", () => {
        expect(effectivePlaybackPath("remux", "ac3", true)).toBe("remux");
        expect(effectivePlaybackPath("transcode", "ac3", true)).toBe(
            "transcode",
        );
    });
});

// ---------------------------------------------------------------------------
// Against a real ffmpeg
// ---------------------------------------------------------------------------

describe.skipIf(noFfmpeg)("measuring a real file", () => {
    let loud: string;
    let quiet: string;
    let silent: string;

    beforeAll(() => {
        // A tone at full scale and the same tone 10 dB down: the *difference* is
        // what can be asserted without pinning the test to one ffmpeg's exact
        // K-weighting arithmetic.
        loud = tone("loud.wav", null);
        quiet = tone("quiet.wav", "volume=-10dB");
        silent = tone("silent.wav", "volume=0");
    });

    function tone(name: string, filter: string | null): string {
        const path = join(dir, name);
        makeClip({
            ffmpegPath: ffmpeg.ffmpegPath as string,
            out: path,
            video: false,
            audio: "tone",
            toneHz: 1000,
            seconds: 5,
            audioFilter: filter,
            acodec: "pcm_s16le",
        });
        return path;
    }

    it("reports a measurement ffmpeg itself would agree with", async () => {
        const result = await measureLoudness(ffmpeg.ffmpegPath as string, loud);
        expect(result.error).toBeNull();
        expect(result.measurement).not.toBeNull();
        // Not pinned to an exact figure — that would be asserting one ffmpeg's
        // K-weighting arithmetic. A steady tone is simply a real, finite,
        // dynamically flat measurement.
        expect(Number.isFinite(result.measurement!.i)).toBe(true);
        expect(result.measurement!.i).toBeGreaterThan(-70);
        expect(result.measurement!.lra).toBeLessThan(2);
    });

    it("tracks a 10 dB attenuation to within half a dB", async () => {
        const a = await measureLoudness(ffmpeg.ffmpegPath as string, loud);
        const b = await measureLoudness(ffmpeg.ffmpegPath as string, quiet);
        expect(a.measurement!.i - b.measurement!.i).toBeCloseTo(10, 0);
    });

    /** Silence is a real answer — recorded, so it is never measured twice. */
    it('answers "nothing to measure" for a silent track without failing', async () => {
        const result = await measureLoudness(
            ffmpeg.ffmpegPath as string,
            silent,
        );
        expect(result.error).toBeNull();
        expect(result.measurement).toBeNull();
    });

    it("reports a broken file as an error rather than a measurement", async () => {
        const broken = join(dir, "broken.wav");
        writeFileSync(broken, Buffer.from("not audio"));
        const result = await measureLoudness(
            ffmpeg.ffmpegPath as string,
            broken,
        );
        expect(result.measurement).toBeNull();
        expect(result.error).not.toBeNull();
    });

    it("measures the audio stream only — the video is never decoded", () => {
        const args = measureArgs("/tv/ep.mkv");
        expect(args.join(" ")).toContain("-map 0:a:0");
        expect(args.join(" ")).toContain("-f null");
        // loudnorm prints its JSON at info level; the streaming paths run at
        // `error`, which would swallow the entire result.
        expect(args[args.indexOf("-loglevel") + 1]).toBe("info");
    });
});

/**
 * The chain, served.
 *
 * Every assertion here is "ffmpeg accepted it and produced fragmented MP4",
 * which is the one thing a unit test on an argument array cannot tell you.
 */
describe.skipIf(noFfmpeg)("serving an equalized stream", () => {
    let db: Db;
    let server: StreamServer;
    let settings: AppSettings = { ...DEFAULT_SETTINGS, loudnessEq: true };
    let ac3Id = 0;
    let directId = 0;

    beforeAll(async () => {
        db = openDatabase(":memory:");
        db.prepare(
            "INSERT INTO shows (id, title, folder_path, added_at) VALUES (1, ?, ?, 0)",
        ).run("Loudness", dir);

        ac3Id = clip("eq-ac3.mkv", "ac3", "remux", 1);
        directId = clip("eq-direct.mp4", "aac", "direct", 2);
        // A measured row, so the served chain carries a real `volume=` pre-gain
        // rather than only the unmeasured shape.
        saveLoudness(db, ac3Id, QUIET, Date.now());

        server = await startStreamServer({ db, getSettings: () => settings });
    });

    afterAll(async () => {
        await server.close();
        db.close();
    });

    function clip(
        name: string,
        acodec: string,
        playbackPath: string,
        episode: number,
    ): number {
        const path = join(dir, name);
        makeClip({
            ffmpegPath: ffmpeg.ffmpegPath as string,
            out: path,
            audio: "tone",
            acodec,
        });
        const info = db
            .prepare(
                `INSERT INTO episodes (show_id, season, episode, path, duration_s, container, vcodec, acodec, playback_path)
         VALUES (1, 1, ?, ?, 1, 'matroska', 'h264', ?, ?)`,
            )
            .run(episode, path, acodec, playbackPath);
        return Number(info.lastInsertRowid);
    }

    async function fmp4(url: string): Promise<Buffer> {
        const res = await fetch(url);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("video/mp4");
        const body = Buffer.from(await res.arrayBuffer());
        // `ftyp` at offset 4 is the fragmented-MP4 header the pump needs.
        expect(body.subarray(4, 8).toString("latin1")).toBe("ftyp");
        return body;
    }

    it("encodes a measured episode through the whole chain", async () => {
        settings = { ...DEFAULT_SETTINGS, loudnessEq: true };
        await fmp4(server.urlFor(ac3Id, 0, 21));
        server.releaseChannel(21);
    });

    /**
     * The demotion, end to end: a file that would have been range-served off disk
     * comes back as a pipe, because that is the only way its audio reaches a
     * filter at all.
     */
    it("pipes a direct-play file instead of range-serving it", async () => {
        settings = { ...DEFAULT_SETTINGS, loudnessEq: true };
        const res = await fetch(server.urlFor(directId, 0, 22));
        expect(res.status).toBe(200);
        expect(res.headers.get("accept-ranges")).toBe("none");
        await res.arrayBuffer();
        server.releaseChannel(22);
    });

    it("goes back to range-serving that same file with the setting off", async () => {
        settings = { ...DEFAULT_SETTINGS, loudnessEq: false };
        const res = await fetch(server.urlFor(directId));
        expect(res.status).toBe(200);
        expect(res.headers.get("accept-ranges")).toBe("bytes");
        await res.arrayBuffer();
    });

    it("takes effect on the next tune-in, with no restart", async () => {
        // The same episode, both ways, through one long-lived server: settings are
        // read per request precisely so this works.
        settings = { ...DEFAULT_SETTINGS, loudnessEq: false };
        expect(
            (await fetch(server.urlFor(directId))).headers.get("accept-ranges"),
        ).toBe("bytes");
        settings = { ...DEFAULT_SETTINGS, loudnessEq: true };
        const piped = await fetch(server.urlFor(directId, 0, 23));
        expect(piped.headers.get("accept-ranges")).toBe("none");
        await piped.arrayBuffer();
        server.releaseChannel(23);
    });
});

// ---------------------------------------------------------------------------
// The background job
// ---------------------------------------------------------------------------

describe.skipIf(noFfmpeg)("LoudnessScanner", () => {
    let db: Db;

    function seed(count: number, acodec = "pcm_s16le"): void {
        db.prepare(
            "INSERT INTO shows (id, title, folder_path, added_at) VALUES (1, ?, ?, 0)",
        ).run("Job", dir);
        const insert = db.prepare(
            `INSERT INTO episodes (show_id, season, episode, path, duration_s, container, vcodec, acodec, playback_path)
       VALUES (1, 1, ?, ?, 1, 'wav', 'none', ?, 'transcode')`,
        );
        for (let i = 0; i < count; i++)
            insert.run(i, join(dir, `job-${i}.wav`), acodec);
    }

    function makeTone(index: number): void {
        makeClip({
            ffmpegPath: ffmpeg.ffmpegPath as string,
            out: join(dir, `job-${index}.wav`),
            video: false,
            audio: "tone",
            seconds: 2,
            acodec: "pcm_s16le",
        });
    }

    /** Poll until `done`, so a test never waits the full timeout on success. */
    async function until(
        done: () => boolean,
        timeoutMs = 30_000,
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!done()) {
            if (Date.now() > deadline)
                throw new Error("timed out waiting for the measuring job");
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    beforeAll(() => {
        for (let i = 0; i < 2; i++) makeTone(i);
    });

    it("measures every unmeasured episode and stops", async () => {
        db = openDatabase(":memory:");
        seed(2);
        const scanner = new LoudnessScanner({
            db,
            ffmpegPath: ffmpeg.ffmpegPath,
            // The job's real pacing is deliberate politeness; a test should not sit
            // through it.
            busyRecheckMs: 25,
            betweenFilesMs: 0,
            getSettings: () => ON,
            log: SILENT,
            isBusy: () => false,
        });

        scanner.start();
        await until(() => loudnessCoverage(db).measured === 2);

        expect(listEpisodesNeedingLoudness(db)).toHaveLength(0);
        await until(() => !scanner.running);
        scanner.dispose();
        db.close();
    }, 60_000);

    it("does nothing at all while the setting is off", async () => {
        db = openDatabase(":memory:");
        seed(2);
        const scanner = new LoudnessScanner({
            db,
            ffmpegPath: ffmpeg.ffmpegPath,
            // The job's real pacing is deliberate politeness; a test should not sit
            // through it.
            busyRecheckMs: 25,
            betweenFilesMs: 0,
            getSettings: () => OFF,
            log: SILENT,
            isBusy: () => false,
        });

        scanner.start();
        expect(scanner.running).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(loudnessCoverage(db).measured).toBe(0);
        scanner.dispose();
        db.close();
    });

    /**
     * The one property that makes a background decoder acceptable in a media app:
     * while anything is playing, it does not run.
     */
    it("waits while the machine is busy", async () => {
        db = openDatabase(":memory:");
        seed(2);
        let busy = true;
        const scanner = new LoudnessScanner({
            db,
            ffmpegPath: ffmpeg.ffmpegPath,
            // The job's real pacing is deliberate politeness; a test should not sit
            // through it.
            busyRecheckMs: 25,
            betweenFilesMs: 0,
            getSettings: () => ON,
            log: SILENT,
            isBusy: () => busy,
        });

        scanner.start();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(loudnessCoverage(db).measured).toBe(0);

        busy = false;
        await until(() => loudnessCoverage(db).measured === 2);
        scanner.dispose();
        db.close();
    }, 60_000);

    it("records a file it cannot measure without stalling on it", async () => {
        db = openDatabase(":memory:");
        seed(2);
        // One good file, one that will never decode.
        writeFileSync(join(dir, "job-1.wav"), Buffer.from("not audio"));

        const scanner = new LoudnessScanner({
            db,
            ffmpegPath: ffmpeg.ffmpegPath,
            // The job's real pacing is deliberate politeness; a test should not sit
            // through it.
            busyRecheckMs: 25,
            betweenFilesMs: 0,
            getSettings: () => ON,
            log: SILENT,
            isBusy: () => false,
        });
        scanner.start();
        await until(
            () => !scanner.running && loudnessCoverage(db).measured >= 1,
        );

        // The good one is measured; the broken one is left for the next launch
        // rather than retried in a loop.
        expect(loudnessCoverage(db).measured).toBe(1);
        scanner.dispose();
        db.close();
        makeTone(1);
    }, 60_000);

    /**
     * The setting switched off and straight back on. The first pass is still
     * unwinding from its abort when the second is asked for, so anything that
     * treats "a pass is running" as "no need to start one" would drop the restart
     * and leave the library unmeasured until the next launch.
     */
    it("picks back up when stopped and restarted immediately", async () => {
        db = openDatabase(":memory:");
        seed(2);
        let on = true;
        const scanner = new LoudnessScanner({
            db,
            ffmpegPath: ffmpeg.ffmpegPath,
            busyRecheckMs: 25,
            betweenFilesMs: 0,
            getSettings: () => (on ? ON : OFF),
            log: SILENT,
            isBusy: () => false,
        });

        scanner.start();
        on = false;
        scanner.stop();
        on = true;
        scanner.start();

        await until(() => loudnessCoverage(db).measured === 2);
        scanner.dispose();
        db.close();
    }, 60_000);

    it("stops the pass when disposed, killing the ffmpeg it was running", async () => {
        db = openDatabase(":memory:");
        seed(2);
        const scanner = new LoudnessScanner({
            db,
            ffmpegPath: ffmpeg.ffmpegPath,
            // The job's real pacing is deliberate politeness; a test should not sit
            // through it.
            busyRecheckMs: 25,
            betweenFilesMs: 0,
            getSettings: () => ON,
            log: SILENT,
            isBusy: () => false,
        });
        scanner.start();
        scanner.dispose();
        await until(() => !scanner.running, 5_000);
        db.close();
    }, 60_000);
});
