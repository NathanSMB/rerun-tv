/**
 * Stream server tests.
 *
 * These run against a real HTTP listener on a real ephemeral port with a real
 * in-memory database, because everything interesting about this component is in
 * the wire behaviour: status codes, range headers, and what happens to an
 * ffmpeg child when the client goes away.
 *
 * The ffmpeg-backed cases generate a tiny MKV with `lavfi` and skip themselves
 * when no ffmpeg is installed, so the suite still runs on a bare machine.
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDatabase } from "@main/db/index.js";
import {
    checkCodecs,
    FfmpegSupervisor,
    resolveFfmpeg,
} from "@main/stream/ffmpeg.js";
import {
    remuxArgs,
    type StreamServer,
    startStreamServer,
    transcodeArgs,
} from "@main/stream/server.js";
import {
    type AppSettings,
    DEFAULT_SETTINGS,
    type HwAccelReport,
} from "@shared/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegMissing } from "./ffmpeg-guard.js";
import { makeClip } from "./helpers/media.js";

const DIRECT_BODY = Buffer.from("0123456789".repeat(100)); // 1000 bytes, easy to index

const ffmpeg = resolveFfmpeg();
const noFfmpeg = ffmpegMissing(ffmpeg.ffmpegPath !== null, "stream server");

let db: Db;
let server: StreamServer;
let dir: string;
/**
 * Live settings and probe report, so a test can select a backend for one request
 * and put them back afterwards — both are read per request by the server.
 */
let settings: AppSettings = DEFAULT_SETTINGS;
let hwAccel: HwAccelReport = {
    vaapi: "failed",
    nvenc: "failed",
    vaapiDevice: null,
};
let directId: number;
let missingFileId: number;
let remuxId = 0;
let transcodeId = 0;
let remuxAc3Id = 0;

/** Insert an episode row directly — the scanner owns the real write path. */
function insertEpisode(
    path: string,
    playbackPath: string,
    container: string,
    season: number,
    episode: number,
    acodec = "aac",
): number {
    const info = db
        .prepare(
            `INSERT INTO episodes (show_id, season, episode, path, duration_s, container, vcodec, acodec, playback_path)
       VALUES (1, ?, ?, ?, 1, ?, 'h264', ?, ?)`,
        )
        .run(season, episode, path, container, acodec, playbackPath);
    return Number(info.lastInsertRowid);
}

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "rerun-stream-"));

    db = openDatabase(":memory:");
    db.prepare(
        "INSERT INTO shows (id, title, folder_path, added_at) VALUES (1, ?, ?, ?)",
    ).run("Test Show", dir, Date.now());

    const directPath = join(dir, "direct.mp4");
    writeFileSync(directPath, DIRECT_BODY);
    directId = insertEpisode(
        directPath,
        "direct",
        "mov,mp4,m4a,3gp,3g2,mj2",
        1,
        1,
    );
    missingFileId = insertEpisode(join(dir, "gone.mp4"), "direct", "mp4", 1, 2);

    if (!noFfmpeg) {
        const sample = join(dir, "sample.mkv");
        makeClip({ ffmpegPath: ffmpeg.ffmpegPath as string, out: sample });
        remuxId = insertEpisode(sample, "remux", "matroska,webm", 1, 3);
        // `episodes.path` is UNIQUE, so the transcode fixture gets its own copy of
        // the same clip rather than a second row pointing at one file.
        const copy = join(dir, "sample-transcode.mkv");
        copyFileSync(sample, copy);
        transcodeId = insertEpisode(copy, "transcode", "matroska,webm", 1, 4);

        // The phase-1 case: H.264 Chromium can decode, wrapped around a soundtrack
        // it can't. Video is copied, only the audio is encoded.
        const ac3 = join(dir, "sample-ac3.mkv");
        makeClip({
            ffmpegPath: ffmpeg.ffmpegPath as string,
            out: ac3,
            acodec: "ac3",
        });
        remuxAc3Id = insertEpisode(ac3, "remux", "matroska,webm", 1, 5, "ac3");
    }

    server = await startStreamServer({
        db,
        getSettings: () => settings,
        getHwAccel: () => hwAccel,
    });
});

