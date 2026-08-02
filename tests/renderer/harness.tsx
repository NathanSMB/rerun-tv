/**
 * The renderer harness: the real `<Player/>`, mounted, with two seams scripted.
 *
 * The layer this exists for is the one `npm test` could not see — *which* store
 * action the Player's effects decide to call (`advance(true)`, `sleepNow()`,
 * `prewarm()`) in response to media-element events. `handoff.test.ts` starts
 * where that decision ends: it calls those actions directly, against the real
 * scheduler. Two bugs lived in the gap and shipped past a green suite
 * (docs/playback.md § "Two things Chromium does around `ended`").
 *
 * Three things are scripted; everything between them is production code:
 *
 * 1. **The media elements.** happy-dom supplies DOM globals so `react-dom` can
 *    mount the real component, but its `<video>` is an inert stub — so `paused`,
 *    `ended`, `play()` and `pause()` are replaced below with the orderings
 *    measured in the real app. `VideoSurface` itself is *not* mocked: the rule
 *    that events are forwarded only while a surface is active is half of what
 *    the decision reads, and a fake would have to restate it. It takes its
 *    plain-`src` branch here (happy-dom has no `MediaSource`); the pump that
 *    branch skips is DOM-free and pinned by `mse.test.ts`.
 * 2. **Picture-in-picture**, which happy-dom does not implement at all — model
 *    below, and it enforces Chromium's gesture rule rather than merely allowing
 *    what the Player asks for.
 * 3. **The preload bridge** (`fixtures.tsx`), at the same `RerunApi` seam
 *    `handoff.test.ts` fakes.
 *
 * Tests never hand-fire raw events. They speak the vocabulary this module
 * exports, so the ordering Chromium was measured to produce lives in exactly one
 * place. If Chromium turns out to do something new, measure it live with
 * `scripts/soak.mjs --eval`, record it in `docs/playback.md`, then teach it here.
 */

import type { RerunApi } from "@shared/ipc.js";
import type { AppSettings, NowPlaying } from "@shared/types.js";
import { DEFAULT_SETTINGS } from "@shared/types.js";
import type { JSX } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PlayerSlot } from "../../src/renderer/src/App.js";
import Blackout from "../../src/renderer/src/screens/Blackout.js";
import { useStore } from "../../src/renderer/src/store.js";
import { type BridgeCall, CHANNEL_ID, scriptedBridge } from "./fixtures.js";

