/**
 * Screen 01 — The Guide. Home, and the only place channels are managed.
 *
 * The lineup reads like a cable guide: a big dial number, the channel's name,
 * and what the scheduler *actually* has on deck (precomputed in the main
 * process, which is why tuning in is instant).
 *
 * Interaction model, in one place so it stays coherent
 * (docs/ui.md, "Hot rows, and the fold-out editor"):
 *
 *  - The list is one full-width column — there is no preview aside, and no
 *    Channels screen. Pointing at a row swaps its show-title block for two
 *    buttons: ▶ tunes in, ✎ unfolds that channel's editor in place. Rows keep
 *    their height either way, so the list never reflows under the pointer.
 *  - Hover is a shortcut, never the only path: ↑/↓ and Home/End move the
 *    highlight, Enter tunes in, E unfolds the editor, Esc folds it shut. A
 *    single click selects, a double click tunes in.
 *  - Only one editor is open at a time — ✎ on another row moves the fold there.
 *  - Reordering is drag-and-drop, but never *only* drag-and-drop: Alt+↑/↓ moves
 *    the selected channel too, so the dial can be arranged from the keyboard.
 *    Either way the new order is applied optimistically and then persisted with
 *    `channels.reorder`.
 *  - Creating a channel uses an inline form rather than `window.prompt`, which
 *    Electron does not support, and unfolds the new channel's editor straight
 *    away — a channel with no shows cannot air, so the lineup is the next step.
 *
 * Rows are a plain list rather than a `listbox`: an `option` may not contain
 * interactive children, and these rows carry buttons and an expandable editor.
 * The roving tabindex and arrow-key handling are kept, so it still behaves like
 * one composite widget.
 */

