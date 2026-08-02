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
 *    truth the scheduler obeys, so it can ungroup false positives and group any
 *    set of episodes the heuristic missed.
 */

import type { ArcView, LibraryShow, UnmatchedFile } from "@shared/types.js";
import {
    type ReactElement,
    useCallback,
    useEffect,
    useMemo,
    useState,
} from "react";
import ArcBuilder from "../components/ArcBuilder.js";
import AssignPanel from "../components/AssignPanel.js";
import { useStore } from "../store.js";
import { errorText, plural } from "../utils.js";
import "./Library.css";

/**
 * What REMUX actually means for this show. The video is a stream copy either
 * way; the only variable is whether ffmpeg also has to encode the soundtrack,
 * which is the common case for anything carrying AC3 or DTS.
 */
function remuxHint(show: LibraryShow): string {
    if (show.paths.remux === 0) return "No files on the remux path.";
    const copy = show.paths.remux - show.remuxAudioEncode;
    const parts = [
        `${plural(show.paths.remux, "file")} copied straight through, video untouched`,
    ];
    if (show.remuxAudioEncode > 0) {
        parts.push(
            `${show.remuxAudioEncode} with the soundtrack encoded to AAC`,
        );
    }
    if (copy > 0 && show.remuxAudioEncode > 0)
        parts.push(`${copy} with the audio copied too`);
    return `${parts.join(" · ")}.`;
}

