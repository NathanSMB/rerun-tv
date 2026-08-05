/**
 * Screen 05 · Settings.
 *
 * Every knob in one place — the app never asks anyone to edit JSON
 * (docs/ui.md). Four sections: where the media lives, how it plays, how the
 * interface behaves, and what the system underneath is doing.
 *
 * They are laid out as stops on a tuning rail — numbered 01–04 down a sticky
 * dial, with one flat column of rows beside it — rather than the four cards in
 * a grid this screen used to be. Playback grew to twice the height of the
 * library, and no arrangement of quadrants hides that: one column always ends
 * early and leaves a hole. A single column has no such seam, and the rail is
 * what keeps every section one click away without it.
 */

import type {
    AppSettings,
    FfmpegInstallProgress,
    FfmpegState,
    ScanRoot,
    SystemInfo,
} from "@shared/types.js";
import { SLEEP_MAX_MIN } from "@shared/types.js";
import { type ReactElement, useRef, useState } from "react";
import Toggle from "../components/Toggle.js";
import { useTunedSection } from "../hooks/useTunedSection.js";
import { useStore } from "../store.js";
import { errorText, useBusyAction } from "../utils.js";
import "./Settings.css";

/**
 * The dial, in the order the sections appear below. Numbered because the rail
 * reads as channel stops — the same 01/02/03 vocabulary the guide uses for
 * channels — not because settings have to be done in sequence.
 */
const SECTIONS = [
    {
        id: "set-library",
        num: "01",
        name: "Library",
        blurb: "Folders scanned for episodes",
    },
    {
        id: "set-playback",
        num: "02",
        name: "Playback",
        blurb: "How episodes are decoded and handed off",
    },
    {
        id: "set-interface",
        num: "03",
        name: "Interface",
        blurb: "How the app behaves around you",
    },
    {
        id: "set-system",
        num: "04",
        name: "System",
        blurb: "What the machinery underneath is doing",
    },
] as const;

/** x264 preset + CRF travel together, so one control writes both settings. */
const QUALITY_PRESETS = [
    { preset: "ultrafast", crf: 23, label: "ultrafast · CRF 23" },
    { preset: "veryfast", crf: 21, label: "veryfast · CRF 21" },
    { preset: "fast", crf: 20, label: "fast · CRF 20" },
    { preset: "medium", crf: 19, label: "medium · CRF 19" },
] as const;

const AUDIO_BITRATES = ["128k", "192k", "256k", "320k"] as const;

/**
 * The three transcode backends. Named by the hardware the user recognises —
 * "NVIDIA GPUs", not "NVENC alone" — because the vendor is the part anyone can
 * check against the machine in front of them.
 */
const HW_ACCELS: { value: AppSettings["hardwareAccel"]; label: string }[] = [
    { value: "software", label: "Software (libx264)" },
    { value: "vaapi", label: "VAAPI — Intel & AMD GPUs" },
    { value: "nvenc", label: "NVENC — NVIDIA GPUs" },
];

/**
 * Annotate an option with what the startup probe found.
 *
 * Options stay *selectable* when the probe says no: a probe can be wrong (a
 * driver that loads late, a device that appears after launch), and choosing an
 * absent backend is harmless — the stream server falls back to software on its
 * own. The note is information, not a gate.
 */
function availabilityNote(
    value: AppSettings["hardwareAccel"],
    report: SystemInfo["hwAccel"] | undefined,
): string {
    if (value === "software" || report == null) return "";
    const status = value === "vaapi" ? report.vaapi : report.nvenc;
    if (status === "pending") return " · checking…";
    return status === "ok" ? " · available" : " · not detected";
}

const START_SCREENS: { value: AppSettings["startScreen"]; label: string }[] = [
    { value: "guide", label: "Guide" },
    { value: "library", label: "Library" },
    { value: "settings", label: "Settings" },
];

const OSD_DELAYS = [2, 3, 5, 10];

/**
 * Where the sleep dial opens. Only a starting point now — the panel's dial goes
 * anywhere up to `SLEEP_MAX_MIN` in five-minute steps — so this list is a set of
 * likely answers rather than the whole range the player can reach.
 */
