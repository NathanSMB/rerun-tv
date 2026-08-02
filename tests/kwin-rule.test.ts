/**
 * The KWin window rule (docs/ui.md).
 *
 * Getting the floating window above a *full-screen* window needs KWin's overlay
 * layer, which no client can request for itself — so the app writes a window
 * rule, and that means editing `~/.config/kwinrulesrc`: a file that belongs to
 * KDE and holds rules the viewer wrote by hand.
 *
 * Which is the whole reason for this suite. The feature is a nicety; losing
 * somebody's window rules is not, and "we rewrote your config" is the kind of
 * bug that is discovered weeks later when a window misbehaves. So every case
 * below is a variation on *leave everything else exactly as it was*.
 */

import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    applyPipRule,
    ensureKwinPipRule,
    isKwinSession,
    PIP_RULE_ID,
    syncKwinPipRule,
} from "@main/kwin-rule.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** A real file, from a real session: the viewer's own rule for another browser. */
const EXISTING = `[9c4473ff-befd-4196-ba10-6af4fa403962]
Description=Window settings for zen
above=true
aboverule=3
layer=overlay
layerrule=2
title=Picture-in-Picture
titlematch=1
types=1
wmclass=zen
wmclassmatch=1

[General]
count=1
rules=9c4473ff-befd-4196-ba10-6af4fa403962
`;

