/**
 * The sleep dial (docs/ui.md, "The sleep timer").
 *
 * Replaces the press-to-cycle presets: one drag sets any duration from off to
 * five hours in five-minute detents, and the panel's readout says what that
 * actually means — the wall-clock time the picture goes dark, and that it waits
 * for the credits.
 *
 * Two decisions here are load-bearing:
 *
 * 1. **Edits commit live; closing never cancels.** The panel has no OK button
 *    for the same reason the volume track doesn't: the armed timer *is* the
 *    state, the countdown chip shows it, and an editing buffer with a confirm
 *    step would be a second source of truth for a number the viewer can already
 *    see. Esc and Enter both simply close.
 *
 * 2. **The dial reads *remaining* time, not the armed figure.** Reopening the
 *    panel forty minutes into an armed hour shows twenty minutes, because that
 *    is the number the next drag is relative to. `sleepMinutes` is what was
 *    asked for; this control is about what is left.
 *
 * It is rendered inside `.stage` so it survives `requestFullscreen()` — see the
 * Player's header — and shares the OSD's idle-hide timer.
 */

import { SLEEP_MAX_MIN, SLEEP_STEP_MIN } from "@shared/types.js";
import type { JSX, KeyboardEvent } from "react";
import { useCallback, useEffect, useRef } from "react";
import Slider from "./Slider.js";
import "./SleepPanel.css";

/**
 * How long typed digits wait for another digit before they commit.
 *
 * Long enough to type "135" without the "1" landing as one minute, short enough
 * that a deliberate "90" doesn't feel stuck. Entries that cannot grow — three
 * digits, or a value another digit would push past the ceiling — commit at once
 * rather than sitting out the wait.
 */
const DIGIT_COMMIT_MS = 900;

/** One preset chip. `null` disarms; `0` arms an already-due timer. */
interface Preset {
    label: string;
    minutes: number | null;
}

const PRESETS: Preset[] = [
    { label: "Off", minutes: null },
    { label: "After this ep", minutes: 0 },
    { label: "30m", minutes: 30 },
    { label: "1h", minutes: 60 },
    { label: "2h", minutes: 120 },
    { label: "3h", minutes: 180 },
    { label: "5h", minutes: SLEEP_MAX_MIN },
];

/** "1h 35m", "45 min", "5 h" — the readout's own format, not the OSD timecode. */
function formatMinutes(minutes: number): string {
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0
        ? `${hours} h`
        : `${hours}h ${String(rest).padStart(2, "0")}m`;
}

/** The wall clock the viewer will actually see on the wall. */
function formatClock(at: number): string {
    return new Date(at).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
    });
}

export interface SleepPanelProps {
    /** The armed deadline, or null when the timer is off. */
    sleepUntil: number | null;
    /** Repainted once a second by the Player while the timer is armed. */
    nowMs: number;
    /** False mid-arc: the stop lands at the end of the arc, not this episode. */
    endsUnit: boolean;
    /** Parts in the current arc, for the mid-arc wording. */
    arcPartCount: number | null;
    onArm(minutes: number | null): void;
    onAdjust(deltaMin: number): void;
    onClose(): void;
}

