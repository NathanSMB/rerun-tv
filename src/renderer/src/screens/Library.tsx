/**
 * Screen 04 · The Library.
 *
 * Where files become television (plan §3). Three jobs:
 *
 * 1. **Scan status** — a live strip driven by `scan` push events from main, with
 *    the one button that means pause / resume / rescan depending on state.
 * 2. **Shows** — what the scanner parsed, and how each file will play (the
 *    DIRECT / REMUX / TRANSCODE decision made once at scan time, plan §6).
 *    Unparseable files wait in the Unmatched queue instead of vanishing, and can
 *    be assigned by hand or dismissed.
 * 3. **Arcs** — the Part-N heuristic only proposes; this panel is the source of
 *    truth the scheduler obeys, so it can ungroup false positives and group a
 *    consecutive run the heuristic missed.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactElement
} from 'react'
import type { ArcView, Episode, LibraryShow, ScanRoot, Show, UnmatchedFile } from '@shared/types.js'
import { episodeCode } from '@shared/playback.js'
import { useStore } from '../store.js'
import './Library.css'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Season/episode order — the order the scheduler walks a show in. */
function byAiring(a: Episode, b: Episode): number {
  return a.season - b.season || a.episode - b.episode
}

export default function Library(): ReactElement {
  const library = useStore((s) => s.library)
  const shows = useStore((s) => s.shows)
  const scan = useStore((s) => s.scan)
  const refreshLibrary = useStore((s) => s.refreshLibrary)
  const navigate = useStore((s) => s.navigate)

  /** null while the roots are still being read — the empty state must not flash. */
  const [roots, setRoots] = useState<ScanRoot[] | null>(null)
  const [selectedShowId, setSelectedShowId] = useState<number | null>(null)
  const [arcs, setArcs] = useState<ArcView[]>([])
  const [arcsBusy, setArcsBusy] = useState(false)
  const [arcsError, setArcsError] = useState<string | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [assigningId, setAssigningId] = useState<number | null>(null)
  const [dismissingId, setDismissingId] = useState<number | null>(null)
  const [buildingArc, setBuildingArc] = useState(false)

  useEffect(() => {
    let alive = true
    window.rerun.library
      .listRoots()
      .then((next) => {
        if (alive) setRoots(next)
      })
      .catch((err: unknown) => {
        if (alive) {
          setRoots([])
          setActionError(errorText(err))
        }
      })
    return () => {
      alive = false
    }
  }, [])

  // Keep a show selected so the arc panel always has something to show.
  useEffect(() => {
    if (library == null) return
    const stillThere = library.shows.some((show) => show.id === selectedShowId)
    if (!stillThere) setSelectedShowId(library.shows[0]?.id ?? null)
  }, [library, selectedShowId])

  const reloadArcs = useCallback(async (showId: number | null): Promise<void> => {
    if (showId == null) {
      setArcs([])
      return
    }
    setArcsBusy(true)
    setArcsError(null)
    try {
      setArcs(await window.rerun.library.listArcs(showId))
    } catch (err) {
      setArcsError(errorText(err))
    } finally {
      setArcsBusy(false)
    }
  }, [])

  useEffect(() => {
    void reloadArcs(selectedShowId)
    setBuildingArc(false)
  }, [selectedShowId, reloadArcs])

  const selectedShow: LibraryShow | null = useMemo(
    () => library?.shows.find((show) => show.id === selectedShowId) ?? null,
    [library, selectedShowId]
  )

  // ---- scan strip ---------------------------------------------------------

  const scanLabel =
    scan.state === 'scanning'
      ? `Scanning ${scan.currentRoot ?? 'library'} · incremental`
      : scan.state === 'paused'
        ? `Paused · ${scan.currentRoot ?? 'library'}`
        : 'Library · scanner idle'

  const scanButtonLabel =
    scan.state === 'scanning' ? 'Pause scan' : scan.state === 'paused' ? 'Resume scan' : 'Rescan'

  const pct = scan.total > 0 ? Math.min(100, Math.round((scan.done / scan.total) * 100)) : 0

  async function onScanButton(): Promise<void> {
    setScanBusy(true)
    setActionError(null)
    try {
      if (scan.state === 'scanning') await window.rerun.library.pauseScan()
      else if (scan.state === 'paused') await window.rerun.library.resumeScan()
      else await window.rerun.library.rescan()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setScanBusy(false)
    }
  }

  async function onDismiss(file: UnmatchedFile): Promise<void> {
    setDismissingId(file.id)
    setActionError(null)
    try {
      await window.rerun.library.dismissUnmatched(file.id)
      await refreshLibrary()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setDismissingId(null)
    }
  }

  async function onUngroup(arc: ArcView): Promise<void> {
    setArcsBusy(true)
    setArcsError(null)
    try {
      await window.rerun.library.deleteArc(arc.id)
      await refreshLibrary()
      await reloadArcs(selectedShowId)
    } catch (err) {
      setArcsError(errorText(err))
    } finally {
      setArcsBusy(false)
    }
  }

  const noRoots = roots != null && roots.length === 0
  const noEpisodes = !noRoots && library != null && library.totalEpisodes === 0
  const unmatched = library?.unmatched ?? []

  return (
    <>
      <div className="lib-scan">
        <div className="lib-scan-info">
          <div className="caption scan-label">{scanLabel}</div>
          <div
            className="progress"
            role="progressbar"
            aria-label="Scan progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
          >
            <div className="fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="scan-note">
            <b>
              {scan.done.toLocaleString()} of {scan.total.toLocaleString()}
            </b>{' '}
            files probed · {scan.probed.toLocaleString()} new since last scan · unchanged files
            skipped
          </div>
          {scan.error != null && (
            <p className="lib-error" role="alert">
              {scan.error}
            </p>
          )}
          {actionError != null && (
            <p className="lib-error" role="alert">
              {actionError}
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={scanBusy || noRoots}
          onClick={() => void onScanButton()}
        >
          {scanBusy ? 'Working…' : scanButtonLabel}
        </button>
      </div>

      <div className="lib-body">
        <div className="lib-main">
          {noRoots ? (
            <div className="empty">
              <b>No folders to scan yet</b>
              Rerun TV needs at least one library folder — a directory whose top-level folders are
              show names. Add one in Settings and the scanner will take it from there.
              <div className="lib-empty-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => navigate('settings')}
                >
                  Open Settings
                </button>
              </div>
            </div>
          ) : noEpisodes ? (
            <div className="empty">
              <b>Nothing scanned yet</b>
              Your folders are configured but no episodes have been parsed. Run a scan — files are
              keyed by path, size and mtime, so nothing is probed twice.
              <div className="lib-empty-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={scanBusy}
                  onClick={() => void onScanButton()}
                >
                  {scanButtonLabel}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="caption lineup-caption">Shows — with how each file will play</div>
              {(library?.shows ?? []).map((show) => (
                <button
                  type="button"
                  key={show.id}
                  className={`show-row${show.id === selectedShowId ? ' sel' : ''}`}
                  aria-pressed={show.id === selectedShowId}
                  onClick={() => setSelectedShowId(show.id)}
                >
                  <span className="s-block">
                    <span className="s-name">{show.title}</span>
                    <span className="s-facts">
                      {plural(show.episodeCount, 'episode')} · {plural(show.seasonCount, 'season')} ·{' '}
                      {plural(show.arcCount, 'arc')}
                    </span>
                  </span>
                  <span className="pipetags">
                    <span className="pipetag">DIRECT {show.paths.direct}</span>
                    <span className="pipetag">REMUX {show.paths.remux}</span>
                    <span className="pipetag warn">TRANSCODE {show.paths.transcode}</span>
                  </span>
                  <span className="s-ok">✓ READY</span>
                </button>
              ))}

              <div className="caption lineup-caption">
                {unmatched.length === 0
                  ? 'Unmatched — nothing waiting'
                  : `Unmatched — ${plural(unmatched.length, 'file')} waiting for a home`}
              </div>
              {unmatched.length === 0 ? (
                <p className="lib-note">
                  Every file the scanner saw parsed into a show, season and episode.
                </p>
              ) : (
                unmatched.map((file) => (
                  <div key={file.id}>
                    <div className="file-row">
                      <span className="file-path" title={file.reason}>
                        {file.path}
                      </span>
                      <span className="file-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-expanded={assigningId === file.id}
                          onClick={() =>
                            setAssigningId(assigningId === file.id ? null : file.id)
                          }
                        >
                          Assign…
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={dismissingId === file.id}
                          onClick={() => void onDismiss(file)}
                        >
                          {dismissingId === file.id ? 'Dismissing…' : 'Dismiss'}
                        </button>
                      </span>
                    </div>
                    {assigningId === file.id && (
                      <AssignPanel
                        file={file}
                        shows={shows}
                        onCancel={() => setAssigningId(null)}
                        onAssigned={async () => {
                          setAssigningId(null)
                          await refreshLibrary()
                        }}
                      />
                    )}
                  </div>
                ))
              )}
            </>
          )}
        </div>

        <aside className="lib-side">
          <div className="caption side-caption">
            Detected arcs · {selectedShow?.title ?? 'no show selected'}
          </div>

          {arcsError != null && (
            <p className="lib-error" role="alert">
              {arcsError}
            </p>
          )}

          {selectedShow == null ? (
            <p className="side-tip">Select a show to review the arcs the scheduler will obey.</p>
          ) : (
            <>
              {arcsBusy && arcs.length === 0 && <p className="lib-note">Loading arcs…</p>}
              {!arcsBusy && arcs.length === 0 && (
                <p className="lib-note">
                  No arcs in {selectedShow.title}. Every episode is drawn on its own.
                </p>
              )}
              {arcs.map((arc) => (
                <div className="arc-card" key={arc.id}>
                  <div className="a-name">“{arc.title}”</div>
                  <div className="a-meta">
                    {arc.partCount} PARTS · {arc.range} ·{' '}
                    {arc.source === 'auto' ? 'AUTO-DETECTED' : 'GROUPED BY YOU'}
                  </div>
                  <button
                    type="button"
                    className="linkbtn"
                    disabled={arcsBusy}
                    onClick={() => void onUngroup(arc)}
                  >
                    Ungroup
                  </button>
                </div>
              ))}

              <p className="side-tip">
                Select a consecutive run of episodes in any show to group it into an arc the
                scheduler will never interrupt.
              </p>

              {buildingArc ? (
                <ArcBuilder
                  showId={selectedShow.id}
                  onCancel={() => setBuildingArc(false)}
                  onCreated={async () => {
                    setBuildingArc(false)
                    await refreshLibrary()
                    await reloadArcs(selectedShow.id)
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setBuildingArc(true)}
                >
                  New arc from selection
                </button>
              )}
            </>
          )}
        </aside>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Unmatched → show/season/episode
// ---------------------------------------------------------------------------

/**
 * The manual fix-up for a file the parser couldn't read. Inputs are validated
 * here (a show, positive integers, a sane double-episode range) so the obvious
 * mistakes never reach IPC; anything the main process rejects — a duplicate
 * episode, say — is surfaced verbatim rather than swallowed.
 */
function AssignPanel({
  file,
  shows,
  onAssigned,
  onCancel
}: {
  file: UnmatchedFile
  shows: Show[]
  onAssigned: () => Promise<void>
  onCancel: () => void
}): ReactElement {
  const [showId, setShowId] = useState<string>(shows[0] != null ? String(shows[0].id) : '')
  const [season, setSeason] = useState('1')
  const [episode, setEpisode] = useState('1')
  const [episodeEnd, setEpisodeEnd] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const id = `assign-${file.id}`

  function positiveInt(raw: string): number | null {
    const value = Number(raw)
    return Number.isInteger(value) && value > 0 ? value : null
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)

    const show = Number(showId)
    if (!Number.isInteger(show) || show <= 0) return setError('Pick a show for this file.')
    const s = positiveInt(season)
    if (s == null) return setError('Season has to be a whole number, 1 or more.')
    const e = positiveInt(episode)
    if (e == null) return setError('Episode has to be a whole number, 1 or more.')
    let end: number | null = null
    if (episodeEnd.trim() !== '') {
      end = positiveInt(episodeEnd)
      if (end == null) return setError('Episode end has to be a whole number, 1 or more.')
      if (end < e) return setError('Episode end has to be the same as, or after, the episode.')
    }

    setBusy(true)
    try {
      await window.rerun.library.assignUnmatched({
        fileId: file.id,
        showId: show,
        season: s,
        episode: e,
        episodeEnd: end,
        title: title.trim() === '' ? null : title.trim()
      })
      await onAssigned()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="assign" onSubmit={(event) => void submit(event)}>
      <p className="assign-why">Parser said: {file.reason}</p>
      <div className="assign-grid">
        <label htmlFor={`${id}-show`}>Show</label>
        <select
          id={`${id}-show`}
          className="selectbox"
          value={showId}
          disabled={busy || shows.length === 0}
          onChange={(event) => setShowId(event.target.value)}
        >
          {shows.length === 0 && <option value="">No shows in the library yet</option>}
          {shows.map((show) => (
            <option key={show.id} value={String(show.id)}>
              {show.title}
            </option>
          ))}
        </select>

        <label htmlFor={`${id}-season`}>Season</label>
        <input
          id={`${id}-season`}
          className="textinput"
          type="number"
          min={1}
          step={1}
          value={season}
          disabled={busy}
          onChange={(event) => setSeason(event.target.value)}
        />

        <label htmlFor={`${id}-episode`}>Episode</label>
        <input
          id={`${id}-episode`}
          className="textinput"
          type="number"
          min={1}
          step={1}
          value={episode}
          disabled={busy}
          onChange={(event) => setEpisode(event.target.value)}
        />

        <label htmlFor={`${id}-end`}>Episode end</label>
        <input
          id={`${id}-end`}
          className="textinput"
          type="number"
          min={1}
          step={1}
          placeholder="only for a double"
          value={episodeEnd}
          disabled={busy}
          onChange={(event) => setEpisodeEnd(event.target.value)}
        />

        <label htmlFor={`${id}-title`}>Title</label>
        <input
          id={`${id}-title`}
          className="textinput"
          type="text"
          placeholder="optional"
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      {error != null && (
        <p className="lib-error" role="alert">
          {error}
        </p>
      )}
      <div className="assign-actions">
        <button type="submit" className="btn btn-tune btn-sm" disabled={busy}>
          {busy ? 'Assigning…' : 'Assign'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// New arc from selection
// ---------------------------------------------------------------------------

/**
 * Group a consecutive run of episodes into an arc. "Consecutive" is checked
 * against the show's airing order rather than raw episode numbers, so a gap in
 * the numbering (a missing file) still counts as adjacent — and the requirement
 * is stated in the UI before the main process has to reject anything.
 */
function ArcBuilder({
  showId,
  onCreated,
  onCancel
}: {
  showId: number
  onCreated: () => Promise<void>
  onCancel: () => void
}): ReactElement {
  const [episodes, setEpisodes] = useState<Episode[] | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setEpisodes(null)
    setSelected([])
    window.rerun.library
      .listEpisodes(showId)
      .then((eps) => {
        if (alive) setEpisodes([...eps].sort(byAiring))
      })
      .catch((err: unknown) => {
        if (alive) {
          setEpisodes([])
          setError(errorText(err))
        }
      })
    return () => {
      alive = false
    }
  }, [showId])

  const ordered = episodes ?? []
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const indices = ordered.map((ep, i) => (selectedSet.has(ep.id) ? i : -1)).filter((i) => i >= 0)
  const first = indices[0]
  const last = indices[indices.length - 1]
  const isRun =
    indices.length >= 2 && last != null && first != null && last - first + 1 === indices.length

  let hint: string
  if (indices.length === 0) hint = 'Pick the episodes that make up the arc, in order.'
  else if (indices.length === 1) hint = 'An arc needs at least two parts.'
  else if (!isRun && first != null && last != null)
    hint = `Not a consecutive run — everything from ${episodeCode(
      ordered[first].season,
      ordered[first].episode,
      ordered[first].episodeEnd
    )} to ${episodeCode(
      ordered[last].season,
      ordered[last].episode,
      ordered[last].episodeEnd
    )} has to be selected.`
  else hint = `${indices.length} parts selected.`

  function toggle(episodeId: number): void {
    setSelected((current) =>
      current.includes(episodeId)
        ? current.filter((id) => id !== episodeId)
        : [...current, episodeId]
    )
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)
    if (!isRun) return setError('Select a consecutive run of at least two episodes.')
    if (title.trim() === '') return setError('Give the arc a name.')
    setBusy(true)
    try {
      await window.rerun.library.createArc({
        showId,
        episodeIds: indices.map((i) => ordered[i].id),
        title: title.trim()
      })
      await onCreated()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="arc-builder" onSubmit={(event) => void submit(event)}>
      <label className="caption arc-builder-caption" htmlFor={`arc-title-${showId}`}>
        New arc
      </label>
      <input
        id={`arc-title-${showId}`}
        className="textinput"
        type="text"
        placeholder="Arc name, e.g. Awakening"
        value={title}
        disabled={busy}
        onChange={(event) => setTitle(event.target.value)}
      />
      {episodes == null ? (
        <p className="lib-note">Loading episodes…</p>
      ) : ordered.length === 0 ? (
        <p className="lib-note">This show has no episodes to group.</p>
      ) : (
        <div className="ep-list" role="group" aria-label="Episodes to group into an arc">
          {ordered.map((ep) => {
            const inArc = ep.partGroupId != null
            const on = selectedSet.has(ep.id)
            return (
              <button
                type="button"
                key={ep.id}
                className={`ep-pick${on ? ' on' : ''}`}
                aria-pressed={on}
                disabled={busy || inArc}
                title={inArc ? 'Already part of an arc — ungroup it first' : undefined}
                onClick={() => toggle(ep.id)}
              >
                <span className="ep-code">
                  {episodeCode(ep.season, ep.episode, ep.episodeEnd)}
                </span>
                <span className="ep-title">{ep.title ?? '—'}</span>
                {inArc && <span className="ep-flag">IN ARC</span>}
              </button>
            )
          })}
        </div>
      )}
      <p className="arc-hint">{hint}</p>
      {error != null && (
        <p className="lib-error" role="alert">
          {error}
        </p>
      )}
      <div className="assign-actions">
        <button type="submit" className="btn btn-tune btn-sm" disabled={busy || !isRun}>
          {busy ? 'Grouping…' : 'Create arc'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}
