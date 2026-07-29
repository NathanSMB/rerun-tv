/**
 * The IPC contract.
 *
 * `RerunApi` is the single source of truth for what the renderer can ask the
 * main process to do. The preload bridge builds a `contextBridge` object that
 * satisfies this interface by forwarding every method over `ipcRenderer.invoke`
 * on the matching channel name from `IPC`, and the main process registers one
 * `ipcMain.handle` per channel. Add a method here first; both sides then fail
 * to typecheck until they implement it.
 */

import type {
  AppSettings,
  ArcView,
  AssignUnmatchedInput,
  Channel,
  ChannelDetail,
  ChannelSummary,
  CreateArcInput,
  CreateChannelInput,
  Episode,
  EpisodeView,
  LibraryOverview,
  NowPlaying,
  PlayMode,
  ScanRoot,
  ScanStatus,
  Show,
  SystemInfo,
  UpdateChannelInput
} from './types.js'

export interface RerunApi {
  library: {
    getOverview(): Promise<LibraryOverview>
    listShows(): Promise<Show[]>
    listEpisodes(showId: number): Promise<Episode[]>
    listRoots(): Promise<ScanRoot[]>
    addRoot(path: string): Promise<ScanRoot[]>
    removeRoot(rootId: number): Promise<ScanRoot[]>
    /** `full: true` re-probes every file instead of only changed ones. */
    rescan(full?: boolean): Promise<void>
    pauseScan(): Promise<void>
    resumeScan(): Promise<void>
    getScanStatus(): Promise<ScanStatus>
    assignUnmatched(input: AssignUnmatchedInput): Promise<void>
    dismissUnmatched(fileId: number): Promise<void>
    listArcs(showId: number): Promise<ArcView[]>
    createArc(input: CreateArcInput): Promise<ArcView>
    deleteArc(groupId: number): Promise<void>
  }

  channels: {
    list(): Promise<ChannelSummary[]>
    get(channelId: number): Promise<ChannelDetail | null>
    create(input: CreateChannelInput): Promise<Channel>
    update(channelId: number, patch: UpdateChannelInput): Promise<Channel>
    remove(channelId: number): Promise<void>
    /** Persist a drag-reorder of the guide: channel ids in display order. */
    reorder(channelIds: number[]): Promise<void>
    addShow(channelId: number, showId: number): Promise<ChannelDetail>
    removeShow(channelId: number, showId: number): Promise<ChannelDetail>
    setMode(channelId: number, showId: number, mode: PlayMode): Promise<ChannelDetail>
    /** Null removes the override so the season inherits the show mode. */
    setSeasonMode(
      channelId: number,
      showId: number,
      season: number,
      mode: PlayMode | null
    ): Promise<ChannelDetail>
    setWeight(channelId: number, showId: number, weight: number): Promise<ChannelDetail>
    /** Reset the cursor to the pilot, or deal a fresh shuffle bag. */
    resetProgress(channelId: number, showId: number): Promise<ChannelDetail>
  }

  player: {
    /** Tune in: commit the scheduler's next pick and start playing it. */
    tune(channelId: number): Promise<NowPlaying | null>
    /** Advance — auto-advance on `ended`, or a user skip. */
    next(channelId: number): Promise<NowPlaying | null>
    /** What the scheduler *would* pick next, without committing it. */
    peekNext(channelId: number): Promise<EpisodeView | null>
    /** Log the outcome of the episode that just finished or was abandoned. */
    reportEnded(channelId: number, episodeId: number, completed: boolean): Promise<void>
  }

  settings: {
    getAll(): Promise<AppSettings>
    set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<AppSettings>
  }

  system: {
    getInfo(): Promise<SystemInfo>
    /** Native folder picker; resolves to null if the user cancels. */
    pickFolder(): Promise<string | null>
    backupDb(): Promise<string | null>
  }

  /** Push channels from main. Each returns an unsubscribe function. */
  events: {
    onScanProgress(cb: (status: ScanStatus) => void): () => void
    onLibraryChanged(cb: () => void): () => void
    onChannelsChanged(cb: () => void): () => void
  }
}

/** Channel names for `invoke`/`handle`. Kept flat and namespaced by prefix. */
export const IPC = {
  library: {
    getOverview: 'library:getOverview',
    listShows: 'library:listShows',
    listEpisodes: 'library:listEpisodes',
    listRoots: 'library:listRoots',
    addRoot: 'library:addRoot',
    removeRoot: 'library:removeRoot',
    rescan: 'library:rescan',
    pauseScan: 'library:pauseScan',
    resumeScan: 'library:resumeScan',
    getScanStatus: 'library:getScanStatus',
    assignUnmatched: 'library:assignUnmatched',
    dismissUnmatched: 'library:dismissUnmatched',
    listArcs: 'library:listArcs',
    createArc: 'library:createArc',
    deleteArc: 'library:deleteArc'
  },
  channels: {
    list: 'channels:list',
    get: 'channels:get',
    create: 'channels:create',
    update: 'channels:update',
    remove: 'channels:remove',
    reorder: 'channels:reorder',
    addShow: 'channels:addShow',
    removeShow: 'channels:removeShow',
    setMode: 'channels:setMode',
    setSeasonMode: 'channels:setSeasonMode',
    setWeight: 'channels:setWeight',
    resetProgress: 'channels:resetProgress'
  },
  player: {
    tune: 'player:tune',
    next: 'player:next',
    peekNext: 'player:peekNext',
    reportEnded: 'player:reportEnded'
  },
  settings: {
    getAll: 'settings:getAll',
    set: 'settings:set'
  },
  system: {
    getInfo: 'system:getInfo',
    pickFolder: 'system:pickFolder',
    backupDb: 'system:backupDb'
  }
} as const

/** Main → renderer push events. */
export const EVENTS = {
  scanProgress: 'event:scanProgress',
  libraryChanged: 'event:libraryChanged',
  channelsChanged: 'event:channelsChanged'
} as const
