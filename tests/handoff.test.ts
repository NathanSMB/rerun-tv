/**
 * The gapless handoff (docs/stall-fix-plan.html, phase 3).
 *
 * This is the phase with a way to be quietly, badly wrong: `prewarmNext` runs a
 * *committing* `pickNext` thirty seconds early, so if the renderer then also
 * calls `next` when the episode ends, the channel advances twice for one episode
 * watched. A shuffle bag loses an episode a cycle, a sequential cursor skips one,
 * and a multipart arc drops a part — all silently, and all only visible days
 * later as "why did it skip episode 7".
 *
 * So the store's transition logic is tested against the *real* scheduler over a
 * real in-memory database, with only the IPC hop faked. The invariant every case
 * below checks is the same one: **one play-log entry per episode the viewer
 * actually saw.**
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { RerunApi } from '@shared/ipc.js'
import type { EpisodeView, NowPlaying } from '@shared/types.js'
import { DEFAULT_SETTINGS } from '@shared/types.js'
import { openDatabase, type Db } from '@main/db/index.js'
import {
  addChannelShow,
  createChannel,
  getChannel,
  markLastAiringCompleted,
  setChannelShowMode
} from '@main/db/repositories/channels.js'
import { peekNext, pickNext, validateActiveArc } from '@main/scheduler/scheduler.js'
import { toEpisodeView } from '@main/services/channels.js'
import { useStore } from '../src/renderer/src/store.js'

let db: Db
let channelId: number
let showId: number
/** Every encoder release the store asked for, in order: `channel:3` or `channel:3:41`. */
let released: string[]
/** How many times a *committing* pick ran. The number this suite is really about. */
let commits: number

function insertShow(title: string): number {
  return Number(
    db
      .prepare(`INSERT INTO shows (title, folder_path, added_at) VALUES (?, ?, 0)`)
      .run(title, `/tv/${title}`).lastInsertRowid
  )
}

function insertEpisode(season: number, episode: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO episodes (show_id, season, episode, path, duration_s, container, vcodec, acodec, playback_path)
         VALUES (?, ?, ?, ?, 1320, 'matroska', 'h264', 'ac3', 'remux')`
      )
      .run(showId, season, episode, `/tv/show/S${season}E${episode}.mkv`).lastInsertRowid
  )
}

function insertArc(title: string, episodeIds: number[]): void {
  const groupId = Number(
    db
      .prepare(`INSERT INTO part_groups (show_id, title, source) VALUES (?, ?, 'manual')`)
      .run(showId, title).lastInsertRowid
  )
  const link = db.prepare(`UPDATE episodes SET part_group_id = ?, part_index = ? WHERE id = ?`)
  episodeIds.forEach((id, index) => link.run(groupId, index + 1, id))
}

function playLog(): { episodeId: number; completed: number }[] {
  return db
    .prepare(`SELECT episode_id AS episodeId, completed FROM play_log ORDER BY id`)
    .all() as { episodeId: number; completed: number }[]
}

/** What the main process's `toNowPlaying` builds, minus Electron. */
function nowPlaying(channel: number, episodeId: number, arc: NowPlaying['arc']): NowPlaying | null {
  const channelRow = getChannel(db, channel)
  const episode = toEpisodeView(db, episodeId)
  if (!channelRow || !episode) return null
  return {
    channelId: channelRow.id,
    channelNumber: channelRow.number,
    channelName: channelRow.name,
    episode,
    streamUrl: `http://127.0.0.1:9/stream/${episodeId}?ch=${channel}`,
    arc
  }
}

function commit(channel: number): NowPlaying | null {
  commits += 1
  const pick = pickNext(db, channel)
  return pick ? nowPlaying(channel, pick.episodeId, pick.arc) : null
}

/**
 * The preload bridge, backed by the real scheduler.
 *
 * Only the methods the playback actions touch are implemented — a partial object
 * cast rather than a hundred lines of stubs. Anything else the store reaches for
 * fails loudly as a TypeError, which is the outcome we want from a test that has
 * drifted out of date.
 */
function fakeBridge(): RerunApi {
  const player: RerunApi['player'] = {
    tune: async (channel) => {
      validateActiveArc(db, channel)
      released.push(`channel:${channel}`)
      return commit(channel)
    },
    next: async (channel) => {
      released.push(`channel:${channel}`)
      return commit(channel)
    },
    prewarmNext: async (channel) => commit(channel),
    peekNext: async (channel): Promise<EpisodeView | null> => {
      const pick = peekNext(db, channel)
      return pick ? toEpisodeView(db, pick.episodeId) : null
    },
    reportEnded: async (channel, episodeId, completed) => {
      markLastAiringCompleted(db, channel, episodeId, completed)
      released.push(`channel:${channel}:${episodeId}`)
    },
    release: async (channel, episodeId) => {
      released.push(episodeId == null ? `channel:${channel}` : `channel:${channel}:${episodeId}`)
    }
  }

  return {
    player,
    channels: { list: async () => [] },
    settings: { set: async () => useStore.getState().settings }
  } as unknown as RerunApi
}

