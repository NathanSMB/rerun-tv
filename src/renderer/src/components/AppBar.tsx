/**
 * The app bar: wordmark, screen navigation, and the live scan pill.
 *
 * Present on every screen except the Player, which is deliberately full-bleed.
 * The bar itself is a drag region for the frameless window (see `.appbar` in
 * `global.css`); its buttons opt back out, so clicks still land.
 *
 * The scan pill is the app's only ambient status surface. It answers "is the
 * library alright?" without the user going looking, and clicking it jumps to
 * the Library screen where the answer can actually be acted on — matching the
 * mockup's note. Priority of what it reports, most urgent first: scan error,
 * scan running, scan paused, no library at all, unmatched files waiting, all
 * clear.
 */

import type { JSX } from "react";
import headerIcon from "../assets/header-icon.png";
import type { Screen } from "../store.js";
import { useStore } from "../store.js";

const NAV: ReadonlyArray<{ screen: Screen; label: string }> = [
    { screen: "guide", label: "Guide" },
    { screen: "library", label: "Library" },
    { screen: "settings", label: "Settings" },
];

interface Pill {
    text: string;
    /** `warn` paints the dot amber; `ok` leaves it signal-green. */
    tone: "ok" | "warn";
    /** Whether to render the status dot at all. */
    dot: boolean;
    /**
     * What a screen reader is told, which is deliberately *not* `text`.
     *
     * `text` carries a running count, and a live region wired straight to it
     * would announce "SCANNING · 1,204 / 40,000" on every progress push —
     * hundreds of interruptions during one scan of a large library. This is the
     * pill's *state* instead, so the announcement fires when the situation
     * changes rather than when a number does.
     */
    announcement: string;
}

const n = (value: number): string => value.toLocaleString();

export default function AppBar(): JSX.Element {
    const screen = useStore((s) => s.screen);
    const scan = useStore((s) => s.scan);
    const library = useStore((s) => s.library);
    const navigate = useStore((s) => s.navigate);

    const totalEpisodes = library?.totalEpisodes ?? 0;
    const unmatched = library?.unmatched.length ?? 0;

    let pill: Pill;
    if (scan.error) {
        pill = {
            text: "SCAN FAILED · OPEN LIBRARY",
            tone: "warn",
            dot: true,
            announcement: "Library scan failed",
        };
    } else if (scan.state === "scanning") {
        pill = {
            text: `SCANNING · ${n(scan.done)} / ${n(scan.total)}`,
            tone: "ok",
            dot: true,
            announcement: "Scanning the library",
        };
    } else if (scan.state === "paused") {
        pill = {
            text: `SCAN PAUSED · ${n(scan.done)} / ${n(scan.total)}`,
            tone: "warn",
            dot: true,
            announcement: "Library scan paused",
        };
    } else if (totalEpisodes === 0) {
        pill = {
            text: "NO LIBRARY · ADD A FOLDER",
            tone: "warn",
            dot: false,
            announcement: "No library yet — add a folder",
        };
    } else if (unmatched > 0) {
        pill = {
            text: `${n(unmatched)} UNMATCHED · ${n(totalEpisodes)} EPISODES`,
            tone: "warn",
            dot: true,
            announcement: "Some files are waiting to be matched",
        };
    } else {
        pill = {
            text: `LIBRARY OK · ${n(totalEpisodes)} EPISODES`,
            tone: "ok",
            dot: true,
            announcement: "Library is up to date",
        };
    }

    return (
        <header className="appbar">
            <span className="wordmark">
                <img
                    className="wordmark-icon"
                    src={headerIcon}
                    alt=""
                    aria-hidden="true"
                />
                RERUN <span>TV</span>
            </span>

            <nav className="appnav" aria-label="Screens">
                {NAV.map((item) => (
                    <button
                        key={item.screen}
                        type="button"
                        className={screen === item.screen ? "on" : undefined}
                        aria-current={
                            screen === item.screen ? "page" : undefined
                        }
                        onClick={() => navigate(item.screen)}
                    >
                        {item.label}
                    </button>
                ))}
            </nav>

            <button
                type="button"
                className="scanpill"
                title="Open the Library"
                onClick={() => navigate("library")}
            >
                {pill.dot && (
                    <span
                        className={pill.tone === "warn" ? "live warn" : "live"}
                        aria-hidden="true"
                    />
                )}
                <span aria-hidden="true">{pill.text}</span>
                {/*
                    The announced copy: state, not counts. Visually hidden so the
                    pill above stays the thing sighted users read.
                */}
                <span className="visually-hidden" aria-live="polite">
                    {pill.announcement}
                </span>
            </button>
        </header>
    );
}
