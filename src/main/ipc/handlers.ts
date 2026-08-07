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
    FfmpegState,
    FfmpegUpdateCheck,
    MetadataPlan,
    NowPlaying,
    PlayMode,
    ScanStatus,
    SystemInfo,
    UpdateChannelInput,
} from "../../shared/types.js";
import type { Db } from "../db/index.js";
import * as channelRepo from "../db/repositories/channels.js";
import * as libraryRepo from "../db/repositories/library.js";
import * as playbackRepo from "../db/repositories/playback-state.js";
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
import {
    cancelFfmpegInstall,
    checkFfmpegUpdate,
    installManagedFfmpeg,
    managedFfmpegAvailable,
    removeManagedFfmpeg,
} from "../services/ffmpeg-manager.js";
import { assignUnmatched, getLibraryOverview } from "../services/library.js";
import { buildPlan, type MetadataService } from "../services/metadata.js";
import { advanceChannel, notePromoted, tuneIn } from "../services/playback.js";
import {
    discardStagedImport,
    getRestoreReceipt,
    inspectAndStage,
} from "../services/restore.js";
import {
    managedVersionDir,
    readManagedRecord,
    resetFfmpegCache,
    resolveFfmpeg,
} from "../stream/ffmpeg.js";
import type { StreamServer } from "../stream/server.js";

