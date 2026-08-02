import type { Show } from "@shared/types.js";
import { type ReactElement, useMemo, useState } from "react";

/**
 * The fold's right-hand column: search the library, add a show to this channel.
 *
 * Owns its own search query, which is the point of the split — the query is
 * throwaway UI state that nothing else in the fold reads, and keeping it here
 * means the (already long) parent has one fewer piece of state whose lifetime a
 * reader has to track. It still dies with the fold on remount, exactly as the
 * drafts contract in the file header requires, because this component unmounts
 * with its parent.
 */
export default function AddShowPanel({
    shows,
    lineupShowIds,
    episodeCounts,
    disabled,
    onAdd,
    onOpenLibrary,
}: {
    shows: Show[];
    /** Already in this channel's lineup, so not offered again. */
    lineupShowIds: Set<number>;
    episodeCounts: Map<number, number>;
    disabled: boolean;
    onAdd(showId: number): void;
    onOpenLibrary(): void;
}): ReactElement {
    const [query, setQuery] = useState("");

    const candidates = useMemo(() => {
        const q = query.trim().toLowerCase();
        return shows.filter(
            (show) =>
                !lineupShowIds.has(show.id) &&
                (q === "" || show.title.toLowerCase().includes(q)),
        );
    }, [shows, lineupShowIds, query]);

    return (
        <div className="fold-right">
            <span className="caption">Add a show</span>
            {shows.length === 0 ? (
                <p className="fold-empty">
                    <b>The library is empty.</b> Point Rerun TV at a folder of
                    episodes and scan it — shows appear here as soon as the
                    scanner has parsed them.
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm fold-empty-action"
                        onClick={onOpenLibrary}
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
                            if (e.key === "Escape" && query !== "") {
                                e.stopPropagation();
                                setQuery("");
                            }
                        }}
                    />
                    {candidates.length === 0 ? (
                        <p className="fold-note">
                            {query.trim() === ""
                                ? "Every show in the library is already on this channel."
                                : `Nothing in the library matches “${query.trim()}”.`}
                        </p>
                    ) : (
                        candidates.map((show) => (
                            <div className="pick" key={show.id}>
                                <span className="p-name">{show.title}</span>
                                <span className="p-eps">
                                    {episodeCounts.get(show.id) ?? 0} EP
                                </span>
                                <button
                                    type="button"
                                    className="add"
                                    aria-label={`Add ${show.title} to this channel`}
                                    disabled={disabled}
                                    onClick={() => onAdd(show.id)}
                                >
                                    +
                                </button>
                            </div>
                        ))
                    )}
                </>
            )}
        </div>
    );
}
