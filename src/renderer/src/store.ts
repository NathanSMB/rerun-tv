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
import { DEFAULT_SETTINGS, SLEEP_MAX_MIN } from '@shared/types.js'

export type Screen = 'guide' | 'player' | 'channels' | 'library' | 'settings' | 'blackout'

/**
 * Whether this episode is the last thing in its **playable unit**.
 *
 * The scheduler hands out units, not episodes (`scheduler/units.ts`): a
 * standalone episode is a unit of one, a multipart arc is a unit of N. That
 * distinction reaches the renderer intact on `NowPlaying.arc`, which is null for
 * a standalone episode and carries `partIndex`/`partCount` inside an arc — so
 * "may we stop here?" needs no extra IPC and no scheduler state.
 *
 * This is what makes the sleep timer land at the end of an episode or the end of
 * an arc, never in the middle of a two-parter.
 */
export function endsPlayableUnit(playing: NowPlaying | null): boolean {
  if (!playing) return false
  const { arc } = playing
  return arc === null || arc.partIndex >= arc.partCount
}

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
 * Tune-in, advance, prewarm and leaving the player all touch scheduler state
 * (commits and reservations), and every one of them is `await`ed across an IPC
 * round trip. Interleaving two of them is how a channel double-advances: a
 * prewarm resolving *after* a skip has already picked would leave a stale
 * reservation promoted alongside the skipped-to episode, and the play log would
 * show two airings for one episode watched. Serialising is cheaper and far
 * easier to reason about than reconciling.
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
   * A pick the scheduler has **reserved** for this channel, waiting to be
   * promoted when the current episode ends (docs/stall-fix-plan.html, phase 3).
   *
   * Its presence is what forbids calling `player.next` on the next advance —
   * the standby is buffering this exact episode, and promotion must commit
   * *it* (`player.promoteNext`) rather than draw again. Discarding it on
   * leaving the player or changing channel costs nothing: the reservation is
   * dropped with its encoder and the schedule was never touched.
   */
  pendingNext: NowPlaying | null
  volume: number
  muted: boolean

  // ---- sleep timer ----
  /**
   * Wall-clock epoch-ms deadline, or null when the timer is off.
   *
   * Stored as a deadline rather than a remaining count on purpose: expiry is a
   * `Date.now()` comparison made at the two moments that matter (an episode
   * ending, and the pause branch), so Chromium's background-timer throttling
   * cannot make the timer drift. The 1-second tick in the Player exists only to
   * paint the countdown chip.
   *
   * Reaching the deadline does not stop playback — the current *playable unit*
   * finishes first. See `endsPlayableUnit`.
   */
  sleepUntil: number | null
  /** The armed duration, kept so the OSD button can cycle on from it. */
  sleepMinutes: number | null

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

  /**
   * Arm the sleep timer for `minutes` from now, or disarm it with null.
   *
   * Clamped to `SLEEP_MAX_MIN`. Arming zero is legal and means "already due" —
   * playback then runs to the end of the current unit and stops.
   */
  armSleep(minutes: number | null): void
  /**
   * Add (or subtract) minutes from the time *remaining*, arming from now if the
   * timer is off. Winding a running timer below zero switches it off.
   */
  adjustSleep(deltaMin: number): void
  /**
   * Stop now rather than at the next unit boundary — the paused case, where
   * nothing is "finishing" and waiting would mean waiting forever.
   */
  sleepNow(): Promise<void>

  setVolume(volume: number): void
  toggleMute(): void
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void>
}

/** Has the armed deadline passed? Null (disarmed) is never due. */
function sleepDue(sleepUntil: number | null): boolean {
  return sleepUntil !== null && Date.now() >= sleepUntil
}

/**
 * Shut the channel down and go dark.
 *
 * The caller has already reported the outcome of the episode on air, and both
 * callers run inside `serialize` — this must not take the queue itself or it
 * would deadlock against the transition that invoked it.
 */
