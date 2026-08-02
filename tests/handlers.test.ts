/**
 * IPC handler tests.
 *
 * This suite exists because of a specific blind spot. Every other suite reaches
 * the main process through either a repository/scheduler function directly, or
 * a *fake* bridge that restates what a handler is supposed to do — so a handler
 * that forgot to discard a reservation, broadcast an event, or release an
 * encoder would leave every one of them green. `handlers.ts` is the only glue
 * between the subsystems, and it was the only file none of them executed.
 *
 * These run the real `registerHandlers` against a real in-memory database, with
 * Electron aliased to the recording stub in `tests/helpers/electron.ts`. What is
 * asserted is *wiring*: which subsystem a channel reaches, what it broadcasts,
 * and what it does to scheduler state — not the behaviour of the subsystems
 * themselves, which have their own suites.
 */

import { type Db, openDatabase } from "@main/db/index.js";
import * as channelRepo from "@main/db/repositories/channels.js";
import { getSettings } from "@main/db/repositories/settings.js";
import { type HandlerContext, registerHandlers } from "@main/ipc/handlers.js";
import type { LoudnessScanner } from "@main/library/loudness.js";
import type { Scanner } from "@main/library/scanner.js";
import type { StreamServer } from "@main/stream/server.js";
import { EVENTS, IPC } from "@shared/ipc.js";
import type { ChannelDetail, NowPlaying } from "@shared/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import { seedFlatShow } from "./helpers/db.js";
import {
    invoke,
    registeredChannels,
    resetElectronStub,
    sentEvents,
} from "./helpers/electron.js";

/** Everything the handlers did to a subsystem, in order. */
let calls: string[] = [];

let db: Db;

/**
 * Recording stand-ins for the three subsystems the handlers drive.
 *
 * Deliberately dumb: each records the call and returns the least interesting
 * legal value. The point is to see *that* a handler reached the scanner or the
 * stream server, which is the wiring these tests are about — the scanner and the
 * server have their own suites for what those calls then do.
 */
function makeContext(): HandlerContext {
    const scanner = {
        scan: async () => {
            calls.push("scanner.scan");
        },
        startWatching: () => {
            calls.push("scanner.startWatching");
        },
        stopWatching: () => {
            calls.push("scanner.stopWatching");
        },
        pause: () => {
            calls.push("scanner.pause");
        },
        resume: () => {
            calls.push("scanner.resume");
        },
        getStatus: () => {
            calls.push("scanner.getStatus");
            return {
                state: "idle" as const,
                total: 0,
                done: 0,
                probed: 0,
                currentRoot: null,
                error: null,
            };
        },
    } as unknown as Scanner;

    const loudness = {
        start: () => {
            calls.push("loudness.start");
        },
        stop: () => {
            calls.push("loudness.stop");
        },
    } as unknown as LoudnessScanner;

    const stream = {
        port: 1234,
        urlFor: (episodeId: number, seekS?: number, channelId?: number) =>
            `http://127.0.0.1:1234/stream/${episodeId}?k=test&t=${seekS ?? 0}&ch=${channelId ?? 0}`,
        releaseChannel: (channelId: number) => {
            calls.push(`stream.releaseChannel:${channelId}`);
        },
        releaseEpisode: (channelId: number, episodeId: number) => {
            calls.push(`stream.releaseEpisode:${channelId}:${episodeId}`);
        },
        activeKeys: () => [],
        close: async () => undefined,
    } as unknown as StreamServer;

    return {
        db,
        scanner,
        loudness,
        stream,
        codecCheck: () => "ok",
        hwAccel: () => ({
            vaapi: "failed",
            nvenc: "failed",
            vaapiDevice: null,
        }),
        restart: async () => {
            calls.push("restart");
        },
    };
}

/** Channel names that were broadcast, in order. */
function broadcasts(): string[] {
    return sentEvents.map((e) => e.channel);
}

beforeEach(() => {
    resetElectronStub();
    calls = [];
    db = openDatabase(":memory:");
    registerHandlers(makeContext());
});

describe("registration", () => {
    /**
     * The contract's own promise: "the main process registers one `ipcMain.handle`
     * per channel". Nothing else checks it, and a channel the preload bridge
     * forwards to nothing fails at runtime as an unhandled-invoke error.
     */
    it("registers exactly the channels in the IPC table", () => {
        const expected = Object.values(IPC)
            .flatMap((group) => Object.values(group))
            .sort();
        expect(registeredChannels().sort()).toEqual(expected);
    });
});

describe("library handlers", () => {
    it("adding a root scans it and starts watching it", async () => {
        const roots = await invoke(IPC.library.addRoot, "/tv");

        expect(roots).toEqual([expect.objectContaining({ path: "/tv" })]);
        // The watcher call is the load-bearing one: without it a root added while
        // the app is running is not watched until the next launch.
        expect(calls).toContain("scanner.startWatching");
        expect(calls).toContain("scanner.scan");
    });

    it("removing a root reconciles the watcher too", async () => {
        const [root] = (await invoke(IPC.library.addRoot, "/tv")) as {
            id: number;
        }[];
        calls = [];

        const left = await invoke(IPC.library.removeRoot, root.id);

        expect(left).toEqual([]);
        expect(calls).toContain("scanner.startWatching");
        expect(broadcasts()).toContain(EVENTS.libraryChanged);
    });

    it("rescan(full) reaches the scanner without blocking the reply", async () => {
        await invoke(IPC.library.rescan, true);
        expect(calls).toContain("scanner.scan");
    });

    it("pause and resume reach the scanner", async () => {
        await invoke(IPC.library.pauseScan);
        await invoke(IPC.library.resumeScan);
        expect(calls).toEqual(["scanner.pause", "scanner.resume"]);
    });
});

