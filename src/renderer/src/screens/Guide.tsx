/**
 * Screen 01 — The Guide. Home.
 *
 * The lineup reads like a cable guide: a big dial number, the channel's name,
 * and what the scheduler *actually* has on deck (precomputed in the main
 * process, which is why tuning in is instant). The right-hand aside previews the
 * selected channel and is where you commit — tune in, or go edit the lineup.
 *
 * Interaction model, in one place so it stays coherent:
 *
 *  - The list is a `listbox` with a roving tabindex. Selection follows focus:
 *    ↑/↓ and Home/End move the highlight and update the preview; Enter or Space
 *    tunes in. A single click selects, a double click tunes in.
 *  - Reordering is drag-and-drop, but never *only* drag-and-drop: Alt+↑/↓ moves
 *    the selected channel too, so the dial can be arranged from the keyboard.
 *    Either way the new order is applied optimistically and then persisted with
 *    `channels.reorder`.
 *  - Creating a channel uses an inline form rather than `window.prompt`, which
 *    Electron does not support.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, JSX, KeyboardEvent } from 'react'
import type { ChannelSummary } from '@shared/types.js'
import ChannelBanner from '../components/ChannelBanner.js'
import ChannelNumber from '../components/ChannelNumber.js'
import { useStore } from '../store.js'
import './Guide.css'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const rowDomId = (channelId: number): string => `guide-ch-${channelId}`

const pad2 = (value: number): string => String(value).padStart(2, '0')

const idsOf = (rows: ChannelSummary[]): number[] => rows.map((r) => r.channel.id)

const sameOrder = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i])

/** Move `id` to `toIndex`, returning a new array (or the same one if it's a no-op). */
function moveId(ids: number[], id: number, toIndex: number): number[] {
  const from = ids.indexOf(id)
  if (from === -1 || from === toIndex || toIndex < 0 || toIndex >= ids.length) return ids
  const next = ids.slice()
  next.splice(from, 1)
  next.splice(toIndex, 0, id)
  return next
}

/**
 * The right-hand column of a row: show titles in mono caps, two per line, the
 * way the mockup stacks them. Long lineups are truncated rather than allowed to
 * push the row's height around.
 */
function showLines(titles: string[]): string[] {
  const MAX = 6
  const shown = titles.slice(0, MAX).map((t) => t.toUpperCase())
  const rest = titles.length - shown.length
  if (rest > 0) shown.push(`+${rest} MORE`)
  const lines: string[] = []
  for (let i = 0; i < shown.length; i += 2) lines.push(shown.slice(i, i + 2).join(' · '))
  return lines
}

function listSentence(items: string[]): string {
  if (items.length === 1) return items[0]
  if (items.length <= 3) return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
  return `${items.slice(0, 3).join(', ')} and ${items.length - 3} more`
}

/**
 * What comes after the on-deck episode. The guide only knows the channel's show
 * titles — per-show modes live in the Channel Editor's detail payload — so this
 * says what it can honestly say and no more.
 */
