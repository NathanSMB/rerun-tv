/**
 * Small helpers shared by more than one screen.
 *
 * Deliberately tiny and deliberately here: each of these was written three or
 * four times across `Guide`, `Library`, `Settings` and `ChannelFold` before it
 * moved, and three copies of "how do we word a plural" is how two of them end
 * up disagreeing. Anything with an opinion about *layout* belongs in a
 * component; this file is only for text and control flow.
 */

import { useCallback, useState } from "react";

/** The message out of an unknown throw — what every catch in the UI wants. */
export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** `1 episode` / `4 episodes`. */
export function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export interface BusyAction {
    /** The key of the action in flight, or null. Drives `disabled` on controls. */
    busy: string | null;
    /** The last failure, cleared when the next action starts. */
    error: string | null;
    /**
     * Run one async mutation under `key`: locks, clears the previous error, and
     * reports a failure rather than letting it escape as an unhandled rejection.
     * Never throws — the error lands in `error`, which the caller renders.
     */
    run(key: string, fn: () => Promise<void>): Promise<void>;
    setError(message: string | null): void;
}

/**
 * The busy-lock every mutating screen needs.
 *
 * Screens call the bridge directly for their own mutations (see the store's
 * header for why), which means each of them needs the same three things around
 * the call: a lock so the control can't be double-fired, a cleared error, and a
 * visible message when it fails. Written out by hand this was ~15 lines in
 * every screen, and the copies had already drifted on whether the error clears
 * on the next attempt.
 */
export function useBusyAction(): BusyAction {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const run = useCallback(
        async (key: string, fn: () => Promise<void>): Promise<void> => {
            setBusy(key);
            setError(null);
            try {
                await fn();
            } catch (err) {
                setError(errorText(err));
            } finally {
                setBusy(null);
            }
        },
        [],
    );

    return { busy, error, run, setError };
}