const SLEEP_DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, SLEEP_MAX_MIN];

/** "45 minutes", "1 h 30 min", "5 hours" — the dropdown's labels. */
function sleepDurationLabel(minutes: number): string {
    if (minutes < 60) return `${minutes} minutes`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    const hoursLabel = hours === 1 ? "1 hour" : `${hours} hours`;
    return rest === 0 ? hoursLabel : `${hours} h ${rest} min`;
}

function formatMb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the badge beside the version says the binary *is*. */
const FFMPEG_SOURCE_LABEL: Record<FfmpegState["source"], string> = {
    managed: "managed by Rerun TV",
    system: "installed on this system",
    bundled: "shipped beside the app",
    missing: "not found",
};

/** …and the sentence under the label explaining what that means. */
const FFMPEG_SOURCE_HINT: Record<FfmpegState["source"], string> = {
    managed:
        "Rerun TV's own copy, kept in its data folder and never added to your PATH",
    system: "Found on this machine's PATH; a managed copy would take precedence",
    bundled: "Found beside the application itself",
    missing:
        "Nothing to play with — download a managed copy, or install ffmpeg",
};

/** The Settings card's one-line echo of an install in flight. */
function installLabel(progress: FfmpegInstallProgress): string {
    switch (progress.phase) {
        case "manifest":
            return "Looking up the build for this machine…";
        case "downloading":
            return progress.receivedBytes != null && progress.totalBytes
                ? `Downloading — ${Math.round((progress.receivedBytes / progress.totalBytes) * 100)}%`
                : "Downloading…";
        case "verifying":
            return "Verifying the checksum…";
        case "extracting":
            return "Unpacking…";
        case "testing":
            return "Testing that it can encode…";
        case "done":
            return progress.message ?? "Installed.";
        case "cancelled":
            return "Download cancelled.";
        case "error":
            return progress.message ?? "The download failed.";
    }
}

function baseName(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1) || path;
}

function formatDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * One stop's heading — the name, and what the section is for.
 *
 * Takes the section itself rather than its id: looking it back up out of
 * `SECTIONS` needed a non-null assertion the compiler couldn't verify, for no
 * gain over passing the object the caller already has.
 */
function SectionHead({
    section,
}: {
    section: (typeof SECTIONS)[number];
}): ReactElement {
    const id = section.id;
    return (
        <div className="set-head">
            <h2 id={`${id}-title`}>{section.name}</h2>
            <span className="set-blurb">{section.blurb}</span>
        </div>
    );
}

/**
 * The System section's status dot.
 *
 * `ok` is the unmodified green, `warn` amber ("still checking", "paused"), `bad`
 * red. A named component rather than the four near-identical nested ternaries
 * this replaced — those were the one place in the screen where reading the
 * markup did not tell you what colour anything would be.
 */
function StatusDot({
    status,
}: {
    status: "ok" | "warn" | "bad";
}): ReactElement {
    const suffix = status === "ok" ? "" : ` ${status}`;
    return <span className={`status-dot${suffix}`} />;
}

/** `pending` reads as "still working", anything else as pass/fail. */
function probeStatus(value: string | null | undefined): "ok" | "warn" | "bad" {
    if (value == null || value === "pending") return "warn";
    return value === "ok" ? "ok" : "bad";
}

