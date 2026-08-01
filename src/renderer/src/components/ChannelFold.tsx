/**
 * The channel editor, as a fold-out beneath a guide row.
 *
 * This is where the retired Channels screen went (docs/channel-edit-ux.html,
 * "Hot Rows"). Every scheduling knob from plan §5 is still a visible control —
 * the lineup itself (each show holds one lottery ticket per `weight`), the
 * per-show play mode (a cursor for *In order*, a dealt bag for *Shuffle*), the
 * season overrides, and the live progress state with a way to reset it — but the
 * layout is compressed to one strip per show so a channel can be tuned without
 * leaving the dial.
 *
 * Two things are load-bearing:
 *
 *  - The mutating `channels.*` calls all return a fresh `ChannelDetail`, and this
 *    component still re-reads through the store (`refreshChannelDetail` +
 *    `refreshChannels`) so the row above — whose on-deck line comes from the same
 *    scheduler state — never falls out of sync with the fold.
 *  - Deleting is a two-step *inside* the fold rather than a `window.confirm`:
 *    Electron does not implement `confirm()`, and an inline confirm keeps the
 *    destructive action attached to the channel it destroys.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { LineupEntry, PlayMode } from '@shared/types.js'
import { useStore } from '../store.js'
import './ChannelFold.css'

/** A weight is a lottery multiplier; past 10 the difference stops being legible. */
const MIN_WEIGHT = 1
const MAX_WEIGHT = 10

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

interface Props {
  channelId: number
  /** Close the fold — the Done button, and the delete that empties it. */
  onClose(): void
}

/**
 * Note that the Guide renders this inside the open row, so switching channels
 * (or closing and reopening) *remounts* it. Every draft below — a half-typed
 * rename, a search query, an armed delete — is therefore discarded by
 * construction rather than by a reset effect. Hoisting this component out of the
 * row would quietly break that, which is why `guide-fold.test.tsx` asserts the
 * behaviour rather than trusting the structure.
 */

