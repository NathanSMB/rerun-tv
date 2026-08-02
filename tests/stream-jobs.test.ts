/**
 * Encoder job bookkeeping (docs/stall-fix-plan.html, phase 3).
 *
 * Plan §6's original invariant was "never more than one ffmpeg job per channel".
 * The gapless handoff relaxes it to two — the episode on air plus the one
 * prewarming behind it — which is a change to the one rule that stops the app
 * leaving encoders running on somebody's machine. So it gets tested against a
 * real listener, with real child processes.
 *
 * `RERUN_FFMPEG_PATH` points at a stub that emits one chunk and then *never
 * exits*, because that is the only way to hold several jobs open at once and look
 * at them: the real fixtures are one-second clips that a stream copy finishes
 * before the assertion runs. It lives in its own file so the stub cannot leak
 * into the suites that want the genuine binary.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, openDatabase } from "@main/db/index.js";
import { resetFfmpegCache } from "@main/stream/ffmpeg.js";
import { type StreamServer, startStreamServer } from "@main/stream/server.js";
import { DEFAULT_SETTINGS } from "@shared/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * A stand-in for ffmpeg. Writes a plausible `ftyp` box — the stream server holds
 * the response open until the first byte arrives, so it has to write *something*
 * — and then stays alive until it is killed, which is what makes the job table
 * observable.
 */
const STUB = `#!/usr/bin/env node
if (process.argv.includes('-version')) {
  process.stdout.write('ffmpeg version n0.0-stub\\n')
  process.exit(0)
}
const ftyp = Buffer.from([0, 0, 0, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])
process.stdout.write(ftyp)
setInterval(() => {}, 3600000)
`;

let dir: string;
let db: Db;
let server: StreamServer;
/** Live requests, kept open so their jobs stay in the supervisor. */
const open: AbortController[] = [];

function insertEpisode(episode: number): number {
    return Number(
        db
            .prepare(
                `INSERT INTO episodes (show_id, season, episode, path, duration_s, container, vcodec, acodec, playback_path)
         VALUES (1, 1, ?, ?, 1320, 'matroska', 'h264', 'ac3', 'remux')`,
            )
            .run(episode, join(dir, `S01E${episode}.mkv`)).lastInsertRowid,
    );
}

/**
 * Start a stream and leave it running. Resolves once the first chunk has landed,
 * which is also the point at which the job is definitely registered.
 */
async function openStream(
    episodeId: number,
    channelId?: number,
    seekS = 0,
): Promise<void> {
    const controller = new AbortController();
    open.push(controller);
    const response = await fetch(server.urlFor(episodeId, seekS, channelId), {
        signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await response.body!.getReader().read();
}

let e1 = 0;
let e2 = 0;
let e3 = 0;
/** The last case closes the server itself; `close()` twice throws. */
let closed = false;

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "rerun-jobs-"));
    const stub = join(dir, "fake-ffmpeg");
    writeFileSync(stub, STUB);
    chmodSync(stub, 0o755);
    process.env.RERUN_FFMPEG_PATH = stub;
    resetFfmpegCache();

    db = openDatabase(":memory:");
    db.prepare(
        "INSERT INTO shows (id, title, folder_path, added_at) VALUES (1, ?, ?, 0)",
    ).run("Stub Show", dir);
    e1 = insertEpisode(1);
    e2 = insertEpisode(2);
    e3 = insertEpisode(3);

    server = await startStreamServer({
        db,
        getSettings: () => DEFAULT_SETTINGS,
    });
});

/**
 * Every case gets the job table to itself.
 *
 * These used to run as one long story — case 2 asserted on the job case 1 had
 * left behind — so `.only`, a reorder, or a failure early on turned the rest into
 * noise about state that was never set up. Hanging up on this case's requests and
 * waiting for the supervisor to notice is the same teardown a closing window
 * performs, and it leaves the next case a clean slate.
 */