declare global {
    /** React's `act` refuses to run without this, and it is set per environment. */
    var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/**
 * The pristine store actions, captured before anything wraps them, so a test
 * that instruments the store cannot leave a wrapper around a wrapper for the
 * next one.
 */
const REAL = useStore.getState();

/**
 * How many consecutive passes must do *no* work before `settle` declares the
 * world at rest.
 *
 * More than one because the media model is not the only thing in flight: a store
 * transition can hop several macrotasks (a bridge round trip, then the effect
 * that reads its result) without touching a video element at all, so a single
 * idle pass proves nothing. Three is the longest such chain in the suite — the
 * `ended` handoff — with a pass to spare.
 */
const SETTLE_QUIET_PASSES = 3;

/**
 * The hard cap. Reaching it means work is being re-armed every pass — a `play()`
 * the Player reissues forever, a `src` that never sticks, an effect loop — which
 * is a hang in the app, not a slow test. Throwing says so instead of returning a
 * half-settled stage and failing somewhere less informative.
 */
const SETTLE_MAX_PASSES = 40;

const macrotask = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

// ---------------------------------------------------------------------------
// The measured media model
// ---------------------------------------------------------------------------

interface MediaState {
    paused: boolean;
    ended: boolean;
    /** Resolvers for `play()` calls the harness has not let take effect yet. */
    pending: Array<() => void>;
    /** The `src` this element has already reported as loaded. */
    loaded: string | null;
}

const media = new WeakMap<HTMLMediaElement, MediaState>();

function mediaState(el: HTMLMediaElement): MediaState {
    let state = media.get(el);
    if (!state) {
        state = { paused: true, ended: false, pending: [], loaded: null };
        media.set(el, state);
    }
    return state;
}

let installed = false;

/**
 * Replace happy-dom's inert media element with the model measured in Chromium.
 *
 * The handoff that motivated this harness warns about exactly this: a fake that
 * fires `ended` without a preceding `pause` would happily pass the broken code.
 * So the two properties the Player reads — `paused` and `ended` — are backed by
 * state the *scenario vocabulary* drives, never by anything happy-dom decides.
 */
function installMediaModel(): void {
    if (installed) return;
    installed = true;
    const proto = HTMLMediaElement.prototype;

    Object.defineProperty(proto, "paused", {
        configurable: true,
        get(this: HTMLMediaElement): boolean {
            return mediaState(this).paused;
        },
    });

    Object.defineProperty(proto, "ended", {
        configurable: true,
        get(this: HTMLMediaElement): boolean {
            return mediaState(this).ended;
        },
    });

    /**
     * `play()` resolves on a later task and only fires `play` when it does. That
     * delay is not incidental: it is what leaves a promoted standby paused across
     * at least one effect pass, which is the window bug 2 lived in.
     */
    proto.play = function (this: HTMLMediaElement): Promise<void> {
        return new Promise<void>((resolve) => {
            mediaState(this).pending.push(resolve);
        });
    };

    /** Synchronous, as Chromium's is: the flag flips and `pause` fires with it. */
    proto.pause = function (this: HTMLMediaElement): void {
        const state = mediaState(this);
        if (state.paused) return;
        state.paused = true;
        this.dispatchEvent(new Event("pause"));
    };

    /** `VideoSurface.detach()` calls this; resetting the element is what it means. */
    proto.load = function (this: HTMLMediaElement): void {
        mediaState(this).loaded = null;
    };
}

/** Both surfaces, in DOM order: slot `a`, then slot `b`. */
function videos(): HTMLVideoElement[] {
    return Array.from(document.querySelectorAll("video"));
}

// ---------------------------------------------------------------------------
// The measured picture-in-picture model
// ---------------------------------------------------------------------------

/**
 * PiP as Electron was measured performing it (docs/pip-plan.html §2). The
 * orderings were first taken on 38 and re-checked on 43, which is what the app
 * ships against; document-PiP differs between the two but element-PiP — the
 * only kind this models — did not change.
 *
 * Three facts are baked in, and each one is a rule the Player has to obey rather
 * than a convenience:
 *
 * 1. **A fresh entry throws `NotAllowedError` outside a user gesture**, while a
 *    transfer to another element with a session already live does not. So the
 *    model tracks activation, and only the vocabulary's clicks and keystrokes
 *    supply it. A Player that deferred its entry to an effect fails here exactly
 *    as it would in the app.
 * 2. **A transfer emits `leavepictureinpicture` on the old element**, before the
 *    new element's `enterpictureinpicture` and before the promise resolves:
 *    measured `enter:a`, `promise:a`, `leave:a`, `enter:b`, `promise:b`. That
 *    middle event is the one a naive implementation reads as "the viewer closed
 *    the window", which would break every handoff.
 * 3. The events **bubble**, which is what lets the Player listen once on the
 *    document instead of chasing elements through ref callbacks.
 */
interface PipModel {
    /** Every session change, in order: `enter:<slot>`, `leave:<slot>`, `exit`. */
    log: string[];
    element(): HTMLVideoElement | null;
    /** The window closing itself — the ✕, "back to tab", or the OS. */
    close(): void;
}

let pipInstalled = false;
let pipElement: HTMLVideoElement | null = null;
let pipLog: string[] = [];
/** Non-zero while a click or keystroke the vocabulary dispatched is in flight. */
let gestureDepth = 0;

const slotOf = (el: HTMLVideoElement | null): string =>
    el === null ? "none" : (["a", "b"][videos().indexOf(el)] ?? "?");

function firePip(el: HTMLVideoElement, type: string): void {
    el.dispatchEvent(new Event(type, { bubbles: true }));
}

function installPipModel(): PipModel {
    if (!pipInstalled) {
        pipInstalled = true;

        Object.defineProperty(document, "pictureInPictureEnabled", {
            configurable: true,
            get: () => true,
        });
        Object.defineProperty(document, "pictureInPictureElement", {
            configurable: true,
            get: () => pipElement,
        });

        HTMLVideoElement.prototype.requestPictureInPicture = function (
            this: HTMLVideoElement,
        ): Promise<PictureInPictureWindow> {
            if (pipElement === null && gestureDepth === 0) {
                const error = new Error(
                    "Must be handling a user gesture if there isn't already an element in Picture-in-Picture.",
                );
                error.name = "NotAllowedError";
                return Promise.reject(error);
            }
            const previous = pipElement;
            return new Promise((resolve) => {
                // A round trip through Chromium's window manager: the events land on a
                // later task than the call, and the promise settles after them.
                setTimeout(() => {
                    if (previous && previous !== this) {
                        pipElement = null;
                        pipLog.push(`leave:${slotOf(previous)}`);
                        firePip(previous, "leavepictureinpicture");
                    }
                    pipElement = this;
                    pipLog.push(`enter:${slotOf(this)}`);
                    firePip(this, "enterpictureinpicture");
                    resolve({
                        width: 512,
                        height: 288,
                    } as PictureInPictureWindow);
                }, 0);
            });
        };

        document.exitPictureInPicture = (): Promise<void> => {
            const leaving = pipElement;
            pipElement = null;
            pipLog.push("exit");
            if (leaving) firePip(leaving, "leavepictureinpicture");
            return Promise.resolve();
        };
    }

    pipElement = null;
    pipLog = [];
    gestureDepth = 0;
    return {
        get log() {
            return pipLog;
        },
        element: () => pipElement,
        close: () => {
            if (pipElement === null) return;
            pipLog.push(`closed:${slotOf(pipElement)}`);
            pipElement = null;
        },
    };
}

// ---------------------------------------------------------------------------
// The measured fullscreen model
// ---------------------------------------------------------------------------

/**
 * Fullscreen as Chromium performs it, in the two respects the blackout handoff
 * turns on (docs/blackout-fullscreen-plan.html):
 *
 * 1. **Removing the fullscreen element from the document drops fullscreen.**
 *    Modelled as a getter that reports a detached element as nothing at all,
 *    which is what makes the failure this feature fixes reachable from a test:
 *    the stage unmounts with the Player, and without the handoff there is no
 *    fullscreen left for the blackout to inherit.
 * 2. **A fresh request needs a user gesture; re-targeting an existing session
 *    does not.** The same rule as PiP above, and the same reason it matters:
 *    the sleep timer fires with nobody touching anything, so the handoff is
 *    only legal *because* the Player is already fullscreen when it is made.
 *
 * happy-dom implements none of this. The simplification against the real API is
 * that the transition is synchronous rather than a round trip through the
 * compositor; what the tests read is the ordering against the screen flip, which
 * that does not disturb.
 */
let fullscreenInstalled = false;
let fullscreenElement: Element | null = null;

function installFullscreenModel(): void {
    if (!fullscreenInstalled) {
        fullscreenInstalled = true;

        Object.defineProperty(document, "fullscreenElement", {
            configurable: true,
            get: () =>
                fullscreenElement?.isConnected === true
                    ? fullscreenElement
                    : null,
        });

        Element.prototype.requestFullscreen = function (
            this: Element,
        ): Promise<void> {
            if (document.fullscreenElement === null && gestureDepth === 0) {
                const error = new Error(
                    "Fullscreen request requires a user gesture.",
                );
                error.name = "TypeError";
                return Promise.reject(error);
            }
            fullscreenElement = this;
            document.dispatchEvent(new Event("fullscreenchange"));
            return Promise.resolve();
        };

        document.exitFullscreen = (): Promise<void> => {
            fullscreenElement = null;
            document.dispatchEvent(new Event("fullscreenchange"));
            return Promise.resolve();
        };
    }
    fullscreenElement = null;
}

/**
 * Run something with user activation, the way a real click or keystroke carries
 * it. Synchronous on purpose: Chromium's activation does not survive an await,
 * and neither should this — an entry that escaped its gesture must fail here.
 */
function withGesture<T>(run: () => T): T {
    gestureDepth += 1;
    try {
        return run();
    } finally {
        gestureDepth -= 1;
    }
}

/**
 * A stream that has opened: fresh timestamps, paused at zero, and the load
 * events that follow. `VideoSurface` forwards only the active surface's, which
 * is how a standby buffers without touching the OSD.
 *
 * Reports whether it opened anything, which is half of `settle`'s idea of quiet.
 */
function openStreams(): boolean {
    let worked = false;
    for (const el of videos()) {
        const state = mediaState(el);
        const src = el.getAttribute("src");
        if (src === null || src === state.loaded) continue;
        worked = true;
        state.loaded = src;
        state.paused = true;
        state.ended = false;
        // A `play()` issued against the stream we just replaced never fires `play`.
        for (const resolve of state.pending.splice(0)) resolve();
        el.currentTime = 0;
        el.dispatchEvent(new Event("loadstart"));
        el.dispatchEvent(new Event("loadedmetadata"));
        el.dispatchEvent(new Event("loadeddata"));
    }
    return worked;
}

/**
 * Let outstanding `play()` calls take effect — a task after they were asked for.
 * Reports whether there were any, the other half of `settle`'s idea of quiet.
 */
function letPlaysTake(): boolean {
    let worked = false;
    for (const el of videos()) {
        const state = mediaState(el);
        if (state.pending.length === 0) continue;
        worked = true;
        const waiting = state.pending.splice(0);
        if (state.paused) {
            state.paused = false;
            state.ended = false;
            el.dispatchEvent(new Event("play"));
        }
        for (const resolve of waiting) resolve();
    }
    return worked;
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/**
 * The screen switch, as `App.tsx` makes it: the Player owns the window while
 * `screen === 'player'`, and is unmounted the moment it doesn't. The other
 * screens are not this layer's business and are not mounted — except the
 * blackout, which is, because it is the one screen whose behaviour is a
 * *consequence* of the Player's teardown: it inherits fullscreen across the
 * unmount (docs/blackout-fullscreen-plan.html), and nothing on either side of
 * that swap can be tested without both halves of it present.
 *
 * The exception is the one App.tsx makes: with the picture floating in a PiP
 * window the Player stays mounted, off-stage, so the channel keeps running while
 * the viewer browses. It is rendered from the same slot either way — remounting
 * it would drop the elements the floating window is playing — and a blackout
 * still outranks it, because the sleep timer wins.
 *
 * That last rule is *not* restated here: `<PlayerSlot/>` is the very component
 * App renders, imported from App.tsx. A copy of it would have made this whole
 * suite pass while the app itself unmounted the Player out from under a floating
 * window — the exact bug App's header warns about. The stubbing stops at the
 * screens the Player is not: the guide, library and settings are not this
 * layer's business, so App's chrome branch is the one thing left out.
 */
function Shell(): JSX.Element | null {
    const screen = useStore((s) => s.screen);
    if (screen === "blackout") return <Blackout />;
    return <PlayerSlot />;
}

type StoreState = ReturnType<typeof useStore.getState>;

export interface Scenario {
    /** Every bridge call the store made, in order. */
    readonly calls: BridgeCall[];
    /**
     * Which store action the Player's effects chose, in order — the whole point
     * of this layer.
     *
     * The bridge log cannot answer this on its own. `prewarm()` carries its own
     * authoritative sleep guard and returns *before* it reaches the bridge, so a
     * Player that asked for a prewarm it should not have would leave no trace
     * there at all. These wrappers run the real action underneath.
     */
    readonly actions: string[];
    state(): StoreState;
    /** Run everything in flight to a standstill: loads, plays, store transitions. */
    settle(): Promise<void>;
    /** The surface on air. Throws once the Player has left the screen. */
    activeVideo(): HTMLVideoElement;

    // ---- the scenario vocabulary ----
    /** The countdown reaching its deadline, right now. */
    expireSleep(minutes?: number): Promise<void>;
    /** Arm or (with null) cancel the timer, the way the OSD button does. */
    armSleep(minutes: number | null): Promise<void>;
    /**
     * A keystroke, delivered to whatever holds focus — which is what decides
     * whether the player's window-level map sees it at all.
     */
    press(key: string): Promise<void>;
    /** Press the moon button in the OSD row. */
    clickSleep(): Promise<void>;
    /** A wheel notch over an element: `up` adds time, `down` takes it away. */
    wheel(el: Element, direction: "up" | "down"): Promise<void>;
    /** The sleep panel, or null when it is closed. */
    sleepPanel(): HTMLElement | null;
    /** The moon button. */
    sleepButton(): HTMLElement;

    // ---- picture-in-picture ----
    /** Press the PiP button in the OSD row — a gesture, like the real one. */
    clickPip(): Promise<void>;
    /** Which surface the floating window is showing, or null for none. */
    pipSlot(): string | null;
    /** Every session change the model saw: `enter:a`, `leave:a`, `exit`. */
    pipLog(): string[];
    /** The floating window's ✕ (and "back to tab") — no gesture, as in Chromium. */
    closePipWindow(): Promise<void>;
    /** Ask for PiP from outside any gesture, the way an effect would. */
    enterPipWithoutGesture(): Promise<void>;

    // ---- fullscreen ----
    /**
     * What is filling the screen: the Player's `stage` wrapper, the document root
     * the blackout inherits, or nothing. An element that has been unmounted reads
     * as `null`, exactly as Chromium reports it.
     */
    fullscreenTarget(): "stage" | "root" | "other" | null;
    /** The stream dying under the player: what raises the Retry/Skip card. */
    breakStream(): Promise<void>;
    /** T−30s: reserve the next pick into the standby surface. */
    prewarm(): Promise<void>;
    /** A human asking to pause — the OSD button, the only thing that means it. */
    viewerPause(): Promise<void>;
    viewerPlay(): Promise<void>;
    /** Move the playhead: how a test enters the up-next window. */
    at(seconds: number): Promise<void>;
    /** The `pause` Chromium fires immediately before `ended`. */
    pauseForEnd(): Promise<void>;
    /** The `ended` that follows it, stopping *inside* the promotion window. */
    ended(): Promise<void>;
    /** Both of the above, then settle: an episode running out. */
    endEpisode(): Promise<void>;
    unmount(): Promise<void>;
}

/**
 * Mount the Player against `deck` and tune in, leaving the first episode on air.
 *
 * Every scenario starts here, and the store is reset per call the same way
 * `handoff.test.ts` resets it: module-level state in the store is the one thing
 * that can bleed between tests.
 */
export async function openPlayer(
    deck: NowPlaying[],
    settings: Partial<AppSettings> = {},
): Promise<Scenario> {
    installMediaModel();
    installFullscreenModel();
    const pip = installPipModel();
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    const bridge = scriptedBridge(deck);
    (globalThis as { rerun?: RerunApi }).rerun = bridge.api;

    const actions: string[] = [];
    useStore.setState({
        screen: "guide",
        nowPlaying: null,
        upNext: null,
        pendingNext: null,
        sleepUntil: null,
        sleepMinutes: null,
        pipActive: false,
        channels: [],
        volume: DEFAULT_SETTINGS.volume,
        muted: DEFAULT_SETTINGS.muted,
        settings: { ...DEFAULT_SETTINGS, ...settings },
        advance: async (completed) => {
            actions.push(`advance(${completed})`);
            await REAL.advance(completed);
        },
        prewarm: async () => {
            actions.push("prewarm");
            await REAL.prewarm();
        },
        sleepNow: async () => {
            actions.push("sleepNow");
            await REAL.sleepNow();
        },
        leavePlayer: async () => {
            actions.push("leavePlayer");
            await REAL.leavePlayer();
        },
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
        root.render(<Shell />);
    });

    /**
     * Run until a pass finds nothing left to do.
     *
     * The old version ran a fixed eight passes and called that "at rest", which is
     * two different lies depending on the scenario: a cascade one pass longer than
     * eight was silently left half-run, and every other scenario paid for seven
     * passes it did not need. Looping to quiescence makes the claim true, and the
     * cap turns a runaway into a named failure rather than a fixed number of
     * passes that quietly hides it.
     */
    const settle = async (): Promise<void> => {
        let quiet = 0;
        for (let pass = 0; quiet < SETTLE_QUIET_PASSES; pass++) {
            if (pass >= SETTLE_MAX_PASSES) {
                throw new Error(
                    `the scenario did not settle after ${SETTLE_MAX_PASSES} passes: ` +
                        "something re-arms work every pass — a play() reissued " +
                        "forever, a src that never sticks, or an effect loop",
                );
            }
            let worked = false;
            await act(async () => {
                // Plays first: a `play()` asked for during this pass must not also be
                // granted in it, or the transient-pause window would never be open.
                worked = letPlaysTake();
                worked = openStreams() || worked;
                await macrotask();
            });
            quiet = worked ? 0 : quiet + 1;
        }
    };

    const activeVideo = (): HTMLVideoElement => {
        const el = videos().find((video) =>
            video.classList.contains("is-active"),
        );
        if (!el) throw new Error("no active video surface is mounted");
        return el;
    };

    const button = (label: string): HTMLElement => {
        const el = document.querySelector<HTMLElement>(
            `button[aria-label="${label}"]`,
        );
        if (!el) throw new Error(`no button labelled "${label}" is on screen`);
        return el;
    };

    const sleepButtonEl = (): HTMLElement => {
        const el = document.querySelector<HTMLElement>("button.osd-btn.sleep");
        if (!el) throw new Error("the sleep button is not on screen");
        return el;
    };

    const click = async (label: string): Promise<void> => {
        const el = button(label);
        await act(async () => {
            withGesture(() => el.click());
            await macrotask();
        });
        await settle();
    };

    /**
     * Measured in the real app: `pause` fires immediately before `ended`, same
     * millisecond, with the element's `ended` **already true**
     * (docs/playback.md § "Two things Chromium does around `ended`"). Chromium
     * queues the two as separate tasks, so React flushes effects in between —
     * and that gap is where bug 1 lived. Hence its own `act`.
     */
    const pauseForEndOn = async (el: HTMLVideoElement): Promise<void> => {
        await act(async () => {
            const state = mediaState(el);
            state.ended = true;
            state.paused = true;
            el.dispatchEvent(new Event("pause"));
            await macrotask();
        });
    };

    /**
     * The `ended` event, and the store transition it starts — but *not* the
     * `play()` that follows a promotion. Stopping here leaves the stage in the
     * handoff window: the newly active element on screen, paused, `ended` false.
     */
    const endedOn = async (el: HTMLVideoElement): Promise<void> => {
        await act(async () => {
            el.dispatchEvent(new Event("ended"));
            await macrotask();
        });
        for (let pass = 0; pass < 3; pass++) {
            await act(async () => {
                await macrotask();
            });
        }
    };

    /**
     * Both, on the element that was on air when the episode started running out.
     * Resolving it once matters: a Player that mistakenly tears the screen down on
     * the `pause` still gets its `ended` — Chromium fires it either way — so the
     * failure reads as the wrong decision rather than as a missing surface.
     */
    const endEpisode = async (): Promise<void> => {
        const el = activeVideo();
        await pauseForEndOn(el);
        await endedOn(el);
        await settle();
    };

    await act(async () => {
        await useStore.getState().tune(CHANNEL_ID);
    });
    await settle();

    return {
        calls: bridge.calls,
        actions,
        state: () => useStore.getState(),
        settle,
        activeVideo,

        /**
         * Expiry is a `Date.now()` comparison against `sleepUntil` (store.ts), so a
         * deadline already in the past *is* the crossing — no fake timers needed.
         * The Player repaints `nowMs` the moment `sleepUntil` changes, which is the
         * same one-second tick that crosses the deadline in the real app.
         */
        expireSleep: async (minutes = 30) => {
            await act(async () => {
                useStore.setState({
                    sleepUntil: Date.now() - 1000,
                    sleepMinutes: minutes,
                });
                await macrotask();
            });
        },

        armSleep: async (minutes) => {
            await act(async () => {
                useStore.getState().armSleep(minutes);
                await macrotask();
            });
            await settle();
        },

        // The real action, not the instrumented one: `actions` records what the
        // *Player* chose, and a prewarm the harness asked for is not that.
        prewarm: async () => {
            await act(async () => {
                await REAL.prewarm();
            });
            await settle();
        },

        viewerPause: () => click("Pause"),
        viewerPlay: () => click("Play"),

        /**
         * Keystrokes go to `document.activeElement`, never to `window` directly, and
         * that is the whole point of having this in the harness. The player's map is
         * bound on `window` but ignores anything whose target sits inside a
         * `[role="slider"]`, so *what has focus* is what decides whether a key
         * reaches it — the sleep panel's arrows depend on exactly that, and a test
         * that fired at `window` would prove nothing about it.
         */
        press: async (key) => {
            const target = document.activeElement ?? document.body;
            // Esc in fullscreen is Chromium's, not ours: it leaves fullscreen and the
            // page never sees the keystroke (the Player's Esc map is written around
            // exactly this, which is why its first Esc only un-fullscreens). Modelled
            // here so a screen that quietly relies on receiving that key fails.
            if (key === "Escape" && document.fullscreenElement !== null) {
                await act(async () => {
                    await document.exitFullscreen();
                    await macrotask();
                });
                await settle();
                return;
            }
            await act(async () => {
                // A keystroke carries user activation, which is what lets <kbd>P</kbd>
                // open a fresh session at all.
                withGesture(() =>
                    target.dispatchEvent(
                        new KeyboardEvent("keydown", { key, bubbles: true }),
                    ),
                );
                await macrotask();
            });
            await settle();
        },

        // By class, not by label: the moon's `aria-label` changes with what is armed.
        clickSleep: async () => {
            const el = sleepButtonEl();
            await act(async () => {
                el.click();
                await macrotask();
            });
            await settle();
        },

        wheel: async (el, direction) => {
            await act(async () => {
                el.dispatchEvent(
                    new WheelEvent("wheel", {
                        deltaY: direction === "up" ? -100 : 100,
                        bubbles: true,
                    }),
                );
                await macrotask();
            });
            await settle();
        },

        sleepPanel: () => document.querySelector<HTMLElement>(".sleep-panel"),

        sleepButton: sleepButtonEl,

        // ---- picture-in-picture ----

        clickPip: () => click("Picture-in-picture"),

        pipSlot: () => {
            const el = pip.element();
            return el === null ? null : slotOf(el);
        },

        pipLog: () => [...pip.log],

        /**
         * Chromium gives us one event for both the ✕ and "back to tab", and no way
         * to tell them apart — so there is one way to fire it here too.
         */
        closePipWindow: async () => {
            const el = pip.element();
            if (!el) throw new Error("nothing is in picture-in-picture");
            await act(async () => {
                pip.close();
                firePip(el, "leavepictureinpicture");
                await macrotask();
            });
            await settle();
        },

        fullscreenTarget: () => {
            const el = document.fullscreenElement;
            if (el === null) return null;
            if (el === document.documentElement) return "root";
            return el.classList.contains("stage") ? "stage" : "other";
        },

        enterPipWithoutGesture: async () => {
            const el = activeVideo();
            await act(async () => {
                await el.requestPictureInPicture().catch(() => undefined);
                await macrotask();
            });
            await settle();
        },

        breakStream: async () => {
            const el = activeVideo();
            await act(async () => {
                el.dispatchEvent(new Event("error"));
                await macrotask();
            });
            await settle();
        },

        at: async (seconds) => {
            const el = activeVideo();
            await act(async () => {
                el.currentTime = seconds;
                el.dispatchEvent(new Event("timeupdate"));
                await macrotask();
            });
            await settle();
        },

        pauseForEnd: () => pauseForEndOn(activeVideo()),
        ended: () => endedOn(activeVideo()),
        endEpisode,

        // Unmounting is what clears the banner timeout and the countdown interval:
        // both are owned by effects, so nothing else has to know about them.
        unmount: async () => {
            await act(async () => {
                root.unmount();
            });
            container.remove();
        },
    };
}
