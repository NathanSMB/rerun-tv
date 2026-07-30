/**
 * The renderer's single Zustand store.
 *
 * Everything that crosses the IPC boundary lands here; components read slices
 * and call actions, and never call the bridge directly (except the Player,
 * which owns the `<video>` elements' own transient state — currentTime, OSD
 * visibility — locally because it changes every frame).
 *
 * Main-process push events (`scanProgress`, `libraryChanged`, `channelsChanged`)
 * are wired up once in `init()`.
 *
 * The bridge is reached through `bridge()` rather than `window.rerun` for one
 * reason: it keeps this module free of DOM types, which is what lets
 * `tests/store-handoff.test.ts` drive the schedule-advance logic against a fake
 * bridge in Node. That logic is worth testing because getting it wrong
 * double-spends the schedule (see `advance`).
 */

import { create } from 'zustand'
import type { RerunApi } from '@shared/ipc.js'
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

/** The preload bridge. Same object as `window.rerun`; see the module header. */
function bridge(): RerunApi {
  const api = (globalThis as { rerun?: RerunApi }).rerun
  if (!api) throw new Error('The preload bridge is not available')
  return api
}

const EMPTY_SCAN: ScanStatus = {
  state: 'idle',
  total: 0,
  done: 0,
  probed: 0,
  currentRoot: null,
  error: null
}