afterAll(async () => {
    await server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
});

describe("urlFor", () => {
    /** The per-boot key is minted inside the server; tests assert the rest. */
    const withoutKey = (url: string): string => {
        const parsed = new URL(url);
        parsed.searchParams.delete("k");
        return parsed.toString().replace(/\?$/, "");
    };

    it("is the one URL shape the <video> element sees", () => {
        expect(withoutKey(server.urlFor(directId))).toBe(
            `http://127.0.0.1:${server.port}/stream/${directId}`,
        );
    });

    it("carries a seek as ?t= and a channel slot as ?ch=", () => {
        expect(withoutKey(server.urlFor(7, 90))).toBe(
            `http://127.0.0.1:${server.port}/stream/7?t=90`,
        );
        expect(withoutKey(server.urlFor(7, 0))).toBe(
            `http://127.0.0.1:${server.port}/stream/7`,
        );
        expect(withoutKey(server.urlFor(7, 12.5, 3))).toBe(
            `http://127.0.0.1:${server.port}/stream/7?t=12.5&ch=3`,
        );
    });

    it("carries the per-boot key on every stream URL", () => {
        const key = new URL(server.urlFor(directId)).searchParams.get("k");
        expect(key).toMatch(/^[\w-]{20,}$/);
        // Same key for every episode this boot — it identifies the app, not a stream.
        expect(new URL(server.urlFor(7, 90, 3)).searchParams.get("k")).toBe(
            key,
        );
    });
});

/**
 * Loopback binding keeps the LAN out; the key is what keeps the *machine* out.
 * Without it any local process — or a browser page, whose Host is legitimately
 * loopback — could walk the episode ids and read the bytes.
 */
describe("stream key", () => {
    it("refuses a request with no key", async () => {
        const res = await fetch(
            `http://127.0.0.1:${server.port}/stream/${directId}`,
        );
        expect(res.status).toBe(403);
    });

    it("refuses a wrong key without revealing whether the episode exists", async () => {
        const bad = `http://127.0.0.1:${server.port}/stream`;
        const missing = await fetch(`${bad}/999999?k=nope`);
        const real = await fetch(`${bad}/${directId}?k=nope`);
        expect(missing.status).toBe(403);
        expect(real.status).toBe(403);
    });

    // `/health` stays open on purpose — it carries nothing worth guarding, and
    // startup verification runs before anyone holds a key. See the `health` suite.
});

describe("health", () => {
    it("answers for startup verification", async () => {
        const res = await fetch(`http://127.0.0.1:${server.port}/health`);
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ ok: true });
    });
});

