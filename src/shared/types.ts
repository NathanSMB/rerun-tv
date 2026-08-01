/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 *
 * Nothing in here may import Node or DOM APIs — this module is bundled into all
 * three build targets. Rows read straight out of SQLite are camel-cased at the
 * repository boundary, so the renderer never sees snake_case.
 */

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/** How the stream server will deliver a given file. Decided once, at scan time. */
export type PlaybackPath = 'direct' | 'remux' | 'transcode'

/** How a show draws its next unit when the channel picks it. */
export type PlayMode = 'sequential' | 'shuffle'

/** Where a multipart arc came from: the Part-N heuristic, or the user. */
export type ArcSource = 'auto' | 'manual'

export interface Show {
  id: number
  title: string
  folderPath: string
  addedAt: number
}

export interface Episode {
  id: number
  showId: number
  season: number
  /** First episode number. For a double (`S01E03-E04`) this is 3. */
  episode: number
  /** Last episode number for a multi-episode file, else null. */
  episodeEnd: number | null
  title: string | null
  path: string
  durationS: number
  container: string
  vcodec: string
  acodec: string
  width: number | null
  height: number | null
  /** Arc membership — null for a standalone episode. */
  partGroupId: number | null
  /** 1-based position inside the arc, null when not in an arc. */
  partIndex: number | null
  playbackPath: PlaybackPath
  /** Rescan key: a file is re-probed only when mtime or size changed. */
  mtimeMs: number
  sizeBytes: number
}

/**
 * One episode's measured EBU R128 loudness, as reported by ffmpeg's `loudnorm`
 * filter (`main/stream/loudness.ts`).
 *
 * Deliberately *not* part of `Episode`. The scanner owns every other column on
 * that row and rewrites them on each pass; loudness is measured by a separate,
 * much slower background job, so keeping it off `EpisodeInput` is what stops an
 * ordinary rescan from having an opinion about it.
 */
export interface LoudnessMeasurement {
  /** Integrated loudness of the source, LUFS. */
  i: number
  /** True peak, dBTP. */
  tp: number
  /** Loudness range, LU. */
  lra: number
  /** Gating threshold, LUFS. */
  thresh: number
}

export interface PartGroup {
  id: number
  showId: number
  title: string
  source: ArcSource
}

export interface ScanRoot {
  id: number
  path: string
  addedAt: number
}

