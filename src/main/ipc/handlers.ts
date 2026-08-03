/**
 * The main-process side of the IPC contract.
 *
 * One `ipcMain.handle` per channel in `IPC`, in the same order as the
 * `RerunApi` interface. There is deliberately almost no logic here — handlers
 * translate an IPC call into a call on the library, scheduler, or stream
 * subsystem and hand back a view model. Anything that looks like a decision
 * belongs in `services/` or `scheduler/`, not in this file.
 *
 * Every handler is wrapped so a thrown error crosses the bridge as a readable
 * message instead of an opaque `Error invoking remote method`.
 */

import { copyFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { EVENTS, IPC } from "../../shared/ipc.js";
import type {
    AppSettings,
    AssignUnmatchedInput,
    ChannelDetail,
    CreateArcInput,
    CreateChannelInput,
    EpisodeView,
    NowPlaying,
    PlayMode,
    ScanStatus,
    SystemInfo,
    UpdateChannelInput,
} from "../../shared/types.js";
import type { Db } from "../db/index.js";
import * as channelRepo from "../db/repositories/channels.js";
import * as libraryRepo from "../db/repositories/library.js";
import { getSettings, setSetting } from "../db/repositories/settings.js";
import type { LoudnessScanner } from "../library/loudness.js";
import type { Scanner } from "../library/scanner.js";
import {
    backupsDir,
    databasePath,
    stagedImportMetaPath,
    stagedImportPath,
} from "../paths.js";
import {
    discardReserved,
    peekNext,
    pickNext,
    promoteReserved,
    reserveNext,
    resetProgress,
    validateActiveArc,
} from "../scheduler/scheduler.js";
import {
    getChannelDetail,
    listChannelSummaries,
    toEpisodeView,
} from "../services/channels.js";
import { assignUnmatched, getLibraryOverview } from "../services/library.js";
import {
    discardStagedImport,
    getRestoreReceipt,
    inspectAndStage,
} from "../services/restore.js";
import { resolveFfmpeg } from "../stream/ffmpeg.js";
import type { StreamServer } from "../stream/server.js";

export interface HandlerContext {
    db: Db;
    scanner: Scanner;
    /** The background loudness measuring job, started/stopped with its setting. */
    loudness: LoudnessScanner;
    stream: StreamServer;
    /** Resolved once at startup; `pending` until the check finishes. */
    codecCheck: () => SystemInfo["codecCheck"];
    /** Likewise for the GPU probe — `pending` reads as "use software for now". */
    hwAccel: () => SystemInfo["hwAccel"];
    /** Tear down every subsystem and relaunch — how an import is finished. */
    restart: () => Promise<void>;
}

/** Broadcast a push event to every open window. */
export function broadcast(channel: string, payload?: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, payload);
    }
}

/**
 * Assemble a `NowPlaying` from a committed scheduler pick.
 *
 * The `?ch=` parameter is what lets the stream server enforce the plan's
 * "never more than one ffmpeg job per channel" rule — it tells the supervisor
 * which job slot this request belongs to.
 */
function toNowPlaying(
    ctx: HandlerContext,
    channelId: number,
    episodeId: number,
    arc: NowPlaying["arc"],
): NowPlaying | null {
    const channel = channelRepo.getChannel(ctx.db, channelId);
    const episode = toEpisodeView(ctx.db, episodeId);
    if (!channel || !episode) return null;

    return {
        channelId: channel.id,
        channelNumber: channel.number,
        channelName: channel.name,
        episode,
        // No seek: tuning in always starts an episode from the top
        // (docs/ui.md, "Player").
        streamUrl: ctx.stream.urlFor(episodeId, 0, channelId),
        arc,
    };
}

