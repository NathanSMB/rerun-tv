/**
 * The picture-in-picture session controller (docs/ui.md, "Picture-in-picture").
 *
 * Everything here is the logic that cannot be tested anywhere else: happy-dom
 * has no PiP APIs, and the orderings that matter — a `leavepictureinpicture`
 * that is really a transfer, a swap that lands mid-request — are Chromium's, not
 * ours to produce in a browser test. So the machine is DOM-free and driven here
 * by the event orderings measured against the real Electron build.
 *
 * Two facts from that spike are what the whole design rests on, and they are
 * restated here because every case below is downstream of them:
 *
 * 1. A **fresh** entry needs a user gesture (`NotAllowedError` without one), but
 *    a **transfer** to another element while a session exists does not.
 * 2. A transfer fires `leavepictureinpicture` on the *old* element, between the
 *    two enters: `enter:a`, `leave:a`, `enter:b`.
 *
 * Together they produce the invariant the last describe block pins down: across
 * a handoff the machine must never emit `exit` before `transfer`. Exiting first
 * would close the session, and closing it takes the gesture-free window with it.
 */

import { describe, expect, it } from "vitest";
import {
    createPipMachine,
    floatingSlot,
    isFloating,
    PIP_IDLE,
    type PipCommand,
    type PipEvent,
    reducePip,
} from "../src/renderer/src/player/pip.js";

/** Run a script of events, returning every command the machine asked for. */
function run(events: PipEvent[]): {
    commands: PipCommand[];
    machine: ReturnType<typeof createPipMachine>;
} {
    const machine = createPipMachine();
    const commands: PipCommand[] = [];
    for (const event of events) {
        const command = machine.send(event);
        if (command) commands.push(command);
    }
    return { commands, machine };
}

/** The viewer pressing P with surface `slot` on air, and Chromium obliging. */
const opened = (slot = "a"): PipEvent[] => [
    { type: "toggle", slot },
    { type: "entered", slot },
];

describe("opening a session", () => {
    it("asks to enter on the surface that is on air", () => {
        const { commands, machine } = run(opened("a"));

        expect(commands).toEqual([{ type: "enter", slot: "a" }]);
        expect(isFloating(machine.state)).toBe(true);
        expect(floatingSlot(machine.state)).toBe("a");
    });

    it("counts as floating from the moment it is asked for, not when it resolves", () => {
        // The OSD button must light up on the press. The request is a round trip
        // through Chromium's window manager and takes long enough to see.
        const { machine } = run([{ type: "toggle", slot: "a" }]);

        expect(isFloating(machine.state)).toBe(true);
    });

    it("goes back to idle when the request is refused", () => {
        // What a gesture-less request answers with. Nothing to bring back inline —
        // the picture never left.
        const { commands, machine } = run([
            { type: "toggle", slot: "a" },
            { type: "failed" },
        ]);

        expect(commands).toEqual([{ type: "enter", slot: "a" }]);
        expect(isFloating(machine.state)).toBe(false);
    });

    it("ignores a second press while the first request is still in flight", () => {
        const { commands } = run([
            { type: "toggle", slot: "a" },
            { type: "toggle", slot: "a" },
            { type: "entered", slot: "a" },
        ]);

        // One request, not two. A double press is impatience, not a change of mind.
        expect(commands).toEqual([{ type: "enter", slot: "a" }]);
    });

    it("does nothing at a handoff when nothing is floating", () => {
        const { commands } = run([
            { type: "swapped", slot: "b" },
            { type: "left", slot: "a" },
        ]);

        expect(commands).toEqual([]);
    });
});

