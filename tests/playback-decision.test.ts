/**
 * The playback decision is made once, at scan time, and everything downstream
 * (the stream server's branch, the Library screen's DIRECT/REMUX/TRANSCODE tag)
 * trusts it — so it gets its own test.
 */

import { describe, expect, it } from 'vitest'
import {
  decidePlaybackPath,
  episodeCode,
  formatDuration,
  isAudioSupported,
  isVideoSupported,
  normalizeContainer
} from '@shared/playback.js'

describe('normalizeContainer', () => {
  it('reduces ffprobe’s comma list to the canonical container name', () => {
    // ffprobe reports an MP4 as `mov,mp4,m4a,3gp,3g2,mj2`. Every member of that
    // family direct-plays, so the path decision is the same either way — but
    // `mp4` is the name that yields the right Content-Type, and `mov` (the
    // first entry) would have a plain .mp4 served as video/quicktime.
    expect(normalizeContainer('mov,mp4,m4a,3gp,3g2,mj2')).toBe('mp4')
    expect(decidePlaybackPath('mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac')).toBe('direct')
  })

  it('keeps a single name as-is, case-insensitively', () => {
    expect(normalizeContainer('MKV')).toBe('mkv')
    expect(normalizeContainer('avi')).toBe('avi')
  })

  it('falls back to the first entry when nothing in the list direct-plays', () => {
    expect(normalizeContainer('avi,nut')).toBe('avi')
  })

  it('falls back to unknown for an empty format name', () => {
    expect(normalizeContainer('')).toBe('unknown')
  })
})

describe('decidePlaybackPath', () => {
  it('direct-plays a well-formed MP4', () => {
    expect(decidePlaybackPath('mov,mp4,m4a,3gp,3g2,mj2', 'h264', 'aac')).toBe('direct')
    expect(decidePlaybackPath('webm', 'vp9', 'opus')).toBe('direct')
  })

  it('remuxes an MKV whose codecs are already fine — the common case', () => {
    expect(decidePlaybackPath('mkv', 'h264', 'aac')).toBe('remux')
    expect(decidePlaybackPath('matroska', 'h264', 'aac')).toBe('remux')
    expect(decidePlaybackPath('avi', 'h264', 'mp3')).toBe('remux')
  })

  it('resolves ffprobe’s ambiguous `matroska,webm` pessimistically', () => {
    // WebM is a Matroska subset, so the demuxer reports the same name list for
    // both. Picking `webm` out of it would mark every MKV in the library
    // direct-play and Chromium would refuse to demux them, so the ambiguous
    // case resolves to `matroska` and gets remuxed — a stream copy, cheap.
    // `library/ffprobe.ts` disambiguates with the file extension first, so a
    // genuine `.webm` still direct-plays; this is the fallback for callers
    // that can't.
    expect(normalizeContainer('matroska,webm')).toBe('matroska')
    expect(decidePlaybackPath('matroska,webm', 'h264', 'aac')).toBe('remux')
    expect(decidePlaybackPath('webm', 'vp9', 'opus')).toBe('direct')
  })

  it('transcodes when either codec is unsupported, whatever the container', () => {
    expect(decidePlaybackPath('mkv', 'hevc', 'dts')).toBe('transcode')
    expect(decidePlaybackPath('mkv', 'h264', 'dts')).toBe('transcode')
    // A native container cannot rescue an unplayable video codec.
    expect(decidePlaybackPath('mp4', 'hevc', 'aac')).toBe('transcode')
  })

  it('knows the Chromium codec sets', () => {
    expect(isVideoSupported('AVC1')).toBe(true)
    expect(isVideoSupported('mpeg2video')).toBe(false)
    expect(isAudioSupported('FLAC')).toBe(true)
    expect(isAudioSupported('truehd')).toBe(false)
  })
})

describe('episodeCode', () => {
  it('zero-pads season and episode', () => {
    expect(episodeCode(4, 11)).toBe('S04E11')
    expect(episodeCode(1, 3)).toBe('S01E03')
  })

  it('renders a double episode as a range', () => {
    expect(episodeCode(1, 3, 4)).toBe('S01E03-E04')
  })

  it('ignores a redundant or absent end number', () => {
    expect(episodeCode(1, 3, 3)).toBe('S01E03')
    expect(episodeCode(1, 3, null)).toBe('S01E03')
  })
})

describe('formatDuration', () => {
  it('omits the hour component under an hour', () => {
    expect(formatDuration(44 * 60)).toBe('44:00')
    expect(formatDuration(65)).toBe('1:05')
  })

  it('includes hours when there are any', () => {
    expect(formatDuration(3862)).toBe('1:04:22')
  })

  it('clamps junk to zero', () => {
    expect(formatDuration(-5)).toBe('0:00')
    expect(formatDuration(0)).toBe('0:00')
  })
})