describe("direct path", () => {
    it("serves the whole file on a plain GET", async () => {
        const res = await fetch(server.urlFor(directId));
        expect(res.status).toBe(200);
        expect(res.headers.get("accept-ranges")).toBe("bytes");
        expect(res.headers.get("content-type")).toBe("video/mp4");
        expect(res.headers.get("content-length")).toBe("1000");
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(DIRECT_BODY)).toBe(true);
    });

    it("ignores ?t= — direct files seek natively via ranges", async () => {
        const res = await fetch(server.urlFor(directId, 30));
        expect(res.status).toBe(200);
        expect((await res.arrayBuffer()).byteLength).toBe(1000);
    });

    it("answers a bounded range with 206 and the exact bytes", async () => {
        const res = await fetch(server.urlFor(directId), {
            headers: { Range: "bytes=0-9" },
        });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe("bytes 0-9/1000");
        expect(res.headers.get("content-length")).toBe("10");
        expect(await res.text()).toBe("0123456789");
    });

    it("answers an open-ended range", async () => {
        const res = await fetch(server.urlFor(directId), {
            headers: { Range: "bytes=990-" },
        });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe("bytes 990-999/1000");
        expect(await res.text()).toBe("0123456789");
    });

    it("answers a suffix range", async () => {
        const res = await fetch(server.urlFor(directId), {
            headers: { Range: "bytes=-5" },
        });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe("bytes 995-999/1000");
        expect(await res.text()).toBe("56789");
    });

    it("clamps a range that runs past the end", async () => {
        const res = await fetch(server.urlFor(directId), {
            headers: { Range: "bytes=995-99999" },
        });
        expect(res.status).toBe(206);
        expect(res.headers.get("content-range")).toBe("bytes 995-999/1000");
    });

    it("rejects an unsatisfiable range with 416", async () => {
        const res = await fetch(server.urlFor(directId), {
            headers: { Range: "bytes=5000-6000" },
        });
        expect(res.status).toBe(416);
        expect(res.headers.get("content-range")).toBe("bytes */1000");
        expect(await res.text()).toBe("");
    });

    it("answers HEAD with headers and no body", async () => {
        const res = await fetch(server.urlFor(directId), { method: "HEAD" });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-length")).toBe("1000");
        expect(res.headers.get("accept-ranges")).toBe("bytes");
        expect(await res.text()).toBe("");
    });

    it("404s when the row survives but the file is gone", async () => {
        const res = await fetch(server.urlFor(missingFileId));
        expect(res.status).toBe(404);
    });
});

/**
 * The MSE pump reads stream bytes with `fetch()` from a `file://`-origin
 * renderer, which — unlike a `<video src>` — is same-origin-policy gated. Without
 * these headers every piped episode silently falls back to the old plain-`src`
 * path that phase 2 exists to retire.
 */
describe("CORS", () => {
    it("allows the renderer to read a direct file", async () => {
        const res = await fetch(server.urlFor(directId));
        await res.arrayBuffer();
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        // A pump on the direct path would still want the length it was told.
        expect(res.headers.get("access-control-expose-headers")).toMatch(
            /Content-Length/,
        );
    });

    it.skipIf(noFfmpeg)(
        "allows the renderer to read a piped stream",
        async () => {
            const res = await fetch(server.urlFor(remuxId, 0, 21));
            await res.arrayBuffer();
            expect(res.headers.get("access-control-allow-origin")).toBe("*");
        },
    );

    it("allows the renderer to read an error body, so ffmpeg’s message survives", async () => {
        const res = await fetch(server.urlFor(999_999));
        await res.text();
        expect(res.status).toBe(404);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("answers a preflight", async () => {
        const res = await fetch(server.urlFor(directId), { method: "OPTIONS" });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
        expect(res.headers.get("access-control-allow-methods")).toMatch(/GET/);
        expect(res.headers.get("access-control-allow-headers")).toMatch(
            /Range/,
        );
    });
});

describe("routing and access control", () => {
    it("404s an unknown episode id", async () => {
        const res = await fetch(server.urlFor(999_999));
        expect(res.status).toBe(404);
    });

    it("404s a path that is not an episode id", async () => {
        const res = await fetch(
            `http://127.0.0.1:${server.port}/stream/../../etc/passwd`,
        );
        expect(res.status).toBe(404);
    });

    it("405s a write method", async () => {
        const res = await fetch(server.urlFor(directId), { method: "POST" });
        expect(res.status).toBe(405);
    });

    it("rejects a non-loopback Host header (DNS rebinding)", async () => {
        const status = await new Promise<number>((resolve, reject) => {
            const req = request(
                {
                    host: "127.0.0.1",
                    port: server.port,
                    path: `/stream/${directId}`,
                    headers: { Host: "evil.example.com" },
                },
                (res) => {
                    res.resume();
                    resolve(res.statusCode ?? 0);
                },
            );
            req.on("error", reject);
            req.end();
        });
        expect(status).toBe(403);
    });
});

describe.skipIf(noFfmpeg)("piped paths", () => {
    it("remuxes an MKV into a fragmented MP4 body", async () => {
        const res = await fetch(server.urlFor(remuxId, 0, 1));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("video/mp4");
        // An open-ended pipe: no length, and not range-seekable.
        expect(res.headers.get("content-length")).toBeNull();
        expect(res.headers.get("accept-ranges")).toBe("none");

        const body = Buffer.from(await res.arrayBuffer());
        expect(body.length).toBeGreaterThan(0);
        // fMP4 always opens with an `ftyp` box.
        expect(body.subarray(4, 8).toString("latin1")).toBe("ftyp");
    });

    it("transcodes with the current settings", async () => {
        const res = await fetch(server.urlFor(transcodeId, 0, 2));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("video/mp4");
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.subarray(4, 8).toString("latin1")).toBe("ftyp");
    });

    it("answers HEAD without spawning an encoder", async () => {
        const res = await fetch(server.urlFor(remuxId), { method: "HEAD" });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("video/mp4");
        expect(await res.text()).toBe("");
    });

    it("releaseChannel stops the job, and a finished job frees its slot", async () => {
        const res = await fetch(server.urlFor(remuxId, 0, 9));
        await res.arrayBuffer();
        // The whole clip is one second long, so the job has already exited; the call
        // must still be safe (it is what a skip or channel change does).
        expect(() => server.releaseChannel(9)).not.toThrow();
    });

    it("serves H.264+AC3 down the remux pipe, encoding only the audio", async () => {
        const res = await fetch(server.urlFor(remuxAc3Id, 0, 11));
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("video/mp4");
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.subarray(4, 8).toString("latin1")).toBe("ftyp");
    });

    it("surfaces ffmpeg failure as a 500 rather than an empty 200", async () => {
        const broken = join(dir, "broken.mkv");
        writeFileSync(broken, Buffer.from("this is not a matroska file"));
        const id = insertEpisode(broken, "remux", "matroska,webm", 2, 1);
        const res = await fetch(server.urlFor(id));
        expect(res.status).toBe(500);
        expect(await res.text()).toMatch(/ffmpeg/i);
    });
});

