/**
 * Group any two or more episodes into an arc.
 *
 * Split out of `Library.tsx` for the same reason as `AssignPanel`: it owns its
 * own selection state and talks to the screen through two callbacks. The main
 * process stores the episodes in the show's airing order regardless of the order
 * they were clicked in.
 */

import { episodeCode } from "@shared/playback.js";
import type { Episode } from "@shared/types.js";
import {
    type FormEvent,
    type ReactElement,
    useEffect,
    useMemo,
    useState,
} from "react";
import { errorText } from "../utils.js";

/** Season/episode order — the order the scheduler walks a show in. */
function byAiring(a: Episode, b: Episode): number {
    return a.season - b.season || a.episode - b.episode;
}

export default function ArcBuilder({
    showId,
    onCreated,
    onCancel,
}: {
    showId: number;
    onCreated: () => Promise<void>;
    onCancel: () => void;
}): ReactElement {
    const [episodes, setEpisodes] = useState<Episode[] | null>(null);
    const [selected, setSelected] = useState<number[]>([]);
    const [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        setEpisodes(null);
        setSelected([]);
        window.rerun.library
            .listEpisodes(showId)
            .then((eps) => {
                if (alive) setEpisodes([...eps].sort(byAiring));
            })
            .catch((err: unknown) => {
                if (alive) {
                    setEpisodes([]);
                    setError(errorText(err));
                }
            });
        return () => {
            alive = false;
        };
    }, [showId]);

    const ordered = episodes ?? [];
    const selectedSet = useMemo(() => new Set(selected), [selected]);
    const indices = ordered
        .map((ep, i) => (selectedSet.has(ep.id) ? i : -1))
        .filter((i) => i >= 0);
    const canCreate = indices.length >= 2;

    let hint: string;
    if (indices.length === 0) hint = "Pick the episodes that make up the arc.";
    else if (indices.length === 1) hint = "An arc needs at least two parts.";
    else hint = `${indices.length} parts selected · plays in airing order.`;

    function toggle(episodeId: number): void {
        setSelected((current) =>
            current.includes(episodeId)
                ? current.filter((id) => id !== episodeId)
                : [...current, episodeId],
        );
    }

    async function submit(event: FormEvent): Promise<void> {
        event.preventDefault();
        setError(null);
        if (!canCreate) return setError("Select at least two episodes.");
        if (title.trim() === "") return setError("Give the arc a name.");
        setBusy(true);
        try {
            await window.rerun.library.createArc({
                showId,
                episodeIds: indices.map((i) => ordered[i].id),
                title: title.trim(),
            });
            await onCreated();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form className="arc-builder" onSubmit={(event) => void submit(event)}>
            <label
                className="caption arc-builder-caption"
                htmlFor={`arc-title-${showId}`}
            >
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
                <fieldset
                    className="ep-list"
                    aria-label="Episodes to group into an arc"
                >
                    {ordered.map((ep) => {
                        const inArc = ep.partGroupId != null;
                        const on = selectedSet.has(ep.id);
                        return (
                            <button
                                type="button"
                                key={ep.id}
                                className={`ep-pick${on ? " on" : ""}`}
                                aria-pressed={on}
                                disabled={busy || inArc}
                                title={
                                    inArc
                                        ? "Already part of an arc — ungroup it first"
                                        : undefined
                                }
                                onClick={() => toggle(ep.id)}
                            >
                                <span className="ep-code">
                                    {episodeCode(
                                        ep.season,
                                        ep.episode,
                                        ep.episodeEnd,
                                    )}
                                </span>
                                <span className="ep-title">
                                    {ep.title ?? "—"}
                                </span>
                                {inArc && (
                                    <span className="ep-flag">IN ARC</span>
                                )}
                            </button>
                        );
                    })}
                </fieldset>
            )}
            <p className="arc-hint">{hint}</p>
            {error != null && (
                <p className="form-error lib-error" role="alert">
                    {error}
                </p>
            )}
            <div className="assign-actions">
                <button
                    type="submit"
                    className="btn btn-tune btn-sm"
                    disabled={busy || !canCreate}
                >
                    {busy ? "Grouping…" : "Create arc"}
                </button>
                <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busy}
                    onClick={onCancel}
                >
                    Cancel
                </button>
            </div>
        </form>
    );
}
