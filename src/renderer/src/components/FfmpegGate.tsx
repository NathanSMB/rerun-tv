/**
 * The first-launch ffmpeg gate.
 *
 * Rerun TV cannot decode a frame without ffmpeg, so a machine that has none is
 * not in a state any screen can usefully render — the guide would list channels
 * that cannot be tuned and the library would find nothing to scan. This is the
 * one genuinely blocking prerequisite in the app, and the only modal in it.
 *
 * Two decisions shape it:
 *
 * 1. **It overlays, it does not replace.** The shell keeps rendering behind the
 *    scrim. Boot continues, Settings is readable through it once dismissed, and
 *    nothing about the app's structure is special-cased on "no ffmpeg" — which
 *    is also why `App` needs only one line to mount it.
 * 2. **It closes by itself.** There is no dismiss button, because the problem is
 *    real; but the moment a working binary appears — from the download here, or
 *    from a `pacman -S ffmpeg` in a terminal — the re-check finds it and the
 *    modal unmounts. The viewer never has to come back and tell us.
 *
 * The re-check runs on a five-second timer *and* on window focus, because
 * alt-tabbing back from a package manager is exactly the moment the answer
 * changed.
 */

import type { FfmpegInstallProgress } from "@shared/types.js";
import type { JSX, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { errorText } from "../utils.js";
import "./FfmpegGate.css";

/** How often the gate asks again while it is on screen. */
const RECHECK_MS = 5000;

/** Where someone who would rather do it themselves is sent. */
const DOWNLOAD_PAGE = "https://ffmpeg.org/download.html";

function formatMb(bytes: number): string {
    return `${Math.round(bytes / 1_000_000)} MB`;
}

/** The one line under the bar: what is happening, in words. */
function phaseLabel(progress: FfmpegInstallProgress): string {
    switch (progress.phase) {
        case "manifest":
            return "Looking up the build for this machine…";
        case "downloading":
            return progress.receivedBytes != null && progress.totalBytes
                ? `Downloading — ${formatMb(progress.receivedBytes)} of ${formatMb(progress.totalBytes)}`
                : "Downloading…";
        case "verifying":
            return "Checking the download against its published checksum…";
        case "extracting":
            return "Unpacking…";
        case "testing":
            return "Testing that it can encode…";
        case "done":
            return "Installed.";
        case "cancelled":
            return "Download cancelled.";
        case "error":
            return progress.message ?? "The download failed.";
    }
}

/** Zero-width phases still show a bar, so the dialog never looks stalled. */
function percentOf(progress: FfmpegInstallProgress | null): number | null {
    if (progress?.phase !== "downloading") return null;
    if (!progress.totalBytes || progress.receivedBytes == null) return null;
    return Math.min(
        100,
        Math.round((progress.receivedBytes / progress.totalBytes) * 100),
    );
}

export default function FfmpegGate(): JSX.Element {
    const ffmpeg = useStore((s) => s.ffmpeg);
    const install = useStore((s) => s.ffmpegInstall);
    const refreshFfmpeg = useStore((s) => s.refreshFfmpeg);
    const refreshSystem = useStore((s) => s.refreshSystem);

    const [error, setError] = useState<string | null>(null);
    /** Covers the gap between the click and the first progress event. */
    const [starting, setStarting] = useState(false);
    const dialogRef = useRef<HTMLDivElement | null>(null);

    const running =
        starting ||
        (install != null &&
            install.phase !== "done" &&
            install.phase !== "error" &&
            install.phase !== "cancelled");

    // Poll, and ask again whenever the window comes back — the two ways an
    // install done outside the app becomes visible to it.
    useEffect(() => {
        const check = (): void => {
            void refreshFfmpeg(true);
        };
        const timer = window.setInterval(check, RECHECK_MS);
        window.addEventListener("focus", check);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener("focus", check);
        };
    }, [refreshFfmpeg]);

    // The dialog takes the keyboard on mount: everything behind the scrim is
    // inert, and tabbing into a guide nobody can use would be worse than nothing.
    useEffect(() => {
        dialogRef.current?.focus();
    }, []);

    /**
     * Hold Tab inside the dialog.
     *
     * Written out rather than pulled from a library because it is eight lines and
     * this is the app's only modal. Escape is deliberately not handled — there is
     * nothing to escape to.
     */
    function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
        if (event.key !== "Tab") return;
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), a[href]",
        );
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (
            event.shiftKey &&
            (active === first || active === dialogRef.current)
        ) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    async function onDownload(): Promise<void> {
        setError(null);
        setStarting(true);
        try {
            await window.rerun.system.installManagedFfmpeg();
            // The progress event's `done` already refreshes both, but an install
            // that finished between the last event and this resolution would
            // otherwise leave the gate up until the next poll.
            await refreshFfmpeg();
            await refreshSystem();
        } catch (err) {
            setError(errorText(err));
        } finally {
            setStarting(false);
        }
    }

    function onCancel(): void {
        void window.rerun.system.cancelFfmpegInstall();
    }

    const percent = percentOf(install);
    const failed =
        install?.phase === "error" ? (install.message ?? null) : null;
    const message = error ?? failed;

    return (
        <div className="ffg-scrim">
            {/* `tabIndex={-1}` so the dialog itself can take focus on mount
                without joining the tab order — see the effect above. */}
            <div
                className="ffg-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="ffg-title"
                aria-describedby="ffg-body"
                tabIndex={-1}
                ref={dialogRef}
                onKeyDown={onKeyDown}
            >
                <div className="ffg-kicker">Missing component</div>
                <h2 id="ffg-title">FFmpeg is required</h2>
                <p id="ffg-body" className="ffg-body">
                    Rerun TV plays your library through FFmpeg, and this machine
                    doesn&rsquo;t have it. Rerun TV can fetch a copy from its
                    publisher and keep it to itself &mdash; it stays inside the
                    app&rsquo;s own folder and is never added to your{" "}
                    <code>PATH</code>. Or install it yourself; Rerun TV will
                    find it and this notice will go away on its own.
                </p>

                {running && (
                    <div className="ffg-progress">
                        <div
                            className="ffg-track"
                            role="progressbar"
                            aria-label="Download progress"
                            aria-valuenow={percent ?? undefined}
                            aria-valuemin={0}
                            aria-valuemax={100}
                        >
                            <div
                                className={`ffg-fill${percent == null ? " is-indeterminate" : ""}`}
                                style={
                                    percent == null
                                        ? undefined
                                        : { width: `${percent}%` }
                                }
                            />
                        </div>
                        {/* Null only in the moment between the click and the
                            first event, which still needs to say something. */}
                        <div className="ffg-phase">
                            {install == null
                                ? "Starting…"
                                : phaseLabel(install)}
                        </div>
                    </div>
                )}

                {message != null && (
                    <div className="ffg-error" role="alert">
                        {message}
                    </div>
                )}

                <div className="ffg-actions">
                    {running ? (
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={onCancel}
                        >
                            Cancel
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="btn btn-tune btn-sm"
                            disabled={ffmpeg?.downloadable === false}
                            onClick={() => void onDownload()}
                        >
                            Download it for me
                        </button>
                    )}
                    {/*
                        `target="_blank"` rather than an IPC call: the main process
                        already hands http(s) window-opens to the OS browser and
                        refuses everything else (`index.ts`), so this needs no new
                        channel and inherits that scheme check.
                    */}
                    <a
                        className="linkbtn"
                        href={DOWNLOAD_PAGE}
                        target="_blank"
                        rel="noreferrer"
                    >
                        Install it myself&nbsp;&rarr;
                    </a>
                    <button
                        type="button"
                        className="linkbtn"
                        onClick={() => void refreshFfmpeg(true)}
                    >
                        Check again
                    </button>
                </div>

                {ffmpeg?.downloadable === false && (
                    <p className="ffg-note">
                        No managed build is published for this platform yet, so
                        the download is unavailable here &mdash; installing it
                        yourself is the way in.
                    </p>
                )}
            </div>
        </div>
    );
}