/**
 * Phase 3 of docs/hwaccel-plan.html: the failures a startup probe cannot rule
 * out — a driver that refuses one particular profile, an exhausted encoder
 * session, a GPU unplugged since launch — must cost a beat of tune-in latency,
 * never a dead channel.
 *
 * The lever is a VAAPI device that does not exist. The probe report claims it
 * works, so the server builds a hardware command; ffmpeg then fails on
 * `-init_hw_device` before emitting a byte, which is precisely the window the
 * fallback lives in.
 */
describe.skipIf(noFfmpeg)("hardware fallback", () => {
    /** Select a backend for one request, then put the world back. */
    async function withAccel<T>(
        accel: AppSettings["hardwareAccel"],
        report: HwAccelReport,
        fn: () => Promise<T>,
    ): Promise<T> {
        settings = { ...DEFAULT_SETTINGS, hardwareAccel: accel };
        hwAccel = report;
        try {
            return await fn();
        } finally {
            settings = DEFAULT_SETTINGS;
            hwAccel = { vaapi: "failed", nvenc: "failed", vaapiDevice: null };
        }
    }

    const BOGUS: HwAccelReport = {
        vaapi: "ok",
        nvenc: "failed",
        vaapiDevice: "/dev/dri/definitely-not-a-render-node",
    };

    it("serves the episode on software when the hardware job dies at startup", async () => {
        await withAccel("vaapi", BOGUS, async () => {
            const res = await fetch(server.urlFor(transcodeId, 0, 31));
            expect(res.status).toBe(200);
            expect(res.headers.get("content-type")).toBe("video/mp4");
            const body = Buffer.from(await res.arrayBuffer());
            // A real fMP4 body, produced by the libx264 job that replaced the dead one.
            expect(body.subarray(4, 8).toString("latin1")).toBe("ftyp");
        });
    });

    it("leaves no orphaned job behind after a fallback", async () => {
        await withAccel("vaapi", BOGUS, async () => {
            const res = await fetch(server.urlFor(transcodeId, 0, 32));
            await res.arrayBuffer();
            // Both the failed hardware job and its software replacement are done; the
            // channel's slot must be empty, not holding a corpse.
            expect(
                server
                    .activeKeys()
                    .filter((key) => key.startsWith("channel:32:")),
            ).toEqual([]);
        });
    });

    /**
     * The fallback must not become a way for genuine errors to disappear: a file
     * ffmpeg cannot read fails on software too, and that is the message the user
     * needs to see.
     */
    it("still reports a real file error rather than masking it", async () => {
        await withAccel("vaapi", BOGUS, async () => {
            const broken = join(dir, "broken-hw.mkv");
            writeFileSync(
                broken,
                Buffer.from("this is not a matroska file either"),
            );
            const id = insertEpisode(
                broken,
                "transcode",
                "matroska,webm",
                3,
                1,
            );
            const res = await fetch(server.urlFor(id, 0, 33));
            expect(res.status).toBe(500);
            expect(await res.text()).toMatch(/ffmpeg/i);
        });
    });

    /** A remux never runs a video encoder, so a hardware selection cannot reach it. */
    it("does not touch the remux path", async () => {
        await withAccel("vaapi", BOGUS, async () => {
            const res = await fetch(server.urlFor(remuxId, 0, 34));
            expect(res.status).toBe(200);
            const body = Buffer.from(await res.arrayBuffer());
            expect(body.subarray(4, 8).toString("latin1")).toBe("ftyp");
        });
    });
});