describe("channel handlers", () => {
    it("create/update/remove broadcast so every open surface re-reads", async () => {
        const channel = (await invoke(IPC.channels.create, {
            name: "Late Night",
            number: 7,
        })) as { id: number };
        expect(broadcasts()).toEqual([EVENTS.channelsChanged]);

        await invoke(IPC.channels.update, channel.id, { name: "Graveyard" });
        await invoke(IPC.channels.remove, channel.id);

        expect(broadcasts()).toEqual([
            EVENTS.channelsChanged,
            EVENTS.channelsChanged,
            EVENTS.channelsChanged,
        ]);
        // Deleting a channel must take its encoders with it.
        expect(calls).toContain(`stream.releaseChannel:${channel.id}`);
    });

    it("reports a taken dial number in words the viewer can act on", async () => {
        await invoke(IPC.channels.create, { name: "One", number: 3 });
        await expect(
            invoke(IPC.channels.create, { name: "Two", number: 3 }),
        ).rejects.toThrow("Channel 3 is already taken.");
    });

    it("refuses a nonsense weight rather than storing it", async () => {
        const showId = seedFlatShow(db, "Show", 3);
        const channel = (await invoke(IPC.channels.create, {
            name: "Ch",
        })) as { id: number };
        await invoke(IPC.channels.addShow, channel.id, showId);

        await expect(
            invoke(IPC.channels.setWeight, channel.id, showId, -1),
        ).rejects.toThrow(/positive number/);
    });
});

describe("player handlers", () => {
    /** A channel with one show, ready to tune. */
    function seedChannel(episodes = 4): { channelId: number; showId: number } {
        const showId = seedFlatShow(db, "Cheers", episodes);
        const channel = channelRepo.createChannel(db, "Ch", 1);
        channelRepo.addChannelShow(db, channel.id, showId);
        return { channelId: channel.id, showId };
    }

    it("tune commits a pick and releases the channel's old encoders first", async () => {
        const { channelId } = seedChannel();

        const now = (await invoke(IPC.player.tune, channelId)) as NowPlaying;

        expect(now.channelId).toBe(channelId);
        expect(now.streamUrl).toContain(`/stream/${now.episode.id}`);
        expect(calls).toContain(`stream.releaseChannel:${channelId}`);
        // Committed, not peeked: tuning in spends a schedule step and logs it.
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM play_log WHERE episode_id = ?",
                )
                .get(now.episode.id),
        ).toEqual({ n: 1 });
    });

    it("release drops the reservation as well as the encoder", async () => {
        const { channelId } = seedChannel();
        await invoke(IPC.player.tune, channelId);
        const reserved = (await invoke(
            IPC.player.prewarmNext,
            channelId,
        )) as NowPlaying;
        calls = [];

        await invoke(IPC.player.release, channelId, reserved.episode.id);

        expect(calls).toContain(
            `stream.releaseEpisode:${channelId}:${reserved.episode.id}`,
        );
        // The reservation is gone, so the next prewarm plans afresh rather than
        // handing back the same parked pick.
        const again = (await invoke(
            IPC.player.prewarmNext,
            channelId,
        )) as NowPlaying;
        expect(again).not.toBeNull();
    });

    /**
     * The invariant `tests/handoff.test.ts` asserts through a fake bridge, checked
     * here against the real handlers: one play-log entry per episode watched, even
     * though promotion and the end-report are separate calls.
     */
    it("promoteNext commits the reserved pick exactly once", async () => {
        const { channelId } = seedChannel();
        const first = (await invoke(IPC.player.tune, channelId)) as NowPlaying;
        const reserved = (await invoke(
            IPC.player.prewarmNext,
            channelId,
        )) as NowPlaying;

        await invoke(IPC.player.reportEnded, channelId, first.episode.id, true);
        await invoke(IPC.player.promoteNext, channelId, reserved.episode.id);

        const airings = db
            .prepare(
                "SELECT episode_id, COUNT(*) AS n FROM play_log GROUP BY episode_id",
            )
            .all() as { episode_id: number; n: number }[];
        for (const row of airings) expect(row.n).toBe(1);
    });
});

describe("settings handlers", () => {
    it("toggling watchFolders drives the scanner immediately", async () => {
        await invoke(IPC.settings.set, "watchFolders", false);
        expect(calls).toContain("scanner.stopWatching");

        calls = [];
        await invoke(IPC.settings.set, "watchFolders", true);
        expect(calls).toContain("scanner.startWatching");
    });

    it("toggling loudnessEq starts and stops the measuring job", async () => {
        await invoke(IPC.settings.set, "loudnessEq", true);
        expect(calls).toContain("loudness.start");

        calls = [];
        await invoke(IPC.settings.set, "loudnessEq", false);
        expect(calls).toContain("loudness.stop");
    });

    it("refuses a key that isn't a real setting", async () => {
        await expect(
            invoke(IPC.settings.set, "lastRestoreReceipt", "hi"),
        ).rejects.toThrow(/Unknown setting/);
        expect(getSettings(db)).not.toHaveProperty("lastRestoreReceipt");
    });
});

describe("error propagation", () => {
    /**
     * The wrapper's whole job: a thrown error must cross as its own message, not
     * as Electron's "Error invoking remote method".
     */
    it("forwards the handler's message, not an opaque IPC one", async () => {
        await expect(invoke(IPC.channels.get, 999)).resolves.toBeNull();
        await expect(
            invoke(IPC.channels.addShow, 999, 999),
        ).rejects.not.toThrow(/invoking remote method/);
    });

    it("returns null for a channel that does not exist", async () => {
        const detail = (await invoke(
            IPC.channels.get,
            404,
        )) as ChannelDetail | null;
        expect(detail).toBeNull();
    });
});