import type { ChannelSummary } from "@shared/types.js";
import type { DragEvent, JSX, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChannelFold from "../components/ChannelFold.js";
import ChannelNumber from "../components/ChannelNumber.js";
import { useStore } from "../store.js";
import "./Guide.css";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const rowDomId = (channelId: number): string => `guide-ch-${channelId}`;
const foldDomId = (channelId: number): string => `guide-fold-${channelId}`;

const pad2 = (value: number): string => String(value).padStart(2, "0");

const idsOf = (rows: ChannelSummary[]): number[] =>
    rows.map((r) => r.channel.id);

const sameOrder = (a: number[], b: number[]): boolean =>
    a.length === b.length && a.every((value, i) => value === b[i]);

/** Move `id` to `toIndex`, returning a new array (or the same one if it's a no-op). */
function moveId(ids: number[], id: number, toIndex: number): number[] {
    const from = ids.indexOf(id);
    if (from === -1 || from === toIndex || toIndex < 0 || toIndex >= ids.length)
        return ids;
    const next = ids.slice();
    next.splice(from, 1);
    next.splice(toIndex, 0, id);
    return next;
}

/**
 * The right-hand column of a row: show titles in mono caps, two per line, the
 * way the mockup stacks them. Long lineups are truncated rather than allowed to
 * push the row's height around.
 */
function showLines(titles: string[]): string[] {
    /** Two titles per line × the three lines the row has height for. */
    const MAX = 6;
    const shown = titles.slice(0, MAX).map((t) => t.toUpperCase());
    const rest = titles.length - shown.length;
    if (rest > 0) shown.push(`+${rest} MORE`);
    const lines: string[] = [];
    for (let i = 0; i < shown.length; i += 2)
        lines.push(shown.slice(i, i + 2).join(" · "));
    return lines;
}

// ---------------------------------------------------------------------------
// screen
// ---------------------------------------------------------------------------

export default function Guide(): JSX.Element {
    const channels = useStore((s) => s.channels);
    const selectedChannelId = useStore((s) => s.selectedChannelId);
    const editingChannelId = useStore((s) => s.editingChannelId);
    const selectChannel = useStore((s) => s.selectChannel);
    const refreshChannels = useStore((s) => s.refreshChannels);
    const openEditor = useStore((s) => s.openEditor);
    const closeEditor = useStore((s) => s.closeEditor);
    const tune = useStore((s) => s.tune);
    const navigate = useStore((s) => s.navigate);

    /** Optimistic drag order; null means "trust the store". */
    const [pendingOrder, setPendingOrder] = useState<number[] | null>(null);
    const [draggingId, setDraggingId] = useState<number | null>(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const newNameRef = useRef<HTMLInputElement | null>(null);

    const rows = useMemo(() => {
        if (!pendingOrder) return channels;
        const byId = new Map(channels.map((c) => [c.channel.id, c]));
        const ordered: ChannelSummary[] = [];
        for (const id of pendingOrder) {
            const found = byId.get(id);
            if (found) {
                ordered.push(found);
                byId.delete(id);
            }
        }
        for (const leftover of byId.values()) ordered.push(leftover);
        return ordered;
    }, [channels, pendingOrder]);

    // Drag handlers fire outside React's render, so keep the latest order to hand.
    const rowsRef = useRef(rows);
    rowsRef.current = rows;

    useEffect(() => {
        if (creating) newNameRef.current?.focus();
    }, [creating]);

    const fail = useCallback((err: unknown, what: string): void => {
        console.error(`[rerun] ${what} failed:`, err);
        setError(
            `${what} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }, []);

    /**
     * Persist the visual order if it differs from what the store holds. Callers
     * that just computed a new order pass it in explicitly — `rowsRef` only
     * catches up on the next render, which is too late for a keyboard move.
     */
    const commitOrder = useCallback(
        async (ids?: number[]): Promise<void> => {
            const next = ids ?? idsOf(rowsRef.current);
            if (sameOrder(next, idsOf(channels))) {
                setPendingOrder(null);
                return;
            }
            setBusy(true);
            try {
                await window.rerun.channels.reorder(next);
                await refreshChannels();
                setError(null);
            } catch (err) {
                fail(err, "Reordering channels");
            } finally {
                setPendingOrder(null);
                setBusy(false);
            }
        },
        [channels, fail, refreshChannels],
    );

    // ---- keyboard --------------------------------------------------------

    const focusRow = (channelId: number): void => {
        document.getElementById(rowDomId(channelId))?.focus();
    };

    const moveSelection = (delta: number): void => {
        if (rows.length === 0) return;
        const current = rows.findIndex(
            (r) => r.channel.id === selectedChannelId,
        );
        const nextIndex = Math.min(
            rows.length - 1,
            Math.max(0, (current === -1 ? 0 : current) + delta),
        );
        const next = rows[nextIndex];
        if (!next) return;
        selectChannel(next.channel.id);
        focusRow(next.channel.id);
    };

    const moveSelectedChannel = (delta: number): void => {
        if (selectedChannelId == null) return;
        const ids = idsOf(rows);
        const to = ids.indexOf(selectedChannelId) + delta;
        const next = moveId(ids, selectedChannelId, to);
        if (next === ids) return;
        setPendingOrder(next);
        // The reordered row keeps its DOM node (React keys by channel id), so focus
        // rides along with it.
        void commitOrder(next);
    };

    const toggleEditor = (channelId: number): void => {
        if (editingChannelId === channelId) closeEditor();
        else void openEditor(channelId);
    };

    const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
        // Escape closes the fold from anywhere inside it, so the way out is the same
        // wherever focus happens to be. Controls that want it for themselves — the
        // rename field abandoning a draft, a non-empty search clearing — stop it
        // propagating, so they get first refusal rather than a special case here.
        if (event.key === "Escape") {
            if (editingChannelId != null) {
                event.preventDefault();
                closeEditor();
            }
            return;
        }

        // Every other shortcut is a bare letter or arrow, which means it is also
        // ordinary text someone may be typing into the fold's rename or search
        // field. They only count when the *row* has focus; otherwise typing "e" into
        // the library search would fold the editor shut mid-word.
        if (
            event.target !== event.currentTarget &&
            !(event.target as HTMLElement).dataset.chRow
        ) {
            return;
        }

        if (
            event.altKey &&
            (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
            event.preventDefault();
            moveSelectedChannel(event.key === "ArrowDown" ? 1 : -1);
            return;
        }
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                moveSelection(1);
                break;
            case "ArrowUp":
                event.preventDefault();
                moveSelection(-1);
                break;
            case "Home":
                event.preventDefault();
                moveSelection(-rows.length);
                break;
            case "End":
                event.preventDefault();
                moveSelection(rows.length);
                break;
            case "Enter":
            case " ": {
                event.preventDefault();
                const selected = rows.find(
                    (r) => r.channel.id === selectedChannelId,
                );
                if (selected?.onDeck) void tune(selected.channel.id);
                break;
            }
            case "e":
            case "E":
                event.preventDefault();
                if (selectedChannelId != null) toggleEditor(selectedChannelId);
                break;
            default:
                break;
        }
    };

    // ---- drag ------------------------------------------------------------

    const onDragStart = (
        event: DragEvent<HTMLDivElement>,
        channelId: number,
    ): void => {
        // Dragging a row while its editor is open would slide a tall panel around
        // the list; fold it shut and let the drag be about order alone.
        if (editingChannelId != null) closeEditor();
        setDraggingId(channelId);
        selectChannel(channelId);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(channelId));
    };

    const onDragOverRow = (event: DragEvent<HTMLDivElement>): void => {
        if (draggingId == null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
    };

    const onDragEnterRow = (targetId: number): void => {
        if (draggingId == null || draggingId === targetId) return;
        const ids = idsOf(rowsRef.current);
        const next = moveId(ids, draggingId, ids.indexOf(targetId));
        if (next !== ids) setPendingOrder(next);
    };

    const onDragEnd = (): void => {
        setDraggingId(null);
        void commitOrder();
    };

    // ---- channel management ---------------------------------------------

    const submitNewChannel = async (name: string): Promise<void> => {
        const trimmed = name.trim();
        if (!trimmed) return;
        setBusy(true);
        try {
            const created = await window.rerun.channels.create({
                name: trimmed,
            });
            await refreshChannels();
            setCreating(false);
            setNewName("");
            setError(null);
            // A brand-new channel has nothing to air, so the lineup is the only useful
            // next step — open it rather than leaving an empty row behind.
            await openEditor(created.id);
        } catch (err) {
            fail(err, "Creating the channel");
        } finally {
            setBusy(false);
        }
    };

    // ---- render ----------------------------------------------------------

    const newChannelForm = (
        <form
            className="guide-newch"
            onSubmit={(event) => {
                event.preventDefault();
                void submitNewChannel(newName);
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
                    if (event.key === "Escape") {
                        event.preventDefault();
                        setCreating(false);
                        setNewName("");
                    }
                }}
            />
            <button
                type="submit"
                className="btn btn-tune btn-sm"
                disabled={busy || !newName.trim()}
            >
                Create
            </button>
            <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                    setCreating(false);
                    setNewName("");
                }}
            >
                Cancel
            </button>
        </form>
    );

    return (
        <div className="guide-body">
            <section
                className="guide-list"
                aria-labelledby="guide-lineup-caption"
            >
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
                    <p className="form-error guide-error" role="alert">
                        {error}
                    </p>
                )}

                {rows.length === 0 && !creating ? (
                    <div className="empty">
                        <b>No channels yet.</b>
                        Rerun TV needs two things before anything can air: a
                        folder of episodes, and a channel to put them on. Add a
                        library folder first, then make a channel and drop a few
                        shows into it.
                        <div className="guide-empty-actions">
                            <button
                                type="button"
                                className="btn btn-tune btn-sm"
                                onClick={() => setCreating(true)}
                            >
                                + Create the first channel
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => navigate("library")}
                            >
                                Open the Library
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => navigate("settings")}
                            >
                                Add a folder
                            </button>
                        </div>
                    </div>
                ) : (
                    <ul
                        className="guide-rows"
                        aria-label="Channel lineup"
                        onKeyDown={onListKeyDown}
                    >
                        {rows.map((summary) => {
                            const { channel, onDeck, showTitles } = summary;
                            const isSelected = channel.id === selectedChannelId;
                            const isEditing = channel.id === editingChannelId;
                            const classes = ["ch-row"];
                            if (isSelected) classes.push("sel");
                            if (isEditing) classes.push("editing");
                            if (draggingId === channel.id)
                                classes.push("dragging");
                            return (
                                <li className="ch-slot" key={channel.id}>
                                    {/* biome-ignore lint/a11y/useSemanticElements: a native <button> would synthesise a click from Enter and Space, which the list's key handler already spends on "tune in" — the row would activate twice */}
                                    {/* biome-ignore lint/a11y/useKeyWithClickEvents: the row's keys are handled by the list, so that Escape still reaches it from inside an open fold */}
                                    <div
                                        id={rowDomId(channel.id)}
                                        className={classes.join(" ")}
                                        data-ch-row="true"
                                        role="button"
                                        aria-current={
                                            isSelected ? "true" : undefined
                                        }
                                        aria-label={`CH ${pad2(channel.number)} ${channel.name}`}
                                        tabIndex={isSelected ? 0 : -1}
                                        draggable
                                        onClick={() =>
                                            selectChannel(channel.id)
                                        }
                                        onDoubleClick={() => {
                                            if (onDeck) void tune(channel.id);
                                        }}
                                        onDragStart={(event) =>
                                            onDragStart(event, channel.id)
                                        }
                                        onDragOver={onDragOverRow}
                                        onDragEnter={() =>
                                            onDragEnterRow(channel.id)
                                        }
                                        onDrop={(event) => {
                                            event.preventDefault();
                                            onDragEnd();
                                        }}
                                        onDragEnd={onDragEnd}
                                    >
                                        <ChannelNumber
                                            number={channel.number}
                                        />
                                        <div className="ch-meta">
                                            <div className="ch-name">
                                                {channel.name}
                                            </div>
                                            <div className="ch-deck">
                                                {onDeck ? (
                                                    <>
                                                        <code>
                                                            {onDeck.code}
                                                        </code>
                                                        {onDeck.showTitle}
                                                        {onDeck.title
                                                            ? ` — “${onDeck.title}”`
                                                            : ""}
                                                    </>
                                                ) : showTitles.length === 0 ? (
                                                    "No shows in this lineup"
                                                ) : (
                                                    "Nothing on deck yet"
                                                )}
                                            </div>
                                        </div>

                                        {/* Titles and controls occupy the same cell: the row's height
                        is the same whether or not the pointer is on it. */}
                                        <div className="ch-shows">
                                            {showLines(showTitles).map(
                                                // Index, not the text: a lineup can
                                                // hold the same two shows twice, and
                                                // identical lines would collide.
                                                (line, i) => (
                                                    // biome-ignore lint/suspicious/noArrayIndexKey: the list is static per render and lines are not unique
                                                    <div key={i}>{line}</div>
                                                ),
                                            )}
                                        </div>
                                        <div className="ch-ctrls">
                                            <button
                                                type="button"
                                                className="iconbtn play"
                                                title={
                                                    onDeck
                                                        ? "Tune in"
                                                        : "Nothing on deck to tune in to"
                                                }
                                                aria-label={`Tune in to CH ${pad2(channel.number)} ${channel.name}`}
                                                disabled={!onDeck || busy}
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    void tune(channel.id);
                                                }}
                                            >
                                                ▶
                                            </button>
                                            <button
                                                type="button"
                                                className="iconbtn"
                                                title="Edit channel"
                                                aria-label={`Edit CH ${pad2(channel.number)} ${channel.name}`}
                                                aria-expanded={isEditing}
                                                aria-controls={
                                                    isEditing
                                                        ? foldDomId(channel.id)
                                                        : undefined
                                                }
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    selectChannel(channel.id);
                                                    toggleEditor(channel.id);
                                                }}
                                            >
                                                ✎
                                            </button>
                                        </div>
                                    </div>

                                    {/* The fold is a grid row that animates 0fr → 1fr, so it opens
                      to its natural height without anyone measuring it. */}
                                    <div
                                        className={
                                            isEditing ? "fold open" : "fold"
                                        }
                                    >
                                        <div className="fold-inner">
                                            {isEditing && (
                                                <div id={foldDomId(channel.id)}>
                                                    <ChannelFold
                                                        channelId={channel.id}
                                                        onClose={closeEditor}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {rows.length > 0 && (
                    <p className="guide-hint">
                        <span>
                            <kbd>↑</kbd>
                            <kbd>↓</kbd>browse
                        </span>
                        <span>
                            <kbd>Enter</kbd>tune in
                        </span>
                        <span>
                            <kbd>E</kbd>edit
                        </span>
                        {editingChannelId != null && (
                            <span>
                                <kbd>Esc</kbd>close
                            </span>
                        )}
                        {rows.length > 1 && (
                            <span>
                                <kbd>Alt</kbd>
                                <kbd>↑</kbd>
                                <kbd>↓</kbd>reorder — or drag a row
                            </span>
                        )}
                    </p>
                )}
            </section>
        </div>
    );
}
