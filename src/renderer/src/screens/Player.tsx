/**
 * Screen 02 — the Player (plan §7).
 *
 * Full-bleed video with an OSD layer that rises on mouse move or key press and
 * fades after `settings.osdHideAfterS` seconds of idle.
 *
 * Four decisions in here are load-bearing and non-obvious:
 *
 * 1. **Fullscreen is requested on the stage wrapper, never on a `<video>`.**
 *    The wrapper holds both videos and the OSD, so an episode handoff — which
 *    swaps which element is on top — cannot take the fullscreen element away with
 *    it. Requesting fullscreen on a video would drop out of fullscreen on every
 *    auto-advance, and would also hide our OSD behind Chromium's native controls.
 *
 * 2. **Seeking is done by loading a new URL, not by setting `currentTime`.**
 *    The remux and transcode paths (plan §6) are open-ended ffmpeg pipes with no
 *    byte ranges and no known length, so the browser cannot seek them. The
 *    stream server's contract is `/stream/<id>?t=<seconds>`: it restarts ffmpeg
 *    at `-ss`. Because the fresh stream then reports `currentTime` from zero, we
 *    keep the requested position in the slot's `offset` and render
 *    `offset + videoTime` everywhere a position is shown. Only the `direct` path
 *    — a real file served with range requests — seeks natively.
 *
 * 3. **The pipes are played through MediaSource, not through `src`.**
 *    See `player/mse.ts`. Handing an unseekable pipe to Chromium's progressive
 *    loader is what produced the minute-long freezes; the pump owns read pace so
 *    the connection is never abandoned. That lives entirely in `VideoSurface`,
 *    which this screen treats as "a `<video>` that knows how to play our URLs".
 *
 * 4. **There are two video elements, and a handoff is a swap, not a load.**
 *    Thirty seconds before the end of an episode the store reserves the next
 *    pick and this screen starts buffering it in a hidden standby surface. On
 *    `ended` the store promotes (and only then commits) that pick, the stage
 *    flips which surface is on top, and
 *    the already-buffered element simply starts playing — no tune-in latency, no
 *    black frame. With `prewarmNext` off nothing is prewarmed and the second
 *    surface stays empty, which is exactly the single-element behaviour.
 *
 * 5. **Picture-in-picture is a session that moves between those two elements.**
 *    Unlike fullscreen there is no wrapper to hand it: PiP floats one `<video>`.
 *    So the session has to follow every swap, and it can — a transfer to another
 *    element needs no user gesture while a session is live, which a *fresh* entry
 *    does (docs/pip-plan.html §2). All of that intent lives in `player/pip.ts`;
 *    this screen only executes the commands it returns, and is the only place
 *    that touches `requestPictureInPicture()`.
 *
 * While PiP is floating the viewer may leave for the guide, and then this screen
 * stays *mounted but hidden* (`floating`) so the streams, the handoffs and the
 * sleep timer all keep running. Hidden means `opacity: 0`, never `display: none`
 * — the same rule the standby surface follows, and what keeps frames flowing to
 * the floating window.
 */

import { formatDuration, withSeek } from "@shared/playback.js";
import { SLEEP_STEP_MIN } from "@shared/types.js";
import type { JSX, WheelEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import SleepPanel from "../components/SleepPanel.js";
import Slider from "../components/Slider.js";
import { createPipMachine, isFloating, type PipEvent } from "../player/pip.js";
import {
    EMPTY_STAGE,
    mirrorPending,
    other,
    reconcile,
    type SlotId,
    type StageState,
    slotFor,
    writeSlot,
} from "../player/stage.js";
import VideoSurface, {
    type VideoSurfaceHandle,
} from "../player/VideoSurface.js";
import { endsPlayableUnit, useStore } from "../store.js";
import "./Player.css";

/**
 * Seconds of remaining runtime that trigger the "up next" toast *and* the
 * prewarm (plan §6). One window, deliberately: the toast is the user-visible
 * promise that the next episode is ready, and now it actually is.
 */
const UP_NEXT_WINDOW_S = 30;
// Coupled across the process boundary to `MAX_JOBS_PER_CHANNEL` in
// `main/stream/server.ts`: the channel is allowed two encoders precisely so the
// episode on air and the one prewarming inside this window can overlap. Widen
// this much beyond the second encoder's reach and the prewarm is wasted work.

/** How long the channel banner stays up after a tune-in or a handoff. */
const BANNER_MS = 4000;

/** Volume step for the ↑/↓ keys. */
const VOLUME_STEP = 0.05;

/**
 * Coalescing window for seeks. Holding an arrow key on the scrub bar would
 * otherwise kill and restart ffmpeg once per repeat; we only commit once the
 * user stops moving.
 */
const SEEK_COMMIT_MS = 250;

/** Mouse-move reveals are throttled so a moving pointer doesn't re-render 60×/s. */
const ACTIVITY_THROTTLE_MS = 150;

const clamp = (value: number, max: number): number =>
    Math.min(max, Math.max(0, value));

/**
 * The Media Session, when there is one.
 *
 * Guarded rather than assumed: the renderer test harness runs in happy-dom,
 * which has no `navigator.mediaSession` at all, and this is a garnish — the
 * floating window's skip button and the OS media keys — not something the player
 * may refuse to mount without.
 */
function mediaSession(): MediaSession | null {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator))
        return null;
    const session = navigator.mediaSession;
    return typeof session?.setActionHandler === "function" ? session : null;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export interface PlayerProps {
    /**
     * Mounted only to keep the channel alive while the picture floats in a PiP
     * window and the viewer browses somewhere else. The screen is off-stage: no
     * keyboard map (a <kbd>Space</kbd> in the Library must not pause the
     * channel), no fullscreen, no chrome worth revealing.
     */
    floating?: boolean;
}

