/**
 * A stand-in for the `electron` module, aliased in by `vitest.config.ts`.
 *
 * This exists so `src/main/ipc/handlers.ts` — the file every other subsystem is
 * reached *through*, and the one place a wiring mistake is invisible to every
 * other suite — can be exercised for real in Node. Electron is a genuine process
 * boundary, the same class of thing as the preload bridge that
 * `tests/renderer/bridge.ts` fakes; nothing inside our own code is replaced.
 *
 * The rule that keeps this honest: anything a handler calls on Electron either
 * records what it was asked to do (`ipcMain`, `BrowserWindow`) or throws loudly
 * (`dialog`). A silently plausible return value here would let a test pass while
 * the real app showed the user a dialog that never opened.
 */

/** One registered `ipcMain.handle` channel. */
type Handler = (event: unknown, ...args: unknown[]) => unknown;

const handlers = new Map<string, Handler>();

/** Everything `broadcast()` sent, in order — the push-event assertions read this. */
export const sentEvents: { channel: string; payload: unknown }[] = [];

export const ipcMain = {
    handle(channel: string, fn: Handler): void {
        if (handlers.has(channel)) {
            throw new Error(`duplicate ipcMain.handle for ${channel}`);
        }
        handlers.set(channel, fn);
    },
    removeHandler(channel: string): void {
        handlers.delete(channel);
    },
};

const fakeWindow = {
    webContents: {
        send(channel: string, payload: unknown): void {
            sentEvents.push({ channel, payload });
        },
    },
};

export const BrowserWindow = {
    getAllWindows: () => [fakeWindow],
};

function refuse(name: string): () => never {
    return () => {
        throw new Error(
            `${name} is not available in tests — a handler reached for a native ` +
                `dialog. Drive it through the ctx seam instead, or assert it isn't called.`,
        );
    };
}

export const dialog = {
    showOpenDialog: refuse("dialog.showOpenDialog"),
    showSaveDialog: refuse("dialog.showSaveDialog"),
    showMessageBox: refuse("dialog.showMessageBox"),
};

export const app = {
    getPath: (name: string) => `/tmp/rerun-test/${name}`,
    getVersion: () => "0.0.0-test",
    quit: refuse("app.quit"),
    relaunch: refuse("app.relaunch"),
};

export const shell = {
    openExternal: refuse("shell.openExternal"),
};

// ---------------------------------------------------------------------------
// Test-side controls
// ---------------------------------------------------------------------------

/**
 * Invoke a registered handler the way the preload bridge would, including the
 * error rewrapping — so a test sees exactly what the renderer would see.
 */
export async function invoke(channel: string, ...args: unknown[]) {
    const fn = handlers.get(channel);
    if (!fn) {
        throw new Error(
            `no handler registered for ${channel} — registerHandlers() did not ` +
                `cover it, which is the bug this suite exists to catch`,
        );
    }
    return await fn({}, ...args);
}

/** Every channel `registerHandlers` registered. */
export function registeredChannels(): string[] {
    return [...handlers.keys()];
}

export function resetElectronStub(): void {
    handlers.clear();
    sentEvents.length = 0;
}