/**
 * The arg builders are the whole of phase 1's cost model, so they are asserted
 * directly rather than only through a served response: what matters is that the
 * *video* is never handed to an encoder when Chromium could have decoded it.
 */
describe("remuxArgs", () => {
    const settings = { ...DEFAULT_SETTINGS, transcodeAudioBitrate: "192k" };

    it("copies both streams when the soundtrack is already playable", () => {
        const args = remuxArgs("/tv/ep.mkv", 0, true, settings);
        expect(args).toContain("-c");
        expect(args).toContain("copy");
        expect(args).not.toContain("aac");
        expect(args).not.toContain("libx264");
    });

    it("copies the video and encodes only the audio when it is not", () => {
        const args = remuxArgs("/tv/ep.mkv", 0, false, settings);
        const joined = args.join(" ");
        expect(joined).toContain("-c:v copy");
        expect(joined).toContain("-c:a aac");
        expect(joined).toContain("-b:a 192k");
        // The point of the whole exercise: no video encoder, ever, on this path.
        expect(args).not.toContain("libx264");
        expect(args).not.toContain("-crf");
    });

    it("keeps the fMP4 mux and the pre-input keyframe seek either way", () => {
        for (const audioOk of [true, false]) {
            const args = remuxArgs("/tv/ep.mkv", 90, audioOk, settings);
            expect(args.join(" ")).toContain(
                "-movflags frag_keyframe+empty_moov+default_base_moof",
            );
            expect(args.at(-1)).toBe("pipe:1");
            // `-ss` before `-i`, which is what makes the seek fast.
            expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
            expect(args[args.indexOf("-ss") + 1]).toBe("90");
        }
    });

    it("omits -ss entirely at position zero", () => {
        expect(remuxArgs("/tv/ep.mkv", 0, false, settings)).not.toContain(
            "-ss",
        );
    });

    /**
     * The mov muxer copies a source's chapters into a third, `text`-handler track.
     * Chromium's progressive demuxer ignores it; its MediaSource parser rejects the
     * whole init segment, which took out every chapter-marked rip until this flag
     * was added. Asserted on both piped paths because both feed the pump.
     */
    it("drops the source’s chapter track, which MediaSource will not parse", () => {
        for (const args of [
            remuxArgs("/tv/ep.mp4", 0, true, settings),
            remuxArgs("/tv/ep.mp4", 0, false, settings),
            transcodeArgs("/tv/ep.mkv", 0, settings),
        ]) {
            expect(args.join(" ")).toContain("-map_chapters -1");
        }
    });

    it("maps exactly one video and at most one audio track", () => {
        const joined = remuxArgs("/tv/ep.mkv", 0, true, settings).join(" ");
        expect(joined).toContain("-map 0:v:0");
        // `?` so a silent file still plays rather than failing the mux.
        expect(joined).toContain("-map 0:a:0?");
    });

    /**
     * AAC can only name seven channel layouts with a standard
     * `channelConfiguration`; anything else needs a Program Config Element, which
     * Chromium's MediaSource AAC parser refuses. An AC3 `5.1(side)` disc rip — very
     * ordinary — lands in exactly that hole.
     */
    it("constrains the AAC layout so no Program Config Element is emitted", () => {
        const encoding = remuxArgs("/tv/ep.mkv", 0, false, settings).join(" ");
        expect(encoding).toContain(
            "-af aformat=channel_layouts=mono|stereo|3.0|4.0|5.0|5.1|7.1",
        );
        expect(transcodeArgs("/tv/ep.mkv", 0, settings).join(" ")).toContain(
            "-af aformat=channel_layouts=",
        );
    });

    it("never puts a filter on a stream copy, which ffmpeg refuses", () => {
        const copying = remuxArgs("/tv/ep.mkv", 0, true, settings);
        expect(copying).not.toContain("-af");
        expect(copying.join(" ")).toContain("-c copy");
    });
});