export default function Player({
    floating = false,
}: PlayerProps): JSX.Element | null {
    const nowPlaying = useStore((s) => s.nowPlaying);
    const pendingNext = useStore((s) => s.pendingNext);
    const upNext = useStore((s) => s.upNext);
    const volume = useStore((s) => s.volume);
    const muted = useStore((s) => s.muted);
    const osdHideAfterS = useStore((s) => s.settings.osdHideAfterS);
    const prewarmNext = useStore((s) => s.settings.prewarmNext);
    const sleepDefaultMin = useStore((s) => s.settings.sleepTimerDefaultMin);
    const sleepUntil = useStore((s) => s.sleepUntil);
    const advance = useStore((s) => s.advance);
    const prewarm = useStore((s) => s.prewarm);
    const leavePlayer = useStore((s) => s.leavePlayer);
    const navigate = useStore((s) => s.navigate);
    const setPipActive = useStore((s) => s.setPipActive);
    const armSleep = useStore((s) => s.armSleep);
    const adjustSleep = useStore((s) => s.adjustSleep);
    const sleepNow = useStore((s) => s.sleepNow);
    const setVolume = useStore((s) => s.setVolume);
    const adjustVolume = useStore((s) => s.adjustVolume);
    const toggleMute = useStore((s) => s.toggleMute);

    const stageRef = useRef<HTMLDivElement>(null);
    const surfaceA = useRef<VideoSurfaceHandle | null>(null);
    const surfaceB = useRef<VideoSurfaceHandle | null>(null);

    const episodeId = nowPlaying?.episode.id ?? null;
    const totalS = nowPlaying?.episode.durationS ?? 0;

    const [stage, setStage] = useState<StageState>(() =>
        reconcile(EMPTY_STAGE, nowPlaying),
    );
    const [videoTime, setVideoTime] = useState(0);

    if ((stage[stage.active]?.episodeId ?? null) !== episodeId) {
        // Adjusting state during render (rather than in an effect) so no surface ever
        // commits a frame still pointing at the previous episode's stream. A promoted
        // standby is paused at zero, so the timecode resets with it.
        setStage(reconcile(stage, nowPlaying));
        setVideoTime(0);
    }

    const activeSlot = stage[stage.active];
    const standbySlot = stage[other(stage.active)];

    const [scrubPreview, setScrubPreview] = useState<number | null>(null);
    const [paused, setPaused] = useState(false);
    const [failed, setFailed] = useState(false);
    const [fullscreen, setFullscreen] = useState(false);

    /**
     * The PiP session controller. Created once — it holds the phase that tells a
     * transfer's `leavepictureinpicture` apart from the viewer closing the window,
     * so re-creating it on a render would lose exactly the thing it is for.
     */
    const [pip] = useState(createPipMachine);
    /** Mirror of `isFloating(pip.state)`, because the machine is not React state. */
    const [pipFloating, setPipFloating] = useState(false);

    const [osdVisible, setOsdVisible] = useState(true);
    const [sleepOpen, setSleepOpen] = useState(false);
    const [bannerFlash, setBannerFlash] = useState(true);
    const [osdHovered, setOsdHovered] = useState(false);
    const [dragging, setDragging] = useState(false);
    /** Bumped on any user activity; restarts the idle timer effect below. */
    const [activity, setActivity] = useState(0);
    /**
     * Wall clock, repainted once a second *only while the sleep timer is armed*.
     *
     * The countdown chip is the only thing that needs it. Expiry itself is never
     * read from this value — see the store's `sleepUntil`.
     */
    const [nowMs, setNowMs] = useState(() => Date.now());

    const lastActivityRef = useRef(0);
    const advancingRef = useRef(false);
    const seekTimerRef = useRef<number | null>(null);
    /** Set while a load is in flight so a URL-seek resumes playback on its own. */
    const wantsPlayRef = useRef(true);
    /** Timestamp of the last browser-initiated fullscreen exit — see the Esc map. */
    const leftFullscreenAtRef = useRef(0);
    /** The episode we have already asked to prewarm after, so we ask exactly once. */
    const prewarmedAfterRef = useRef<number | null>(null);

    const offset = activeSlot?.offset ?? 0;
    const position = scrubPreview ?? offset + videoTime;
    const remainingS = totalS - position;
    const chromeVisible = osdVisible || failed;
    const showBanner = bannerFlash || chromeVisible;
    const inUpNextWindow = remainingS <= UP_NEXT_WINDOW_S && remainingS > 0;

    // ---- sleep timer --------------------------------------------------------

    const sleepExpired = sleepUntil !== null && nowMs >= sleepUntil;
    const endsUnit = endsPlayableUnit(nowPlaying);
    /**
     * The timer has fired *and* this episode finishes its playable unit, so
     * nothing more will be picked on this channel: no prewarm, and no "up next".
     * Mid-arc this is false — the remaining parts still play, and the store's arc
     * lock is what supplies them.
     */
    const sleepPending = sleepExpired && endsUnit;

    const showToast =
        prewarmNext &&
        upNext != null &&
        !failed &&
        inUpNextWindow &&
        !sleepPending;

    /** One surface's element, by slot. Null until that surface has mounted. */
    const videoForSlot = useCallback(
        (slot: string): HTMLVideoElement | null => {
            const handle = slot === "a" ? surfaceA.current : surfaceB.current;
            return handle?.element ?? null;
        },
        [],
    );

    /** The element on air. Everything transport-related goes through this. */
    const activeVideo = useCallback(
        (): HTMLVideoElement | null => videoForSlot(stage.active),
        [videoForSlot, stage.active],
    );

    // ---- picture-in-picture -------------------------------------------------

    /**
     * Feed the controller one event and carry out whatever it asks for. The only
     * place in the app that touches the PiP DOM API.
     *
     * It recurses through its own name — a request resolving is another event —
     * and the recursion is bounded: a transfer can queue at most one further
     * transfer, and both terminate in `active` or `idle`.
     */
    const pipStep = useCallback(
        function step(event: PipEvent): void {
            const command = pip.send(event);
            const floatingNow = isFloating(pip.state);
            setPipFloating(floatingNow);
            // The store's copy is what keeps this screen mounted while the viewer is
            // off browsing (App.tsx). Written here because the machine is the truth.
            setPipActive(floatingNow);
            if (!command) return;

            switch (command.type) {
                case "enter":
                case "transfer": {
                    const video = videoForSlot(command.slot);
                    if (
                        !video ||
                        typeof video.requestPictureInPicture !== "function"
                    ) {
                        step({ type: "failed" });
                        return;
                    }
                    void video.requestPictureInPicture().then(
                        () => step({ type: "entered", slot: command.slot }),
                        (error: unknown) => {
                            // `NotAllowedError` here means the entry escaped its gesture — a
                            // bug in the caller, not in the viewer's setup, so it is worth
                            // saying out loud rather than failing silently.
                            console.warn(
                                "[player] picture-in-picture refused:",
                                error,
                            );
                            step({ type: "failed" });
                        },
                    );
                    break;
                }
                case "exit":
                    if (document.pictureInPictureElement) {
                        void document
                            .exitPictureInPicture()
                            .catch(() => undefined);
                    }
                    break;
                case "returnInline":
                    // The picture is on the page again, so the page had better be showing
                    // it. A no-op when the player is already the visible screen, which is
                    // the common case; the one that matters is closing the floating window
                    // from the guide.
                    if (useStore.getState().screen !== "player")
                        navigate("player");
                    break;
            }
        },
        [pip, videoForSlot, setPipActive, navigate],
    );

    /**
     * The button and <kbd>P</kbd>. Both arrive inside a user gesture, which is the
     * only moment a *fresh* session may be opened, so the request must not be
     * deferred to an effect (docs/pip-plan.html §2, fact R5).
     */
    const togglePip = useCallback(() => {
        // Fullscreen and a floating window are mutually exclusive states of the same
        // picture; asking for one means leaving the other.
        if (document.fullscreenElement)
            void document.exitFullscreen().catch(() => undefined);
        pipStep({ type: "toggle", slot: stage.active });
    }, [pipStep, stage.active]);

    /**
     * `leavepictureinpicture`, from anywhere in the tree.
     *
     * Listened for on the document in the capture phase rather than on each
     * `<video>`: the elements come and go through ref callbacks, and this way a
     * surface that mounts later cannot miss its listener. Chromium was measured
     * firing these with `bubbles: true` on the element, so both phases would work
     * — capture is the one that does not depend on that.
     */
    useEffect(() => {
        const onLeave = (event: Event): void => {
            const target = event.target;
            for (const slot of ["a", "b"]) {
                if (videoForSlot(slot) === target) {
                    pipStep({ type: "left", slot });
                    return;
                }
            }
        };
        document.addEventListener("leavepictureinpicture", onLeave, true);
        return () =>
            document.removeEventListener(
                "leavepictureinpicture",
                onLeave,
                true,
            );
    }, [pipStep, videoForSlot]);

    /**
     * Leaving the screen for good closes the window. A blackout means dark, and a
     * floating window is a light source like any other; `teardown` deliberately
     * does not steer navigation on the way out.
     *
     * Keyed on `pip` alone (which never changes) so this runs exactly once, at
     * unmount — a dependency on `pipStep` would tear the session down every time
     * one of its inputs changed.
     */
    useEffect(() => {
        return () => {
            const command = pip.send({ type: "teardown" });
            if (command?.type === "exit" && document.pictureInPictureElement) {
                void document.exitPictureInPicture().catch(() => undefined);
            }
            useStore.getState().setPipActive(false);
        };
    }, [pip]);

    /**
     * A dead stream in a floating window is a frozen frame with no explanation —
     * the Retry/Skip card is on the page it isn't showing. So the picture comes
     * home to meet it.
     */
    useEffect(() => {
        if (!failed || !pipFloating) return;
        pipStep({ type: "toggle", slot: stage.active });
    }, [failed, pipFloating, pipStep, stage.active]);

    // ---- OSD visibility -----------------------------------------------------

    const reveal = useCallback(() => {
        setOsdVisible(true);
        const now = Date.now();
        if (now - lastActivityRef.current < ACTIVITY_THROTTLE_MS) return;
        lastActivityRef.current = now;
        setActivity((n) => n + 1);
    }, []);

    /**
     * The idle timer. It is deliberately expressed as an effect keyed on every
     * reason the OSD should stay up, so "keep it visible while paused / while the
     * pointer is on the OSD / while dragging the scrub bar" needs no bookkeeping:
     * those states simply cancel the timeout.
     */
    // biome-ignore lint/correctness/useExhaustiveDependencies: `activity` is a counter the effect never reads — bumping it is how a pointer move restarts the countdown
    useEffect(() => {
        if (
            !osdVisible ||
            paused ||
            osdHovered ||
            dragging ||
            failed ||
            sleepOpen
        )
            return;
        const id = window.setTimeout(
            () => setOsdVisible(false),
            Math.max(1, osdHideAfterS) * 1000,
        );
        return () => window.clearTimeout(id);
    }, [
        osdVisible,
        paused,
        osdHovered,
        dragging,
        failed,
        sleepOpen,
        osdHideAfterS,
        activity,
    ]);

    /**
     * The panel is chrome, so it cannot outlive the chrome: an OSD that faded
     * while the pointer was elsewhere must not leave a dialog behind to reappear
     * on the next mouse move. Closing it here also returns focus to the stage.
     */
    useEffect(() => {
        if (!osdVisible && sleepOpen) setSleepOpen(false);
    }, [osdVisible, sleepOpen]);

    /** Banner: shown on tune-in and on every episode handoff, then fades. */
    useEffect(() => {
        if (episodeId == null) return;
        setBannerFlash(true);
        setFailed(false);
        wantsPlayRef.current = true;
        prewarmedAfterRef.current = null;
        const id = window.setTimeout(() => setBannerFlash(false), BANNER_MS);
        return () => window.clearTimeout(id);
    }, [episodeId]);

    // ---- prewarm and handoff ------------------------------------------------

    /**
     * T−30s: ask the store to commit the next pick and start its encoder. Keyed on
     * the *boolean* window rather than on `remainingS`, so this fires once per
     * episode instead of four times a second, and guarded by episode id so a seek
     * back into the window cannot ask twice.
     */
    useEffect(() => {
        if (!prewarmNext || !inUpNextWindow || failed) return;
        // Nothing follows this episode, so committing a pick for it would spend a
        // schedule step we'd only have to release again at the boundary. The ref is
        // deliberately left unset: cancelling the timer re-runs this effect, and the
        // prewarm then fires late but still inside the window, so a change of mind
        // doesn't cost the gapless handoff.
        if (sleepPending) return;
        if (episodeId == null || prewarmedAfterRef.current === episodeId)
            return;
        prewarmedAfterRef.current = episodeId;
        void prewarm();
    }, [prewarmNext, inUpNextWindow, failed, sleepPending, episodeId, prewarm]);

    /** The countdown chip's clock. Runs only while something is counting down. */
    useEffect(() => {
        if (sleepUntil === null) return;
        setNowMs(Date.now());
        const id = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [sleepUntil]);

    /**
     * Expiry while paused.
     *
     * Waiting for the unit to finish assumes something is playing towards its end.
     * Paused, nothing is, and a viewer who paused and did not come back is the
     * exact case the timer is for — so this is the one path that stops mid-episode.
     *
     * It keys on `wantsPlayRef` rather than on `paused`, and that distinction is
     * load-bearing — `paused` is true during several moments that are not a viewer
     * pausing, both of which were caught only by running the real app:
     *
     * 1. **Chromium fires `pause` immediately before `ended`** (measured: same
     *    millisecond, with the element's `ended` already true). Keying on `paused`
     *    lost the race against `handleEnded` at the close of every episode, and an
     *    episode watched to the end was logged `completed: false` — a stop, not a
     *    watch, which is what a shuffle bag reads.
     * 2. **A promoted standby is paused for an instant.** So a timer that expired
     *    mid-arc stopped at the handoff into the next part — precisely the thing
     *    the unit boundary exists to prevent. A seek's reload has the same shape.
     *
     * `wantsPlayRef` is false only where a human asked for it: `togglePlay`. Every
     * transient pause above leaves it true, and so leaves the timer waiting for a
     * boundary, which is the whole contract.
     */
    useEffect(() => {
        if (!sleepExpired || !paused || failed) return;
        if (wantsPlayRef.current) return;
        void sleepNow();
    }, [sleepExpired, paused, failed, sleepNow]);

    /** Mirror the store's pending pick into the standby surface, and drop it when it goes. */
    useEffect(() => {
        setStage((current) => mirrorPending(current, pendingNext));
    }, [pendingNext]);

    /**
     * The swap itself. Runs when `stage.active` changes — i.e. after a promotion —
     * and is what turns a buffered standby into the picture: raise its pump to the
     * full read targets, re-assert volume (it was muted while hidden), and play.
     */
    // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the swap alone — re-running this when `applyVolume` or `pipStep` re-bind would fight the transport
    useEffect(() => {
        const handle =
            stage.active === "a" ? surfaceA.current : surfaceB.current;
        const video = handle?.element;
        if (!video) return;
        handle.promote();
        // The standby was muted while hidden; it is the picture now.
        applyVolume(video);
        if (wantsPlayRef.current && video.paused)
            void video.play().catch(() => undefined);
        // …and if the picture is floating, the window has to come with it. The
        // controller answers with a *transfer* — never an exit followed by a fresh
        // entry, which would need a gesture nobody made at an automatic handoff.
        pipStep({ type: "swapped", slot: stage.active });
        // Keyed on the swap alone: `applyVolume` changing is the volume effect's job,
        // and re-running this on it would fight the transport.
    }, [stage.active]);

    // ---- volume -------------------------------------------------------------

    /**
     * The store owns volume/mute (it persists them); the element on air is a
     * mirror of it. Applied here when the *store* changes, and again from
     * `loadedmetadata` when a fresh element arrives — an effect cannot cover that
     * second case, because a surface's element appears through a ref callback and
     * none of this effect's dependencies change when it does.
     */
    const applyVolume = useCallback(
        (video: HTMLVideoElement) => {
            video.volume = volume;
            video.muted = muted;
        },
        [volume, muted],
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: the effect never reads `activeSlot` — its key is here so a *newly mounted* element, which `activeVideo()` reaches through a ref the rule cannot see, gets the store's volume too
    useEffect(() => {
        const video = activeVideo();
        if (video) applyVolume(video);
    }, [applyVolume, activeVideo, activeSlot?.source.key]);

    // ---- transport ----------------------------------------------------------

    /**
     * A *human* asking for playback or for silence — the OSD button, <kbd>Space</kbd>,
     * a media key, or the floating window's own play/pause.
     *
     * `wantsPlayRef` is set here and nowhere else, and that is load-bearing: it is
     * what the sleep timer's paused branch reads to tell a viewer who walked away
     * from the several pauses Chromium performs on its own (see "Expiry while
     * paused" below).
     */
    const setPlaying = useCallback(
        (wanted: boolean) => {
            const video = activeVideo();
            if (!video) return;
            wantsPlayRef.current = wanted;
            if (wanted) void video.play().catch(() => setFailed(true));
            else video.pause();
        },
        [activeVideo],
    );

    const togglePlay = useCallback(() => {
        const video = activeVideo();
        if (!video) return;
        setPlaying(video.paused);
    }, [activeVideo, setPlaying]);

    /**
     * Perform the seek. `direct` files are real files behind range requests, so
     * `currentTime` works; everything else is a pipe and must be re-requested at
     * `?t=`, carrying the offset forward for display.
     */
    const performSeek = useCallback(
        (seconds: number) => {
            const video = activeVideo();
            if (!video || !nowPlaying) return;
            const target = clamp(seconds, Math.max(0, totalS - 1));

            if (nowPlaying.episode.playbackPath === "direct") {
                // Range requests: the browser can do this itself, and the offset for a
                // direct source is always 0, so the displayed position needs no fixup.
                setScrubPreview(null);
                setVideoTime(target);
                video.currentTime = target;
                return;
            }

            const at = Math.floor(target);
            wantsPlayRef.current = true;
            setVideoTime(0);
            setScrubPreview(null);
            setStage((current) =>
                writeSlot(
                    current,
                    current.active,
                    slotFor(nowPlaying, at, withSeek(nowPlaying.streamUrl, at)),
                ),
            );
        },
        [activeVideo, nowPlaying, totalS],
    );

    const commitSeek = useCallback(
        (seconds: number) => {
            if (seekTimerRef.current !== null)
                window.clearTimeout(seekTimerRef.current);
            seekTimerRef.current = window.setTimeout(() => {
                seekTimerRef.current = null;
                performSeek(seconds);
            }, SEEK_COMMIT_MS);
        },
        [performSeek],
    );

    useEffect(
        () => () => {
            if (seekTimerRef.current !== null)
                window.clearTimeout(seekTimerRef.current);
        },
        [],
    );

    /**
     * `ended` can fire more than once around a source swap, and a leaned-on skip
     * key would queue several advances — the ref makes both one-shot until the
     * scheduler has answered.
     */
    const runAdvance = useCallback(
        (completed: boolean) => {
            if (advancingRef.current) return;
            advancingRef.current = true;
            void advance(completed).finally(() => {
                advancingRef.current = false;
            });
        },
        [advance],
    );

    const skip = useCallback(() => runAdvance(false), [runAdvance]);
    const handleEnded = useCallback(() => runAdvance(true), [runAdvance]);

    // ---- media session ------------------------------------------------------

    /**
     * The transport controls we don't draw.
     *
     * Chromium's floating PiP window has its own play/pause, and shows a skip
     * button *only* when a `nexttrack` handler is registered — so this is what puts
     * one there. Routing those buttons through `setPlaying`/`skip` rather than
     * letting them poke the element directly is what keeps `wantsPlayRef` honest:
     * a pause from the floating window is a human pausing, and must read as one.
     *
     * (If a future Chromium bypasses the session for its overlay buttons, the
     * element pauses anyway and the OSD stays truthful; the only thing lost is the
     * sleep timer's paused branch firing for that pause — it would wait for the
     * end of the episode instead, which is the safe direction to be wrong in.)
     *
     * On Linux this also lands on MPRIS, so the keyboard's own media keys work.
     */
    useEffect(() => {
        const session = mediaSession();
        if (!session) return;
        session.setActionHandler("play", () => setPlaying(true));
        session.setActionHandler("pause", () => setPlaying(false));
        session.setActionHandler("nexttrack", () => skip());
        return () => {
            session.setActionHandler("play", null);
            session.setActionHandler("pause", null);
            session.setActionHandler("nexttrack", null);
        };
    }, [setPlaying, skip]);

    /** What the floating window and the OS media popup are titled. */
    useEffect(() => {
        const session = mediaSession();
        if (!session || !nowPlaying || typeof MediaMetadata === "undefined")
            return;
        const { episode, channelNumber, channelName } = nowPlaying;
        session.metadata = new MediaMetadata({
            title: episode.title ?? episode.code,
            artist: episode.showTitle,
            album: `CH ${String(channelNumber).padStart(2, "0")} · ${channelName}`,
        });
    }, [nowPlaying]);

    useEffect(() => {
        const session = mediaSession();
        if (!session) return;
        session.playbackState = paused ? "paused" : "playing";
    }, [paused]);

    /**
     * The moon, and <kbd>S</kbd>.
     *
     * Opening arms the default when nothing is armed yet, which keeps the old
     * one-press fast path intact — "give me the usual" is still a single press,
     * and the panel simply opens around the result so a second gesture can refine
     * it. A press with the panel already open closes it; there is nothing to
     * commit, because the dial commits as it moves.
     */
    const toggleSleepPanel = useCallback(() => {
        // Read `sleepOpen` rather than use an updater: arming is a store write, and
        // React may run an updater during a render, where a write to another store
        // is not allowed.
        const opening = !sleepOpen;
        if (opening && sleepUntil === null) armSleep(sleepDefaultMin);
        setSleepOpen(opening);
    }, [sleepOpen, sleepUntil, sleepDefaultMin, armSleep]);

    /** Wheel over the moon, the chip or the panel: ±5 minutes, no clicks at all. */
    const wheelSleep = useCallback(
        (e: WheelEvent<HTMLElement>) => {
            adjustSleep(e.deltaY < 0 ? SLEEP_STEP_MIN : -SLEEP_STEP_MIN);
        },
        [adjustSleep],
    );

    /** Re-open the active surface's stream from scratch, standby untouched. */
    const retry = useCallback(() => {
        setFailed(false);
        wantsPlayRef.current = true;
        setStage((current) => ({
            ...current,
            generation: {
                ...current.generation,
                [current.active]: current.generation[current.active] + 1,
            },
        }));
    }, []);

    // ---- fullscreen ---------------------------------------------------------

    const toggleFullscreen = useCallback(() => {
        if (document.fullscreenElement) {
            void document.exitFullscreen().catch(() => undefined);
        } else {
            // The other direction of the same exclusivity as `togglePip`: the picture
            // cannot be both filling the screen and floating beside it.
            if (pipFloating) pipStep({ type: "toggle", slot: stage.active });
            // The stage, never a video — see the file header.
            void stageRef.current?.requestFullscreen().catch(() => undefined);
        }
    }, [pipFloating, pipStep, stage.active]);

    useEffect(() => {
        const onChange = (): void => {
            const isFs = document.fullscreenElement != null;
            setFullscreen(isFs);
            if (!isFs) leftFullscreenAtRef.current = Date.now();
        };
        document.addEventListener("fullscreenchange", onChange);
        return () => {
            document.removeEventListener("fullscreenchange", onChange);
            // Leaving the player must not strand the window in fullscreen — but only
            // while fullscreen is still ours. Going dark re-targets it to the document
            // root before unmounting us (`goDark` in the store) precisely so the
            // blackout inherits a chromeless screen; exiting here would undo that.
            if (document.fullscreenElement === stageRef.current) {
                void document.exitFullscreen().catch(() => undefined);
            }
        };
    }, []);

    // ---- keyboard map -------------------------------------------------------

    /**
     * Bound on `window` for the lifetime of the screen. Keystrokes are ignored
     * when a text field or one of our sliders has focus, so the scrub bar's own
     * ←/→ never doubles as "skip episode".
     *
     * A *floating* player binds nothing at all: it is mounted only to keep the
     * channel running, and a window-level map from an off-stage screen would make
     * <kbd>Space</kbd> in the Library pause the television.
     */
    useEffect(() => {
        if (floating) return;
        const onKeyDown = (e: globalThis.KeyboardEvent): void => {
            const target = e.target as HTMLElement | null;
            if (
                target?.closest(
                    'input, textarea, select, [contenteditable="true"], [role="slider"]',
                ) != null
            ) {
                reveal();
                return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey) return;

            reveal();

            switch (e.key) {
                case " ":
                    e.preventDefault();
                    togglePlay();
                    break;
                case "ArrowUp":
                    e.preventDefault();
                    adjustVolume(VOLUME_STEP);
                    break;
                case "ArrowDown":
                    e.preventDefault();
                    adjustVolume(-VOLUME_STEP);
                    break;
                case "ArrowRight":
                    e.preventDefault();
                    skip();
                    break;
                case "f":
                case "F":
                    e.preventDefault();
                    toggleFullscreen();
                    break;
                case "m":
                case "M":
                    e.preventDefault();
                    toggleMute();
                    break;
                case "p":
                case "P":
                    e.preventDefault();
                    // Inside the keydown handler, so the entry still counts as a gesture.
                    togglePip();
                    break;
                case "s":
                case "S":
                    e.preventDefault();
                    toggleSleepPanel();
                    break;
                case "Escape":
                    // The panel takes the first Esc, before fullscreen and before the
                    // guide — it is the innermost thing open.
                    if (sleepOpen) {
                        e.preventDefault();
                        setSleepOpen(false);
                        break;
                    }
                    // Chromium swallows Esc to leave fullscreen, so by the time we see
                    // one we are usually already out. Either way the first Esc only ever
                    // exits fullscreen; the second one leaves the player.
                    if (document.fullscreenElement) {
                        void document.exitFullscreen().catch(() => undefined);
                    } else if (Date.now() - leftFullscreenAtRef.current > 400) {
                        // With the picture floating, Esc is "go and browse", not "stop
                        // watching": the channel keeps playing in the corner and this screen
                        // stays mounted behind the guide. Only a viewer with nothing floating
                        // means to end the session.
                        if (pipFloating) navigate("guide");
                        else void leavePlayer();
                    }
                    break;
                default:
                    break;
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [
        floating,
        reveal,
        togglePlay,
        skip,
        toggleFullscreen,
        toggleMute,
        toggleSleepPanel,
        togglePip,
        pipFloating,
        navigate,
        sleepOpen,
        adjustVolume,
        leavePlayer,
    ]);

    if (!nowPlaying) return null;

    const { episode, arc, channelNumber } = nowPlaying;
    const dial = String(channelNumber).padStart(2, "0");
    const episodeLine = [
        episode.code,
        (episode.title ?? episode.showTitle).toUpperCase(),
        arc ? `PART ${arc.partIndex} OF ${arc.partCount}` : null,
    ]
        .filter(Boolean)
        .join(" · ");

    const volumePct = Math.round((muted ? 0 : volume) * 100);

    /**
     * What the sleep chip says. Once the deadline has passed the countdown is
     * meaningless — what the viewer needs to know is *where* it will stop, which
     * mid-arc is the end of the arc rather than the end of this episode.
     */
    const sleepLabel = ((): string | null => {
        if (sleepUntil === null) return null;
        if (!sleepExpired) return formatDuration((sleepUntil - nowMs) / 1000);
        if (endsUnit) return "after this episode";
        return `after part ${arc?.partCount ?? "?"}`;
    })();

    /**
     * Both surfaces are always mounted, so promoting one is a class change rather
     * than a mount — a mount would throw away the buffer the standby exists to
     * have built. The inactive one is `opacity: 0` rather than `display: none`, so
     * Chromium keeps its decoder warm.
     */
    const surface = (slot: SlotId): JSX.Element => {
        const isActive = stage.active === slot;
        return (
            <VideoSurface
                key={slot}
                source={stage[slot]?.source ?? null}
                active={isActive}
                standby={!isActive}
                generation={stage.generation[slot]}
                handleRef={slot === "a" ? surfaceA : surfaceB}
                className={`video${isActive ? " is-active" : ""}`}
                onStreamError={() => setFailed(true)}
                onLoadStart={() => setVideoTime(0)}
                onLoadedMetadata={(video) => {
                    applyVolume(video);
                    if (wantsPlayRef.current)
                        void video.play().catch(() => undefined);
                }}
                onLoadedData={() => setFailed(false)}
                onTimeUpdate={setVideoTime}
                onPlay={() => setPaused(false)}
                onPause={() => setPaused(true)}
                onEnded={handleEnded}
                onError={() => setFailed(true)}
            />
        );
    };

    return (
        <div
            ref={stageRef}
            className={`stage${chromeVisible ? "" : " idle"}${floating ? " is-offscreen" : ""}`}
            aria-hidden={floating}
            onMouseMove={reveal}
            onPointerDown={reveal}
        >
            {surface("a")}
            {surface("b")}

            <div className={`banner${showBanner ? "" : " is-hidden"}`}>
                <span className="b-num">{dial}</span>
                <span>
                    <span className="b-show">{episode.showTitle}</span>
                    <br />
                    <span className="b-ep">{episodeLine}</span>
                </span>
            </div>

            <span className={`onair${chromeVisible ? "" : " is-hidden"}`}>
                <span className="live" />
                ON AIR
            </span>

            {showToast && upNext && (
                <div className="toast" role="status">
                    Up next on CH {dial} · <b>{upNext.showTitle}</b>{" "}
                    <code>{upNext.code}</code>
                    {upNext.title ? ` “${upNext.title}”` : ""}
                    {standbySlot !== null && (
                        <span className="toast-ready"> · ready</span>
                    )}
                </div>
            )}

            {/*
        Chromium paints its own "Playing in picture-in-picture" over the blanked
        element — outside the DOM, so it cannot be styled or suppressed — which
        means this card must not repeat it. It carries what the browser's line
        does not: which channel is in the window, and the two things worth doing
        from here. Its wrapper is click-through, so the OSD underneath — scrub,
        volume, the sleep timer — keeps working on the same element.
      */}
            {pipFloating && !failed && (
                <div className="pip-placard">
                    <div className="pp-card">
                        <div className="pp-title">
                            Keep watching while you browse
                        </div>
                        <div className="pp-sub">
                            CH {dial} · {episodeLine}
                        </div>
                        <div className="pp-actions">
                            <button
                                type="button"
                                className="btn btn-tune"
                                onClick={togglePip}
                            >
                                Bring it back
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => navigate("guide")}
                            >
                                Browse the guide
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {failed && (
                <div className="player-error" role="alert">
                    <div className="pe-title">
                        Can&rsquo;t play this episode
                    </div>
                    <div className="pe-sub">
                        {episode.showTitle} · {episode.code}
                        {episode.title ? ` · ${episode.title}` : ""}
                    </div>
                    <div className="pe-hint">
                        The stream stopped or never started. Retry, or skip to
                        the next pick on this channel.
                    </div>
                    <div className="pe-actions">
                        <button
                            type="button"
                            className="btn btn-tune"
                            onClick={retry}
                        >
                            Retry
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={skip}
                        >
                            Skip
                        </button>
                    </div>
                </div>
            )}

            {sleepOpen && (
                <SleepPanel
                    sleepUntil={sleepUntil}
                    nowMs={nowMs}
                    endsUnit={endsUnit}
                    arcPartCount={arc?.partCount ?? null}
                    onArm={armSleep}
                    onAdjust={adjustSleep}
                    onClose={() => setSleepOpen(false)}
                />
            )}

            <div
                className={`osd${chromeVisible ? "" : " is-hidden"}`}
                onPointerEnter={() => setOsdHovered(true)}
                onPointerLeave={() => setOsdHovered(false)}
            >
                <Slider
                    className="scrub"
                    label="Seek"
                    value={clamp(position, Math.max(totalS, 1))}
                    max={Math.max(totalS, 1)}
                    step={10}
                    ariaValueText={`${formatDuration(position)} of ${formatDuration(totalS)}`}
                    onPreview={setScrubPreview}
                    onCommit={commitSeek}
                    onDragChange={setDragging}
                    knob
                />

                <div className="osd-row">
                    <button
                        type="button"
                        className="osd-btn primary"
                        aria-label={paused ? "Play" : "Pause"}
                        onClick={togglePlay}
                    >
                        {paused ? (
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M8 5v14l11-7z" />
                            </svg>
                        ) : (
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                            </svg>
                        )}
                    </button>

                    <button
                        type="button"
                        className="osd-btn"
                        aria-label="Skip to next episode"
                        onClick={skip}
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M6 5l8 7-8 7V5zm10 0h2v14h-2z" />
                        </svg>
                    </button>

                    <div className="vol">
                        <button
                            type="button"
                            className="osd-btn"
                            aria-label={muted ? "Unmute" : "Mute"}
                            aria-pressed={muted}
                            onClick={toggleMute}
                        >
                            {muted ? (
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M4.3 3L3 4.3 7.7 9H4v6h4l5 4v-6.7l3.2 3.2c-.5.4-1.1.7-1.7.9v2.1c1.2-.3 2.2-.8 3.1-1.5l2.1 2.1 1.3-1.3L4.3 3zM13 5L10.9 7.1 13 9.2V5zm3.5 7c0 .3 0 .5-.1.8l1.6 1.6c.3-.7.5-1.5.5-2.4 0-2.6-1.7-4.8-4-5.6v2.1c1.2.6 2 1.9 2 3.5z" />
                                </svg>
                            ) : (
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a3.5 3.5 0 0 0-2-3.15v6.3a3.5 3.5 0 0 0 2-3.15z" />
                                </svg>
                            )}
                        </button>
                        <Slider
                            className="vol-track"
                            label="Volume"
                            value={volumePct}
                            max={100}
                            step={5}
                            ariaValueText={muted ? "Muted" : `${volumePct}%`}
                            onPreview={(v) => setVolume(v / 100)}
                            onCommit={(v) => setVolume(v / 100)}
                        />
                    </div>

                    <button
                        type="button"
                        className={`osd-btn sleep${sleepUntil !== null ? " is-armed" : ""}`}
                        aria-label={
                            sleepUntil === null
                                ? "Set sleep timer"
                                : sleepExpired
                                  ? `Sleep timer finished — stopping ${sleepLabel}. Press to change`
                                  : `Sleep timer: ${sleepLabel} left. Press to change`
                        }
                        aria-expanded={sleepOpen}
                        onClick={toggleSleepPanel}
                        onWheel={wheelSleep}
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9zm0 2.2A5.2 5.2 0 0 0 18.8 12 7 7 0 0 1 12 18.8 6.8 6.8 0 0 1 12 5.2z" />
                        </svg>
                    </button>

                    {sleepLabel !== null && (
                        <span
                            className={`sleep-chip${sleepExpired ? " is-due" : ""}`}
                            role="status"
                            title="Scroll to add or remove 5 minutes"
                            onWheel={wheelSleep}
                        >
                            {sleepExpired ? "Sleeps " : ""}
                            {sleepLabel}
                        </span>
                    )}

                    <div className="kbd-hints" aria-hidden="true">
                        <span>
                            <kbd>Space</kbd>pause
                        </span>
                        <span>
                            <kbd>→</kbd>skip
                        </span>
                        <span>
                            <kbd>S</kbd>sleep
                        </span>
                        <span>
                            <kbd>P</kbd>pip
                        </span>
                        <span>
                            <kbd>F</kbd>fullscreen
                        </span>
                        <span>
                            <kbd>Esc</kbd>guide
                        </span>
                    </div>

                    <span className="timecode">
                        <b>{formatDuration(position)}</b> /{" "}
                        {formatDuration(totalS)}
                    </span>

                    <button
                        type="button"
                        className={`osd-btn pip${pipFloating ? " is-floating" : ""}`}
                        aria-label="Picture-in-picture"
                        aria-pressed={pipFloating}
                        onClick={togglePip}
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M19 11h-8v6h8v-6zm2-8H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.02H3V4.97h18v14.05z" />
                        </svg>
                    </button>

                    <button
                        type="button"
                        className="osd-btn"
                        aria-label="Toggle fullscreen"
                        aria-pressed={fullscreen}
                        onClick={toggleFullscreen}
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M5 5h5v2H7v3H5V5zm9 0h5v5h-2V7h-3V5zM5 14h2v3h3v2H5v-5zm12 0h2v5h-5v-2h3v-3z" />
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    );
}