export function registerHandlers(ctx: HandlerContext): void {
    const { db } = ctx;

    const handle = (
        channel: string,
        fn: (...args: never[]) => unknown,
    ): void => {
        ipcMain.handle(channel, async (_event, ...args) => {
            try {
                return await (fn as (...a: unknown[]) => unknown)(...args);
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : String(err);
                console.error(`[ipc] ${channel} failed:`, err);
                throw new Error(message);
            }
        });
    };

    const ffprobePath = (): string => {
        const { ffprobePath: path } = resolveFfmpeg();
        if (!path)
            throw new Error(
                "ffprobe not found — install ffmpeg (pacman -S ffmpeg)",
            );
        return path;
    };

    // ---- library ------------------------------------------------------------

    handle(IPC.library.getOverview, () => getLibraryOverview(db));
    handle(IPC.library.listShows, () => libraryRepo.listShows(db));
    handle(IPC.library.listEpisodes, (showId: number) =>
        libraryRepo.listEpisodes(db, showId),
    );
    handle(IPC.library.listRoots, () => libraryRepo.listScanRoots(db));

    handle(IPC.library.addRoot, (path: string) => {
        libraryRepo.addScanRoot(db, path);
        void ctx.scanner.scan();
        ctx.scanner.startWatching();
        return libraryRepo.listScanRoots(db);
    });

    handle(IPC.library.removeRoot, (rootId: number) => {
        libraryRepo.removeScanRoot(db, rootId);
        // Reconcile the watcher too, or the removed root keeps producing events
        // for a library that no longer claims it.
        ctx.scanner.startWatching();
        broadcast(EVENTS.libraryChanged);
        return libraryRepo.listScanRoots(db);
    });

    // Fire-and-forget: the scan reports itself through the progress event, so the
    // renderer's button doesn't sit disabled for the length of a full pass.
    handle(IPC.library.rescan, (full?: boolean) => {
        void ctx.scanner.scan(full ?? false);
    });
    handle(IPC.library.pauseScan, () => ctx.scanner.pause());
    handle(IPC.library.resumeScan, () => ctx.scanner.resume());
    handle(
        IPC.library.getScanStatus,
        (): ScanStatus => ctx.scanner.getStatus(),
    );

    handle(IPC.library.assignUnmatched, async (input: AssignUnmatchedInput) => {
        await assignUnmatched(db, input, ffprobePath());
        broadcast(EVENTS.libraryChanged);
    });

    handle(IPC.library.dismissUnmatched, (fileId: number) => {
        libraryRepo.removeUnmatched(db, fileId);
        broadcast(EVENTS.libraryChanged);
    });

    handle(IPC.library.listArcs, (showId: number) =>
        libraryRepo.listArcs(db, showId),
    );

    handle(IPC.library.createArc, (input: CreateArcInput) => {
        const arc = libraryRepo.createArc(
            db,
            input.showId,
            input.title,
            input.episodeIds,
            "manual",
        );
        broadcast(EVENTS.libraryChanged);
        return arc;
    });

    handle(IPC.library.deleteArc, (groupId: number) => {
        libraryRepo.deleteArc(db, groupId);
        broadcast(EVENTS.libraryChanged);
    });

    // ---- channels -----------------------------------------------------------

    const channelsChanged = <T>(value: T): T => {
        broadcast(EVENTS.channelsChanged);
        return value;
    };

    /**
     * An edit to a channel's lineup, plus the reply every lineup mutation sends.
     *
     * The `discardReserved` is the load-bearing part. A prewarm reservation holds
     * a cursor/bag computed under the *old* rules; if the user changes a mode
     * mid-prewarm the repository clears the bag, and promoting the stale
     * reservation would write the old-rules bag straight back over it. The
     * episode-id guard in `promoteReserved` doesn't catch this, because the
     * pick itself is usually unchanged — only the state behind it is. Dropping
     * the reservation costs one replan at handoff and keeps the edit authoritative.
     */
    const lineupEdited = (channelId: number): ChannelDetail | null => {
        discardReserved(db, channelId);
        return channelsChanged(getChannelDetail(db, channelId));
    };

    handle(IPC.channels.list, () => listChannelSummaries(db));
    handle(IPC.channels.get, (channelId: number) =>
        getChannelDetail(db, channelId),
    );

    handle(IPC.channels.create, (input: CreateChannelInput) =>
        channelsChanged(
            channelRepo.createChannel(db, input.name, input.number),
        ),
    );
    handle(
        IPC.channels.update,
        (channelId: number, patch: UpdateChannelInput) =>
            channelsChanged(channelRepo.updateChannel(db, channelId, patch)),
    );
    handle(IPC.channels.remove, (channelId: number) => {
        ctx.stream.releaseChannel(channelId);
        channelRepo.deleteChannel(db, channelId);
        channelsChanged(null);
    });
    handle(IPC.channels.reorder, (channelIds: number[]) =>
        channelsChanged(channelRepo.reorderChannels(db, channelIds)),
    );

    handle(IPC.channels.addShow, (channelId: number, showId: number) => {
        channelRepo.addChannelShow(db, channelId, showId);
        return lineupEdited(channelId);
    });
    handle(IPC.channels.removeShow, (channelId: number, showId: number) => {
        channelRepo.removeChannelShow(db, channelId, showId);
        return lineupEdited(channelId);
    });
    handle(
        IPC.channels.setMode,
        (channelId: number, showId: number, mode: PlayMode) => {
            channelRepo.setChannelShowMode(db, channelId, showId, mode);
            return lineupEdited(channelId);
        },
    );
    handle(
        IPC.channels.setSeasonMode,
        (
            channelId: number,
            showId: number,
            season: number,
            mode: PlayMode | null,
        ) => {
            channelRepo.setChannelShowSeasonMode(
                db,
                channelId,
                showId,
                season,
                mode,
            );
            return lineupEdited(channelId);
        },
    );
    handle(
        IPC.channels.setWeight,
        (channelId: number, showId: number, weight: number) => {
            channelRepo.setChannelShowWeight(db, channelId, showId, weight);
            return lineupEdited(channelId);
        },
    );
    handle(IPC.channels.resetProgress, (channelId: number, showId: number) => {
        resetProgress(db, channelId, showId);
        return lineupEdited(channelId);
    });

    // ---- player -------------------------------------------------------------

    handle(IPC.player.tune, (channelId: number): NowPlaying | null => {
        // An arc left dangling by a crash mid-airing is validated (and cleared if
        // stale) here, at tune-in — the mitigation for scheduler state corruption
        // (docs/architecture.md, "Risks, and what answers them").
        validateActiveArc(db, channelId);
        ctx.stream.releaseChannel(channelId);
        const pick = pickNext(db, channelId);
        if (!pick) return null;
        return toNowPlaying(ctx, channelId, pick.episodeId, pick.arc);
    });

    handle(IPC.player.next, (channelId: number): NowPlaying | null => {
        // Kill the outgoing job the moment the channel advances, so a skip never
        // leaves a second ffmpeg running. Safe to take the whole channel here: the
        // renderer only reaches `next` when it has no prewarm to promote.
        ctx.stream.releaseChannel(channelId);
        const pick = pickNext(db, channelId);
        if (!pick) return null;
        return toNowPlaying(ctx, channelId, pick.episodeId, pick.arc);
    });

    /**
     * The gapless handoff's reserving half
     * (docs/playback.md, "Gapless handoffs").
     *
     * Deliberately `reserveNext`, not `peekNext`: the standby has to buffer *the*
     * episode that will air, and for a shuffle show or a multipart arc only a
     * held reservation is that. Nothing is committed yet — `promoteNext` spends
     * the schedule step when the handoff really happens, and a `release` before
     * then drops the reservation along with the encoder, so a viewer who leaves
     * mid-prewarm burns no unit and logs no phantom airing.
     *
     * Nothing is released: for the last ~30 seconds this channel legitimately owns
     * two encoders.
     */
    handle(IPC.player.prewarmNext, (channelId: number): NowPlaying | null => {
        const pick = reserveNext(db, channelId);
        if (!pick) return null;
        return toNowPlaying(ctx, channelId, pick.episodeId, pick.arc);
    });

    handle(IPC.player.promoteNext, (channelId: number, episodeId: number) => {
        promoteReserved(db, channelId, episodeId);
    });

    handle(IPC.player.peekNext, (channelId: number): EpisodeView | null => {
        const pick = peekNext(db, channelId);
        return pick ? toEpisodeView(db, pick.episodeId) : null;
    });

    handle(
        IPC.player.reportEnded,
        (channelId: number, episodeId: number, completed: boolean) => {
            channelRepo.markLastAiringCompleted(
                db,
                channelId,
                episodeId,
                completed,
            );
            // This episode is done with, so its encoder is too. Only this one: a prewarmed
            // episode's job has to survive the handoff, which is the whole point.
            ctx.stream.releaseEpisode(channelId, episodeId);
        },
    );

    handle(
        IPC.player.release,
        (channelId: number, episodeId: number | null) => {
            // Every way the renderer abandons a prewarm funnels through here, so the
            // reservation goes with the encoder that was buffering it.
            discardReserved(db, channelId, episodeId ?? undefined);
            if (episodeId == null) ctx.stream.releaseChannel(channelId);
            else ctx.stream.releaseEpisode(channelId, episodeId);
        },
    );

    // ---- settings -----------------------------------------------------------

    handle(IPC.settings.getAll, () => getSettings(db));
    handle(IPC.settings.set, (key: keyof AppSettings, value: never) => {
        const settings = setSetting(db, key, value);
        // Toggling folder watching takes effect immediately rather than at restart.
        if (key === "watchFolders") {
            if (settings.watchFolders) ctx.scanner.startWatching();
            else ctx.scanner.stopWatching();
        }
        // Likewise the measuring job: it exists only to serve this setting, so it
        // should not be spending a core on a library nobody is equalizing.
        if (key === "loudnessEq") {
            if (settings.loudnessEq) ctx.loudness.start();
            else ctx.loudness.stop();
        }
        return settings;
    });

    // ---- system -------------------------------------------------------------

    handle(IPC.system.getInfo, (): SystemInfo => {
        const ff = resolveFfmpeg();
        const dbPath = databasePath();
        let dbSizeBytes = 0;
        try {
            dbSizeBytes = statSync(dbPath).size;
        } catch {
            // The file may not exist yet on a very first run.
        }
        return {
            appVersion: app.getVersion(),
            ffmpegPath: ff.ffmpegPath,
            ffprobePath: ff.ffprobePath,
            ffmpegVersion: ff.version,
            ffmpegSource: ff.source,
            codecCheck: ctx.codecCheck(),
            hwAccel: ctx.hwAccel(),
            dbPath,
            dbSizeBytes,
            streamPort: ctx.stream.port,
            lastRestore: getRestoreReceipt(db),
        };
    });

    handle(IPC.system.pickFolder, async (): Promise<string | null> => {
        const win =
            BrowserWindow.getFocusedWindow() ??
            BrowserWindow.getAllWindows()[0];
        const result = await dialog.showOpenDialog(win, {
            title: "Add a library folder",
            properties: ["openDirectory", "createDirectory"],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
    });

    handle(IPC.system.backupDb, async (): Promise<string | null> => {
        const win =
            BrowserWindow.getFocusedWindow() ??
            BrowserWindow.getAllWindows()[0];
        const result = await dialog.showSaveDialog(win, {
            title: "Back up the library database",
            defaultPath: join(app.getPath("home"), "rerun-tv-library.db"),
        });
        if (result.canceled || !result.filePath) return null;
        // WAL checkpoint first, so the copy is a complete database on its own.
        db.pragma("wal_checkpoint(TRUNCATE)");
        copyFileSync(databasePath(), result.filePath);
        return result.filePath;
    });

    handle(IPC.system.importDb, async (): Promise<boolean> => {
        const win =
            BrowserWindow.getFocusedWindow() ??
            BrowserWindow.getAllWindows()[0];
        const picked = await dialog.showOpenDialog(win, {
            title: "Import a library database",
            properties: ["openFile"],
            filters: [
                {
                    name: "Rerun TV database",
                    extensions: ["db", "sqlite", "sqlite3"],
                },
                { name: "All files", extensions: ["*"] },
            ],
        });
        const source = picked.canceled ? null : (picked.filePaths[0] ?? null);
        if (source == null) return false;

        // Validated and copied before anything is asked of the user, so the confirm
        // can quote real numbers — and so a bad file fails before it looks committal.
        const report = inspectAndStage(
            source,
            stagedImportPath(),
            stagedImportMetaPath(),
        );

        const media =
            report.sampled === 0
                ? "It contains no episodes yet."
                : report.missing === 0
                  ? `All ${report.sampled} sampled episode files were found on this machine.`
                  : `${report.missing} of ${report.sampled} sampled episode files were not found on ` +
                    "this machine — those episodes drop out of the schedule on the next scan.";

        const confirm = await dialog.showMessageBox(win, {
            type: "warning",
            buttons: ["Cancel", "Replace and restart"],
            defaultId: 0,
            cancelId: 0,
            title: "Replace the library database?",
            message: `Replace your library with ${basename(source)}?`,
            detail: [
                `The imported database has ${report.shows} shows, ${report.episodes} episodes and ` +
                    `${report.channels} channels. Your current library has ${countRows(db, "shows")} shows, ` +
                    `${countRows(db, "episodes")} episodes and ${countRows(db, "channels")} channels — ` +
                    "all of it, including playback progress, is replaced.",
                media,
                `Your current database will be saved to ${backupsDir()} first.`,
                "Rerun TV restarts to finish the import.",
            ].join("\n\n"),
        });

        if (confirm.response !== 1) {
            discardStagedImport(stagedImportPath(), stagedImportMetaPath());
            return false;
        }

        // Deliberately not awaited: the reply has to reach the renderer before the
        // process goes away, or the caller sees a dead-channel error instead.
        void ctx.restart();
        return true;
    });
}

/**
 * The tables `countRows` will interpolate. A union rather than a `string`, so a
 * future caller physically cannot reach this with a value off the wire — the
 * table name is the one part of these statements that cannot be a parameter.
 */
type CountableTable = "shows" | "episodes" | "channels";

function countRows(db: Db, table: CountableTable): number {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
    };
    return row.n;
}