beforeEach(() => {
  db = openDatabase(':memory:')
  released = []
  commits = 0
  showId = insertShow('Gargoyles')
  ;(globalThis as { rerun?: RerunApi }).rerun = fakeBridge()

  useStore.setState({
    nowPlaying: null,
    upNext: null,
    pendingNext: null,
    screen: 'guide',
    channels: [],
    settings: { ...DEFAULT_SETTINGS, prewarmNext: true }
  })
})

/** A show of `count` standalone episodes on a sequential channel — a known order. */
function sequentialChannel(count: number, dial = 3): void {
  for (let episode = 1; episode <= count; episode++) insertEpisode(1, episode)
  channelId = createChannel(db, 'Test', dial).id
  addChannelShow(db, channelId, showId)
  setChannelShowMode(db, channelId, showId, 'sequential')
}

const store = (): ReturnType<typeof useStore.getState> => useStore.getState()

describe('prewarm then handoff', () => {
  beforeEach(() => sequentialChannel(6))

  it('advances the schedule exactly once across a prewarmed handoff', async () => {
    await store().tune(channelId)
    const first = store().nowPlaying!
    expect(commits).toBe(1)
    expect(playLog()).toHaveLength(1)

    await store().prewarm()
    const pending = store().pendingNext!
    expect(commits).toBe(2)
    expect(playLog()).toHaveLength(2)
    // The second episode in airing order — the pick is committed, not guessed.
    expect(pending.episode.episode).toBe(2)

    await store().advance(true)

    // The promotion must not have run `pickNext` again. This is the whole test.
    expect(commits).toBe(2)
    expect(playLog()).toHaveLength(2)
    expect(store().nowPlaying?.episode.id).toBe(pending.episode.id)
    expect(store().pendingNext).toBeNull()
    // The finished episode is logged complete; the promoted one is still airing.
    expect(playLog()).toEqual([
      { episodeId: first.episode.id, completed: 1 },
      { episodeId: pending.episode.id, completed: 0 }
    ])
  })

  it('advances exactly once when the viewer skips into a pending prewarm', async () => {
    await store().tune(channelId)
    const first = store().nowPlaying!
    await store().prewarm()
    const pending = store().pendingNext!

    await store().advance(false)

    expect(commits).toBe(2)
    expect(store().nowPlaying?.episode.id).toBe(pending.episode.id)
    // Skipped, so the abandoned episode stays incomplete — a skip is not a watch.
    expect(playLog()).toEqual([
      { episodeId: first.episode.id, completed: 0 },
      { episodeId: pending.episode.id, completed: 0 }
    ])
  })

  it('never double-advances when a skip lands while the prewarm is still in flight', async () => {
    await store().tune(channelId)

    // The race the store's serialisation exists for: both transitions issued
    // before either has resolved.
    const prewarming = store().prewarm()
    const advancing = store().advance(true)
    await Promise.all([prewarming, advancing])

    // Two picks total — the tune-in and one advance — however the two interleaved.
    expect(commits).toBe(2)
    expect(playLog()).toHaveLength(2)
    expect(store().pendingNext).toBeNull()
    expect(store().nowPlaying?.episode.id).toBe(playLog()[1].episodeId)
  })

  it('keeps the play log one entry per episode across a marathon of handoffs', async () => {
    await store().tune(channelId)
    const watched = [store().nowPlaying!.episode.id]

    for (let handoff = 0; handoff < 5; handoff++) {
      await store().prewarm()
      await store().advance(true)
      watched.push(store().nowPlaying!.episode.id)
    }

    // Six episodes seen, six log entries, in the order they aired, no repeats.
    expect(watched).toHaveLength(6)
    expect(new Set(watched).size).toBe(6)
    expect(playLog().map((row) => row.episodeId)).toEqual(watched)
  })

  it('drops only the pending episode when the viewer leaves, keeping its log entry open', async () => {
    await store().tune(channelId)
    const first = store().nowPlaying!
    await store().prewarm()
    const pending = store().pendingNext!

    await store().leavePlayer()

    expect(store().nowPlaying).toBeNull()
    expect(store().pendingNext).toBeNull()
    // Both encoders on the channel go — including the prewarm nobody will watch.
    expect(released).toContain(`channel:${channelId}`)
    // The schedule step was genuinely spent; the pick's entry simply stays
    // incomplete, exactly as it would after a crash mid-episode (plan §10).
    expect(playLog()).toEqual([
      { episodeId: first.episode.id, completed: 0 },
      { episodeId: pending.episode.id, completed: 0 }
    ])
    expect(commits).toBe(2)
  })

  it('releases the outgoing encoder on a handoff and nothing else', async () => {
    await store().tune(channelId)
    const first = store().nowPlaying!
    await store().prewarm()
    released.length = 0

    await store().advance(true)

    // Just the episode that finished. Killing the channel here would take the
    // prewarmed stream with it and undo the whole point.
    expect(released).toEqual([`channel:${channelId}:${first.episode.id}`])
  })

  it('abandons a pending pick when prewarming is switched off mid-episode', async () => {
    await store().tune(channelId)
    await store().prewarm()
    const pending = store().pendingNext!
    released.length = 0

    await store().setSetting('prewarmNext', false)

    expect(store().pendingNext).toBeNull()
    // The pending episode's job only — the one on air is on the same channel.
    expect(released).toEqual([`channel:${channelId}:${pending.episode.id}`])
    expect(released).not.toContain(`channel:${channelId}`)
  })

  /**
   * Loudness equalization is an ffmpeg argument, so a standby spawned before the
   * toggle is still encoding with the *old* audio settings. Left alone it would
   * hand off mid-channel to an episode that sounds different from the setting
   * that is now switched on — the one place this feature could be audibly
   * self-contradictory. Dropping the standby makes the next episode be
   * re-requested at handoff, which is where every other consumer of Settings
   * picks a change up.
   */
  it('abandons a pending pick when loudness equalization is toggled', async () => {
    for (const value of [true, false]) {
      await store().tune(channelId)
      await store().prewarm()
      const pending = store().pendingNext!
      released.length = 0

      await store().setSetting('loudnessEq', value)

      expect(store().pendingNext).toBeNull()
      expect(released).toEqual([`channel:${channelId}:${pending.episode.id}`])
      expect(released).not.toContain(`channel:${channelId}`)
    }
  })
})

