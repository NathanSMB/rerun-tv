/**
 * The manual fix-up for a file the parser couldn't read.
 *
 * Split out of `Library.tsx` because it owns a form's worth of its own state and
 * shares nothing with the screen but two props. Validation happens here — a
 * show, positive integers, a sane double-episode range — so the obvious mistakes
 * never reach IPC; anything the main process rejects (a duplicate episode, say)
 * is surfaced verbatim rather than swallowed.
 *
 * Note what the browser catches before this code runs: the number inputs carry
 * `min=1`, so a zero never reaches `positiveInt` at all. The guards here are for
 * what the constraint lets through — an empty field, or a range that runs
 * backwards.
 */

import type { Show, UnmatchedFile } from "@shared/types.js";
import { type FormEvent, type ReactElement, useState } from "react";
import { errorText, showLabel } from "../utils.js";

export default function AssignPanel({
    file,
    shows,
    onAssigned,
    onCancel,
}: {
    file: UnmatchedFile;
    shows: Show[];
    onAssigned: () => Promise<void>;
    onCancel: () => void;
}): ReactElement {
    const [showId, setShowId] = useState<string>(
        shows[0] != null ? String(shows[0].id) : "",
    );
    const [season, setSeason] = useState("1");
    const [episode, setEpisode] = useState("1");
    const [episodeEnd, setEpisodeEnd] = useState("");
    const [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const id = `assign-${file.id}`;

    function positiveInt(raw: string): number | null {
        const value = Number(raw);
        return Number.isInteger(value) && value > 0 ? value : null;
    }

    async function submit(event: FormEvent): Promise<void> {
        event.preventDefault();
        setError(null);

        const show = Number(showId);
        if (!Number.isInteger(show) || show <= 0)
            return setError("Pick a show for this file.");
        const s = positiveInt(season);
        if (s == null)
            return setError("Season has to be a whole number, 1 or more.");
        const e = positiveInt(episode);
        if (e == null)
            return setError("Episode has to be a whole number, 1 or more.");
        let end: number | null = null;
        if (episodeEnd.trim() !== "") {
            end = positiveInt(episodeEnd);
            if (end == null)
                return setError(
                    "Episode end has to be a whole number, 1 or more.",
                );
            if (end < e)
                return setError(
                    "Episode end has to be the same as, or after, the episode.",
                );
        }

        setBusy(true);
        try {
            await window.rerun.library.assignUnmatched({
                fileId: file.id,
                showId: show,
                season: s,
                episode: e,
                episodeEnd: end,
                title: title.trim() === "" ? null : title.trim(),
            });
            await onAssigned();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setBusy(false);
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
                    {shows.length === 0 && (
                        <option value="">No shows in the library yet</option>
                    )}
                    {shows.map((show) => (
                        <option key={show.id} value={String(show.id)}>
                            {showLabel(show)}
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
                <p className="form-error lib-error" role="alert">
                    {error}
                </p>
            )}
            <div className="assign-actions">
                <button
                    type="submit"
                    className="btn btn-tune btn-sm"
                    disabled={busy}
                >
                    {busy ? "Assigning…" : "Assign"}
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
