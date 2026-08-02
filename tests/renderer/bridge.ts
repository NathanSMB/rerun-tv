/**
 * The fake preload bridge, and the one type-check that keeps it honest.
 *
 * Every renderer test mounts a real screen against a fake `window.rerun`, and
 * each of them used to build that fake as a single object literal ending in
 * `as unknown as RerunApi`. That cast is total: it silences the missing methods
 * (which is the point) *and* the wrong ones (which is not). Four bridges had
 * quietly drifted off `src/shared/ipc.ts` under it — a `channels.update` that
 * answered with a `ChannelDetail` where the contract says `Channel`, event
 * subscriptions returning nothing where the contract promises an unsubscribe, a
 * `system.getInfo` resolving to `{}`. Each is a shape the real main process
 * cannot produce, so each is a test agreeing with a lie.
 *
 * `makeBridge` narrows the cast to one place. Callers hand it a *partial* object
 * per namespace, typed as `Partial<RerunApi[ns]>`, so every method they do write
 * is checked against the contract — arguments and return type both — while the
 * ones a given screen never touches can be left out. Those get filled in with a
 * thrower that names itself, which is strictly better than the `undefined is not
 * a function` the old casts produced.
 *
 * The method roll-call comes from `IPC`, so a method added to the contract is
 * one a stale fake stops silently lacking.
 */

import { IPC, type RerunApi } from "@shared/ipc.js";
import type { SystemInfo } from "@shared/types.js";

/** What a caller may supply: any subset of any namespace, each still typed. */
export type BridgeSpec = {
    [K in keyof RerunApi]?: Partial<RerunApi[K]>;
};

const NAMESPACES = [
    "library",
    "channels",
    "player",
    "settings",
    "system",
    "events",
] as const satisfies readonly (keyof RerunApi)[];

/** `events` has no `invoke` channels, so its roll-call is written out. */
const EVENT_METHODS = [
    "onScanProgress",
    "onLibraryChanged",
    "onChannelsChanged",
] as const satisfies readonly (keyof RerunApi["events"])[];

/**
 * The roll-call is only trustworthy while it is *complete*: a method a caller
 * supplies but the roll-call does not name would be dropped on the floor here
 * and replaced by nothing, which is the silent failure this whole file exists to
 * remove. `IPC` and `RerunApi` are hand-kept in step, so this pins that — a
 * contract method with no channel behind it stops `npm run typecheck`, here,
 * rather than turning into a mystery `undefined` in one renderer test.
 *
 * `Uncovered` collects exactly the method names `IPC` is missing, so the
 * assertion is that it is empty. `Assert`'s `extends true` constraint is what
 * makes that an error rather than a quietly-`false` type; the alias is exported
 * only because an unused local type is itself an error.
 */
type Assert<T extends true> = T;
type Uncovered = {
    [K in keyof typeof IPC]: Exclude<keyof RerunApi[K], keyof (typeof IPC)[K]>;
}[keyof typeof IPC];
export type EveryMethodHasAChannel = Assert<
    [Uncovered] extends [never] ? true : false
>;

function methodNames(namespace: keyof RerunApi): string[] {
    return namespace === "events"
        ? [...EVENT_METHODS]
        : Object.keys(IPC[namespace]);
}

/**
 * A stand-in for a method this fixture never taught. It throws rather than
 * resolving to a plausible-looking empty value: a screen that reaches a part of
 * the bridge the test did not think about should fail in that test, not quietly
 * render as though the library were empty.
 */
function unimplemented(name: string): () => never {
    return () => {
        throw new Error(
            `the fake bridge has no ${name}() — the code under test reached ` +
                `further than this fixture goes. Add it to the makeBridge() spec.`,
        );
    };
}

/** Assemble a complete `RerunApi` from whichever methods the test cares about. */
export function makeBridge(spec: BridgeSpec): RerunApi {
    const api: Record<string, Record<string, unknown>> = {};
    for (const namespace of NAMESPACES) {
        const provided = (spec[namespace] ?? {}) as Record<string, unknown>;
        const filled: Record<string, unknown> = {};
        for (const name of methodNames(namespace)) {
            filled[name] =
                provided[name] ?? unimplemented(`${namespace}.${name}`);
        }
        api[namespace] = filled;
    }
    // The only cast in the file, and it is over an object whose every member was
    // checked against `RerunApi` on the way in.
    return api as unknown as RerunApi;
}

/**
 * Event subscriptions that record nothing and unsubscribe cleanly.
 *
 * The contract's `on*` methods return an unsubscribe function; a fake returning
 * `undefined` is a bug waiting for the first caller that keeps the handle.
 */
export const inertEvents: RerunApi["events"] = {
    onScanProgress: () => () => undefined,
    onLibraryChanged: () => () => undefined,
    onChannelsChanged: () => () => undefined,
};

/**
 * A plausible `SystemInfo` — a working machine with both encoders present.
 *
 * `patch` is how a test says the one thing it is about ("suppose the probe found
 * no VAAPI") without restating a dozen fields that have nothing to do with it.
 */
export function systemInfo(patch: Partial<SystemInfo> = {}): SystemInfo {
    return {
        appVersion: "0.1.0",
        ffmpegPath: "/usr/bin/ffmpeg",
        ffprobePath: "/usr/bin/ffprobe",
        ffmpegVersion: "n8.1.2",
        ffmpegSource: "system",
        codecCheck: "ok",
        hwAccel: {
            vaapi: "ok",
            nvenc: "ok",
            vaapiDevice: "/dev/dri/renderD129",
        },
        dbPath: "/tmp/library.db",
        dbSizeBytes: 1024,
        streamPort: 9,
        lastRestore: null,
        ...patch,
    };
}