describe("the handoff", () => {
    it("transfers the session to the promoted surface", () => {
        const { commands, machine } = run([
            ...opened("a"),
            { type: "swapped", slot: "b" },
            // The measured artifact: the old element reports it lost the window.
            { type: "left", slot: "a" },
            { type: "entered", slot: "b" },
        ]);

        expect(commands).toEqual([
            { type: "enter", slot: "a" },
            { type: "transfer", slot: "b" },
        ]);
        // Crucially *not* `returnInline`: the floating window never blinked.
        expect(isFloating(machine.state)).toBe(true);
        expect(floatingSlot(machine.state)).toBe("b");
    });

    it("swallows the transfer’s leave event whichever order it arrives in", () => {
        // Chromium was measured resolving the transfer *after* the old element's
        // leave event — the ordering the case above covers. Nothing in the spec
        // fixes that, so the reverse must be survivable too: here the late `left`
        // lands after `b` is already active, and is stale rather than a close.
        const { commands, machine } = run([
            ...opened("a"),
            { type: "swapped", slot: "b" },
            { type: "entered", slot: "b" },
            { type: "left", slot: "a" },
        ]);

        expect(commands).toEqual([
            { type: "enter", slot: "a" },
            { type: "transfer", slot: "b" },
        ]);
        // Still floating. A slot that is not showing the picture cannot lose it.
        expect(isFloating(machine.state)).toBe(true);
        expect(floatingSlot(machine.state)).toBe("b");
    });

    it("does not move a session that is already on the promoted surface", () => {
        const { commands } = run([
            ...opened("b"),
            { type: "swapped", slot: "b" },
        ]);

        expect(commands).toEqual([{ type: "enter", slot: "b" }]);
    });

    it("stays on the old surface when the transfer is refused", () => {
        // The old session is still up — the request failed before anything moved.
        const { commands, machine } = run([
            ...opened("a"),
            { type: "swapped", slot: "b" },
            { type: "failed" },
        ]);

        expect(commands).toEqual([
            { type: "enter", slot: "a" },
            { type: "transfer", slot: "b" },
        ]);
        expect(floatingSlot(machine.state)).toBe("a");
    });

    it("brings the picture home when the transfer loses the session as well", () => {
        const { commands, machine } = run([
            ...opened("a"),
            { type: "swapped", slot: "b" },
            { type: "left", slot: "a" },
            { type: "failed" },
        ]);

        // The old window is gone and the new one never opened: this is the only
        // failure that leaves the viewer with no picture anywhere, so it is the only
        // one that returns it inline.
        expect(commands.at(-1)).toEqual({ type: "returnInline" });
        expect(isFloating(machine.state)).toBe(false);
    });

    it("honours a swap that lands while a request is in flight", () => {
        // Pressing P at the exact moment an episode ends: the entry is for `a`, but
        // by the time it resolves `b` is on air.
        const { commands, machine } = run([
            { type: "toggle", slot: "a" },
            { type: "swapped", slot: "b" },
            { type: "entered", slot: "a" },
            { type: "left", slot: "a" },
            { type: "entered", slot: "b" },
        ]);

        expect(commands).toEqual([
            { type: "enter", slot: "a" },
            { type: "transfer", slot: "b" },
        ]);
        expect(floatingSlot(machine.state)).toBe("b");
    });

    it("collapses a swap that lands back on the slot already being requested", () => {
        const { commands } = run([
            ...opened("a"),
            { type: "swapped", slot: "b" },
            { type: "swapped", slot: "b" },
            { type: "entered", slot: "b" },
        ]);

        expect(commands).toEqual([
            { type: "enter", slot: "a" },
            { type: "transfer", slot: "b" },
        ]);
    });

    it("carries the session through a marathon of handoffs", () => {
        const machine = createPipMachine();
        machine.send({ type: "toggle", slot: "a" });
        machine.send({ type: "entered", slot: "a" });

        let from = "a";
        for (let handoff = 0; handoff < 6; handoff++) {
            const to = from === "a" ? "b" : "a";
            const command = machine.send({ type: "swapped", slot: to });
            expect(command).toEqual({ type: "transfer", slot: to });
            machine.send({ type: "left", slot: from });
            machine.send({ type: "entered", slot: to });
            expect(floatingSlot(machine.state)).toBe(to);
            from = to;
        }

        expect(isFloating(machine.state)).toBe(true);
    });
});

describe("closing", () => {
    it("exits on a second press, and returns the picture inline when it confirms", () => {
        const { commands, machine } = run([
            ...opened("a"),
            { type: "toggle", slot: "a" },
            { type: "left", slot: "a" },
        ]);

        expect(commands).toEqual([
            { type: "enter", slot: "a" },
            { type: "exit" },
            { type: "returnInline" },
        ]);
        expect(isFloating(machine.state)).toBe(false);
    });

    it("treats the window’s own ✕ exactly like the OSD button", () => {
        // Chromium does not say which of ✕ and "back to tab" fired the event, so
        // there is one rule for both — and it is the same rule as pressing P.
        const { commands, machine } = run([
            ...opened("a"),
            { type: "left", slot: "a" },
        ]);

        expect(commands).toEqual([
            { type: "enter", slot: "a" },
            { type: "returnInline" },
        ]);
        expect(isFloating(machine.state)).toBe(false);
    });

    it("recovers if the exit is never confirmed", () => {
        // A window torn down by the OS may leave the confirming event unfired. The
        // next press must still open a session rather than finding a stuck machine.
        const { commands } = run([
            ...opened("a"),
            { type: "toggle", slot: "a" },
            { type: "toggle", slot: "a" },
        ]);

        expect(commands).toEqual([
            { type: "enter", slot: "a" },
            { type: "exit" },
            { type: "enter", slot: "a" },
        ]);
    });
});