describe("transcodeArgs", () => {
    it("is still the full re-encode, for the files that genuinely need one", () => {
        const args = transcodeArgs("/tv/ep.mkv", 0, DEFAULT_SETTINGS);
        const joined = args.join(" ");
        expect(joined).toContain("-c:v libx264");
        expect(joined).toContain(`-preset ${DEFAULT_SETTINGS.transcodePreset}`);
        expect(joined).toContain(`-crf ${DEFAULT_SETTINGS.transcodeCrf}`);
        expect(joined).toContain("-c:a aac");
    });
});

describe("FfmpegSupervisor", () => {
    /** A stand-in for a long-running ffmpeg: any child that stays alive will do. */
    function spawnSleeper(
        sup: FfmpegSupervisor,
        key: string,
    ): ReturnType<FfmpegSupervisor["spawn"]> {
        return sup.spawn(
            key,
            ["-e", "setTimeout(() => {}, 60000)"],
            process.execPath,
        );
    }

    it("runs one job per key — a second spawn kills the first", async () => {
        const sup = new FfmpegSupervisor();
        const first = spawnSleeper(sup, "channel:1");
        const died = new Promise<void>((resolve) =>
            first.once("exit", () => resolve()),
        );

        const second = spawnSleeper(sup, "channel:1");
        expect(second.pid).not.toBe(first.pid);

        await died;
        expect(first.killed).toBe(true);
        expect(sup.activeKeys()).toEqual(["channel:1"]);

        sup.killAll();
        await new Promise<void>((resolve) =>
            second.once("exit", () => resolve()),
        );
        expect(sup.activeKeys()).toEqual([]);
    });

    it("keeps separate keys independent", async () => {
        const sup = new FfmpegSupervisor();
        const a = spawnSleeper(sup, "channel:1");
        const b = spawnSleeper(sup, "channel:2");
        expect(sup.activeKeys().sort()).toEqual(["channel:1", "channel:2"]);

        sup.kill("channel:1");
        await new Promise<void>((resolve) => a.once("exit", () => resolve()));
        expect(sup.activeKeys()).toEqual(["channel:2"]);
        expect(b.exitCode).toBeNull();

        sup.killAll();
        await new Promise<void>((resolve) => b.once("exit", () => resolve()));
    });

    it("killIfCurrent ignores a stale child — a late disconnect can’t kill a new tune-in", async () => {
        const sup = new FfmpegSupervisor();
        const stale = spawnSleeper(sup, "channel:1");
        const current = spawnSleeper(sup, "channel:1"); // replaces `stale`
        await new Promise<void>((resolve) =>
            stale.once("exit", () => resolve()),
        );

        // This is what the request handler does when the abandoned request finally
        // emits 'close': it must be a no-op for the job that replaced it.
        sup.killIfCurrent("channel:1", stale);
        expect(current.exitCode).toBeNull();
        expect(sup.activeKeys()).toEqual(["channel:1"]);

        sup.killIfCurrent("channel:1", current);
        await new Promise<void>((resolve) =>
            current.once("exit", () => resolve()),
        );
        expect(sup.activeKeys()).toEqual([]);
    });

    /**
     * Key groups are what carry "at most N encoders per channel" now that a
     * channel legitimately owns two during a handoff (phase 3).
     */
    it("killByPrefix retires a whole channel, both of its jobs included", async () => {
        const sup = new FfmpegSupervisor();
        const onAir = spawnSleeper(sup, "channel:3:41");
        const prewarm = spawnSleeper(sup, "channel:3:42");
        const elsewhere = spawnSleeper(sup, "channel:4:41");

        sup.killByPrefix("channel:3:");
        await Promise.all(
            [onAir, prewarm].map(
                (child) =>
                    new Promise<void>((r) => child.once("exit", () => r())),
            ),
        );
        expect(sup.activeKeys()).toEqual(["channel:4:41"]);
        expect(elsewhere.exitCode).toBeNull();

        sup.killAll();
        await new Promise<void>((r) => elsewhere.once("exit", () => r()));
    });

    /**
     * Newest-wins, and by spawn order rather than by a millisecond clock: two jobs
     * can start inside the same millisecond, and a tie would make the choice
     * arbitrary — occasionally killing the stream that was just tuned in.
     */
    it("trimGroup kills the oldest jobs in a group, never the newest", async () => {
        const sup = new FfmpegSupervisor();
        const oldest = spawnSleeper(sup, "channel:3:41");
        const middle = spawnSleeper(sup, "channel:3:42");
        const newest = spawnSleeper(sup, "channel:3:43");
        const otherChannel = spawnSleeper(sup, "channel:9:41");

        sup.trimGroup("channel:3:", 2);
        await new Promise<void>((r) => oldest.once("exit", () => r()));

        expect(sup.activeKeys().sort()).toEqual([
            "channel:3:42",
            "channel:3:43",
            "channel:9:41",
        ]);
        expect(middle.exitCode).toBeNull();
        expect(newest.exitCode).toBeNull();
        expect(otherChannel.exitCode).toBeNull();

        // A re-spawn makes a key the newest again — which is what a seek does.
        spawnSleeper(sup, "channel:3:42");
        sup.trimGroup("channel:3:", 1);
        await new Promise<void>((r) => newest.once("exit", () => r()));
        expect(sup.activeKeys().sort()).toEqual([
            "channel:3:42",
            "channel:9:41",
        ]);

        sup.killAll();
    });

    it("trimGroup is a no-op below the limit", () => {
        const sup = new FfmpegSupervisor();
        spawnSleeper(sup, "channel:3:41");
        sup.trimGroup("channel:3:", 2);
        expect(sup.activeKeys()).toEqual(["channel:3:41"]);
        sup.killAll();
    });

    it("drops the slot when a job exits on its own", async () => {
        const sup = new FfmpegSupervisor();
        const child = sup.spawn(
            "one-shot",
            ["-e", "process.exit(0)"],
            process.execPath,
        );
        const code = await new Promise<number | null>((resolve) =>
            child.once("close", (c) => resolve(c)),
        );
        expect(code).toBe(0);
        expect(sup.activeKeys()).toEqual([]);
    });
});

describe.skipIf(noFfmpeg)("checkCodecs", () => {
    it("asserts H.264/AAC muxing against a generated asset", async () => {
        await expect(checkCodecs(ffmpeg.ffmpegPath)).resolves.toBe("ok");
    });

    it("is non-fatal when there is no ffmpeg at all", async () => {
        await expect(checkCodecs(null)).resolves.toBe("failed");
    });
});