export default function SleepPanel({
    sleepUntil,
    nowMs,
    endsUnit,
    arcPartCount,
    onArm,
    onAdjust,
    onClose,
}: SleepPanelProps): JSX.Element {
    const digitsRef = useRef("");
    const digitTimerRef = useRef<number | null>(null);

    /**
     * Minutes left, snapped to the dial's detent. An armed timer counting down
     * through 12:59 reads 15 rather than jittering between marks, and an expired
     * one sits at zero rather than going negative.
     */
    const remaining =
        sleepUntil === null
            ? 0
            : Math.min(
                  SLEEP_MAX_MIN,
                  Math.max(
                      0,
                      Math.round(
                          (sleepUntil - nowMs) / 60_000 / SLEEP_STEP_MIN,
                      ) * SLEEP_STEP_MIN,
                  ),
              );

    const expired = sleepUntil !== null && nowMs >= sleepUntil;

    /** Where playback will actually stop, in the viewer's words. */
    const stopsAt = ((): string => {
        if (sleepUntil === null) return "TV stays on";
        if (expired) {
            return endsUnit
                ? "stops when this episode ends"
                : `stops after part ${arcPartCount ?? "?"} of this arc`;
        }
        const suffix = endsUnit
            ? "lets the episode finish"
            : "lets the arc finish";
        return `off around ${formatClock(sleepUntil)} — ${suffix}`;
    })();

    const readout = ((): string => {
        if (sleepUntil === null) return "Off";
        if (expired) return "After this ep";
        return formatMinutes(remaining);
    })();

    const clearDigits = useCallback(() => {
        if (digitTimerRef.current !== null)
            window.clearTimeout(digitTimerRef.current);
        digitTimerRef.current = null;
        digitsRef.current = "";
    }, []);

    useEffect(() => clearDigits, [clearDigits]);

    const commitDigits = useCallback(() => {
        const typed = digitsRef.current;
        clearDigits();
        if (typed === "") return;
        const value = Number(typed);
        onArm(value === 0 ? null : value);
    }, [clearDigits, onArm]);

    const pushDigit = useCallback(
        (digit: string) => {
            const next = digitsRef.current + digit;
            digitsRef.current = next;
            if (digitTimerRef.current !== null)
                window.clearTimeout(digitTimerRef.current);
            // Nothing another digit could add: commit now rather than make the viewer
            // wait out a timeout for a value that is already final. A lone zero counts
            // — it is the "off" key, and nobody types a leading zero to reach 5.
            if (
                next === "0" ||
                next.length >= 3 ||
                Number(next) * 10 > SLEEP_MAX_MIN
            ) {
                return commitDigits();
            }
            digitTimerRef.current = window.setTimeout(
                commitDigits,
                DIGIT_COMMIT_MS,
            );
        },
        [commitDigits],
    );

    /**
     * The panel's own key map.
     *
     * Bound here rather than on the window so it beats the Player's map by
     * bubbling — ArrowRight is skip-episode out there, and an arrow aimed at the
     * dial must never also change the channel's mind. The Slider stops its own
     * arrows; this handler covers the rest of the panel.
     */
    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        /**
         * `S` closes as well as Enter and Esc, and it has to be handled *here*.
         * The player's window-level map ignores any key whose target sits inside a
         * `[role="slider"]` — the guard that keeps the scrub bar's arrows from also
         * skipping the episode — and the dial holds focus while the panel is open,
         * so a second press of `S` would otherwise never reach the toggle it came
         * from and the panel could only be closed with the mouse.
         */
        if (
            e.key === "Enter" ||
            e.key === "Escape" ||
            e.key === "s" ||
            e.key === "S"
        ) {
            e.preventDefault();
            e.stopPropagation();
            clearDigits();
            onClose();
            return;
        }

        /**
         * Keep Tab inside the panel.
         *
         * It is a `role="dialog"` over a player whose chrome is still in the
         * document, so without this Tab walks out into OSD controls the viewer
         * cannot see — and there is no visible way back. Wrapping is the whole
         * containment: the panel is small enough that a focus *sentinel* pair
         * would be more machinery than the problem deserves.
         */
        if (e.key === "Tab") {
            const focusable = [
                ...e.currentTarget.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), [role="slider"], [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
                ),
            ];
            if (focusable.length === 0) return;
            const first = focusable[0] as HTMLElement;
            const last = focusable[focusable.length - 1] as HTMLElement;
            const active = document.activeElement;
            if (
                e.shiftKey &&
                (active === first || !e.currentTarget.contains(active))
            ) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
            return;
        }

        if (/^[0-9]$/.test(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            pushDigit(e.key);
            return;
        }

        // ±30 minutes from the chips or the panel body. With the dial focused its
        // own `verticalStep` has already taken these and stopped them here.
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            onAdjust(e.key === "ArrowUp" ? 30 : -30);
        }
    };

    /** A dial value of zero is off, not an already-due timer — that's the chip. */
    const setFromDial = useCallback(
        (value: number) => {
            const snapped = Math.round(value / SLEEP_STEP_MIN) * SLEEP_STEP_MIN;
            onArm(snapped <= 0 ? null : snapped);
        },
        [onArm],
    );

    const ticks: JSX.Element[] = [];
    for (let minutes = 0; minutes <= SLEEP_MAX_MIN; minutes += 15) {
        const hour = minutes % 60 === 0;
        ticks.push(
            <span
                key={minutes}
                className={`sp-tick${hour ? " is-hour" : ""}`}
                style={{ left: `${(minutes / SLEEP_MAX_MIN) * 100}%` }}
            >
                {hour && minutes > 0 && <i>{minutes / 60}h</i>}
            </span>,
        );
    }

    return (
        <div
            className="sleep-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Sleep timer"
            onKeyDown={handleKeyDown}
            onWheel={(e) =>
                onAdjust(e.deltaY < 0 ? SLEEP_STEP_MIN : -SLEEP_STEP_MIN)
            }
        >
            <div className="sp-read">
                <span
                    className={`sp-dur${sleepUntil === null ? " is-off" : ""}`}
                >
                    {readout}
                </span>
                <span className="sp-until">{stopsAt}</span>
            </div>

            <Slider
                takeFocus
                className="sp-dial"
                label="Sleep timer duration"
                value={remaining}
                max={SLEEP_MAX_MIN}
                step={SLEEP_STEP_MIN}
                verticalStep={30}
                pageStep={30}
                ariaValueText={
                    sleepUntil === null ? "Off" : formatMinutes(remaining)
                }
                onPreview={setFromDial}
                onCommit={setFromDial}
                knob
            >
                <span className="sp-ticks" aria-hidden="true">
                    {ticks}
                </span>
            </Slider>

            <div className="sp-chips">
                {PRESETS.map((preset) => (
                    <button
                        key={preset.label}
                        type="button"
                        className={`sp-chip${
                            (preset.minutes === null && sleepUntil === null) ||
                            (preset.minutes === 0 && expired) ||
                            (
                                preset.minutes != null &&
                                    preset.minutes > 0 &&
                                    !expired &&
                                    remaining === preset.minutes
                            )
                                ? " is-active"
                                : ""
                        }`}
                        onClick={() => onArm(preset.minutes)}
                    >
                        {preset.label}
                    </button>
                ))}
            </div>

            <div className="sp-hints" aria-hidden="true">
                <span>
                    <kbd>←</kbd>
                    <kbd>→</kbd>±5m
                </span>
                <span>
                    <kbd>↑</kbd>
                    <kbd>↓</kbd>±30m
                </span>
                <span>
                    <kbd>0–9</kbd>minutes
                </span>
                <span>
                    <kbd>Enter</kbd>done
                </span>
            </div>
        </div>
    );
}
