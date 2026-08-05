/**
 * The preload bridge.
 *
 * Exposes exactly one global, `window.rerun`, satisfying `RerunApi`. Every
 * method is a thin `ipcRenderer.invoke` on the matching channel from `IPC` —
 * there is no logic here, deliberately: the renderer gets a typed, promise-based
 * API and no filesystem, no Node, no `remote`.
 */

import { contextBridge, ipcRenderer } from "electron";
import { EVENTS, IPC, type RerunApi } from "../shared/ipc.js";
import type { FfmpegInstallProgress, ScanStatus } from "../shared/types.js";

/** Subscribe to a main→renderer push channel; returns an unsubscribe function. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, payload: T): void =>
        cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

const api: RerunApi = {
    library: {
        getOverview: () => ipcRenderer.invoke(IPC.library.getOverview),
        listShows: () => ipcRenderer.invoke(IPC.library.listShows),
        listEpisodes: (showId) =>
            ipcRenderer.invoke(IPC.library.listEpisodes, showId),
        listRoots: () => ipcRenderer.invoke(IPC.library.listRoots),
        addRoot: (path) => ipcRenderer.invoke(IPC.library.addRoot, path),
        removeRoot: (rootId) =>
            ipcRenderer.invoke(IPC.library.removeRoot, rootId),
        // The handler defaults this too; the argument is named here so the
        // channel's payload is always the same shape on the wire.
        rescan: (full) => ipcRenderer.invoke(IPC.library.rescan, full ?? false),
        pauseScan: () => ipcRenderer.invoke(IPC.library.pauseScan),
        resumeScan: () => ipcRenderer.invoke(IPC.library.resumeScan),
        getScanStatus: () => ipcRenderer.invoke(IPC.library.getScanStatus),
        assignUnmatched: (input) =>
            ipcRenderer.invoke(IPC.library.assignUnmatched, input),
        dismissUnmatched: (fileId) =>
            ipcRenderer.invoke(IPC.library.dismissUnmatched, fileId),
        listArcs: (showId) => ipcRenderer.invoke(IPC.library.listArcs, showId),
        createArc: (input) => ipcRenderer.invoke(IPC.library.createArc, input),
        deleteArc: (groupId) =>
            ipcRenderer.invoke(IPC.library.deleteArc, groupId),
    },
    channels: {
        list: () => ipcRenderer.invoke(IPC.channels.list),
        get: (channelId) => ipcRenderer.invoke(IPC.channels.get, channelId),
        create: (input) => ipcRenderer.invoke(IPC.channels.create, input),
        update: (channelId, patch) =>
            ipcRenderer.invoke(IPC.channels.update, channelId, patch),
        remove: (channelId) =>
            ipcRenderer.invoke(IPC.channels.remove, channelId),
        reorder: (channelIds) =>
            ipcRenderer.invoke(IPC.channels.reorder, channelIds),
        addShow: (channelId, showId) =>
            ipcRenderer.invoke(IPC.channels.addShow, channelId, showId),
        removeShow: (channelId, showId) =>
            ipcRenderer.invoke(IPC.channels.removeShow, channelId, showId),
        setMode: (channelId, showId, mode) =>
            ipcRenderer.invoke(IPC.channels.setMode, channelId, showId, mode),
        setSeasonMode: (channelId, showId, season, mode) =>
            ipcRenderer.invoke(
                IPC.channels.setSeasonMode,
                channelId,
                showId,
                season,
                mode,
            ),
        setWeight: (channelId, showId, weight) =>
            ipcRenderer.invoke(
                IPC.channels.setWeight,
                channelId,
                showId,
                weight,
            ),
        resetProgress: (channelId, showId) =>
            ipcRenderer.invoke(IPC.channels.resetProgress, channelId, showId),
    },
    player: {
        tune: (channelId) => ipcRenderer.invoke(IPC.player.tune, channelId),
        next: (channelId) => ipcRenderer.invoke(IPC.player.next, channelId),
        prewarmNext: (channelId) =>
            ipcRenderer.invoke(IPC.player.prewarmNext, channelId),
        promoteNext: (channelId, episodeId) =>
            ipcRenderer.invoke(IPC.player.promoteNext, channelId, episodeId),
        peekNext: (channelId) =>
            ipcRenderer.invoke(IPC.player.peekNext, channelId),
        reportEnded: (channelId, episodeId, completed) =>
            ipcRenderer.invoke(
                IPC.player.reportEnded,
                channelId,
                episodeId,
                completed,
            ),
        release: (channelId, episodeId) =>
            ipcRenderer.invoke(
                IPC.player.release,
                channelId,
                episodeId ?? null,
            ),
    },
    settings: {
        getAll: () => ipcRenderer.invoke(IPC.settings.getAll),
        set: (key, value) => ipcRenderer.invoke(IPC.settings.set, key, value),
    },
    system: {
        getInfo: () => ipcRenderer.invoke(IPC.system.getInfo),
        pickFolder: () => ipcRenderer.invoke(IPC.system.pickFolder),
        backupDb: () => ipcRenderer.invoke(IPC.system.backupDb),
        importDb: () => ipcRenderer.invoke(IPC.system.importDb),
        getFfmpegState: () => ipcRenderer.invoke(IPC.system.getFfmpegState),
        recheckFfmpeg: () => ipcRenderer.invoke(IPC.system.recheckFfmpeg),
        installManagedFfmpeg: () =>
            ipcRenderer.invoke(IPC.system.installManagedFfmpeg),
        cancelFfmpegInstall: () =>
            ipcRenderer.invoke(IPC.system.cancelFfmpegInstall),
        checkFfmpegUpdate: () =>
            ipcRenderer.invoke(IPC.system.checkFfmpegUpdate),
        removeManagedFfmpeg: () =>
            ipcRenderer.invoke(IPC.system.removeManagedFfmpeg),
    },
    events: {
        onScanProgress: (cb) => subscribe<ScanStatus>(EVENTS.scanProgress, cb),
        onLibraryChanged: (cb) =>
            subscribe<void>(EVENTS.libraryChanged, () => cb()),
        onChannelsChanged: (cb) =>
            subscribe<void>(EVENTS.channelsChanged, () => cb()),
        onFfmpegProgress: (cb) =>
            subscribe<FfmpegInstallProgress>(EVENTS.ffmpegProgress, cb),
    },
};

contextBridge.exposeInMainWorld("rerun", api);
