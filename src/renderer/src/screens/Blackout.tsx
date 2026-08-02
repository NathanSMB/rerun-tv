/**
 * Screen 06 — the blackout.
 *
 * Where the sleep timer leaves you. The channel is already released by the time
 * this mounts (`goDark` in the store), so there is no video, no encoder and no
 * wake lock: the app holds nothing, and the OS display-sleep policy takes over.
 * That is the entire point of the feature, and it is why this screen is inert
 * rather than merely dark.
 *
 * If the viewer was watching fullscreen they still are: `goDark` re-targets
 * fullscreen to the document root before unmounting the Player, so this screen
 * inherits it. Dropping back to a window here would hand a dark room its
 * taskbar at the one moment the app is trying to emit nothing.
 *
 * The one affordance — a way back to the guide — is hidden until the pointer
 * moves, on the same reveal-then-idle pattern the Player's OSD uses, tuned by
 * the same `osdHideAfterS` setting. A visible button on a screen you fell asleep
 * in front of would be a light source; waking it on a mouse move costs nothing
 * and is the gesture someone reaching for the mouse makes anyway.
 *
 * Esc and Enter do the same thing, so the exit is never mouse-only.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import "./Blackout.css";

/** Matches the Player's throttle: a moving pointer must not re-render 60×/s. */
const ACTIVITY_THROTTLE_MS = 150;

export default function Blackout(): JSX.Element {
    const osdHideAfterS = useStore((s) => s.settings.osdHideAfterS);
    const navigate = useStore((s) => s.navigate);

    const [awake, setAwake] = useState(false);
    /** Bumped on any activity; restarts the idle timer effect below. */
    const [activity, setActivity] = useState(0);
    const lastActivityRef = useRef(0);

    const reveal = useCallback(() => {
        setAwake(true);
        const now = Date.now();
        if (now - lastActivityRef.current < ACTIVITY_THROTTLE_MS) return;
        lastActivityRef.current = now;
        setActivity((n) => n + 1);
    }, []);

    /**
     * The way out, from the button and from both keys.
     *
     * This screen may be fullscreen — `goDark` hands fullscreen to the document
     * root on the way in, so the blackout is as chromeless as the picture was —
     * and the guide is a windowed screen with an app bar. A fullscreen guide is
     * not a state this app has, so the exit gives fullscreen up on the way out.
     * On <kbd>Esc</kbd> Chromium has already done it and this is a no-op, as it
     * is for anyone who dozed off in a window.
     */
    const backToGuide = useCallback(() => {
        if (document.fullscreenElement)
            void document.exitFullscreen().catch(() => undefined);
        navigate("guide");
    }, [navigate]);

    /** The idle timer, in the Player's shape: an effect keyed on the activity bump. */
    // biome-ignore lint/correctness/useExhaustiveDependencies: `activity` is a counter the effect never reads — bumping it is how a pointer move restarts the countdown
    useEffect(() => {
        if (!awake) return;
        const id = window.setTimeout(
            () => setAwake(false),
            Math.max(1, osdHideAfterS) * 1000,
        );
        return () => window.clearTimeout(id);
    }, [awake, osdHideAfterS, activity]);

    useEffect(() => {
        const onKeyDown = (e: globalThis.KeyboardEvent): void => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            reveal();
            if (e.key === "Escape" || e.key === "Enter") {
                e.preventDefault();
                backToGuide();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [reveal, backToGuide]);

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: not a control — it is the dark screen itself, and these handlers only note that someone is still awake. The way out is the button inside it and the Esc/Enter keys.
        <div
            className={`blackout${awake ? "" : " idle"}`}
            onMouseMove={reveal}
            onPointerDown={reveal}
        >
            <button
                type="button"
                className={`blackout-exit${awake ? "" : " is-hidden"}`}
                // Focus would otherwise land here from the previous screen and give the
                // hidden button a visible focus ring on a screen meant to be black.
                tabIndex={awake ? 0 : -1}
                aria-hidden={!awake}
                onClick={backToGuide}
            >
                Back to channels
            </button>
            <p
                className={`blackout-hint${awake ? "" : " is-hidden"}`}
                aria-hidden={!awake}
            >
                Sleep timer finished
            </p>
        </div>
    );
}