/** The value of `key` inside `[group]`, or null. */
function read(ini: string, group: string, key: string): string | null {
    const section = ini
        .split(/^\[/m)
        .find((chunk) => chunk.startsWith(`${group}]`));
    if (!section) return null;
    const match = new RegExp(`^${key}=(.*)$`, "m").exec(section);
    return match ? match[1] : null;
}

describe("adding the rule", () => {
    it("forces the overlay layer for the floating window", () => {
        const result = applyPipRule(EXISTING, true);

        // Force → Overlay: the pair KDE's own editor writes, and the only thing that
        // outranks a full-screen window.
        expect(read(result, PIP_RULE_ID, "layer")).toBe("overlay");
        expect(read(result, PIP_RULE_ID, "layerrule")).toBe("2");
        // Matched by title, because Chromium's PiP window carries no WM_CLASS and no
        // window role — measured. `wmclassmatch` is absent, which is this file's way
        // of saying "window class: unimportant".
        expect(read(result, PIP_RULE_ID, "title")).toBe("Picture in picture");
        expect(read(result, PIP_RULE_ID, "titlematch")).toBe("1");
        expect(result).not.toContain("wmclassmatch=1\nlayer");
    });

    it("leaves the viewer’s own rules untouched", () => {
        const result = applyPipRule(EXISTING, true);

        // Byte-for-byte, including the keys we have no opinion about.
        expect(result).toContain("Description=Window settings for zen");
        expect(result).toContain("wmclass=zen");
        expect(
            read(result, "9c4473ff-befd-4196-ba10-6af4fa403962", "aboverule"),
        ).toBe("3");
        expect(
            read(result, "9c4473ff-befd-4196-ba10-6af4fa403962", "title"),
        ).toBe("Picture-in-Picture");
    });

    it("registers the rule in the index, which is what makes KWin read it", () => {
        const result = applyPipRule(EXISTING, true);

        // A group KWin cannot find in `rules=` is a group it ignores, however
        // correct the group itself is.
        expect(read(result, "General", "count")).toBe("2");
        expect(read(result, "General", "rules")).toBe(
            `9c4473ff-befd-4196-ba10-6af4fa403962,${PIP_RULE_ID}`,
        );
    });

    it("writes a usable file when there were no rules at all", () => {
        const result = applyPipRule("", true);

        expect(read(result, "General", "count")).toBe("1");
        expect(read(result, "General", "rules")).toBe(PIP_RULE_ID);
        expect(read(result, PIP_RULE_ID, "layer")).toBe("overlay");
    });

    it("is idempotent — the rule is never installed twice", () => {
        const once = applyPipRule(EXISTING, true);
        const twice = applyPipRule(once, true);
        const thrice = applyPipRule(twice, true);

        expect(twice).toBe(once);
        expect(thrice).toBe(once);
        expect(once.match(new RegExp(PIP_RULE_ID, "g"))).toHaveLength(2); // the group, and the index
    });

    it("rewrites a rule the viewer has edited, rather than adding a second one", () => {
        const edited = applyPipRule(EXISTING, true).replace(
            "layer=overlay",
            "layer=above",
        );

        const result = applyPipRule(edited, true);

        expect(read(result, PIP_RULE_ID, "layer")).toBe("overlay");
        expect(read(result, "General", "count")).toBe("2");
    });
});

describe("removing the rule", () => {
    it("takes ours away and nothing else", () => {
        const withRule = applyPipRule(EXISTING, true);

        const result = applyPipRule(withRule, false);

        expect(result).not.toContain(PIP_RULE_ID);
        expect(result).toContain("Description=Window settings for zen");
        expect(read(result, "General", "count")).toBe("1");
        expect(read(result, "General", "rules")).toBe(
            "9c4473ff-befd-4196-ba10-6af4fa403962",
        );
    });

    it("round-trips: on, off, and the file is what it started as", () => {
        // The strongest form of "we did not disturb anything".
        const result = applyPipRule(applyPipRule(EXISTING, true), false);

        expect(result.trim()).toBe(EXISTING.trim());
    });

    it("empties a file that held nothing but our rule", () => {
        const only = applyPipRule("", true);

        // An orphaned `[General] count=0` would be litter in someone else's config.
        expect(applyPipRule(only, false)).toBe("");
    });

    it("does nothing to a file that never had it", () => {
        expect(applyPipRule(EXISTING, false).trim()).toBe(EXISTING.trim());
    });
});

describe("knowing when to keep out of it", () => {
    it("is KDE-only — nobody else has this file or this concept", () => {
        expect(
            isKwinSession({ XDG_CURRENT_DESKTOP: "KDE" } as NodeJS.ProcessEnv),
        ).toBe(true);
        expect(
            isKwinSession({
                XDG_CURRENT_DESKTOP: "plasma",
            } as NodeJS.ProcessEnv),
        ).toBe(true);
        expect(
            isKwinSession({ XDG_SESSION_DESKTOP: "KDE" } as NodeJS.ProcessEnv),
        ).toBe(true);
        expect(
            isKwinSession({
                XDG_CURRENT_DESKTOP: "GNOME",
            } as NodeJS.ProcessEnv),
        ).toBe(false);
        expect(
            isKwinSession({ XDG_CURRENT_DESKTOP: "sway" } as NodeJS.ProcessEnv),
        ).toBe(false);
        expect(isKwinSession({} as NodeJS.ProcessEnv)).toBe(false);
    });
});

/**
 * Installing it for real, which is the part that changed.
 *
 * The rule used to follow a setting, and a Wayland session only got it after the
 * app relaunched itself onto XWayland. Now it is written on every boot, on
 * whichever window system the session happens to run — because the compositor
 * enforces the rule, so nothing about it depends on the protocol we spoke to get
 * a window. These cases pin exactly that.
 */
describe("installing it at boot", () => {
    const KDE_WAYLAND = {
        XDG_CURRENT_DESKTOP: "KDE",
        XDG_SESSION_TYPE: "wayland",
    };
    const KDE_X11 = { XDG_CURRENT_DESKTOP: "KDE", XDG_SESSION_TYPE: "x11" };

    let dir: string;
    let path: string;
    /**
     * Every call below hands in this instead of the default notifier, which
     * shells out to `dbus-send --dest=org.kde.KWin ... reconfigure`. Left to the
     * default, `npm test` would reconfigure the compositor of whoever ran it —
     * a test suite reaching out of its sandbox and poking the desktop — or, on a
     * machine without a session bus, spawn a process per test only to fail.
     */
    let reconfigured: number;
    const notify = () => {
        reconfigured += 1;
    };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "rerun-kwin-"));
        path = join(dir, "kwinrulesrc");
        reconfigured = 0;
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("installs on a Wayland session, where no client could ask for this itself", () => {
        expect(
            ensureKwinPipRule(path, KDE_WAYLAND as NodeJS.ProcessEnv, notify),
        ).toBe(true);

        const written = readFileSync(path, "utf8");
        expect(read(written, PIP_RULE_ID, "layer")).toBe("overlay");
        expect(read(written, "General", "rules")).toBe(PIP_RULE_ID);
    });

    it("installs the identical rule on an X11 session", () => {
        const onX11 = join(dir, "x11-session");
        const onWayland = join(dir, "wayland-session");

        expect(
            ensureKwinPipRule(onX11, KDE_X11 as NodeJS.ProcessEnv, notify),
        ).toBe(true);
        ensureKwinPipRule(onWayland, KDE_WAYLAND as NodeJS.ProcessEnv, notify);

        // The window system never enters into it: the rule is the compositor's.
        expect(readFileSync(onX11, "utf8")).toBe(
            readFileSync(onWayland, "utf8"),
        );
    });

    it("reports no change on the second boot, so KWin is left alone", () => {
        expect(
            ensureKwinPipRule(path, KDE_X11 as NodeJS.ProcessEnv, notify),
        ).toBe(true);
        expect(
            ensureKwinPipRule(path, KDE_X11 as NodeJS.ProcessEnv, notify),
        ).toBe(false);
    });

    it("keeps the viewer’s rules when it adds ours", () => {
        writeFileSync(path, EXISTING, "utf8");

        ensureKwinPipRule(path, KDE_WAYLAND as NodeJS.ProcessEnv, notify);

        const written = readFileSync(path, "utf8");
        expect(written).toContain("Description=Window settings for zen");
        expect(read(written, "General", "count")).toBe("2");
    });

    it("writes nothing at all off KDE", () => {
        const env = {
            XDG_CURRENT_DESKTOP: "GNOME",
            XDG_SESSION_TYPE: "wayland",
        };

        expect(ensureKwinPipRule(path, env as NodeJS.ProcessEnv, notify)).toBe(
            false,
        );
        expect(() => readFileSync(path, "utf8")).toThrow();
    });

    /**
     * Who gets told, and when. A rule on disk that KWin has not re-read does
     * nothing until the next login, so the poke matters — but it is also the one
     * thing here that talks to the running desktop, so it must happen exactly on
     * the boots that changed the file and on no others.
     */
    describe("telling KWin to re-read the file", () => {
        it("pokes KWin once when the rule is actually written", () => {
            ensureKwinPipRule(path, KDE_WAYLAND as NodeJS.ProcessEnv, notify);

            expect(reconfigured).toBe(1);
        });

        it("stays quiet on a boot that changed nothing", () => {
            ensureKwinPipRule(path, KDE_X11 as NodeJS.ProcessEnv, notify);
            expect(reconfigured).toBe(1);

            // Second boot: the file is already exactly right, so there is nothing
            // for KWin to re-read. Every boot calls this, so a notify here would
            // mean a needless compositor reconfigure on every single start-up.
            ensureKwinPipRule(path, KDE_X11 as NodeJS.ProcessEnv, notify);
            expect(reconfigured).toBe(1);
        });

        it("stays quiet off KDE, where there is no KWin to talk to", () => {
            const env = { XDG_CURRENT_DESKTOP: "GNOME" };

            ensureKwinPipRule(path, env as NodeJS.ProcessEnv, notify);

            expect(reconfigured).toBe(0);
        });

        it("stays quiet when the removal leaves the file unchanged", () => {
            // Nothing of ours in the file, asked to remove it: no write, so no poke.
            writeFileSync(path, EXISTING, "utf8");

            expect(
                syncKwinPipRule(
                    false,
                    path,
                    KDE_X11 as NodeJS.ProcessEnv,
                    notify,
                ),
            ).toBe(false);
            expect(reconfigured).toBe(0);
        });
    });

    /**
     * The promise in the module's own docstring: "a read-only config directory
     * must not stop the television from starting". The rule is a nicety layered
     * on a nicety; an EACCES escaping from here would take the whole boot down
     * over a window that merely fails to float.
     */
    // Root ignores the mode bits, so the write would succeed and prove nothing.
    it.skipIf(process.getuid?.() === 0)(
        "survives a config directory it cannot write to",
        () => {
            // r-x------: readable, so the "is there a file already" step works,
            // but neither the temp file nor the rename can be created.
            chmodSync(dir, 0o500);
            try {
                expect(() =>
                    syncKwinPipRule(
                        true,
                        path,
                        KDE_WAYLAND as NodeJS.ProcessEnv,
                        notify,
                    ),
                ).not.toThrow();

                // Reported as "nothing changed", and KWin is not asked to re-read a
                // file that was never written.
                expect(
                    syncKwinPipRule(
                        true,
                        path,
                        KDE_WAYLAND as NodeJS.ProcessEnv,
                        notify,
                    ),
                ).toBe(false);
                expect(reconfigured).toBe(0);
            } finally {
                // Or `afterEach`'s rmSync cannot unlink the directory's contents.
                chmodSync(dir, 0o700);
            }
        },
    );
});
