/**
 * The Wayland desktop entry (docs/ui.md).
 *
 * Same risk class as the KWin rule next door, and the same reason for a suite:
 * this writes a file into `~/.local/share/applications`, a directory that holds
 * the user's own launchers. A bug here either clobbers something that isn't
 * ours or leaves a malformed `.desktop` the whole session's menu has to skip.
 *
 * The `Exec=` quoting has its own group. It is the one part of the file built
 * from paths the *user* chose — where they put the AppImage, where the repo
 * lives — and the Desktop Entry spec stacks two escapes in that field, so it is
 * exactly the sort of thing that works on the author's machine forever.
 */

import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    APP_ID,
    applicationsDir,
    ensureDesktopEntry,
    quoteExecArg,
    renderDesktopEntry,
} from "@main/desktop-entry.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let iconSource: string;
let iconDest: string;
let env: NodeJS.ProcessEnv;

/** The path the entry is written to, given this test's fake XDG data home. */
function entryPath(): string {
    return join(applicationsDir(env), `${APP_ID}.desktop`);
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rerun-desktop-"));
    env = { XDG_DATA_HOME: join(dir, "data") };
    iconSource = join(dir, "icon.png");
    iconDest = join(dir, "data", "icon.png");
    writeFileSync(iconSource, "not really a png");
    mkdirSync(join(dir, "data"), { recursive: true });
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe("quoteExecArg", () => {
    it("quotes a path with spaces, which is the common case", () => {
        expect(quoteExecArg("/home/nathan/My Apps/Rerun TV.AppImage")).toBe(
            '"/home/nathan/My Apps/Rerun TV.AppImage"',
        );
    });

    /**
     * `%` introduces a field code (`%f`, `%U`…). An unescaped one in a path means
     * the launcher swallows it *and the character after it* — a directory called
     * `100%recall` would launch `…/100ecall`.
     */
    it("doubles a percent so it isn't read as a field code", () => {
        expect(quoteExecArg("/tv/100%recall/app")).toBe(
            '"/tv/100%%recall/app"',
        );
    });

    it("escapes the characters the spec reserves inside quotes", () => {
        expect(quoteExecArg('/a"b')).toBe('"/a\\"b"');
        expect(quoteExecArg("/a$b")).toBe('"/a\\$b"');
        expect(quoteExecArg("/a`b")).toBe('"/a\\`b"');
        expect(quoteExecArg("/a\\b")).toBe('"/a\\\\b"');
    });

    it("leaves an ordinary path alone but for the quotes", () => {
        expect(quoteExecArg("/usr/bin/rerun-tv")).toBe('"/usr/bin/rerun-tv"');
    });
});

describe("renderDesktopEntry", () => {
    it("carries the app_id as StartupWMClass, which is what resolves the icon", () => {
        const entry = renderDesktopEntry('"/opt/rerun"', "/data/icon.png");
        expect(entry).toContain(`StartupWMClass=${APP_ID}`);
        expect(entry).toContain("Type=Application");
        expect(entry).toContain('Exec="/opt/rerun"');
    });

    /**
     * `Icon` is an *iconstring*, not an exec string: no shell quoting, no field
     * codes, and the value runs to the end of the line — so a path with a space
     * needs nothing, and quoting it would make the quotes part of the path.
     */
    it("leaves the icon path unquoted, even with a space in it", () => {
        const entry = renderDesktopEntry(
            '"/opt/rerun"',
            "/data/my icons/i.png",
        );
        expect(entry).toContain("Icon=/data/my icons/i.png\n");
    });

    it("ends with a newline, as a well-formed entry must", () => {
        expect(renderDesktopEntry('"/x"', "/y").endsWith("\n")).toBe(true);
    });
});

// ensureDesktopEntry refuses to act off Linux, so this suite only means
// anything there.
const describeLinux = describe.runIf(process.platform === "linux");

describeLinux("ensureDesktopEntry", () => {
    it("writes the entry and copies the icon on first boot", () => {
        const wrote = ensureDesktopEntry(
            iconSource,
            iconDest,
            '"/opt/rerun"',
            env,
        );

        expect(wrote).toBe(true);
        expect(readFileSync(entryPath(), "utf8")).toContain("Name=Rerun TV");
        expect(readFileSync(iconDest, "utf8")).toBe("not really a png");
    });

    /**
     * The idempotence that lets this run on every boot: an unchanged entry must
     * not be rewritten, or every launch dirties a file the desktop watches.
     */
    it("does not rewrite an identical entry", () => {
        ensureDesktopEntry(iconSource, iconDest, '"/opt/rerun"', env);
        const again = ensureDesktopEntry(
            iconSource,
            iconDest,
            '"/opt/rerun"',
            env,
        );
        expect(again).toBe(false);
    });

    it("rewrites when the launch command changed — a moved AppImage", () => {
        ensureDesktopEntry(iconSource, iconDest, '"/opt/rerun"', env);
        const moved = ensureDesktopEntry(
            iconSource,
            iconDest,
            '"/home/nathan/Apps/rerun"',
            env,
        );

        expect(moved).toBe(true);
        expect(readFileSync(entryPath(), "utf8")).toContain(
            'Exec="/home/nathan/Apps/rerun"',
        );
    });

    /**
     * The principle from `kwin-rule.ts`, restated: a nicety layered on a nicety
     * must not stop the television. A read-only or missing home is a warning,
     * never a throw.
     */
    it("never throws when the icon source is gone", () => {
        expect(() =>
            ensureDesktopEntry(
                join(dir, "no-such-icon.png"),
                iconDest,
                '"/opt/rerun"',
                env,
            ),
        ).not.toThrow();
    });

    it("never throws when the data directory cannot be created", () => {
        // A file where the directory needs to be — mkdir fails, and that is fine.
        const blocked = join(dir, "blocked");
        writeFileSync(blocked, "");
        expect(() =>
            ensureDesktopEntry(iconSource, iconDest, '"/opt/rerun"', {
                XDG_DATA_HOME: blocked,
            }),
        ).not.toThrow();
    });

    it("respects XDG_DATA_HOME rather than assuming ~/.local/share", () => {
        ensureDesktopEntry(iconSource, iconDest, '"/opt/rerun"', env);
        expect(entryPath()).toContain(join(dir, "data", "applications"));
    });
});