export default function Library(): ReactElement {
    const library = useStore((s) => s.library);
    const shows = useStore((s) => s.shows);
    const scan = useStore((s) => s.scan);
    const roots = useStore((s) => s.roots);
    const refreshLibrary = useStore((s) => s.refreshLibrary);
    const navigate = useStore((s) => s.navigate);

    const [selectedShowId, setSelectedShowId] = useState<number | null>(null);
    const [arcs, setArcs] = useState<ArcView[]>([]);
    const [arcsBusy, setArcsBusy] = useState(false);
    const [arcsError, setArcsError] = useState<string | null>(null);
    const [scanBusy, setScanBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [assigningId, setAssigningId] = useState<number | null>(null);
    const [dismissingId, setDismissingId] = useState<number | null>(null);
    const [buildingArc, setBuildingArc] = useState(false);

    // Keep a show selected so the arc panel always has something to show.
    useEffect(() => {
        if (library == null) return;
        const stillThere = library.shows.some(
            (show) => show.id === selectedShowId,
        );
        if (!stillThere) setSelectedShowId(library.shows[0]?.id ?? null);
    }, [library, selectedShowId]);

    const reloadArcs = useCallback(
        async (showId: number | null): Promise<void> => {
            if (showId == null) {
                setArcs([]);
                return;
            }
            setArcsBusy(true);
            setArcsError(null);
            try {
                setArcs(await window.rerun.library.listArcs(showId));
            } catch (err) {
                setArcsError(errorText(err));
            } finally {
                setArcsBusy(false);
            }
        },
        [],
    );

    useEffect(() => {
        void reloadArcs(selectedShowId);
        setBuildingArc(false);
    }, [selectedShowId, reloadArcs]);

    const selectedShow: LibraryShow | null = useMemo(
        () => library?.shows.find((show) => show.id === selectedShowId) ?? null,
        [library, selectedShowId],
    );

    // ---- scan strip ---------------------------------------------------------

    const scanLabel =
        scan.state === "scanning"
            ? `Scanning ${scan.currentRoot ?? "library"} · incremental`
            : scan.state === "paused"
              ? `Paused · ${scan.currentRoot ?? "library"}`
              : "Library · scanner idle";

    const scanButtonLabel =
        scan.state === "scanning"
            ? "Pause scan"
            : scan.state === "paused"
              ? "Resume scan"
              : "Rescan";

    const pct =
        scan.total > 0
            ? Math.min(100, Math.round((scan.done / scan.total) * 100))
            : 0;

    async function onScanButton(): Promise<void> {
        setScanBusy(true);
        setActionError(null);
        try {
            if (scan.state === "scanning")
                await window.rerun.library.pauseScan();
            else if (scan.state === "paused")
                await window.rerun.library.resumeScan();
            else await window.rerun.library.rescan();
        } catch (err) {
            setActionError(errorText(err));
        } finally {
            setScanBusy(false);
        }
    }

    async function onDismiss(file: UnmatchedFile): Promise<void> {
        setDismissingId(file.id);
        setActionError(null);
        try {
            await window.rerun.library.dismissUnmatched(file.id);
            await refreshLibrary();
        } catch (err) {
            setActionError(errorText(err));
        } finally {
            setDismissingId(null);
        }
    }

    async function onUngroup(arc: ArcView): Promise<void> {
        setArcsBusy(true);
        setArcsError(null);
        try {
            await window.rerun.library.deleteArc(arc.id);
            await refreshLibrary();
            await reloadArcs(selectedShowId);
        } catch (err) {
            setArcsError(errorText(err));
        } finally {
            setArcsBusy(false);
        }
    }

    const noRoots = roots != null && roots.length === 0;
    const noEpisodes =
        !noRoots && library != null && library.totalEpisodes === 0;
    const unmatched = library?.unmatched ?? [];

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
                            {scan.done.toLocaleString()} of{" "}
                            {scan.total.toLocaleString()}
                        </b>{" "}
                        files probed · {scan.probed.toLocaleString()} new since
                        last scan · unchanged files skipped
                    </div>
                    {scan.error != null && (
                        <p className="form-error lib-error" role="alert">
                            {scan.error}
                        </p>
                    )}
                    {actionError != null && (
                        <p className="form-error lib-error" role="alert">
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
                    {scanBusy ? "Working…" : scanButtonLabel}
                </button>
            </div>

            <div className="lib-body">
                <div className="lib-main">
                    {noRoots ? (
                        <div className="empty">
                            <b>No folders to scan yet</b>
                            Rerun TV needs at least one library folder — a
                            directory whose top-level folders are show names.
                            Add one in Settings and the scanner will take it
                            from there.
                            <div className="lib-empty-actions">
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => navigate("settings")}
                                >
                                    Open Settings
                                </button>
                            </div>
                        </div>
                    ) : noEpisodes ? (
                        <div className="empty">
                            <b>Nothing scanned yet</b>
                            Your folders are configured but no episodes have
                            been parsed. Run a scan — files are keyed by path,
                            size and mtime, so nothing is probed twice.
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
                            <div className="caption lineup-caption">
                                Shows — with how each file will play
                            </div>
                            {(library?.shows ?? []).map((show) => (
                                <button
                                    type="button"
                                    key={show.id}
                                    className={`show-row${show.id === selectedShowId ? " sel" : ""}`}
                                    // `aria-current`, not `aria-pressed`: exactly
                                    // one row is selected at a time and selecting
                                    // another deselects this one, which is
                                    // "current item", not a toggle. (The episode
                                    // pickers below *are* toggles and keep
                                    // `aria-pressed`.)
                                    aria-current={
                                        show.id === selectedShowId
                                            ? "true"
                                            : undefined
                                    }
                                    onClick={() => setSelectedShowId(show.id)}
                                >
                                    <span className="s-block">
                                        <span className="s-name">
                                            {show.title}
                                        </span>
                                        <span className="s-facts">
                                            {plural(
                                                show.episodeCount,
                                                "episode",
                                            )}{" "}
                                            ·{" "}
                                            {plural(show.seasonCount, "season")}{" "}
                                            · {plural(show.arcCount, "arc")}
                                        </span>
                                    </span>
                                    <span className="pipetags">
                                        <span className="pipetag">
                                            DIRECT {show.paths.direct}
                                        </span>
                                        <span
                                            className="pipetag"
                                            title={remuxHint(show)}
                                        >
                                            REMUX {show.paths.remux}
                                            {show.remuxAudioEncode > 0 && (
                                                <span className="pipetag-sub">
                                                    {" "}
                                                    · {show.remuxAudioEncode} →
                                                    AAC
                                                </span>
                                            )}
                                        </span>
                                        <span className="pipetag warn">
                                            TRANSCODE {show.paths.transcode}
                                        </span>
                                    </span>
                                    <span className="s-ok">✓ READY</span>
                                </button>
                            ))}

                            <div className="caption lineup-caption">
                                {unmatched.length === 0
                                    ? "Unmatched — nothing waiting"
                                    : `Unmatched — ${plural(unmatched.length, "file")} waiting for a home`}
                            </div>
                            {unmatched.length === 0 ? (
                                <p className="lib-note">
                                    Every file the scanner saw parsed into a
                                    show, season and episode.
                                </p>
                            ) : (
                                unmatched.map((file) => (
                                    <div key={file.id}>
                                        <div className="file-row">
                                            <span
                                                className="file-path"
                                                title={file.reason}
                                            >
                                                {file.path}
                                            </span>
                                            <span className="file-actions">
                                                <button
                                                    type="button"
                                                    className="btn btn-ghost btn-sm"
                                                    aria-expanded={
                                                        assigningId === file.id
                                                    }
                                                    onClick={() =>
                                                        setAssigningId(
                                                            assigningId ===
                                                                file.id
                                                                ? null
                                                                : file.id,
                                                        )
                                                    }
                                                >
                                                    Assign…
                                                </button>
                                                <button
                                                    type="button"
                                                    className="btn btn-ghost btn-sm"
                                                    disabled={
                                                        dismissingId === file.id
                                                    }
                                                    onClick={() =>
                                                        void onDismiss(file)
                                                    }
                                                >
                                                    {dismissingId === file.id
                                                        ? "Dismissing…"
                                                        : "Dismiss"}
                                                </button>
                                            </span>
                                        </div>
                                        {assigningId === file.id && (
                                            <AssignPanel
                                                file={file}
                                                shows={shows}
                                                onCancel={() =>
                                                    setAssigningId(null)
                                                }
                                                onAssigned={async () => {
                                                    setAssigningId(null);
                                                    await refreshLibrary();
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
                        Detected arcs ·{" "}
                        {selectedShow?.title ?? "no show selected"}
                    </div>

                    {arcsError != null && (
                        <p className="form-error lib-error" role="alert">
                            {arcsError}
                        </p>
                    )}

                    {selectedShow == null ? (
                        <p className="side-tip">
                            Select a show to review the arcs the scheduler will
                            obey.
                        </p>
                    ) : (
                        <>
                            {arcsBusy && arcs.length === 0 && (
                                <p className="lib-note">Loading arcs…</p>
                            )}
                            {!arcsBusy && arcs.length === 0 && (
                                <p className="lib-note">
                                    No arcs in {selectedShow.title}. Every
                                    episode is drawn on its own.
                                </p>
                            )}
                            {arcs.map((arc) => (
                                <div className="arc-card" key={arc.id}>
                                    <div className="a-name">“{arc.title}”</div>
                                    <div className="a-meta">
                                        {arc.partCount} PARTS · {arc.range} ·{" "}
                                        {arc.source === "auto"
                                            ? "AUTO-DETECTED"
                                            : "GROUPED BY YOU"}
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
                                Select any episodes in a show to group them into
                                an arc the scheduler will play in airing order
                                without interruption.
                            </p>

                            {buildingArc ? (
                                <ArcBuilder
                                    showId={selectedShow.id}
                                    onCancel={() => setBuildingArc(false)}
                                    onCreated={async () => {
                                        setBuildingArc(false);
                                        await refreshLibrary();
                                        await reloadArcs(selectedShow.id);
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
    );
}
