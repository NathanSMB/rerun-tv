/**
 * Screen 03 · The Channel Editor.
 *
 * Where a channel gets its personality. Every scheduling knob from plan §5 is a
 * visible control: the lineup itself (each show holds one lottery ticket per
 * `weight`), the per-show play mode (a cursor for *In order*, a dealt bag for
 * *Shuffle*), the arcs that ride along as single units, and the live progress
 * state with a way to reset it.
 *
 * The mutating `channels.*` calls all return a fresh `ChannelDetail`, but this
 * screen deliberately re-reads through the store (`refreshChannelDetail` +
 * `refreshChannels`) so the Guide's on-deck line — which is derived from the same
 * scheduler state — never falls out of sync with what the editor shows.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { LineupEntry, PlayMode } from '@shared/types.js'
import ChannelNumber from '../components/ChannelNumber.js'
import { useStore } from '../store.js'
import './ChannelEditor.css'

/** A weight is a lottery multiplier; past 10 the difference stops being legible. */
const MIN_WEIGHT = 1
const MAX_WEIGHT = 10

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export default function ChannelEditor(): ReactElement {
  const channels = useStore((s) => s.channels)
  const detail = useStore((s) => s.channelDetail)
  const editingChannelId = useStore((s) => s.editingChannelId)
  const shows = useStore((s) => s.shows)
  const library = useStore((s) => s.library)
  const openEditor = useStore((s) => s.openEditor)
  const refreshChannelDetail = useStore((s) => s.refreshChannelDetail)
  const refreshChannels = useStore((s) => s.refreshChannels)
  const navigate = useStore((s) => s.navigate)

  /** Name of the in-flight mutation, or null. Any value locks every control. */
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** Non-null while the header field is being edited inline. */
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [numberDraft, setNumberDraft] = useState<string | null>(null)

  const loadedId = detail?.channel.id ?? null
  const locked = busy !== null

  // The Guide's "Edit channel" goes through `openEditor`, which loads the detail
  // for us. Reaching this screen straight from the nav (or after a reload) can
  // leave a stale/absent detail, so reconcile it here.
  useEffect(() => {
    if (editingChannelId != null && loadedId !== editingChannelId) {
      void refreshChannelDetail(editingChannelId)
    }
  }, [editingChannelId, loadedId, refreshChannelDetail])

  /**
   * Run one mutation, then re-read the channel through the store. Every caller
   * gets a disabled UI for the duration and a visible message on failure.
   */
  async function run(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key)
    setError(null)
    try {
      await fn()
      await refreshChannelDetail()
      await refreshChannels()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const episodeCounts = useMemo(() => {
    const map = new Map<number, number>()
    for (const show of library?.shows ?? []) map.set(show.id, show.episodeCount)
    return map
  }, [library])

  const lineupIds = useMemo(
    () => new Set((detail?.lineup ?? []).map((entry) => entry.showId)),
    [detail]
  )

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    return shows.filter(
      (show) => !lineupIds.has(show.id) && (q === '' || show.title.toLowerCase().includes(q))
    )
  }, [shows, lineupIds, query])

  // ---- header editing -----------------------------------------------------

  function commitName(): void {
    if (nameDraft == null || detail == null) return
    const name = nameDraft.trim()
    setNameDraft(null)
    if (name === '' || name === detail.channel.name) return
    void run('name', () => window.rerun.channels.update(detail.channel.id, { name }))
  }

  function commitNumber(): void {
    if (numberDraft == null || detail == null) return
    const raw = numberDraft.trim()
    setNumberDraft(null)
    if (raw === '') return
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0) {
      setError('A channel number has to be a whole number, like 3.')
      return
    }
    if (value === detail.channel.number) return
    void run('number', () => window.rerun.channels.update(detail.channel.id, { number: value }))
  }

  // ---- lineup mutations ---------------------------------------------------

  const setMode = (entry: LineupEntry, mode: PlayMode): void => {
    if (entry.mode === mode || detail == null) return
    void run(`mode:${entry.showId}`, () =>
      window.rerun.channels.setMode(detail.channel.id, entry.showId, mode)
    )
  }

  const setSeasonMode = (
    entry: LineupEntry,
    season: number,
    mode: PlayMode | null
  ): void => {
    if (detail == null) return
    const current = entry.seasons.find((item) => item.season === season)?.modeOverride ?? null
    if (current === mode) return
    void run(`season-mode:${entry.showId}:${season}`, () =>
      window.rerun.channels.setSeasonMode(detail.channel.id, entry.showId, season, mode)
    )
  }

  const bumpWeight = (entry: LineupEntry, delta: number): void => {
    if (detail == null) return
    const weight = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, entry.weight + delta))
    if (weight === entry.weight) return
    void run(`weight:${entry.showId}`, () =>
      window.rerun.channels.setWeight(detail.channel.id, entry.showId, weight)
    )
  }

  const resetProgress = (entry: LineupEntry): void => {
    if (detail == null) return
    void run(`reset:${entry.showId}`, () =>
      window.rerun.channels.resetProgress(detail.channel.id, entry.showId)
    )
  }

  const removeShow = (entry: LineupEntry): void => {
    if (detail == null) return
    void run(`remove:${entry.showId}`, () =>
      window.rerun.channels.removeShow(detail.channel.id, entry.showId)
    )
  }

  const addShow = (showId: number): void => {
    if (detail == null) return
    void run(`add:${showId}`, () => window.rerun.channels.addShow(detail.channel.id, showId))
  }

  /**
   * The live scheduler state, in words. A bag counts down to a reshuffle; a
   * cursor names the episode the next airing of this show will continue from.
   */
  function renderProgress(entry: LineupEntry): ReactElement {
    const progress = entry.progress
    if (progress.kind === 'bag') {
      if (progress.remaining >= progress.total) {
        return (
          <div className="show-progress">
            <span>
              Shuffle bag: fresh cycle — nothing repeats until all {progress.total} units air
            </span>
          </div>
        )
      }
      return (
        <div className="show-progress">
          <span>
            Shuffle bag: {progress.remaining} of {progress.total} units left this cycle ·
          </span>
          <button
            type="button"
            className="linkbtn"
            disabled={locked}
            onClick={() => resetProgress(entry)}
          >
            reshuffle
          </button>
        </div>
      )
    }
    if (progress.code == null) {
      return (
        <div className="show-progress">
          <span>Cursor at the top of the run — the next airing starts with the pilot</span>
        </div>
      )
    }
    return (
      <div className="show-progress">
        <span>
          Cursor at <code>{progress.code}</code> — next airing continues from here ·
        </span>
        <button
          type="button"
          className="linkbtn"
          disabled={locked}
          onClick={() => resetProgress(entry)}
        >
          reset to pilot
        </button>
      </div>
    )
  }

  // ---- channel picker -----------------------------------------------------

  // Reached straight from the nav: nothing is open yet, so offer the dial.
  if (editingChannelId == null) {
    return (
      <div className="editor-body">
        <div className="editor-main">
          <div className="caption lineup-caption">Channels — pick one to edit</div>
          {channels.length === 0 ? (
            <div className="empty">
              <b>No channels yet</b>
              Channels are created in the Guide. Make one there, then come back to give it a
              lineup.
              <div className="empty-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('guide')}>
                  Go to the Guide
                </button>
              </div>
            </div>
          ) : (
            channels.map((summary) => (
              <button
                type="button"
                key={summary.channel.id}
                className="chpick"
                onClick={() => void openEditor(summary.channel.id)}
              >
                <ChannelNumber number={summary.channel.number} />
                <span className="chpick-meta">
                  <span className="show-name">{summary.channel.name}</span>
                  <span className="show-facts">
                    {summary.showTitles.length > 0
                      ? summary.showTitles.join(' · ')
                      : 'No shows in the lineup yet'}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    )
  }

  if (detail == null) {
    return (
      <div className="editor-body">
        <div className="editor-main">
          <div className="empty">Loading channel…</div>
        </div>
      </div>
    )
  }

  const { channel, lineup, totalUnits, totalArcs } = detail

  return (
    <div className="editor-body">
      <div className="editor-main">
        <div className="editor-head">
          {numberDraft == null ? (
            <button
              type="button"
              className="num-edit"
              aria-label={`Channel number ${channel.number}. Click to change.`}
              disabled={locked}
              onClick={() => setNumberDraft(String(channel.number))}
            >
              <ChannelNumber number={channel.number} />
            </button>
          ) : (
            <input
              className="textinput num-input"
              type="number"
              min={0}
              step={1}
              autoFocus
              aria-label="Channel number"
              value={numberDraft}
              onChange={(e) => setNumberDraft(e.target.value)}
              onBlur={commitNumber}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitNumber()
                if (e.key === 'Escape') setNumberDraft(null)
              }}
            />
          )}
          <div className="editor-headmeta">
            {nameDraft == null ? (
              <button
                type="button"
                className="editor-title name-edit"
                disabled={locked}
                onClick={() => setNameDraft(channel.name)}
                aria-label={`Channel name: ${channel.name}. Click to rename.`}
              >
                {channel.name}
              </button>
            ) : (
              <input
                className="textinput name-input"
                type="text"
                autoFocus
                aria-label="Channel name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName()
                  if (e.key === 'Escape') setNameDraft(null)
                }}
              />
            )}
            <div className="editor-subtitle">
              {plural(lineup.length, 'show')} · {plural(totalUnits, 'playable unit')} ·{' '}
              {plural(totalArcs, 'multipart arc')}
            </div>
          </div>
        </div>

        {error != null && (
          <p className="editor-error" role="alert">
            {error}
          </p>
        )}

        <div className="caption lineup-caption">
          Lineup — each pick draws a show by weight, then an episode by mode
        </div>

        {lineup.length === 0 ? (
          <div className="empty">
            <b>This channel has nothing to air</b>
            A channel needs at least one show before it can go on air. Add one from the list on
            the right — the scheduler will start drawing from it immediately.
          </div>
        ) : (
          lineup.map((entry) => (
            <div className="show-card" key={entry.showId}>
              <div>
                <div className="show-name">{entry.title}</div>
                <div className="show-facts">
                  {plural(entry.episodeCount, 'episode')} · {plural(entry.unitCount, 'unit')}
                  {entry.arcSummary != null && <span className="arcbadge">{entry.arcSummary}</span>}
                </div>
              </div>
              <div className="show-ctrls">
                <span className="seg" role="group" aria-label={`Play mode for ${entry.title}`}>
                  <button
                    type="button"
                    className={entry.mode === 'shuffle' ? 'on' : undefined}
                    aria-pressed={entry.mode === 'shuffle'}
                    disabled={locked}
                    onClick={() => setMode(entry, 'shuffle')}
                  >
                    Shuffle
                  </button>
                  <button
                    type="button"
                    className={entry.mode === 'sequential' ? 'on' : undefined}
                    aria-pressed={entry.mode === 'sequential'}
                    disabled={locked}
                    onClick={() => setMode(entry, 'sequential')}
                  >
                    In order
                  </button>
                </span>
                <span className="weight">
                  weight
                  <button
                    type="button"
                    className="w-step"
                    aria-label={`Lower the weight of ${entry.title}`}
                    disabled={locked || entry.weight <= MIN_WEIGHT}
                    onClick={() => bumpWeight(entry, -1)}
                  >
                    −
                  </button>
                  <span className="w-val">{entry.weight}</span>
                  <button
                    type="button"
                    className="w-step"
                    aria-label={`Raise the weight of ${entry.title}`}
                    disabled={locked || entry.weight >= MAX_WEIGHT}
                    onClick={() => bumpWeight(entry, 1)}
                  >
                    +
                  </button>
                </span>
                <button
                  type="button"
                  className="remove"
                  aria-label={`Remove ${entry.title} from this channel`}
                  disabled={locked}
                  onClick={() => removeShow(entry)}
                >
                  ✕
                </button>
              </div>
              {renderProgress(entry)}
              {entry.seasons.length > 0 && (
                <details className="season-overrides">
                  <summary>
                    Season overrides
                    {entry.seasons.some((season) => season.modeOverride != null) && (
                      <span className="override-count">
                        {
                          entry.seasons.filter((season) => season.modeOverride != null)
                            .length
                        }{' '}
                        active
                      </span>
                    )}
                  </summary>
                  <div className="season-list">
                    {entry.seasons.map((season) => (
                      <div className="season-row" key={season.season}>
                        <span className="season-label">
                          Season {season.season}
                          <small>{plural(season.episodeCount, 'episode')}</small>
                        </span>
                        <span
                          className="seg season-mode"
                          role="group"
                          aria-label={`Play mode for ${entry.title} season ${season.season}`}
                        >
                          <button
                            type="button"
                            className={season.modeOverride == null ? 'on' : undefined}
                            aria-pressed={season.modeOverride == null}
                            disabled={locked}
                            onClick={() => setSeasonMode(entry, season.season, null)}
                          >
                            Use show ({entry.mode === 'sequential' ? 'In order' : 'Shuffle'})
                          </button>
                          <button
                            type="button"
                            className={season.modeOverride === 'shuffle' ? 'on' : undefined}
                            aria-pressed={season.modeOverride === 'shuffle'}
                            disabled={locked}
                            onClick={() => setSeasonMode(entry, season.season, 'shuffle')}
                          >
                            Shuffle
                          </button>
                          <button
                            type="button"
                            className={season.modeOverride === 'sequential' ? 'on' : undefined}
                            aria-pressed={season.modeOverride === 'sequential'}
                            disabled={locked}
                            onClick={() => setSeasonMode(entry, season.season, 'sequential')}
                          >
                            In order
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          ))
        )}
      </div>

      <aside className="editor-side">
        <div className="caption side-caption">Add a show</div>
        {shows.length === 0 ? (
          <div className="empty">
            <b>The library is empty</b>
            Point Rerun TV at a folder of episodes and scan it — shows show up here as soon as
            the scanner has parsed them.
            <div className="empty-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => navigate('library')}
              >
                Open the Library
              </button>
            </div>
          </div>
        ) : (
          <>
            <input
              className="search"
              type="search"
              placeholder="Search library…"
              aria-label="Search the library for a show to add"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {candidates.length === 0 ? (
              <p className="side-note-empty">
                {query.trim() === ''
                  ? 'Every show in the library is already on this channel.'
                  : `Nothing in the library matches “${query.trim()}”.`}
              </p>
            ) : (
              candidates.map((show) => (
                <div className="pick" key={show.id}>
                  <span className="p-name">{show.title}</span>
                  <span className="p-eps">{episodeCounts.get(show.id) ?? 0} EP</span>
                  <button
                    type="button"
                    className="add"
                    aria-label={`Add ${show.title} to this channel`}
                    disabled={locked}
                    onClick={() => addShow(show.id)}
                  >
                    +
                  </button>
                </div>
              ))
            )}
          </>
        )}
      </aside>
    </div>
  )
}