/**
 * Playback transitions run one at a time, in order.
 *
 * Tune-in, advance, prewarm and leaving the player all commit scheduler state,
 * and every one of them is `await`ed across an IPC round trip. Interleaving two
 * of them is how a channel double-advances: a prewarm resolving *after* a skip
 * has already picked would leave the promoted episode and the skipped-to episode
 * both committed, and the play log would show two picks for one episode watched.
 * Serialising is cheaper and far easier to reason about than reconciling.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(action: () => Promise<T>): Promise<T> {
  const run = queue.then(action, action)
  // Swallowed here only so one failed transition doesn't poison the chain; the
  // caller still sees the rejection through `run`.
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
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
  /**
   * A pick the scheduler has already **committed** for this channel, waiting to
   * be promoted when the current episode ends (docs/stall-fix-plan.html, phase 3).
   *
   * Its presence is what forbids calling `player.next` on the next advance — the
   * schedule step has been spent, and asking again would spend a second one. It
   * is discarded on leaving the player or changing channel, in which case its
   * play-log entry simply stays incomplete, exactly as it would after a crash
   * mid-episode.
   */
  pendingNext: NowPlaying | null
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
  /** T−30s: commit the next pick so the standby player can buffer it. */
  prewarm(): Promise<void>
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
  pendingNext: null,
  volume: DEFAULT_SETTINGS.volume,
  muted: DEFAULT_SETTINGS.muted,

  async init() {
    const api = bridge()

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
    const channels = await bridge().channels.list()
    const { selectedChannelId } = get()
    const stillThere = channels.some((c) => c.channel.id === selectedChannelId)
    set({
      channels,
      selectedChannelId: stillThere ? selectedChannelId : (channels[0]?.channel.id ?? null)
    })
  },

  async refreshLibrary() {
    const [library, shows] = await Promise.all([
      bridge().library.getOverview(),
      bridge().library.listShows()
    ])
    set({ library, shows })
  },

  async refreshChannelDetail(channelId) {
    const id = channelId ?? get().editingChannelId
    if (id == null) return set({ channelDetail: null })
    const channelDetail = await bridge().channels.get(id)
    set({ channelDetail })
  },

  tune(channelId) {
    return serialize(async () => {
      const api = bridge()
      // Tuning away from a channel we were watching: report the abandoned
      // episode and drop its encoders, including a prewarm nobody will see.
      const leaving = get().nowPlaying
      if (leaving && leaving.channelId !== channelId) {
        await api.player.reportEnded(leaving.channelId, leaving.episode.id, false)
        await api.player.release(leaving.channelId)
      }
      set({ pendingNext: null })

      const nowPlaying = await api.player.tune(channelId)
      if (!nowPlaying) return
      const upNext = await api.player.peekNext(channelId)
      set({ nowPlaying, upNext, screen: 'player', selectedChannelId: channelId })
      void get().refreshChannels()
    })
  },

  advance(completed) {
    return serialize(async () => {
      const api = bridge()
      const current = get().nowPlaying
      if (!current) return

      // Logs the outcome *and* releases this episode's encoder. A prewarmed
      // episode's job is a separate slot and survives.
      await api.player.reportEnded(current.channelId, current.episode.id, completed)

      const pending = get().pendingNext
      if (pending !== null && pending.channelId === current.channelId) {
        // The schedule step for this episode was already spent at T−30s.
        // Promoting is the *only* correct move: calling `next` here would commit
        // a second pick and the play log would outrun the episodes watched.
        set({ nowPlaying: pending, pendingNext: null })
        set({ upNext: await api.player.peekNext(current.channelId) })
        void get().refreshChannels()
        return
      }

      // A prewarm we can't promote (it belongs to another channel). Drop just its
      // job — not the channel's, which may still be feeding a player.
      if (pending !== null) {
        set({ pendingNext: null })
        await api.player.release(pending.channelId, pending.episode.id)
      }

      const nowPlaying = await api.player.next(current.channelId)
      if (!nowPlaying) return
      const upNext = await api.player.peekNext(current.channelId)
      set({ nowPlaying, upNext })
      void get().refreshChannels()
    })
  },

  prewarm() {
    return serialize(async () => {
      const current = get().nowPlaying
      // Every one of these is a real state by the time the queue reaches us: the
      // user may have skipped, left, or turned the setting off while we waited.
      if (!current || get().pendingNext !== null || !get().settings.prewarmNext) return

      const next = await bridge().player.prewarmNext(current.channelId)
      if (!next) return

      const still = get().nowPlaying
      if (!still || still.channelId !== current.channelId) {
        // Committed a pick nobody is going to watch. Drop just its encoder; the
        // play-log entry stays incomplete, which is the same thing that happens
        // when the app dies mid-episode (plan §10).
        await bridge().player.release(next.channelId, next.episode.id)
        return
      }
      // The toast now promises something that is genuinely buffered.
      set({ pendingNext: next, upNext: next.episode })
    })
  },

  leavePlayer() {
    return serialize(async () => {
      const api = bridge()
      const current = get().nowPlaying
      if (current) {
        await api.player.reportEnded(current.channelId, current.episode.id, false)
        // Everything on this channel, so a prewarm cannot outlive the screen.
        await api.player.release(current.channelId)
      }
      const pending = get().pendingNext
      if (pending && (!current || pending.channelId !== current.channelId)) {
        await api.player.release(pending.channelId, pending.episode.id)
      }
      set({ nowPlaying: null, upNext: null, pendingNext: null, screen: 'guide' })
      void get().refreshChannels()
    })
  },

  setVolume(volume) {
    const clamped = Math.min(1, Math.max(0, volume))
    set({ volume: clamped, muted: clamped === 0 ? get().muted : false })
    if (get().settings.rememberVolume) void bridge().settings.set('volume', clamped)
  },

  toggleMute() {
    const muted = !get().muted
    set({ muted })
    if (get().settings.rememberVolume) void bridge().settings.set('muted', muted)
  },

  async setSetting(key, value) {
    const settings = await bridge().settings.set(key, value)
    set({ settings })

    // Two different reasons to drop a standby, both ending the same way.
    //
    // Turning prewarming off must not leave a committed pick stranded in a
    // standby element nobody is going to promote. And a standby was spawned
    // with the audio settings of the moment: change loudness equalization and
    // it would hand off, mid-channel, to an episode still carrying the old
    // sound — the one place the setting could be audibly self-contradictory.
    // Dropping it means the next episode is re-requested at handoff, with the
    // new setting, which is where every other consumer of Settings picks it up.
    const dropStandby = (key === 'prewarmNext' && value === false) || key === 'loudnessEq'
    if (dropStandby) {
      const pending = get().pendingNext
      if (pending) {
        set({ pendingNext: null })
        // That episode's job only — the one on air is on the same channel.
        await bridge().player.release(pending.channelId, pending.episode.id)
      }
    }
  }
}))