export interface UnmatchedFile {
  id: number
  path: string
  reason: string
  mtimeMs: number
  sizeBytes: number
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface Channel {
  id: number
  name: string
  /** The dial number shown in the guide. Unique. */
  number: number
  accent: string | null
  /** Set while a multipart arc is airing; nothing may interrupt it. */
  activeGroupId: number | null
  activePartIndex: number | null
  sortOrder: number
}

export interface ChannelShow {
  channelId: number
  showId: number
  mode: PlayMode
  /** Lottery weight. A show with weight 2 is drawn twice as often as weight 1. */
  weight: number
}

/** A season can override its channel/show mode; no row means "inherit". */
export interface ChannelShowSeasonMode {
  channelId: number
  showId: number
  season: number
  mode: PlayMode
}

export interface ChannelShowState {
  channelId: number
  showId: number
  /** Index into the show's unit list, for `sequential` mode. */
  cursorUnitIndex: number
  /** Remaining unit keys for `shuffle` mode; refilled when empty. */
  shuffleBag: string[]
}

export interface PlayLogEntry {
  id: number
  channelId: number
  episodeId: number
  at: number
  completed: boolean
}

// ---------------------------------------------------------------------------
// Playable units — the key abstraction
// ---------------------------------------------------------------------------

/**
 * A unit is either one standalone episode or a whole multipart arc. Cursors,
 * shuffle bags and the weighted lottery all operate on units, never on raw
 * episodes, which is what makes an arc uninterruptible *and* exactly as likely
 * to air as any single episode.
 */
export interface PlayableUnit {
  /** Stable identity used inside shuffle bags: `ep:<id>` or `arc:<groupId>`. */
  key: string
  kind: 'episode' | 'arc'
  showId: number
  /** Arc title for `arc`, episode title (or code) for `episode`. */
  title: string
  /** Episode ids in airing order. Length 1 for a standalone episode. */
  episodeIds: number[]
  /** Sort position within the show, in season/episode order. */
  season: number
  episode: number
}

// ---------------------------------------------------------------------------
// View models — shapes the renderer consumes
// ---------------------------------------------------------------------------

/** An episode flattened for display: everything the OSD and guide need. */
export interface EpisodeView {
  id: number
  showId: number
  showTitle: string
  season: number
  episode: number
  episodeEnd: number | null
  title: string | null
  /** `S04E11`, or `S01E03-E04` for a double. */
  code: string
  durationS: number
  playbackPath: PlaybackPath
}

export interface ChannelSummary {
  channel: Channel
  /** Show titles in lineup order, for the right-hand column of the guide. */
  showTitles: string[]
  /** The scheduler's actual next pick — precomputed so tune-in is instant. */
  onDeck: EpisodeView | null
}

/** Live scheduling state for one show in one channel's lineup. */
export type LineupProgress =
  | { kind: 'cursor'; code: string | null }
  | { kind: 'bag'; remaining: number; total: number }

export interface LineupEntry {
  showId: number
  title: string
  mode: PlayMode
  weight: number
  episodeCount: number
  unitCount: number
  arcCount: number
  /** e.g. `"AWAKENING" ×5 + 2 MORE`, or null when the show has no arcs. */
  arcSummary: string | null
  seasons: Array<{
    season: number
    episodeCount: number
    /** Null inherits `LineupEntry.mode`. */
    modeOverride: PlayMode | null
    effectiveMode: PlayMode
  }>
  progress: LineupProgress
}

export interface ChannelDetail {
  channel: Channel
  lineup: LineupEntry[]
  totalUnits: number
  totalArcs: number
}

export interface LibraryShow {
  id: number
  title: string
  episodeCount: number
  seasonCount: number
  arcCount: number
  paths: Record<PlaybackPath, number>
  /**
   * How many of the `remux` episodes need their soundtrack encoded to AAC on the
   * way through (AC3, DTS and friends). The video is still a byte copy for all
   * of them — this is only here so the REMUX tag can stay honest about what
   * ffmpeg is actually doing.
   */
  remuxAudioEncode: number
}

export interface LibraryOverview {
  shows: LibraryShow[]
  unmatched: UnmatchedFile[]
  totalEpisodes: number
}

export interface ArcView {
  id: number
  showId: number
  title: string
  source: ArcSource
  partCount: number
  /** `S01E01–E05` */
  range: string
  episodeIds: number[]
}

export type ScanState = 'idle' | 'scanning' | 'paused'

export interface ScanStatus {
  state: ScanState
  /** Files seen in this pass. */
  total: number
  /** Files processed so far. */
  done: number
  /** Files that were new or changed and therefore actually probed. */
  probed: number
  /** Root currently being walked, for the "Scanning ~/TV" label. */
  currentRoot: string | null
  error: string | null
}

export interface NowPlaying {
  channelId: number
  channelNumber: number
  channelName: string
  episode: EpisodeView
  /** Loopback URL the `<video>` element points at. */
  streamUrl: string
  /** Arc context, when this episode is part of a multipart arc. */
  arc: { title: string; partIndex: number; partCount: number } | null
}

/**
 * What the last database import replaced, and where the old database went.
 *
 * Written into the imported database itself at boot, because the restart that
 * finishes an import takes the renderer's status banner with it — this receipt
 * is the only thing left to tell the user where their safety copy landed.
 */
export interface RestoreReceipt {
  /** The file the user picked. */
  sourcePath: string
  /** ISO timestamp of the swap. */
  restoredAt: string
  /** The pre-restore copy of the database that was replaced. */
  backupPath: string | null
  shows: number
  episodes: number
  channels: number
}

export interface SystemInfo {
  appVersion: string
  ffmpegPath: string | null
  ffprobePath: string | null
  ffmpegVersion: string | null
  /** Whether ffmpeg came from PATH (`system`) or the bundled fallback. */
  ffmpegSource: 'system' | 'bundled' | 'missing'
  /** H.264/AAC decode asserted against an embedded test asset at startup. */
  codecCheck: 'ok' | 'failed' | 'pending'
  dbPath: string
  dbSizeBytes: number
  streamPort: number | null
  /** Set once this database arrived via an import; null on a normal database. */
  lastRestore: RestoreReceipt | null
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** Persisted so the player restores volume/mute on launch. */
  volume: number
  muted: boolean
  rememberVolume: boolean
  watchFolders: boolean
  /** x264 preset used on the transcode path. */
  transcodePreset: string
  transcodeCrf: number
  transcodeAudioBitrate: string
  hardwareEncode: boolean
  /** Start the next stream during the last 30 s for a gapless handoff. */
  prewarmNext: boolean
  /**
   * Even out volume across episodes and between scenes (EBU R128, −16 LUFS).
   *
   * Off by default because it is not free: it forces an AAC encode onto files
   * whose audio would otherwise have been copied byte-for-byte, and takes a
   * direct-play file down the remux pipe. See `stream/loudness.ts`.
   */
  loudnessEq: boolean
  startScreen: 'guide' | 'channels' | 'library' | 'settings'
  /** Seconds of idle before the OSD fades. */
  osdHideAfterS: number
  /**
   * Minutes the sleep timer arms for on its first press in the player.
   *
   * Only the starting point: the sleep panel opens on this value and the dial
   * takes it anywhere from there. The timer itself is never persisted — an armed
   * countdown surviving a restart would be a surprise, not a convenience.
   */
  sleepTimerDefaultMin: number
}

/**
 * The ceiling on an armed sleep timer, in minutes.
 *
 * Five hours is past the length of any evening's viewing, so the dial's far end
 * means "don't stop tonight" rather than a limit anyone bumps into. It is a
 * shared constant because three places must agree on it: the store clamps to it,
 * the panel's dial spans it, and Settings won't offer a default above it.
 */
export const SLEEP_MAX_MIN = 300

/**
 * The dial's detent, in minutes.
 *
 * Small enough that no bedtime is out of reach, coarse enough that the whole
 * range is 61 stops — a drag that snaps rather than one that has to be aimed.
 */
export const SLEEP_STEP_MIN = 5

export const DEFAULT_SETTINGS: AppSettings = {
  volume: 0.7,
  muted: false,
  rememberVolume: true,
  watchFolders: true,
  transcodePreset: 'veryfast',
  transcodeCrf: 21,
  transcodeAudioBitrate: '192k',
  hardwareEncode: false,
  prewarmNext: true,
  loudnessEq: false,
  startScreen: 'guide',
  osdHideAfterS: 3,
  sleepTimerDefaultMin: 30
}

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export interface CreateChannelInput {
  name: string
  number?: number
}

export interface UpdateChannelInput {
  name?: string
  number?: number
  accent?: string | null
}

export interface AssignUnmatchedInput {
  fileId: number
  showId: number
  season: number
  episode: number
  episodeEnd?: number | null
  title?: string | null
}

export interface CreateArcInput {
  showId: number
  episodeIds: number[]
  title: string
}