export default function ChannelFold({ channelId, onClose }: Props): ReactElement {
  const detail = useStore((s) => s.channelDetail)
  const shows = useStore((s) => s.shows)
  const library = useStore((s) => s.library)
  const refreshChannelDetail = useStore((s) => s.refreshChannelDetail)
  const refreshChannels = useStore((s) => s.refreshChannels)
  const navigate = useStore((s) => s.navigate)

  /** Name of the in-flight mutation, or null. Any value locks every control. */
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  /** Non-null while the identity field is being edited inline. */
  const [nameDraft, setNameDraft] = useState<string | null>(null)
  const [numberDraft, setNumberDraft] = useState<string | null>(null)
  /** The delete button has been pressed once and is awaiting confirmation. */
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const confirmRef = useRef<HTMLButtonElement | null>(null)

  const locked = busy !== null

  // Arming the delete moves focus onto the confirm, so the destructive button is
  // never the thing a stray Enter lands on — the user has to arrive deliberately.
  useEffect(() => {
    if (confirmingDelete) confirmRef.current?.focus()
  }, [confirmingDelete])

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

  // ---- identity -----------------------------------------------------------

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

  async function deleteChannel(): Promise<void> {
    if (detail == null) return
    setBusy('delete')
    setError(null)
    try {
      await window.rerun.channels.remove(detail.channel.id)
      // Close before refreshing: the fold is about to have no channel to show,
      // and `refreshChannels` would clear the editor out from under it anyway.
      onClose()
      await refreshChannels()
    } catch (err) {
      setError(errorText(err))
      setConfirmingDelete(false)
    } finally {
      setBusy(null)
    }
  }

  // ---- lineup mutations ---------------------------------------------------

  const setMode = (entry: LineupEntry, mode: PlayMode): void => {
    if (entry.mode === mode || detail == null) return
    void run(`mode:${entry.showId}`, () =>
      window.rerun.channels.setMode(detail.channel.id, entry.showId, mode)
    )
  }

  const setSeasonMode = (entry: LineupEntry, season: number, mode: PlayMode | null): void => {
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
          <span className="strip-sub">
            Shuffle bag: fresh cycle — nothing repeats until all {progress.total} units air
          </span>
        )
      }
      return (
        <span className="strip-sub">
          Shuffle bag: {progress.remaining} of {progress.total} units left this cycle ·{' '}
          <button
            type="button"
            className="linkbtn"
            disabled={locked}
            onClick={() => resetProgress(entry)}
          >
            reshuffle
          </button>
        </span>
      )
    }
    if (progress.code == null) {
      return (
        <span className="strip-sub">
          Cursor at the top of the run — the next airing starts with the pilot
        </span>
      )
    }
    return (
      <span className="strip-sub">
        Cursor at <code>{progress.code}</code> — next airing continues from here ·{' '}
        <button
          type="button"
          className="linkbtn"
          disabled={locked}
          onClick={() => resetProgress(entry)}
        >
          reset to pilot
        </button>
      </span>
    )
  }

  // ---- render -------------------------------------------------------------

  // `openEditor` clears the detail before loading, so this is the ordinary state
  // for a frame or two rather than an error.
  if (detail == null || detail.channel.id !== channelId) {
    return (
      <div className="fold-panel fold-loading" role="status">
        Loading channel&hellip;
      </div>
    )
  }

  const { channel, lineup, totalUnits, totalArcs } = detail

  return (
    <div className="fold-panel">
      <div className="fold-bar">
        <span className="caption">
          Editing CH {String(channel.number).padStart(2, '0')} · {channel.name} — changes air
          immediately
        </span>
        <button type="button" className="btn btn-tune btn-sm" onClick={onClose}>
          Done
        </button>
      </div>

      {error != null && (
        <p className="fold-error" role="alert">
          {error}
        </p>
      )}

      <div className="fold-cols">
        <div className="fold-left">
          {/* Identity: rename, renumber, and delete — the three things that act on
              the channel itself rather than on its lineup — kept on one line. */}
          <div className="fold-idline">
            {nameDraft == null ? (
              <button
                type="button"
                className="idpill"
                disabled={locked}
                onClick={() => setNameDraft(channel.name)}
                aria-label={`Channel name: ${channel.name}. Click to rename.`}
              >
                {channel.name} <small>✎ rename</small>
              </button>
            ) : (
              <input
                className="textinput id-input"
                type="text"
                autoFocus
                maxLength={60}
                aria-label="Channel name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitName()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setNameDraft(null)
                  }
                }}
              />
            )}

            {numberDraft == null ? (
              <button
                type="button"
                className="idpill"
                disabled={locked}
                onClick={() => setNumberDraft(String(channel.number))}
                aria-label={`Channel number ${channel.number}. Click to change.`}
              >
                CH {String(channel.number).padStart(2, '0')} <small>✎ renumber</small>
              </button>
            ) : (
              <input
                className="textinput id-input num-input"
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
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setNumberDraft(null)
                  }
                }}
              />
            )}

            {confirmingDelete ? (
              <span className="del-confirm">
                <span className="del-warn">Deletes its lineup and progress —</span>
                <button
                  ref={confirmRef}
                  type="button"
                  className="btn-del solid"
                  disabled={locked}
                  onClick={() => void deleteChannel()}
                >
                  Delete for good
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={locked}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn-del"
                disabled={locked}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete channel
              </button>
            )}
          </div>

          <div className="caption fold-caption">
            Lineup — each pick draws a show by weight, then an episode by mode
          </div>

          {lineup.length === 0 ? (
            <p className="fold-empty">
              <b>This channel has nothing to air.</b> Add a show from the library on the right
              and the scheduler starts drawing from it immediately.
            </p>
          ) : (
            lineup.map((entry) => (
              <div className="strip" key={entry.showId}>
                <span className="strip-name">
                  {entry.title}
                  <span className="strip-facts">
                    {entry.episodeCount} EP · {plural(entry.unitCount, 'unit')}
                    {entry.arcSummary != null && (
                      <span className="arcbadge">{entry.arcSummary}</span>
                    )}
                  </span>
                </span>

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
                  wt
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

                {renderProgress(entry)}

                {entry.seasons.length > 0 && (
                  <details className="season-overrides">
                    <summary>
                      Season overrides
                      {entry.seasons.some((season) => season.modeOverride != null) && (
                        <span className="override-count">
                          {entry.seasons.filter((season) => season.modeOverride != null).length}{' '}
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

          <p className="fold-facts">
            {plural(lineup.length, 'show')} · {plural(totalUnits, 'playable unit')} ·{' '}
            {plural(totalArcs, 'multipart arc')}
          </p>
        </div>

        <div className="fold-right">
          <span className="caption">Add a show</span>
          {shows.length === 0 ? (
            <p className="fold-empty">
              <b>The library is empty.</b> Point Rerun TV at a folder of episodes and scan it —
              shows appear here as soon as the scanner has parsed them.
              <button
                type="button"
                className="btn btn-ghost btn-sm fold-empty-action"
                onClick={() => navigate('library')}
              >
                Open the Library
              </button>
            </p>
          ) : (
            <>
              <input
                className="search"
                type="search"
                placeholder="Search library…"
                aria-label="Search the library for a show to add"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Esc clears the search rather than folding the editor shut —
                  // closing on a keystroke aimed at a text field loses work.
                  if (e.key === 'Escape' && query !== '') {
                    e.stopPropagation()
                    setQuery('')
                  }
                }}
              />
              {candidates.length === 0 ? (
                <p className="fold-note">
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
        </div>
      </div>
    </div>
  )
}
