/**
 * The taskbar icon, on Wayland.
 *
 * `BrowserWindow`'s `icon` option is an X11 mechanism; a Wayland client cannot
 * hand the compositor an icon at all. KDE (and GNOME) instead resolve the
 * taskbar and titlebar icon by matching the window's `app_id` against an
 * installed `.desktop` entry. Electron derives our `app_id` from the package
 * name — `rerun-tv`, measured via KWin's scripting API — so all that is missing
 * is a `rerun-tv.desktop` for the compositor to find. Without one, Plasma shows
 * the generic Wayland "W".
 *
 * A packaged build would normally get this file from its installer; an AppImage
 * gets it only if the user runs an integration tool, and `npm run start` never
 * gets one. So, like the KWin picture-in-picture rule next door
 * (`kwin-rule.ts`), boot writes it: idempotently, rewriting only when the
 * content actually changed, and never fatally — a read-only home directory must
 * not stop the television from starting.
 *
 * The icon is referenced by absolute path rather than installed into the
 * hicolor theme: the theme route needs size-indexed directories and a cache
 * refresh to be picked up, while a path needs neither. The PNG is copied into
 * our own data directory first so the entry keeps working if the repo moves or
 * the AppImage is mounted somewhere new.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Electron's Wayland `app_id` for this app; the desktop file must carry this name. */
export const APP_ID = "rerun-tv";

export function applicationsDir(env: NodeJS.ProcessEnv = process.env): string {
    const dataHome = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(dataHome, "applications");
}

/**
 * Quote one argument for an `Exec=` line, per the Desktop Entry spec.
 *
 * Two separate escapes stack in that field and both bite real paths. `%` is a
 * field code introducer, so a literal one has to be doubled or the launcher
 * eats it and the character after it. Everything else is shell-ish quoting:
 * inside double quotes the spec reserves `"`, `$`, backtick and backslash, and
 * a path with a space in it is simply broken without the quotes at all.
 *
 * This matters because the value is a *path the user chose* — where they put
 * the AppImage, or where the repo lives.
 */
export function quoteExecArg(arg: string): string {
    const escaped = arg
        .replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"')
        .replaceAll("$", "\\$")
        .replaceAll("`", "\\`")
        .replaceAll("%", "%%");
    return `"${escaped}"`;
}

/**
 * The entry itself, pure so the shape is testable.
 *
 * `StartupWMClass` covers the XWayland case, where matching is by `WM_CLASS`
 * rather than `app_id` — same value either way. `exec` is the already-quoted
 * command line that launched us this boot (the AppImage, or the dev Electron
 * plus the repo), so the entry is honest enough to launch from, but its real
 * job is icon resolution.
 *
 * `iconPath` is deliberately *not* quoted. `Icon` is an "iconstring" in the
 * spec, not an exec string: only `Exec` (and `TryExec`) take shell quoting and
 * field codes, and a value there runs to the end of the line, so a path with a
 * space in it needs nothing. Quoting it would make the quotes part of the path
 * and the icon would silently fail to resolve.
 */
export function renderDesktopEntry(exec: string, iconPath: string): string {
    return [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Rerun TV",
        "Comment=Turn a local media library into lean-back TV channels",
        `Exec=${exec}`,
        `Icon=${iconPath}`,
        "Terminal=false",
        "Categories=AudioVideo;Video;",
        `StartupWMClass=${APP_ID}`,
        "",
    ].join("\n");
}

/**
 * Install (or refresh) `rerun-tv.desktop` and the icon it points at.
 *
 * @param iconSource where the bundled PNG lives this boot
 * @param iconDest   the stable copy the entry references, in our data dir
 * @param exec       the command line that reproduces this launch, already
 *                   quoted with `quoteExecArg` by the caller (it may be several
 *                   arguments, which is why this function cannot quote it)
 */
export function ensureDesktopEntry(
    iconSource: string,
    iconDest: string,
    exec: string,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    if (process.platform !== "linux") return false;

    try {
        copyFileSync(iconSource, iconDest);

        const dir = applicationsDir(env);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${APP_ID}.desktop`);

        const wanted = renderDesktopEntry(exec, iconDest);
        let existing = "";
        try {
            existing = readFileSync(path, "utf8");
        } catch {
            // No entry yet — first boot on this machine.
        }
        if (existing === wanted) return false;

        writeFileSync(path, wanted, "utf8");
        console.info(
            "[desktop] installed rerun-tv.desktop (taskbar icon on Wayland)",
        );
        return true;
    } catch (error) {
        console.warn("[desktop] could not install the desktop entry:", error);
        return false;
    }
}