async function goDark(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void
): Promise<void> {
  const api = bridge()
  const current = get().nowPlaying
  // The whole channel, so a prewarmed standby cannot outlive the screen — the
  // same reasoning as `leavePlayer`. The release also drops the standby's
  // reservation, so nothing was spent on the episode nobody will watch.
  if (current) await api.player.release(current.channelId)
  const pending = get().pendingNext
  if (pending && (!current || pending.channelId !== current.channelId)) {
    await api.player.release(pending.channelId, pending.episode.id)
  }
  set({
    nowPlaying: null,
    upNext: null,
    pendingNext: null,
    sleepUntil: null,
    sleepMinutes: null,
    screen: 'blackout'
  })
  void get().refreshChannels()
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

  sleepUntil: null,
  sleepMinutes: null,

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

      // The sleep boundary. Reached only here, after the outcome is logged, so
      // an episode that genuinely finished is still recorded as watched — the
      // one thing that separates going to sleep from walking out (`leavePlayer`,
      // which reports `completed: false`).
      //
      // Mid-arc this is false and the normal path runs: the scheduler's arc lock
      // hands out the next part, and we come back here when *that* one ends.
      if (sleepDue(get().sleepUntil) && endsPlayableUnit(current)) {
        await goDark(get, set)
        return
      }

      const pending = get().pendingNext
      if (pending !== null && pending.channelId === current.channelId) {
        // The standby is buffering this exact reserved episode. Promoting it and
        // committing the reservation is the *only* correct move: calling `next`
        // here would draw a different pick than the one about to play, and the
        // play log would outrun the episodes watched.
        await api.player.promoteNext(pending.channelId, pending.episode.id)
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
      // Once we know this episode is the last one before sleep there is nothing
      // to buffer — reserving here would only spawn an encoder we'd release
      // again at the boundary. The Player skips the call for the same reason;
      // this is the authoritative check, because the queue may have handed us a
      // state the effect never saw.
      if (sleepDue(get().sleepUntil) && endsPlayableUnit(current)) return

      const next = await bridge().player.prewarmNext(current.channelId)
      if (!next) return

      const still = get().nowPlaying
      if (!still || still.channelId !== current.channelId) {
        // Reserved a pick nobody is going to watch. The release drops its
        // encoder and its reservation together; the schedule was never touched.
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
      // Disarmed on the way out: a timer that survived into the guide would fire
      // against whatever the viewer tuned into next, or — worse — sit armed with
      // nothing to wind down. Leaving the player is a decision to stop watching,
      // which is the thing the timer was there to do.
      set({
        nowPlaying: null,
        upNext: null,
        pendingNext: null,
        sleepUntil: null,
        sleepMinutes: null,
        screen: 'guide'
      })
      void get().refreshChannels()
    })
  },

  armSleep(minutes) {
    if (minutes === null) return set({ sleepUntil: null, sleepMinutes: null })
    // Zero is a real value, not a disarm: it arms an already-due timer, which is
    // the "stop after this episode" chip. The unit boundary does the rest.
    const clamped = Math.min(SLEEP_MAX_MIN, Math.max(0, minutes))
    set({ sleepUntil: Date.now() + clamped * 60_000, sleepMinutes: clamped })
  },

  adjustSleep(deltaMin) {
    const { sleepUntil } = get()
    const now = Date.now()
    // Adjusting an unarmed timer arms it: a scroll on the moon is a way to set
    // the timer, not only to nudge one that already exists.
    if (sleepUntil === null) return get().armSleep(Math.max(0, deltaMin))

    /**
     * The shift is applied to what is *left*, never to the figure the timer was
     * armed with. A viewer who armed 30 minutes an hour ago and scrolls up is
     * asking for five more minutes of television — resolving that against the
     * original 30 would hand them a deadline in the past.
     */
    const remainingMin = (sleepUntil - now) / 60_000
    const next = Math.min(SLEEP_MAX_MIN, Math.round(remainingMin) + deltaMin)
    // Winding an unexpired timer down past zero is a request to switch it off,
    // not to stop at the end of this episode — that reading belongs to the chip
    // the viewer pressed on purpose. An already-expired timer is left alone: it
    // is waiting on a boundary, and there is nothing left to take away.
    if (next <= 0) {
      if (remainingMin > 0) return set({ sleepUntil: null, sleepMinutes: null })
      return
    }
    set({ sleepUntil: now + next * 60_000, sleepMinutes: next })
  },

  sleepNow() {
    return serialize(async () => {
      const current = get().nowPlaying
      if (!current) return
      // Nothing finished here — this is the paused branch — so the episode is
      // logged the way an abandoned one is.
      await bridge().player.reportEnded(current.channelId, current.episode.id, false)
      await goDark(get, set)
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
    // Turning prewarming off must not leave a reserved pick stranded in a
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
