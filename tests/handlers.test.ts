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
import type {
    MetadataService,
    ProviderEpisode,
} from "@main/services/metadata.js";
import type { StreamServer } from "@main/stream/server.js";
import { EVENTS, IPC } from "@shared/ipc.js";
import type {
    ChannelDetail,
    FfmpegState,
    MetadataPlan,
    NowPlaying,
} from "@shared/types.js";
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

/** What the fake provider answers `fetchEpisodes` with; per-test. */
let providerEpisodes: ProviderEpisode[] = [];

/** Set by the test for the second, non-load-bearing provider call failing. */
let providerNameFails = false;

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

    // The TVmaze client, replaced by a fixture. The handlers' own suite is about
    // wiring, so what matters here is that preview reaches the provider at all
    // and that apply reaches it never — the client's behaviour is
    // tests/metadata.test.ts.
    const metadata = {
        search: async (query: string) => {
            calls.push(`metadata.search:${query}`);
            return [
                {
                    providerShowId: "3182",
                    name: "Gargoyles",
                    premiered: "1994-10-24",
                    year: 1994,
                    network: "Syndication",
                    status: "Ended",
                },
            ];
        },
        fetchEpisodes: async (providerShowId: string) => {
            calls.push(`metadata.fetchEpisodes:${providerShowId}`);
            return providerEpisodes;
        },
        fetchShowName: async (providerShowId: string) => {
            calls.push(`metadata.fetchShowName:${providerShowId}`);
            if (providerNameFails)
                throw new Error("TVmaze returned HTTP 503 — try again");
            return "Gargoyles";
        },
    } satisfies MetadataService;

    return {
        db,
        scanner,
        loudness,
        stream,
        metadata,
        codecCheck: () => "ok",
        hwAccel: () => ({
            vaapi: "failed",
            nvenc: "failed",
            vaapiDevice: null,
        }),
        onFfmpegChanged: () => {
            calls.push("onFfmpegChanged");
        },
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
    providerEpisodes = [];
    providerNameFails = false;
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

describe("metadata handlers", () => {
    /** The show the fake provider knows: 3 episodes in season 1. */
    function seedLinkable(): { showId: number; episodeIds: number[] } {
        const showId = seedFlatShow(db, "Gargoyles", 3);
        providerEpisodes = [
            { season: 1, number: 1, name: "Awakening" },
            { season: 1, number: 2, name: "The Thrill of the Hunt" },
            { season: 1, number: 3, name: "Temptation" },
        ];
        const episodeIds = (
            db
                .prepare(
                    "SELECT id FROM episodes WHERE show_id = ? ORDER BY id",
                )
                .all(showId) as { id: number }[]
        ).map((r) => r.id);
        return { showId, episodeIds };
    }

    const preview = (showId: number) =>
        invoke(IPC.library.previewMetadata, {
            showId,
            providerShowId: "3182",
        }) as Promise<MetadataPlan>;

    it("search reaches the provider and writes nothing", async () => {
        await invoke(IPC.library.searchMetadata, "gargoyles");

        expect(calls).toContain("metadata.search:gargoyles");
        expect(broadcasts()).toEqual([]);
    });

    /**
     * The load-bearing half of the preview/apply split: a preview the user backs
     * out of must leave the library exactly as it found it.
     */
    it("preview computes a plan without writing anything", async () => {
        const { showId } = seedLinkable();

        const plan = await preview(showId);

        expect(plan.displayTitle).toBe("Gargoyles");
        expect(plan.episodes).toHaveLength(3);
        expect(plan.matchedCount).toBe(3);
        const show = db
            .prepare(
                "SELECT display_title, metadata_id FROM shows WHERE id = ?",
            )
            .get(showId) as { display_title: string | null };
        expect(show.display_title).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM episodes WHERE metadata_title IS NOT NULL",
                )
                .get() as { n: number },
        ).toEqual({ n: 0 });
        expect(broadcasts()).toEqual([]);
    });

    /**
     * The name is a second, smaller request behind the episode list, and only
     * the list is load-bearing: a preview holding every title the user asked for
     * must not be thrown away because `/shows/:id` 503'd. The show keeps the
     * title it already had.
     */
    it("preview survives the show-name lookup failing", async () => {
        const { showId } = seedLinkable();
        providerNameFails = true;

        const plan = await preview(showId);

        expect(plan.displayTitle).toBe("Gargoyles");
        expect(plan.episodes).toHaveLength(3);
    });

    it("apply writes the plan in one go and tells every screen", async () => {
        const { showId } = seedLinkable();
        const plan = await preview(showId);

        await invoke(IPC.library.applyMetadata, plan);

        const show = db
            .prepare(
                "SELECT display_title, metadata_source, metadata_id FROM shows WHERE id = ?",
            )
            .get(showId);
        expect(show).toEqual({
            display_title: "Gargoyles",
            metadata_source: "tvmaze",
            metadata_id: "3182",
        });
        expect(
            db
                .prepare(
                    "SELECT metadata_title FROM episodes WHERE show_id = ? ORDER BY episode",
                )
                .all(showId),
        ).toEqual([
            { metadata_title: "Awakening" },
            { metadata_title: "The Thrill of the Hunt" },
            { metadata_title: "Temptation" },
        ]);
        expect(broadcasts()).toEqual([EVENTS.libraryChanged]);
        // Apply is offline by contract — a preview on screen stays appliable
        // after the connection drops.
        expect(calls.filter((c) => c.startsWith("metadata."))).toEqual([
            "metadata.fetchEpisodes:3182",
            "metadata.fetchShowName:3182",
        ]);
    });

    /**
     * A scan can run between preview and apply. The ids that vanished are
     * dropped and the rest still land: a stale plan shrinks, never corrupts, and
     * never writes into a show it doesn't name.
     */
    it("apply drops episode ids that no longer belong to the show", async () => {
        const { showId, episodeIds } = seedLinkable();
        const otherShowId = seedFlatShow(db, "Goliath Chronicles", 1);
        const strayId = (
            db
                .prepare("SELECT id FROM episodes WHERE show_id = ?")
                .get(otherShowId) as { id: number }
        ).id;
        const plan = await preview(showId);
        db.prepare("DELETE FROM episodes WHERE id = ?").run(episodeIds[1]);

        await invoke(IPC.library.applyMetadata, {
            ...plan,
            episodes: [
                ...plan.episodes,
                { episodeId: strayId, title: "Not Yours" },
            ],
        });

        expect(
            db
                .prepare("SELECT metadata_title FROM episodes WHERE id = ?")
                .get(strayId),
        ).toEqual({ metadata_title: null });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM episodes WHERE show_id = ? AND metadata_title IS NOT NULL",
                )
                .get(showId),
        ).toEqual({ n: 2 });
    });

    /**
     * An apply replaces the link outright rather than merging into it. Linking
     * the same folder to a *different* series — the fix for a mis-picked
     * candidate — has to leave every row the new plan doesn't name back on its
     * filename title, or the show ends up wearing two providers' titles at once
     * with nothing on screen to explain which is which.
     */
    it("re-apply clears titles the new plan does not cover", async () => {
        const { showId, episodeIds } = seedLinkable();
        await invoke(IPC.library.applyMetadata, await preview(showId));

        // Series B: same show row, a provider that only knows episode one.
        await invoke(IPC.library.applyMetadata, {
            showId,
            provider: "tvmaze",
            providerShowId: "999",
            displayTitle: "Gargoyles: The Goliath Chronicles",
            episodes: [{ episodeId: episodeIds[0], title: "The Journey" }],
            matchedCount: 1,
            multiCount: 0,
            unmatchedCount: 2,
        } satisfies MetadataPlan);

        expect(
            db
                .prepare(
                    "SELECT metadata_title FROM episodes WHERE show_id = ? ORDER BY id",
                )
                .all(showId),
        ).toEqual([
            { metadata_title: "The Journey" },
            { metadata_title: null },
            { metadata_title: null },
        ]);
        expect(
            db
                .prepare("SELECT display_title FROM shows WHERE id = ?")
                .get(showId),
        ).toEqual({ display_title: "Gargoyles: The Goliath Chronicles" });
    });

    /**
     * The transaction, actually exercised rather than asserted about.
     *
     * A title of the wrong *type* is the cheapest real mid-apply failure: the
     * show row and the clear have already been written when better-sqlite3
     * refuses to bind the second pair, so if the two halves were not one unit
     * the show would be left pointing at a provider whose titles never landed —
     * exactly the state Refresh cannot explain. Nothing may survive.
     */
    it("a failure mid-apply rolls back the show row too", async () => {
        const { showId, episodeIds } = seedLinkable();
        await invoke(IPC.library.applyMetadata, await preview(showId));

        await expect(
            invoke(IPC.library.applyMetadata, {
                showId,
                provider: "tvmaze",
                providerShowId: "999",
                displayTitle: "Never Written",
                episodes: [
                    { episodeId: episodeIds[0], title: "The Journey" },
                    // Not a string: the bind throws part-way through the loop.
                    {
                        episodeId: episodeIds[1],
                        title: {} as unknown as string,
                    },
                ],
                matchedCount: 2,
                multiCount: 0,
                unmatchedCount: 1,
            } satisfies MetadataPlan),
        ).rejects.toThrow();

        // Both halves are as the first apply left them — no new display title,
        // and the old provider's episode titles still in place.
        expect(
            db
                .prepare(
                    "SELECT display_title, metadata_id FROM shows WHERE id = ?",
                )
                .get(showId),
        ).toEqual({ display_title: "Gargoyles", metadata_id: "3182" });
        expect(
            db
                .prepare(
                    "SELECT metadata_title FROM episodes WHERE show_id = ? ORDER BY id",
                )
                .all(showId),
        ).toEqual([
            { metadata_title: "Awakening" },
            { metadata_title: "The Thrill of the Hunt" },
            { metadata_title: "Temptation" },
        ]);
    });

    it("unlink puts everything back and tells every screen", async () => {
        const { showId } = seedLinkable();
        await invoke(IPC.library.applyMetadata, await preview(showId));
        sentEvents.length = 0; // the apply's own broadcast, out of the way

        await invoke(IPC.library.unlinkMetadata, showId);

        expect(
            db
                .prepare(
                    "SELECT display_title, metadata_source, metadata_id FROM shows WHERE id = ?",
                )
                .get(showId),
        ).toEqual({
            display_title: null,
            metadata_source: null,
            metadata_id: null,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM episodes WHERE show_id = ? AND metadata_title IS NOT NULL",
                )
                .get(showId),
        ).toEqual({ n: 0 });
        expect(broadcasts()).toContain(EVENTS.libraryChanged);
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

describe("managed ffmpeg handlers", () => {
    /**
     * The two answers must be reported separately, because they genuinely
     * disagree: `RERUN_FFMPEG_PATH` is set on this very test run, so the active
     * binary is the system's while a managed copy could still be sitting on disk.
     * A card that folded them together would tell someone with an update waiting
     * that nothing was installed.
     */
    it("reports the active binary and the managed copy as separate facts", async () => {
        const state = (await invoke(IPC.system.getFfmpegState)) as FfmpegState;

        expect(state).toMatchObject({
            source: expect.stringMatching(/^(managed|system|bundled|missing)$/),
        });
        expect(state).toHaveProperty("managed");
        expect(state).toHaveProperty("downloadable");
    });

    /**
     * The gate polls this every five seconds while it is open. Re-probing on
     * every tick would spawn two ffmpeg processes a second behind the modal, so
     * the notification is conditional on the path having actually moved — and on
     * a machine where nothing changed, it must not fire at all.
     */
    it("does not re-probe when a re-check finds the same binary", async () => {
        await invoke(IPC.system.recheckFfmpeg);
        expect(calls).not.toContain("onFfmpegChanged");
    });

    it("tells the app to re-probe after removing the managed copy", async () => {
        await invoke(IPC.system.removeManagedFfmpeg);
        // Unconditional here, unlike the re-check: removal always changes which
        // binary the next spawn will use, even when it changes it to nothing.
        expect(calls).toContain("onFfmpegChanged");
    });

    it("cancelling with nothing running is a no-op rather than an error", async () => {
        await expect(
            invoke(IPC.system.cancelFfmpegInstall),
        ).resolves.toBeUndefined();
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
