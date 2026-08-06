/**
 * Show metadata lookup — the card in the Library aside (docs/library.md).
 *
 * Three states, one component, because they are three moments of a single
 * gesture and the state that carries between them (the query, the candidate,
 * the plan) never leaves this file:
 *
 * 1. **Unlinked** — `Look up…` opens a typeahead over `library.searchMetadata`.
 * 2. **Preview** — picking a candidate calls `library.previewMetadata`, which
 *    writes nothing and hands back the whole of what an apply *would* write.
 *    What the user reads here is exactly what `applyMetadata` commits, so there
 *    is no refetch between look and commit.
 * 3. **Linked** — the show already carries a provider id: Refresh (a preview
 *    with the stored id, still confirmed by Apply) and Unlink (the total undo).
 *
 * Two behaviours are load-bearing rather than cosmetic. The search is debounced
 * 300 ms *and* single-flight: every request carries a sequence number and a
 * response whose number is stale is dropped, so a slow answer for "gar" can
 * never overwrite the list for "gargoyles" (TVmaze also rate-limits at ~20
 * requests per 10 s, which the debounce alone already respects). And Escape
 * stops propagating in every state — backing out of this card is the whole of
 * what that keystroke means here, per the inline-edit precedent in
 * `ChannelFold.tsx`.
 *
 * Errors from main render inline and verbatim with the panel left open, per
 * `AssignPanel` — a network failure must not cost the user their query.
 */