function sideNote(summary: ChannelSummary): string {
  const { showTitles, onDeck } = summary
  if (showTitles.length === 0) {
    return 'Nothing in this lineup yet. Add shows in the channel editor and this channel starts airing.'
  }
  if (!onDeck) {
    return 'Nothing on deck — these shows have no playable episodes yet. Check the Library screen.'
  }
  const others = showTitles.filter((t) => t !== onDeck.showTitle)
  if (others.length === 0) {
    return `After this, ${onDeck.showTitle} keeps going — it's the only show on this channel.`
  }
  return `Up after: the dial draws again from ${listSentence(others)}.`
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

export default function Guide(): JSX.Element {
  const channels = useStore((s) => s.channels)
  const selectedChannelId = useStore((s) => s.selectedChannelId)
  const selectChannel = useStore((s) => s.selectChannel)
  const refreshChannels = useStore((s) => s.refreshChannels)
  const openEditor = useStore((s) => s.openEditor)
  const tune = useStore((s) => s.tune)
  const navigate = useStore((s) => s.navigate)

  /** Optimistic drag order; null means "trust the store". */
  const [pendingOrder, setPendingOrder] = useState<number[] | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const newNameRef = useRef<HTMLInputElement | null>(null)

  const rows = useMemo(() => {
    if (!pendingOrder) return channels
    const byId = new Map(channels.map((c) => [c.channel.id, c]))
    const ordered: ChannelSummary[] = []
    for (const id of pendingOrder) {
      const found = byId.get(id)
      if (found) {
        ordered.push(found)
        byId.delete(id)
      }
    }
    for (const leftover of byId.values()) ordered.push(leftover)
    return ordered
  }, [channels, pendingOrder])

  // Drag handlers fire outside React's render, so keep the latest order to hand.
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  const selected = rows.find((r) => r.channel.id === selectedChannelId) ?? null

  useEffect(() => {
    if (creating) newNameRef.current?.focus()
  }, [creating])

  const fail = useCallback((err: unknown, what: string): void => {
    console.error(`[rerun] ${what} failed:`, err)
    setError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`)
  }, [])

  /**
   * Persist the visual order if it differs from what the store holds. Callers
   * that just computed a new order pass it in explicitly — `rowsRef` only
   * catches up on the next render, which is too late for a keyboard move.
   */
  const commitOrder = useCallback(async (ids?: number[]): Promise<void> => {
    const next = ids ?? idsOf(rowsRef.current)
    if (sameOrder(next, idsOf(channels))) {
      setPendingOrder(null)
      return
    }
    setBusy(true)
    try {
      await window.rerun.channels.reorder(next)
      await refreshChannels()
      setError(null)
    } catch (err) {
      fail(err, 'Reordering channels')
    } finally {
      setPendingOrder(null)
      setBusy(false)
    }
  }, [channels, fail, refreshChannels])

  // ---- keyboard --------------------------------------------------------

  const focusRow = (channelId: number): void => {
    document.getElementById(rowDomId(channelId))?.focus()
  }

  const moveSelection = (delta: number): void => {
    if (rows.length === 0) return
    const current = rows.findIndex((r) => r.channel.id === selectedChannelId)
    const nextIndex = Math.min(rows.length - 1, Math.max(0, (current === -1 ? 0 : current) + delta))
    const next = rows[nextIndex]
    if (!next) return
    selectChannel(next.channel.id)
    focusRow(next.channel.id)
  }

  const moveSelectedChannel = (delta: number): void => {
    if (selectedChannelId == null) return
    const ids = idsOf(rows)
    const to = ids.indexOf(selectedChannelId) + delta
    const next = moveId(ids, selectedChannelId, to)
    if (next === ids) return
    setPendingOrder(next)
    // The reordered row keeps its DOM node (React keys by channel id), so focus
    // rides along with it.
    void commitOrder(next)
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      moveSelectedChannel(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveSelection(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        moveSelection(-1)
        break
      case 'Home':
        event.preventDefault()
        moveSelection(-rows.length)
        break
      case 'End':
        event.preventDefault()
        moveSelection(rows.length)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (selected?.onDeck) void tune(selected.channel.id)
        break
      default:
        break
    }
  }

  // ---- drag ------------------------------------------------------------

  const onDragStart = (event: DragEvent<HTMLDivElement>, channelId: number): void => {
    setDraggingId(channelId)
    selectChannel(channelId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(channelId))
  }

  const onDragOverRow = (event: DragEvent<HTMLDivElement>): void => {
    if (draggingId == null) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }

  const onDragEnterRow = (targetId: number): void => {
    if (draggingId == null || draggingId === targetId) return
    const ids = idsOf(rowsRef.current)
    const next = moveId(ids, draggingId, ids.indexOf(targetId))
    if (next !== ids) setPendingOrder(next)
  }

  const onDragEnd = (): void => {
    setDraggingId(null)
    void commitOrder()
  }

  // ---- channel management ---------------------------------------------

  const submitNewChannel = async (name: string): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      const created = await window.rerun.channels.create({ name: trimmed })
      await refreshChannels()
      selectChannel(created.id)
      setCreating(false)
      setNewName('')
      setError(null)
    } catch (err) {
      fail(err, 'Creating the channel')
    } finally {
      setBusy(false)
    }
  }

  const deleteSelected = async (): Promise<void> => {
    if (!selected) return
    const { id, name, number } = selected.channel
    if (!window.confirm(`Delete CH ${pad2(number)} “${name}”? Its lineup and progress go with it.`)) {
      return
    }
    setBusy(true)
    try {
      await window.rerun.channels.remove(id)
      await refreshChannels()
      setError(null)
    } catch (err) {
      fail(err, 'Deleting the channel')
    } finally {
      setBusy(false)
    }
  }

  // ---- render ----------------------------------------------------------

  const newChannelForm = (
    <form
      className="guide-newch"
      onSubmit={(event) => {
        event.preventDefault()
        void submitNewChannel(newName)
      }}
    >
      <input
        ref={newNameRef}
        className="textinput"
        type="text"
        value={newName}
        maxLength={60}
        placeholder="Channel name — e.g. Saturday Morning"
        aria-label="New channel name"
        onChange={(event) => setNewName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setCreating(false)
            setNewName('')
          }
        }}
      />
      <button type="submit" className="btn btn-tune btn-sm" disabled={busy || !newName.trim()}>
        Create
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => {
          setCreating(false)
          setNewName('')
        }}
      >
        Cancel
      </button>
    </form>
  )

  return (
    <div className="guide-body">
      <section className="guide-list" aria-labelledby="guide-lineup-caption">
        <div className="guide-listhead">
          <div className="caption" id="guide-lineup-caption">
            Channel lineup
          </div>
          {!creating && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => setCreating(true)}
            >
              + New channel
            </button>
          )}
        </div>

        {creating && newChannelForm}
        {error && (
          <p className="guide-error" role="alert">
            {error}
          </p>
        )}

        {rows.length === 0 && !creating ? (
          <div className="empty">
            <b>No channels yet.</b>
            Rerun TV needs two things before anything can air: a folder of episodes, and
            a channel to put them on. Add a library folder first, then make a channel and
            drop a few shows into it.
            <div className="guide-empty-actions">
              <button type="button" className="btn btn-tune btn-sm" onClick={() => setCreating(true)}>
                + Create the first channel
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('library')}>
                Open the Library
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('settings')}>
                Add a folder
              </button>
            </div>
          </div>
        ) : (
          <div
            className="guide-rows"
            role="listbox"
            aria-label="Channel lineup"
            onKeyDown={onListKeyDown}
          >
            {rows.map((summary) => {
              const { channel, onDeck, showTitles } = summary
              const isSelected = channel.id === selectedChannelId
              const classes = ['ch-row']
              if (isSelected) classes.push('sel')
              if (draggingId === channel.id) classes.push('dragging')
              return (
                <div
                  key={channel.id}
                  id={rowDomId(channel.id)}
                  className={classes.join(' ')}
                  role="option"
                  aria-selected={isSelected}
                  aria-current={isSelected ? 'true' : undefined}
                  tabIndex={isSelected ? 0 : -1}
                  draggable
                  onClick={() => selectChannel(channel.id)}
                  onDoubleClick={() => {
                    if (onDeck) void tune(channel.id)
                  }}
                  onDragStart={(event) => onDragStart(event, channel.id)}
                  onDragOver={onDragOverRow}
                  onDragEnter={() => onDragEnterRow(channel.id)}
                  onDrop={(event) => {
                    event.preventDefault()
                    onDragEnd()
                  }}
                  onDragEnd={onDragEnd}
                >
                  <ChannelNumber number={channel.number} />
                  <div className="ch-meta">
                    <div className="ch-name">{channel.name}</div>
                    <div className="ch-deck">
                      {onDeck ? (
                        <>
                          <code>{onDeck.code}</code>
                          {onDeck.showTitle}
                          {onDeck.title ? ` — “${onDeck.title}”` : ''}
                        </>
                      ) : showTitles.length === 0 ? (
                        'No shows in this lineup'
                      ) : (
                        'Nothing on deck yet'
                      )}
                    </div>
                  </div>
                  <div className="ch-shows">
                    {showLines(showTitles).map((line, i) => (
                      <div key={i}>{line}</div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {rows.length > 1 && (
          <p className="guide-hint">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd>browse
            </span>
            <span>
              <kbd>Enter</kbd>tune in
            </span>
            <span>
              <kbd>Alt</kbd>
              <kbd>↑</kbd>
              <kbd>↓</kbd>reorder — or drag a row
            </span>
          </p>
        )}
      </section>

      <aside className="guide-side" aria-label="Channel preview">
        {selected ? (
          <>
            <div className="side-title">Now tuned · CH {pad2(selected.channel.number)}</div>
            <div className="preview">
              {selected.onDeck ? (
                <ChannelBanner
                  number={selected.channel.number}
                  showTitle={selected.onDeck.showTitle}
                  code={selected.onDeck.code}
                  episodeTitle={selected.onDeck.title}
                  durationS={selected.onDeck.durationS}
                />
              ) : (
                <span className="preview-idle">NO SIGNAL</span>
              )}
            </div>
            <p className="side-note">{sideNote(selected)}</p>
            <div className="side-actions">
              <button
                type="button"
                className="btn btn-tune"
                disabled={!selected.onDeck || busy}
                onClick={() => void tune(selected.channel.id)}
              >
                ▶ Tune in
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void openEditor(selected.channel.id)}
              >
                Edit channel
              </button>
            </div>
            <div className="side-manage">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => void deleteSelected()}
              >
                Delete channel
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="side-title">Nothing tuned</div>
            <div className="preview">
              <span className="preview-idle">NO SIGNAL</span>
            </div>
            <p className="side-note">
              Make a channel and it shows up here with whatever the scheduler has lined
              up next.
            </p>
          </>
        )}
      </aside>
    </div>
  )
}
