/**
 * The renderer's single Zustand store.
 *
 * Everything that crosses the IPC boundary lands here; components read slices
 * and call actions, and never call `window.rerun` directly (except the Player,
 * which owns the `<video>` element's own transient state — currentTime, OSD
 * visibility — locally because it changes every frame).
 *
 * Main-process push events (`scanProgress`, `libraryChanged`, `channelsChanged`)
 * are wired up once in `init()`.
 */

import { create } from 'zustand'
import type {
  AppSettings,
  ChannelDetail,
  ChannelSummary,
  EpisodeView,
  LibraryOverview,
  NowPlaying,
  ScanStatus,
  Show,
  SystemInfo
} from '@shared/types.js'
import { DEFAULT_SETTINGS } from '@shared/types.js'

export type Screen = 'guide' | 'player' | 'channels' | 'library' | 'settings'

const EMPTY_SCAN: ScanStatus = {
  state: 'idle',
  total: 0,
  done: 0,
  probed: 0,
  currentRoot: null,
  error: null
}

interface AppState {
  // ---- navigation ----
  screen: Screen
  /** Channel open in the editor, and the row highlighted in the guide. */
  editingChannelId: number | null
  selectedChannelId: number | null

  // ---- data ----
  channels: ChannelSummary[]
  channelDetail: ChannelDetail | null
  library: LibraryOverview | null
  shows: Show[]
  scan: ScanStatus
  system: SystemInfo | null
  settings: AppSettings
  ready: boolean

  // ---- playback ----
  nowPlaying: NowPlaying | null
  /** The pick after the current one — drives the "up next" toast. */
  upNext: EpisodeView | null
  volume: number
  muted: boolean

  // ---- actions ----
  init(): Promise<void>
  navigate(screen: Screen): void
  selectChannel(channelId: number | null): void
  openEditor(channelId: number): Promise<void>

  refreshChannels(): Promise<void>
  refreshLibrary(): Promise<void>
  refreshChannelDetail(channelId?: number): Promise<void>

  /** Tune in: commit the scheduler's pick and switch to the player. */
  tune(channelId: number): Promise<void>
  /** Skip, or auto-advance when the current episode ends. */
  advance(completed: boolean): Promise<void>
  /** Leave the player (Esc) and log the current episode as incomplete. */
  leavePlayer(): Promise<void>

  setVolume(volume: number): void
  toggleMute(): void
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>
}

export const useStore = create<AppState>((set, get) => ({
  screen: 'guide',
  editingChannelId: null,
  selectedChannelId: null,

  channels: [],
  channelDetail: null,
  library: null,
  shows: [],
  scan: EMPTY_SCAN,
  system: null,
  settings: DEFAULT_SETTINGS,
  ready: false,

  nowPlaying: null,
  upNext: null,
  volume: DEFAULT_SETTINGS.volume,
  muted: DEFAULT_SETTINGS.muted,

  async init() {
    const api = window.rerun

    api.events.onScanProgress((scan) => set({ scan }))
    api.events.onLibraryChanged(() => {
      void get().refreshLibrary()
      void get().refreshChannels()
    })
    api.events.onChannelsChanged(() => {
      void get().refreshChannels()
    })

    const [settings, system, scan] = await Promise.all([
      api.settings.getAll(),
      api.system.getInfo(),
      api.library.getScanStatus()
    ])

    set({
      settings,
      system,
      scan,
      volume: settings.rememberVolume ? settings.volume : DEFAULT_SETTINGS.volume,
      muted: settings.rememberVolume ? settings.muted : false,
      screen: settings.startScreen
    })

    await Promise.all([get().refreshChannels(), get().refreshLibrary()])
    set({ ready: true })
  },

  navigate(screen) {
    set({ screen })
  },

  selectChannel(channelId) {
    set({ selectedChannelId: channelId })
  },

  async openEditor(channelId) {
    set({ screen: 'channels', editingChannelId: channelId })
    await get().refreshChannelDetail(channelId)
  },

  async refreshChannels() {
    const channels = await window.rerun.channels.list()
    const { selectedChannelId } = get()
    const stillThere = channels.some((c) => c.channel.id === selectedChannelId)
    set({
      channels,
      selectedChannelId: stillThere ? selectedChannelId : (channels[0]?.channel.id ?? null)
    })
  },

  async refreshLibrary() {
    const [library, shows] = await Promise.all([
      window.rerun.library.getOverview(),
      window.rerun.library.listShows()
    ])
    set({ library, shows })
  },

  async refreshChannelDetail(channelId) {
    const id = channelId ?? get().editingChannelId
    if (id == null) return set({ channelDetail: null })
    const channelDetail = await window.rerun.channels.get(id)
    set({ channelDetail })
  },

  async tune(channelId) {
    const nowPlaying = await window.rerun.player.tune(channelId)
    if (!nowPlaying) return
    const upNext = await window.rerun.player.peekNext(channelId)
    set({ nowPlaying, upNext, screen: 'player', selectedChannelId: channelId })
    void get().refreshChannels()
  },

  async advance(completed) {
    const current = get().nowPlaying
    if (!current) return
    await window.rerun.player.reportEnded(current.channelId, current.episode.id, completed)
    const nowPlaying = await window.rerun.player.next(current.channelId)
    if (!nowPlaying) return
    const upNext = await window.rerun.player.peekNext(current.channelId)
    set({ nowPlaying, upNext })
    void get().refreshChannels()
  },

  async leavePlayer() {
    const current = get().nowPlaying
    if (current) {
      await window.rerun.player.reportEnded(current.channelId, current.episode.id, false)
    }
    set({ nowPlaying: null, upNext: null, screen: 'guide' })
    void get().refreshChannels()
  },

  setVolume(volume) {
    const clamped = Math.min(1, Math.max(0, volume))
    set({ volume: clamped, muted: clamped === 0 ? get().muted : false })
    if (get().settings.rememberVolume) void window.rerun.settings.set('volume', clamped)
  },

  toggleMute() {
    const muted = !get().muted
    set({ muted })
    if (get().settings.rememberVolume) void window.rerun.settings.set('muted', muted)
  },

  async setSetting(key, value) {
    const settings = await window.rerun.settings.set(key, value)
    set({ settings })
  }
}))