import type {
    Episode,
    MetadataCandidate,
    MetadataPlan,
    Show,
} from "@shared/types.js";
import {
    type KeyboardEvent,
    type ReactElement,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";
import { errorText, plural } from "../utils.js";

/** How long the typeahead waits for the typing to stop. */
const DEBOUNCE_MS = 300;

/** How many concrete retitles the preview shows before trailing off. */
const SAMPLE_SIZE = 3;

/** `'tvmaze'` → `TVmaze`. One provider today; the column exists for more. */
function providerName(source: string): string {
    return source === "tvmaze" ? "TVmaze" : source;
}

/**
 * `S01E01`, or `S01E05–E06` for a span — the label the user recognises.
 *
 * The span test is `episodeEnd > episode`, matching `buildPlan` exactly: a
 * one-episode file written as a range carries `episodeEnd === episode`, and the
 * plan counts it as an ordinary match, so the sample beside it must not read
 * `S01E05–E05`.
 */
function episodeLabel(episode: Episode): string {
    const base = `S${String(episode.season).padStart(2, "0")}E${String(
        episode.episode,
    ).padStart(2, "0")}`;
    return episode.episodeEnd == null || episode.episodeEnd <= episode.episode
        ? base
        : `${base}–E${String(episode.episodeEnd).padStart(2, "0")}`;
}

/** The candidate's identifying half-line: `1994 · Syndication`, or half of it. */
function candidateFacts(candidate: MetadataCandidate): string {
    return [
        candidate.year == null ? null : String(candidate.year),
        candidate.network,
    ]
        .filter((part) => part != null)
        .join(" · ");
}

export default function MetadataCard({
    show,
    onChanged,
}: {
    show: Show;
    /** Re-read the library after something was written. */
    onChanged: () => Promise<void>;
}): ReactElement {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<MetadataCandidate[]>([]);
    const [searching, setSearching] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const [plan, setPlan] = useState<MetadataPlan | null>(null);
    /** Season/episode labels for the plan's episode ids, best-effort. */
    const [labels, setLabels] = useState<Map<number, string>>(new Map());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    /** The sequence number of the newest search; older answers are dropped. */
    const seq = useRef(0);

    /**
     * The same guard for previews. `busy` disables every control that starts
     * one, but the Enter key is not a control and fires as fast as the user can
     * press it — without this, two previews race and the slower answer wins the
     * card.
     */
    const previewSeq = useRef(0);

    /**
     * The panel replaces the `Look up…` button the moment it opens, so focus has
     * to follow. A *stable* ref callback rather than `autoFocus`: an inline
     * arrow is a new function every render, which React would re-run on each
     * keystroke and drag focus back (`ChannelFold.tsx:83`).
     */
    const focusOnMount = useCallback((el: HTMLInputElement | null) => {
        el?.focus();
    }, []);

    // Nothing resets this component when the selection moves: the Library keys
    // it by show id, so a different show is a different instance and every piece
    // of state here — the query, the in-flight sequence, the plan — is born
    // fresh. Selecting away mid-lookup can therefore never leak into the next
    // show's card.

    // The debounce and the single-flight guard, together: the timer is cleared
    // by the cleanup on every keystroke, and the bump to `seq` makes any answer
    // already in flight arrive stale.
    useEffect(() => {
        if (!open) return;
        const trimmed = query.trim();
        seq.current += 1;
        if (trimmed === "") {
            setResults([]);
            setSearching(false);
            return;
        }
        const mine = seq.current;
        setSearching(true);
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const found =
                        await window.rerun.library.searchMetadata(trimmed);
                    if (seq.current !== mine) return;
                    setResults(found);
                    setHighlight(0);
                    setError(null);
                } catch (err) {
                    if (seq.current !== mine) return;
                    setError(errorText(err));
                } finally {
                    if (seq.current === mine) setSearching(false);
                }
            })();
        }, DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [query, open]);

    /**
     * Escape out of the preview.
     *
     * The preview state has no input to hang a key handler off — the search box
     * is unmounted by then — so this listens at the window, in the capture phase
     * so `stopPropagation` still cuts the key off before React's root listener
     * can hand it to the screen underneath. It is exactly the `Back` button:
     * nothing is written, the plan is dropped, and the card returns to whatever
     * it was showing before (the candidate list, or closed if there is none —
     * the Refresh path has no list to go back to).
     */
    useEffect(() => {
        if (plan == null) return;
        const onKey = (event: globalThis.KeyboardEvent): void => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setPlan(null);
            if (results.length === 0) setOpen(false);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [plan, results.length]);

    /** Preview a provider show — the one call both picking and Refresh make. */
    async function preview(providerShowId: string): Promise<void> {
        previewSeq.current += 1;
        const mine = previewSeq.current;
        setBusy(true);
        setError(null);
        try {
            // The plan names episode ids; the labels come from the local rows so
            // the sample can read "S01E01 → …" rather than a bare title.
            const [next, episodes] = await Promise.all([
                window.rerun.library.previewMetadata({
                    showId: show.id,
                    providerShowId,
                }),
                window.rerun.library
                    .listEpisodes(show.id)
                    .catch((): Episode[] => []),
            ]);
            if (previewSeq.current !== mine) return;
            setLabels(
                new Map(
                    episodes.map((episode) => [
                        episode.id,
                        episodeLabel(episode),
                    ]),
                ),
            );
            setPlan(next);
        } catch (err) {
            if (previewSeq.current !== mine) return;
            setError(errorText(err));
        } finally {
            if (previewSeq.current === mine) setBusy(false);
        }
    }

    async function apply(): Promise<void> {
        if (plan == null) return;
        setBusy(true);
        setError(null);
        try {
            // The plan object from the preview, unchanged — the whole point of
            // the split.
            await window.rerun.library.applyMetadata(plan);
            setPlan(null);
            setOpen(false);
            setQuery("");
            setResults([]);
            await onChanged();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    }

    async function unlink(): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            await window.rerun.library.unlinkMetadata(show.id);
            setPlan(null);
            await onChanged();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    }

    function onSearchKey(event: KeyboardEvent<HTMLInputElement>): void {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (results.length === 0) return;
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setHighlight(
                (current) => (current + step + results.length) % results.length,
            );
            return;
        }
        if (event.key === "Enter") {
            // The same lock the pick buttons carry: Enter is the one way to
            // start a preview that isn't a control, so it has to check it too.
            if (busy) return;
            const candidate = results[highlight];
            if (candidate != null) void preview(candidate.providerShowId);
            return;
        }
        if (event.key === "Escape") {
            // Only this panel closes — the Library keeps its selection, its
            // open assign form and everything else it was holding.
            event.stopPropagation();
            setOpen(false);
            setResults([]);
        }
    }

    const linked = show.metadataSource != null && show.metadataId != null;
    const displayed = show.displayTitle ?? show.title;

    // ---- preview ------------------------------------------------------------

    if (plan != null) {
        const titled = plan.matchedCount + plan.multiCount;
        const total = titled + plan.unmatchedCount;
        const sample = plan.episodes.slice(0, SAMPLE_SIZE);
        return (
            <div className="meta-card" data-state="preview">
                <div className="caption side-caption">
                    Preview · nothing written yet
                </div>
                <div className="m-title">{plan.displayTitle}</div>
                <div className="m-meta">{providerName(plan.provider)}</div>
                <div className="m-counts">
                    <b>
                        {titled} of {total}
                    </b>{" "}
                    files get episode titles
                </div>
                <div className="m-counts sub">
                    {plural(plan.multiCount, "multi-episode file")} ·{" "}
                    {plan.unmatchedCount} keep filename titles
                </div>
                {sample.length > 0 && (
                    <ul className="m-sample">
                        {sample.map((episode) => (
                            <li key={episode.episodeId}>
                                {labels.get(episode.episodeId) != null && (
                                    <span className="m-ep">
                                        {labels.get(episode.episodeId)} →{" "}
                                    </span>
                                )}
                                “{episode.title}”
                            </li>
                        ))}
                        {plan.episodes.length > sample.length && <li>…</li>}
                    </ul>
                )}
                {error != null && (
                    <p className="form-error lib-error" role="alert">
                        {error}
                    </p>
                )}
                <div className="m-actions">
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => void apply()}
                    >
                        {busy ? "Applying…" : "Apply"}
                    </button>
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => setPlan(null)}
                    >
                        Back
                    </button>
                </div>
            </div>
        );
    }

    // ---- linked -------------------------------------------------------------

    if (linked && !open) {
        return (
            <div className="meta-card" data-state="linked">
                <div className="caption side-caption">Show metadata</div>
                <div className="m-title">{displayed}</div>
                <div className="m-meta">
                    Linked to {providerName(show.metadataSource as string)}
                </div>
                {error != null && (
                    <p className="form-error lib-error" role="alert">
                        {error}
                    </p>
                )}
                <div className="m-actions">
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => void preview(show.metadataId as string)}
                    >
                        {busy ? "Working…" : "Refresh"}
                    </button>
                    <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() => void unlink()}
                    >
                        Unlink
                    </button>
                </div>
                <p className="m-attrib">data from TVmaze</p>
            </div>
        );
    }

    // ---- unlinked, and the typeahead ---------------------------------------

    return (
        <div className="meta-card" data-state={open ? "searching" : "unlinked"}>
            <div className="caption side-caption">Show metadata</div>
            {!open ? (
                <>
                    <div className="m-title">{displayed}</div>
                    <div className="m-meta">
                        Titled by the scanner — no provider link
                    </div>
                    <div className="m-actions">
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                                setOpen(true);
                                setQuery(show.title);
                                setError(null);
                            }}
                        >
                            Look up…
                        </button>
                    </div>
                </>
            ) : (
                <>
                    <input
                        className="search"
                        type="search"
                        ref={focusOnMount}
                        placeholder="Search TVmaze…"
                        aria-label="Search TVmaze for this show"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={onSearchKey}
                    />
                    {/* "Searching…" takes the list's own first row rather than a
                        banner above it, so a slow answer never shifts the card. */}
                    <ul className="m-results">
                        {searching && results.length === 0 && (
                            <li className="m-status">Searching…</li>
                        )}
                        {!searching &&
                            results.length === 0 &&
                            query.trim() !== "" &&
                            error == null && (
                                <li className="m-status">
                                    Nothing on TVmaze matches “{query.trim()}”.
                                </li>
                            )}
                        {results.map((candidate, index) => (
                            <li key={candidate.providerShowId}>
                                <button
                                    type="button"
                                    className={`m-pick${index === highlight ? " sel" : ""}`}
                                    aria-current={
                                        index === highlight ? "true" : undefined
                                    }
                                    disabled={busy}
                                    onClick={() =>
                                        void preview(candidate.providerShowId)
                                    }
                                >
                                    <span className="m-pick-name">
                                        {candidate.name}
                                    </span>
                                    <span className="m-pick-facts">
                                        {candidateFacts(candidate)}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                    {error != null && (
                        <p className="form-error lib-error" role="alert">
                            {error}
                        </p>
                    )}
                    <p className="m-attrib">
                        ↑↓ choose · Enter previews · Esc closes — data from
                        TVmaze
                    </p>
                </>
            )}
        </div>
    );
}