describe('with prewarming off', () => {
  beforeEach(() => {
    sequentialChannel(4)
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, prewarmNext: false } })
  })

  it('commits nothing early and advances through `next`, exactly as before phase 3', async () => {
    await store().tune(channelId)
    await store().prewarm()

    expect(store().pendingNext).toBeNull()
    expect(commits).toBe(1)
    expect(playLog()).toHaveLength(1)

    released.length = 0
    await store().advance(true)

    expect(commits).toBe(2)
    expect(playLog()).toHaveLength(2)
    // `next` takes the whole channel, which is safe precisely because there is
    // no prewarm to protect.
    expect(released).toContain(`channel:${channelId}`)
  })
})

describe('prewarm inside a multipart arc', () => {
  beforeEach(() => {
    const parts = [insertEpisode(1, 1), insertEpisode(1, 2), insertEpisode(1, 3)]
    insertEpisode(1, 4)
    insertEpisode(1, 5)
    insertArc('Awakening', parts)
    channelId = createChannel(db, 'Arc', 4).id
    addChannelShow(db, channelId, showId)
    setChannelShowMode(db, channelId, showId, 'sequential')
  })

  /**
   * The nastiest failure mode. An arc's parts are handed out one at a time by
   * `pickNext` under a channel lock, so a double-advance here does not merely
   * reorder episodes — it makes part 2 of a three-parter never air.
   */
  it('hands out consecutive parts without skipping or repeating one', async () => {
    await store().tune(channelId)
    expect(store().nowPlaying?.arc).toMatchObject({ partIndex: 1, partCount: 3 })

    await store().prewarm()
    expect(store().pendingNext?.arc).toMatchObject({ partIndex: 2, partCount: 3 })
    await store().advance(true)
    expect(store().nowPlaying?.arc).toMatchObject({ partIndex: 2, partCount: 3 })

    await store().prewarm()
    expect(store().pendingNext?.arc).toMatchObject({ partIndex: 3, partCount: 3 })
    await store().advance(true)
    expect(store().nowPlaying?.arc).toMatchObject({ partIndex: 3, partCount: 3 })

    // Handing out the final part releases the lock, so the lottery runs again.
    expect(getChannel(db, channelId)?.activeGroupId).toBeNull()

    await store().prewarm()
    expect(store().pendingNext?.arc).toBeNull()

    // Three parts in order, one log entry each, then one standalone.
    const log = playLog()
    expect(log).toHaveLength(4)
    expect(new Set(log.map((row) => row.episodeId)).size).toBe(4)
    expect(commits).toBe(4)
  })

  it('leaves the arc lock consistent when the viewer quits mid-arc after a prewarm', async () => {
    await store().tune(channelId)
    await store().prewarm()
    await store().leavePlayer()

    // Part 2 was handed out, so the channel is parked on part 3. Re-tuning must
    // resume the arc rather than restart it or wedge on a decision it can't finish.
    const channel = getChannel(db, channelId)
    expect(channel?.activeGroupId).not.toBeNull()
    expect(channel?.activePartIndex).toBe(2)

    await store().tune(channelId)
    expect(store().nowPlaying?.arc).toMatchObject({ partIndex: 3, partCount: 3 })
  })
})