export default function Settings(): ReactElement {
    const settings = useStore((s) => s.settings);
    const system = useStore((s) => s.system);
    const ffmpeg = useStore((s) => s.ffmpeg);
    const ffmpegInstall = useStore((s) => s.ffmpegInstall);
    const setSetting = useStore((s) => s.setSetting);
    const refreshLibrary = useStore((s) => s.refreshLibrary);
    const refreshSystem = useStore((s) => s.refreshSystem);
    const refreshFfmpeg = useStore((s) => s.refreshFfmpeg);
    const roots = useStore((s) => s.roots);
    const refreshRoots = useStore((s) => s.refreshRoots);

    const { busy, error, run: runAction, setError } = useBusyAction();
    /** A one-line confirmation after an action that produced no visible change. */
    const [note, setNote] = useState<string | null>(null);
    /** The ffmpeg download's own lock; see `onInstallFfmpeg` for why it isn't the shared one. */
    const [installing, setInstalling] = useState(false);

    const bodyRef = useRef<HTMLDivElement | null>(null);
    const tuned = useTunedSection(bodyRef, SECTIONS);

    const locked = busy !== null;

    /** Jump the reader to a stop. The spy picks the highlight up from there. */
    function tuneTo(id: string): void {
        const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)")
            .matches;
        document.getElementById(id)?.scrollIntoView({
            behavior: smooth ? "smooth" : "auto",
            block: "start",
        });
    }

    /**
     * One settings/system call under the shared busy lock, plus this screen's
     * extra: a returned string becomes a confirmation note ("Backup written
     * to…"), because several of these actions have no other visible result.
     */
    async function run(
        key: string,
        fn: () => Promise<string | null>,
    ): Promise<void> {
        setNote(null);
        await runAction(key, async () => {
            const message = await fn();
            if (message != null) setNote(message);
        });
    }

    function update<K extends keyof AppSettings>(
        key: K,
        value: AppSettings[K],
    ): void {
        void run(`setting:${String(key)}`, async () => {
            await setSetting(key, value);
            return null;
        });
    }

    function onQualityChange(value: string): void {
        const chosen = QUALITY_PRESETS.find(
            (q) => `${q.preset}:${q.crf}` === value,
        );
        if (chosen == null) return;
        void run("setting:quality", async () => {
            await setSetting("transcodePreset", chosen.preset);
            await setSetting("transcodeCrf", chosen.crf);
            return null;
        });
    }

    function onAddFolder(): void {
        void run("addRoot", async () => {
            const path = await window.rerun.system.pickFolder();
            if (path == null) return null;
            await window.rerun.library.addRoot(path);
            // Re-read rather than trusting the mutation's return value: the roots
            // are shared with the Library screen now, and one path in and out of
            // the store is what keeps the two from disagreeing.
            await refreshRoots();
            await refreshLibrary();
            return `Added ${path}. It will be scanned on the next pass.`;
        });
    }

    function onRemoveRoot(root: ScanRoot): void {
        const ok = window.confirm(
            `Remove ${root.path} from the library?\n\nEpisodes found only under this folder stop being scheduled. Files on disk are not touched.`,
        );
        if (!ok) return;
        void run(`removeRoot:${root.id}`, async () => {
            await window.rerun.library.removeRoot(root.id);
            await refreshRoots();
            await refreshLibrary();
            return `Removed ${root.path}.`;
        });
    }

    function onRescanAll(): void {
        void run("rescan", async () => {
            await window.rerun.library.rescan(true);
            return "Full rescan started — every file is being re-probed.";
        });
    }

    function onBackup(): void {
        void run("backup", async () => {
            const path = await window.rerun.system.backupDb();
            return path == null
                ? "Backup cancelled."
                : `Database backed up to ${path}`;
        });
    }

    /**
     * The picker, the validation and the confirm all live in main — it's the only
     * side that can report what's actually in the file being imported. All that
     * comes back is whether the user went through with it.
     */
    function onImport(): void {
        void run("import", async () => {
            const started = await window.rerun.system.importDb();
            return started
                ? "Importing — Rerun TV is restarting…"
                : "Import cancelled.";
        });
    }

    /**
     * Download (or re-download) the managed copy.
     *
     * Deliberately *not* through `run()`, which every other action on this screen
     * uses. The shared lock disables the whole screen for the length of an
     * action, which is right for a folder picker and wrong for a 120 MB
     * download — nobody should be unable to change their transcode preset for
     * three minutes because a download is running. Its own `installing` flag
     * guards only the buttons that would misbehave, and the card reports itself
     * through the progress event.
     */
    function onInstallFfmpeg(): void {
        setNote(null);
        setError(null);
        setInstalling(true);
        void window.rerun.system
            .installManagedFfmpeg()
            .then(async (version) => {
                await refreshFfmpeg();
                await refreshSystem();
                setNote(
                    `ffmpeg ${version} installed. Rerun TV is using it now.`,
                );
            })
            .catch((err: unknown) => setError(errorText(err)))
            .finally(() => setInstalling(false));
    }

    function onCancelFfmpeg(): void {
        void window.rerun.system.cancelFfmpegInstall();
    }

    function onCheckFfmpegUpdate(): void {
        void run("ffmpegUpdate", async () => {
            const check = await window.rerun.system.checkFfmpegUpdate();
            if (check.latest == null)
                return "No managed build is published for this platform.";
            return check.updateAvailable
                ? `${check.latest} is available — press Reinstall to update from ${check.installed}.`
                : `Up to date (${check.installed}).`;
        });
    }

    function onRemoveFfmpeg(): void {
        const ok = window.confirm(
            "Remove Rerun TV's own copy of ffmpeg?\n\nPlayback falls back to the ffmpeg installed on this system, if there is one. Nothing else on your machine is touched.",
        );
        if (!ok) return;
        void run("ffmpegRemove", async () => {
            const state = await window.rerun.system.removeManagedFfmpeg();
            await refreshFfmpeg();
            await refreshSystem();
            return state.source === "missing"
                ? "Removed. There is no other ffmpeg on this machine."
                : `Removed. Rerun TV is using the ${FFMPEG_SOURCE_LABEL[state.source]} binary now.`;
        });
    }

    const qualityKey = `${settings.transcodePreset}:${settings.transcodeCrf}`;
    const knownQuality = QUALITY_PRESETS.some(
        (q) => `${q.preset}:${q.crf}` === qualityKey,
    );

    const ffmpegOk = ffmpeg != null && ffmpeg.source !== "missing";

    /**
     * True while an install is genuinely in flight.
     *
     * Both halves are needed. `installing` covers the gap between the click and
     * the first progress event, which is where a second click would land; the
     * phase covers an install started from the *gate*, which this screen never
     * saw begin but must still not offer to start again.
     */
    const ffmpegBusy =
        installing ||
        (ffmpegInstall != null &&
            ffmpegInstall.phase !== "done" &&
            ffmpegInstall.phase !== "error" &&
            ffmpegInstall.phase !== "cancelled");

    const managedHint =
        ffmpeg == null
            ? "—"
            : ffmpeg.managed != null
              ? `${ffmpeg.managed.version}${
                    ffmpeg.managed.installedAt
                        ? ` · installed ${formatDate(ffmpeg.managed.installedAt)}`
                        : ""
                } · ${ffmpeg.managed.dir}`
              : ffmpeg.downloadable
                ? "Rerun TV can download its own copy and prefer it over the system one. It lives in the app's data folder and is never added to your PATH."
                : "No managed build is published for this platform — install ffmpeg yourself and Rerun TV will find it.";

    /**
     * The one sentence worth adding under the dropdown: that a selection this
     * machine can't honour still plays, on software. Only shown when it applies,
     * so the hint doesn't warn about a situation the user isn't in.
     */
    const selectedHwStatus =
        system == null || settings.hardwareAccel === "software"
            ? null
            : settings.hardwareAccel === "vaapi"
              ? system.hwAccel.vaapi
              : system.hwAccel.nvenc;
    const hwHint =
        selectedHwStatus === "failed"
            ? "This machine reports no working encoder for the selected backend — transcodes will run on software."
            : null;

    /**
     * The rail's foot: the answer to "is anything wrong?", visible from every
     * section. It reports only what would send someone to 04 — a missing ffmpeg
     * or a failed codec check stop playback outright, while an absent GPU encoder
     * doesn't (transcodes fall back to software), so that one isn't an alarm. The
     * version is deliberately not repeated here; 04 already ends with it.
     */
    const railStatus =
        system == null
            ? { tone: " warn", text: "checking…" }
            : !ffmpegOk
              ? { tone: " bad", text: "ffmpeg missing" }
              : system.codecCheck === "failed"
                ? { tone: " bad", text: "codec check failed" }
                : system.codecCheck === "pending"
                  ? { tone: " warn", text: "checking…" }
                  : { tone: "", text: "all systems ok" };

    return (
        <div className="set-body" ref={bodyRef}>
            <nav className="set-rail" aria-label="Settings sections">
                {SECTIONS.map((section) => (
                    <button
                        key={section.id}
                        type="button"
                        className={`set-rail-item${tuned === section.id ? " on" : ""}`}
                        aria-current={tuned === section.id ? "true" : undefined}
                        onClick={() => tuneTo(section.id)}
                    >
                        <span className="num">{section.num}</span>
                        <span className="name">{section.name}</span>
                    </button>
                ))}
                <div className="set-rail-status">
                    <span className={`status-dot${railStatus.tone}`} />
                    {railStatus.text}
                </div>
            </nav>

            <main>
                {(error != null || note != null) && (
                    <div
                        className="set-status"
                        role={error != null ? "alert" : "status"}
                    >
                        {error != null ? (
                            <span className="set-status-error">{error}</span>
                        ) : (
                            <span>{note}</span>
                        )}
                    </div>
                )}

                {/* ---- 01 · library folders ---- */}
                <section
                    className="set-section"
                    id="set-library"
                    aria-labelledby="set-library-title"
                >
                    <SectionHead section={SECTIONS[0]} />

                    {roots == null && (
                        <div className="set-row set-muted">
                            Loading folders…
                        </div>
                    )}
                    {roots != null && roots.length === 0 && (
                        <div className="set-row set-muted">
                            No folders yet — add one and the scanner will walk
                            it.
                        </div>
                    )}
                    {(roots ?? []).map((root) => (
                        <div className="set-row" key={root.id}>
                            <span className="folder-path">{root.path}</span>
                            <span className="set-value">
                                {settings.watchFolders && (
                                    <>
                                        <span className="status-dot" />
                                        watching
                                    </>
                                )}
                                <button
                                    type="button"
                                    className="remove"
                                    aria-label={`Remove ${root.path}`}
                                    disabled={locked}
                                    onClick={() => onRemoveRoot(root)}
                                >
                                    ✕
                                </button>
                            </span>
                        </div>
                    ))}

                    <div className="set-row">
                        <div>
                            <div className="set-label">
                                Watch folders for new episodes
                            </div>
                            <div className="set-hint">
                                New files are parsed and probed as they appear
                            </div>
                        </div>
                        <Toggle
                            checked={settings.watchFolders}
                            label="Watch folders for new episodes"
                            disabled={locked}
                            onChange={(next) => update("watchFolders", next)}
                        />
                    </div>

                    <div className="set-row">
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={locked}
                            onClick={onAddFolder}
                        >
                            {busy === "addRoot" ? "Choosing…" : "+ Add folder"}
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={
                                locked || roots == null || roots.length === 0
                            }
                            onClick={onRescanAll}
                        >
                            {busy === "rescan"
                                ? "Starting…"
                                : "Rescan everything"}
                        </button>
                    </div>
                </section>

                {/* ---- 02 · playback ---- */}
                <section
                    className="set-section"
                    id="set-playback"
                    aria-labelledby="set-playback-title"
                >
                    <SectionHead section={SECTIONS[1]} />

                    <div className="set-row">
                        <div>
                            <label className="set-label" htmlFor="set-quality">
                                Transcode quality
                            </label>
                            <div className="set-hint">
                                Only used when a file can&rsquo;t direct-play or
                                remux
                            </div>
                        </div>
                        <select
                            id="set-quality"
                            className="selectbox"
                            value={qualityKey}
                            disabled={locked}
                            onChange={(event) =>
                                onQualityChange(event.target.value)
                            }
                        >
                            {!knownQuality && (
                                <option value={qualityKey}>
                                    {settings.transcodePreset} · CRF{" "}
                                    {settings.transcodeCrf}
                                </option>
                            )}
                            {QUALITY_PRESETS.map((q) => (
                                <option
                                    key={q.label}
                                    value={`${q.preset}:${q.crf}`}
                                >
                                    {q.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="set-row">
                        <label className="set-label" htmlFor="set-audio">
                            Audio bitrate (transcode)
                        </label>
                        <select
                            id="set-audio"
                            className="selectbox"
                            value={settings.transcodeAudioBitrate}
                            disabled={locked}
                            onChange={(event) =>
                                update(
                                    "transcodeAudioBitrate",
                                    event.target.value,
                                )
                            }
                        >
                            {!AUDIO_BITRATES.includes(
                                settings.transcodeAudioBitrate as (typeof AUDIO_BITRATES)[number],
                            ) && (
                                <option value={settings.transcodeAudioBitrate}>
                                    {settings.transcodeAudioBitrate}
                                </option>
                            )}
                            {AUDIO_BITRATES.map((rate) => (
                                <option key={rate} value={rate}>
                                    {rate.replace("k", "")} kbps
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="set-row">
                        <div>
                            <label className="set-label" htmlFor="set-hwaccel">
                                Hardware encode &amp; decode
                            </label>
                            <div className="set-hint">
                                GPU acceleration for episodes that need a full
                                transcode. Direct and remux playback never
                                re-encode video, so they are unaffected.
                                {hwHint != null && <> {hwHint}</>}
                            </div>
                        </div>
                        <select
                            id="set-hwaccel"
                            className="selectbox"
                            value={settings.hardwareAccel}
                            disabled={locked}
                            onChange={(event) =>
                                update(
                                    "hardwareAccel",
                                    event.target
                                        .value as AppSettings["hardwareAccel"],
                                )
                            }
                        >
                            {HW_ACCELS.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                    {availabilityNote(
                                        option.value,
                                        system?.hwAccel,
                                    )}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="set-row">
                        <div>
                            <div className="set-label">
                                Loudness equalization
                            </div>
                            <div className="set-hint">
                                Even out volume across episodes and between
                                quiet and loud scenes, targeting &minus;16 LUFS.
                                Episodes are measured in the background while
                                nothing is playing.
                            </div>
                        </div>
                        <Toggle
                            checked={settings.loudnessEq}
                            label="Loudness equalization"
                            disabled={locked}
                            onChange={(next) => update("loudnessEq", next)}
                        />
                    </div>

                    <div className="set-row">
                        <div>
                            <div className="set-label">
                                Pre-warm next episode
                            </div>
                            <div className="set-hint">
                                Buffer the next episode during the last 30 s so
                                handoffs cut instantly. Runs a second stream for
                                that half-minute.
                            </div>
                        </div>
                        <Toggle
                            checked={settings.prewarmNext}
                            label="Pre-warm next episode"
                            disabled={locked}
                            onChange={(next) => update("prewarmNext", next)}
                        />
                    </div>
                </section>

                {/* ---- 03 · interface ---- */}
                <section
                    className="set-section"
                    id="set-interface"
                    aria-labelledby="set-interface-title"
                >
                    <SectionHead section={SECTIONS[2]} />

                    <div className="set-row">
                        <label className="set-label" htmlFor="set-start">
                            Start on
                        </label>
                        <select
                            id="set-start"
                            className="selectbox"
                            value={settings.startScreen}
                            disabled={locked}
                            onChange={(event) =>
                                update(
                                    "startScreen",
                                    event.target
                                        .value as AppSettings["startScreen"],
                                )
                            }
                        >
                            {START_SCREENS.map((screen) => (
                                <option key={screen.value} value={screen.value}>
                                    {screen.label}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="set-row">
                        <label className="set-label" htmlFor="set-osd">
                            Hide player controls after
                        </label>
                        <select
                            id="set-osd"
                            className="selectbox"
                            value={String(settings.osdHideAfterS)}
                            disabled={locked}
                            onChange={(event) =>
                                update(
                                    "osdHideAfterS",
                                    Number(event.target.value),
                                )
                            }
                        >
                            {!OSD_DELAYS.includes(settings.osdHideAfterS) && (
                                <option value={String(settings.osdHideAfterS)}>
                                    {settings.osdHideAfterS} seconds
                                </option>
                            )}
                            {OSD_DELAYS.map((seconds) => (
                                <option key={seconds} value={String(seconds)}>
                                    {seconds} seconds
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="set-row">
                        <div>
                            <label className="set-label" htmlFor="set-sleep">
                                Sleep timer starts at
                            </label>
                            <div className="set-hint">
                                Where the dial opens on the first press of{" "}
                                <kbd>S</kbd>; drag it anywhere up to 5 hours.
                                Playback stops at the end of the episode or arc
                            </div>
                        </div>
                        <select
                            id="set-sleep"
                            className="selectbox"
                            value={String(settings.sleepTimerDefaultMin)}
                            disabled={locked}
                            onChange={(event) =>
                                update(
                                    "sleepTimerDefaultMin",
                                    Number(event.target.value),
                                )
                            }
                        >
                            {!SLEEP_DURATIONS.includes(
                                settings.sleepTimerDefaultMin,
                            ) && (
                                <option
                                    value={String(
                                        settings.sleepTimerDefaultMin,
                                    )}
                                >
                                    {sleepDurationLabel(
                                        settings.sleepTimerDefaultMin,
                                    )}
                                </option>
                            )}
                            {SLEEP_DURATIONS.map((minutes) => (
                                <option key={minutes} value={String(minutes)}>
                                    {sleepDurationLabel(minutes)}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="set-row">
                        <div>
                            <div className="set-label">Remember volume</div>
                            <div className="set-hint">
                                Restore last volume and mute state on launch
                            </div>
                        </div>
                        <Toggle
                            checked={settings.rememberVolume}
                            label="Remember volume"
                            disabled={locked}
                            onChange={(next) => update("rememberVolume", next)}
                        />
                    </div>

                    <section
                        className="shortcuts"
                        aria-label="Keyboard shortcuts"
                    >
                        <span>
                            <kbd>Space</kbd>pause
                        </span>
                        <span>
                            <kbd>↑</kbd>
                            <kbd>↓</kbd>volume
                        </span>
                        <span>
                            <kbd>→</kbd>skip
                        </span>
                        <span>
                            <kbd>S</kbd>sleep timer
                        </span>
                        <span>
                            <kbd>P</kbd>picture-in-picture
                        </span>
                        <span>
                            <kbd>F</kbd>fullscreen
                        </span>
                        <span>
                            <kbd>Esc</kbd>guide
                        </span>
                    </section>
                </section>

                {/* ---- 04 · system ---- */}
                <section
                    className="set-section"
                    id="set-system"
                    aria-labelledby="set-system-title"
                >
                    <SectionHead section={SECTIONS[3]} />

                    <div className="set-row">
                        <div>
                            <div className="set-label">ffmpeg</div>
                            <div className="set-hint">
                                {ffmpeg == null
                                    ? "Locating the binary…"
                                    : FFMPEG_SOURCE_HINT[ffmpeg.source]}
                            </div>
                            {ffmpeg?.path != null && (
                                <div className="set-hint folder-path">
                                    {ffmpeg.path}
                                </div>
                            )}
                            {/* Only worth a line when it disagrees with the winner —
                                an env override pinning something else, or a managed
                                copy that has just been superseded. */}
                            {ffmpeg?.managed != null &&
                                ffmpeg.source !== "managed" && (
                                    <div className="set-hint">
                                        A managed copy ({ffmpeg.managed.version}
                                        ) is installed but not in use —
                                        something else is taking precedence.
                                    </div>
                                )}
                        </div>
                        <span className="set-value">
                            {ffmpeg == null ? (
                                <>
                                    <StatusDot status="warn" />
                                    checking…
                                </>
                            ) : ffmpegOk ? (
                                <>
                                    <StatusDot status="ok" />
                                    <b>{ffmpeg.version ?? "installed"}</b>·{" "}
                                    {FFMPEG_SOURCE_LABEL[ffmpeg.source]}
                                </>
                            ) : (
                                <>
                                    <StatusDot status="bad" />
                                    not found
                                </>
                            )}
                        </span>
                    </div>

                    <div className="set-row">
                        <div>
                            <div className="set-label">
                                Managed copy of ffmpeg
                            </div>
                            <div className="set-hint">{managedHint}</div>
                            {ffmpegInstall != null && (
                                <div className="set-hint" role="status">
                                    {installLabel(ffmpegInstall)}
                                </div>
                            )}
                        </div>
                        <span className="set-value">
                            {ffmpegBusy ? (
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-sm"
                                    onClick={onCancelFfmpeg}
                                >
                                    Cancel
                                </button>
                            ) : (
                                <>
                                    {ffmpeg?.managed != null && (
                                        <button
                                            type="button"
                                            className="btn btn-ghost btn-sm"
                                            disabled={locked}
                                            onClick={onCheckFfmpegUpdate}
                                        >
                                            {busy === "ffmpegUpdate"
                                                ? "Checking…"
                                                : "Check for updates"}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="btn btn-ghost btn-sm"
                                        disabled={
                                            locked ||
                                            ffmpeg == null ||
                                            !ffmpeg.downloadable
                                        }
                                        onClick={onInstallFfmpeg}
                                    >
                                        {ffmpeg?.managed != null
                                            ? "Reinstall"
                                            : "Download"}
                                    </button>
                                    {ffmpeg?.managed != null && (
                                        <button
                                            type="button"
                                            className="remove"
                                            aria-label="Remove the managed ffmpeg"
                                            disabled={locked}
                                            onClick={onRemoveFfmpeg}
                                        >
                                            ✕
                                        </button>
                                    )}
                                </>
                            )}
                        </span>
                    </div>

                    <div className="set-row">
                        <div>
                            <div className="set-label">Codec check</div>
                            <div className="set-hint">
                                H.264/AAC decode asserted at startup
                            </div>
                        </div>
                        <span className="set-value">
                            {system == null ||
                            system.codecCheck === "pending" ? (
                                <>
                                    <StatusDot status="warn" />
                                    pending
                                </>
                            ) : system.codecCheck === "ok" ? (
                                <>
                                    <StatusDot status="ok" />
                                    OK
                                </>
                            ) : (
                                <>
                                    <StatusDot status="bad" />
                                    FAILED
                                </>
                            )}
                        </span>
                    </div>

                    <div className="set-row">
                        <div>
                            <div className="set-label">Hardware encoders</div>
                            <div className="set-hint">
                                {system == null
                                    ? "—"
                                    : system.hwAccel.vaapiDevice != null
                                      ? `VAAPI on ${system.hwAccel.vaapiDevice}`
                                      : "Probed at startup with a test encode on each GPU"}
                            </div>
                        </div>
                        <span className="set-value">
                            {system == null ? (
                                <>
                                    <StatusDot status="warn" />
                                    checking…
                                </>
                            ) : (
                                <>
                                    <StatusDot
                                        status={probeStatus(
                                            system.hwAccel.vaapi,
                                        )}
                                    />
                                    VAAPI
                                    <StatusDot
                                        status={probeStatus(
                                            system.hwAccel.nvenc,
                                        )}
                                    />
                                    NVENC
                                </>
                            )}
                        </span>
                    </div>

                    <div className="set-row">
                        <div>
                            <div className="set-label">Database</div>
                            <div className="set-hint">
                                {system == null
                                    ? "—"
                                    : `${system.dbPath} · ${formatMb(system.dbSizeBytes)}`}
                            </div>
                            {/* The restart eats the status banner, so the receipt is the only
                  thing left to say where the replaced database went. */}
                            {system?.lastRestore != null && (
                                <div className="set-hint">
                                    Restored from{" "}
                                    {baseName(system.lastRestore.sourcePath)} on{" "}
                                    {formatDate(system.lastRestore.restoredAt)}
                                    {system.lastRestore.backupPath != null &&
                                        ` · previous database saved at ${system.lastRestore.backupPath}`}
                                </div>
                            )}
                        </div>
                        <span className="set-value">
                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={locked || system == null}
                                onClick={onBackup}
                            >
                                {busy === "backup" ? "Backing up…" : "Back up…"}
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                disabled={locked || system == null}
                                onClick={onImport}
                            >
                                {busy === "import" ? "Importing…" : "Import…"}
                            </button>
                        </span>
                    </div>

                    <div className="set-row">
                        <div>
                            <div className="set-label">Rerun TV</div>
                            <div className="set-hint">
                                {system?.streamPort != null
                                    ? `Stream server on localhost:${system.streamPort}`
                                    : "Stream server idle"}
                            </div>
                        </div>
                        <span className="set-value">
                            <b>{system?.appVersion ?? "—"}</b>
                        </span>
                    </div>
                </section>
            </main>
        </div>
    );
}