afterEach(async () => {
    for (const controller of open.splice(0)) controller.abort();
    if (closed) return;
    const deadline = Date.now() + 5000;
    while (server.activeKeys().length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(server.activeKeys()).toEqual([]);
});

afterAll(async () => {
    for (const controller of open) controller.abort();
    if (!closed) await server.close();
    db.close();
    delete process.env.RERUN_FFMPEG_PATH;
    resetFfmpegCache();
    rmSync(dir, { recursive: true, force: true });
});

describe("job keys", () => {
    it("names a slot by channel *and* episode, so a handoff needs no coordination", async () => {
        await openStream(e1, 7);
        expect(server.activeKeys()).toEqual([`channel:7:${e1}`]);
    });

    it("lets a channel hold the episode on air and the one prewarming behind it", async () => {
        await openStream(e1, 7);
        await openStream(e2, 7);
        expect(server.activeKeys().sort()).toEqual([
            `channel:7:${e1}`,
            `channel:7:${e2}`,
        ]);
    });

    it("replaces a job in place on a seek — same channel, same episode", async () => {
        await openStream(e1, 7);
        await openStream(e2, 7);

        await openStream(e1, 7, 120);

        // Still two: the seek took over episode 1's own slot rather than opening a third.
        expect(server.activeKeys().sort()).toEqual([
            `channel:7:${e1}`,
            `channel:7:${e2}`,
        ]);
    });

    it("caps a channel at two, retiring the oldest", async () => {
        await openStream(e1, 7);
        await openStream(e2, 7);
        // The seek refreshes episode 1's slot, which is what makes episode 2 the
        // oldest — the ordering the cap is about, so it is set up here rather than
        // inherited from the case above.
        await openStream(e1, 7, 120);

        await openStream(e3, 7);

        const keys = server.activeKeys();
        expect(keys).toHaveLength(2);
        expect(keys.sort()).toEqual([`channel:7:${e1}`, `channel:7:${e3}`]);
    });

    it("releaseEpisode drops one job and leaves the channel’s other one alone", async () => {
        await openStream(e1, 7);
        await openStream(e3, 7);

        server.releaseEpisode(7, e1);

        expect(server.activeKeys()).toEqual([`channel:7:${e3}`]);
    });

    it("releaseChannel drops everything the channel owns", async () => {
        await openStream(e1, 7);
        await openStream(e2, 7);
        expect(server.activeKeys()).toHaveLength(2);

        server.releaseChannel(7);

        expect(server.activeKeys()).toEqual([]);
    });

    it("keeps channels independent", async () => {
        await openStream(e1, 11);
        await openStream(e2, 12);
        expect(server.activeKeys().sort()).toEqual([
            `channel:11:${e1}`,
            `channel:12:${e2}`,
        ]);

        server.releaseChannel(11);
        expect(server.activeKeys()).toEqual([`channel:12:${e2}`]);
        server.releaseChannel(12);
    });

    it("kills the encoder when the client hangs up", async () => {
        // The one thing standing between a skipped episode and an ffmpeg running
        // forever is `req.on("close") -> supervisor.killIfCurrent(...)`. Nothing
        // else in this suite notices if that line goes: every other case tears jobs
        // down through `releaseChannel`/`releaseEpisode`/`close()`, which are
        // explicit calls the renderer only makes on the tidy paths. A window
        // closing, a channel change, a crashed renderer — all of those are just the
        // socket going away, and this is the test for that.
        const controller = new AbortController();
        const response = await fetch(server.urlFor(e1, 0, 31), {
            signal: controller.signal,
        });
        expect(response.status).toBe(200);
        await response.body!.getReader().read();
        expect(server.activeKeys()).toContain(`channel:31:${e1}`);

        controller.abort();

        // The close event is asynchronous, so poll rather than assert once — but
        // bounded, because "eventually" here means milliseconds and a hang is
        // exactly the failure being tested for.
        const deadline = Date.now() + 5000;
        while (server.activeKeys().length > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(server.activeKeys()).toEqual([]);
    });

    it("does not apply the channel cap to a request with no channel slot", async () => {
        // No `?ch=`: a preview or a direct URL, keyed by episode and not part of any
        // channel's budget.
        await openStream(e1);
        await openStream(e2);
        await openStream(e3);
        expect(server.activeKeys().sort()).toEqual([
            `episode:${e1}`,
            `episode:${e2}`,
            `episode:${e3}`,
        ]);
    });

    it("leaves no encoder behind when the server closes", async () => {
        await openStream(e1, 21);
        expect(server.activeKeys().length).toBeGreaterThan(0);
        await server.close();
        closed = true;
        expect(server.activeKeys()).toEqual([]);
    });
});