export interface HandlerContext {
    db: Db;
    scanner: Scanner;
    /** The background loudness measuring job, started/stopped with its setting. */
    loudness: LoudnessScanner;
    stream: StreamServer;
    /** The TVmaze client behind the show metadata lookup — the app's only other network user. */
    metadata: MetadataService;
    /** Resolved once at startup; `pending` until the check finishes. */
    codecCheck: () => SystemInfo["codecCheck"];
    /** Likewise for the GPU probe — `pending` reads as "use software for now". */
    hwAccel: () => SystemInfo["hwAccel"];
    /**
     * The ffmpeg binary underneath changed — installed, updated or removed.
     *
     * Everything that resolves per use already follows the new pointer on its
     * own; this is for the two answers that were computed *about the old binary*
     * and have to be taken again (`index.ts` re-runs the codec and GPU probes).
     */
    onFfmpegChanged: () => void;
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
 *
 * `resumeAtS` is where a resumed channel picks up, and it reaches the element by
 * one of two routes depending on the path. A piped stream cannot be seeked in
 * the element, so the seek is baked into the URL as `?t=` and ffmpeg restarts at
 * `-ss`. A `direct` file is served with range requests and `serveFile` ignores
 * `?t=` outright, so its URL is left unseeked and the Player moves the element's
 * own `currentTime` instead. Everything but a resumed tune-in passes 0 and gets
 * the from-the-top behaviour unchanged.
 */
function toNowPlaying(
    ctx: HandlerContext,
    channelId: number,
    episodeId: number,
    arc: NowPlaying["arc"],
    resumeAtS = 0,
): NowPlaying | null {
    const channel = channelRepo.getChannel(ctx.db, channelId);
    const episode = toEpisodeView(ctx.db, episodeId);
    if (!channel || !episode) return null;

    const urlSeekS = episode.playbackPath === "direct" ? 0 : resumeAtS;
    return {
        channelId: channel.id,
        channelNumber: channel.number,
        channelName: channel.name,
        episode,
        streamUrl: ctx.stream.urlFor(episodeId, urlSeekS, channelId),
        resumeAtS,
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

    // ---- show metadata lookup (docs/library.md) ------------------------------
    //
    // Search and preview are the only handlers in the app that touch the
    // network, and neither writes anything: the renderer's CSP forbids reaching
    // TVmaze directly, so the lookup lives here and comes back as data. Apply is
    // the mirror image — one transaction, no network at all, so a preview left
    // on screen can still be committed after the connection drops.

    handle(IPC.library.searchMetadata, (query: string) =>
        ctx.metadata.search(query),
    );

    handle(
        IPC.library.previewMetadata,
        async (input: { showId: number; providerShowId: string }) => {
            const show = libraryRepo.getShow(db, input.showId);
            // Checked before the fetch, not after: a show deleted out from under
            // an open panel should cost the provider nothing.
            if (!show) throw new Error("that show is no longer in the library");

            // Both provider calls in flight at once — they are independent, and
            // the name comes from the provider rather than from whatever the
            // renderer echoed back so that Refresh (which re-previews from the
            // stored id, with no candidate in hand) behaves identically.
            //
            // Only the episode list is load-bearing, so the name lookup is
            // caught and not awaited into a rejection: a preview that has every
            // title in hand must not be thrown away because the second, smaller
            // request 503'd. A failed name reads as no name and falls through to
            // the title the show already carries, below.
            const [providerEpisodes, name] = await Promise.all([
                ctx.metadata.fetchEpisodes(input.providerShowId),
                ctx.metadata
                    .fetchShowName(input.providerShowId)
                    .catch(() => null),
            ]);
            return buildPlan(
                {
                    showId: show.id,
                    providerShowId: input.providerShowId,
                    // A provider that answered without a name leaves the show
                    // named exactly as the scanner named it — never blank.
                    name: name ?? show.displayTitle ?? show.title,
                },
                providerEpisodes,
                libraryRepo.listEpisodes(db, show.id),
            );
        },
    );

    handle(IPC.library.applyMetadata, (plan: MetadataPlan) => {
        // A scan may have run between preview and apply, so every id in the plan
        // is re-checked against the show it claims to belong to. Rows that
        // vanished or moved are dropped — a stale plan can shrink, never write
        // into the wrong show.
        const mine = new Set(
            libraryRepo.listEpisodes(db, plan.showId).map((ep) => ep.id),
        );
        const pairs = plan.episodes
            .filter((ep) => mine.has(ep.episodeId))
            .map((ep) => ({ episodeId: ep.episodeId, title: ep.title }));

        // One transaction for all three writes: a show pointing at a provider
        // whose episode titles never landed is a state the Refresh button can't
        // explain, and `setEpisodeMetadataTitles` deliberately has no txn of its
        // own so this caller can supply it.
        //
        // The clear comes first because an apply *replaces* the link rather than
        // merging into it — re-linking to a series with fewer episodes has to
        // leave the uncovered rows back on their filename titles, not wearing
        // the previous provider's.
        db.transaction(() => {
            libraryRepo.setShowMetadata(db, plan.showId, {
                displayTitle: plan.displayTitle,
                source: plan.provider,
                providerId: plan.providerShowId,
            });
            libraryRepo.clearEpisodeMetadataTitles(db, plan.showId);
            libraryRepo.setEpisodeMetadataTitles(db, pairs);
        })();

        broadcast(EVENTS.libraryChanged);
    });

    handle(IPC.library.unlinkMetadata, (showId: number) => {
        libraryRepo.clearShowMetadata(db, showId);
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
        // (docs/architecture.md, "Risks, and what answers them"). It runs ahead of
        // both branches of `tuneIn`: clearing a lock that points at nothing is
        // right whether the channel is about to resume or to draw.
        validateActiveArc(db, channelId);
        ctx.stream.releaseChannel(channelId);
        const tuned = tuneIn(db, channelId);
        if (!tuned) return null;
        return toNowPlaying(
            ctx,
            channelId,
            tuned.episodeId,
            tuned.arc,
            tuned.resumeAtS,
        );
    });

    handle(IPC.player.next, (channelId: number): NowPlaying | null => {
        // Kill the outgoing job the moment the channel advances, so a skip never
        // leaves a second ffmpeg running. Safe to take the whole channel here: the
        // renderer only reaches `next` when it has no prewarm to promote.
        ctx.stream.releaseChannel(channelId);
        const tuned = advanceChannel(db, channelId);
        if (!tuned) return null;
        return toNowPlaying(ctx, channelId, tuned.episodeId, tuned.arc);
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
        // The standby is the picture now, so it is where this channel resumes. A
        // crash a second into a handoff would otherwise reopen on the episode that
        // just finished.
        notePromoted(db, channelId, episodeId);
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
            // Every way off an episode passes through here, and most of them mean
            // the viewer is finished with it — it ended, it was skipped, the sleep
            // timer stopped the channel — so the resume point goes with it. The two
            // paths that do *not* mean that (leaving the player, changing channel)
            // call `savePosition` immediately afterwards and put it back. Guarded by
            // episode id, so a late report cannot wipe a newer pick's row.
            playbackRepo.clearPlaybackState(db, channelId, episodeId);
            // This episode is done with, so its encoder is too. Only this one: a prewarmed
            // episode's job has to survive the handoff, which is the whole point.
            ctx.stream.releaseEpisode(channelId, episodeId);
        },
    );

    handle(
        IPC.player.savePosition,
        (channelId: number, episodeId: number, positionS: number) => {
            playbackRepo.savePlaybackPosition(
                db,
                channelId,
                episodeId,
                positionS,
            );
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

    // ---- system · managed ffmpeg -------------------------------------------

    /**
     * The gate and the Settings card both render from this one shape.
     *
     * `managed` is reported even when something else is active, because those two
     * genuinely disagree when `RERUN_FFMPEG_PATH` is set — and a card that said
     * "not installed" while an update sat on disk would be lying.
     */
    const ffmpegState = async (): Promise<FfmpegState> => {
        const ff = resolveFfmpeg();
        const record = readManagedRecord();
        return {
            path: ff.ffmpegPath,
            ffprobePath: ff.ffprobePath,
            version: ff.version,
            source: ff.source,
            managed:
                record == null
                    ? null
                    : {
                          version: record.version,
                          installedAt: record.installedAt,
                          dir: managedVersionDir(record.version),
                      },
            downloadable: await managedFfmpegAvailable(),
        };
    };

    handle(IPC.system.getFfmpegState, ffmpegState);

    handle(IPC.system.recheckFfmpeg, async (): Promise<FfmpegState> => {
        const before = resolveFfmpeg().ffmpegPath;
        resetFfmpegCache();
        const state = await ffmpegState();
        // Only when it actually changed: the gate polls this every few seconds
        // while it is open, and re-probing the same binary on every tick would
        // spawn two ffmpeg processes a second for as long as the modal is up.
        if (state.path !== before) ctx.onFfmpegChanged();
        return state;
    });

    handle(IPC.system.installManagedFfmpeg, () =>
        installManagedFfmpeg({
            onProgress: (progress) =>
                broadcast(EVENTS.ffmpegProgress, progress),
            onInstalled: () => ctx.onFfmpegChanged(),
        }),
    );

    handle(IPC.system.cancelFfmpegInstall, () => {
        cancelFfmpegInstall();
    });

    handle(
        IPC.system.checkFfmpegUpdate,
        (): Promise<FfmpegUpdateCheck> => checkFfmpegUpdate(),
    );

    handle(IPC.system.removeManagedFfmpeg, async (): Promise<FfmpegState> => {
        removeManagedFfmpeg(() => ctx.onFfmpegChanged());
        return await ffmpegState();
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