describe("teardown", () => {
    it("closes a live session without steering navigation back to the player", () => {
        // The sleep timer's blackout, and leaving the player. A floating window is a
        // light source too, so it goes — but `returnInline` here would fight the
        // navigation that is already happening.
        const { commands, machine } = run([
            ...opened("a"),
            { type: "teardown" },
        ]);

        expect(commands).toEqual([
            { type: "enter", slot: "a" },
            { type: "exit" },
        ]);
        expect(isFloating(machine.state)).toBe(false);
    });

    it("closes a session that is still opening", () => {
        const { commands } = run([
            { type: "toggle", slot: "a" },
            { type: "teardown" },
        ]);

        expect(commands).toEqual([
            { type: "enter", slot: "a" },
            { type: "exit" },
        ]);
    });

    it("asks for nothing when there was no session", () => {
        const { commands } = run([{ type: "teardown" }]);

        expect(commands).toEqual([]);
    });

    it("swallows the leave event that follows it", () => {
        const { commands } = run([
            ...opened("a"),
            { type: "teardown" },
            { type: "left", slot: "a" },
        ]);

        // No `returnInline`. The player is going dark; nothing is coming back.
        expect(commands).toEqual([
            { type: "enter", slot: "a" },
            { type: "exit" },
        ]);
    });

    it("exits at most once however many times it is asked", () => {
        const { commands } = run([
            ...opened("a"),
            { type: "teardown" },
            { type: "teardown" },
            { type: "teardown" },
        ]);

        expect(
            commands.filter((command) => command.type === "exit"),
        ).toHaveLength(1);
    });
});

/**
 * The invariant, checked by exhaustion rather than by example.
 *
 * Every event sequence up to a bounded length is run through the machine, and
 * the property asserted over all of them: between a `swapped` and the transfer
 * it produces, the machine never asks to exit. There is no sequence — however
 * the events interleave — where a handoff throws the session away and then tries
 * to open a fresh one, because a fresh one would need a gesture nobody made.
 */
describe("the ordering invariant", () => {
    const ALPHABET: PipEvent[] = [
        { type: "toggle", slot: "a" },
        { type: "toggle", slot: "b" },
        { type: "swapped", slot: "a" },
        { type: "swapped", slot: "b" },
        { type: "entered", slot: "a" },
        { type: "entered", slot: "b" },
        { type: "failed" },
        { type: "left", slot: "a" },
        { type: "left", slot: "b" },
    ];

    /** Every sequence of `length` events, as a generator so nothing is held. */
    function* sequences(length: number): Generator<PipEvent[]> {
        if (length === 0) {
            yield [];
            return;
        }
        for (const head of ALPHABET) {
            for (const tail of sequences(length - 1)) yield [head, ...tail];
        }
    }

    it("never exits in response to a handoff", () => {
        let checked = 0;
        for (const sequence of sequences(4)) {
            let state = PIP_IDLE;
            for (const event of sequence) {
                const next = reducePip(state, event);
                if (event.type === "swapped" && next.command?.type === "exit") {
                    throw new Error(
                        `a swap asked to exit: ${JSON.stringify(sequence)}`,
                    );
                }
                state = next.state;
            }
            checked += 1;
        }
        // 9^4 — the whole space at that length, not a sample.
        expect(checked).toBe(ALPHABET.length ** 4);
    });

    it("only ever exits in response to a press or a teardown", () => {
        for (const sequence of sequences(3)) {
            let state = PIP_IDLE;
            for (const event of sequence) {
                const next = reducePip(state, event);
                if (next.command?.type === "exit") {
                    expect(["toggle", "teardown"]).toContain(event.type);
                }
                state = next.state;
            }
        }
    });

    /**
     * The other half: a command that needs a gesture may only be produced by an
     * event that carries one. `enter` is legal from `toggle` alone — every other
     * way of putting the picture back must go through `transfer`, which needs no
     * activation because a session is already live.
     */
    it("only ever asks for a gesture-requiring entry on a press", () => {
        for (const sequence of sequences(3)) {
            let state = PIP_IDLE;
            for (const event of sequence) {
                const next = reducePip(state, event);
                if (next.command?.type === "enter")
                    expect(event.type).toBe("toggle");
                state = next.state;
            }
        }
    });
});
