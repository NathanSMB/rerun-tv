// electron-builder `afterPack` hook: dlopens every packed .node addon with the
// packed Electron binary and fails the build on a NODE_MODULE_VERSION
// mismatch.
//
// This exists because 0.1.0 shipped an AppImage that died on boot with
// ERR_DLOPEN_FAILED: better_sqlite3.node was compiled for NODE_MODULE_VERSION
// 137 (Node 24) while Electron 43 requires 148. Nothing in the release job
// noticed, because every step before packaging runs under Node, where the
// wrong-ABI binary is the *correct* one. The mismatch is only observable from
// inside Electron, which nothing did until a user double-clicked the download.
//
// It runs after the app directory is populated but before the AppImage is
// assembled and published — the last point where a bad build can still be
// stopped rather than shipped. It deliberately uses the Electron binary from
// the output directory rather than the one in node_modules: that is the
// runtime the user actually gets, so it is the only ABI that matters.
//
// The addons are required by file path rather than through their module's
// entry point, because a module's entry point is not guaranteed to load its
// addon — better-sqlite3 defers `require('bindings')` into the Database
// constructor, so `require('better-sqlite3')` succeeds on a binary that cannot
// possibly work. Loading the file is the only check that does not depend on
// knowing how each module happens to be written.
//
// Only a NODE_MODULE_VERSION error fails the build. Plenty of .node files are
// not loadable addons at all — better-sqlite3 ships test_extension.node, an
// SQLite loadable extension that reports "Module did not self-register" — and
// failing on those would make the hook a nuisance that gets deleted. The ABI
// text is emitted by Node itself and is the exact signature of the bug this
// guards against.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

// Native modules cannot be loaded from inside an asar archive, so electron-
// builder extracts them next to it; everything worth checking is under here.
function findAddons(dir) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
        // No unpacked directory means no native modules were packed, which is
        // a fine state for a pure-JS build.
        if (error.code === "ENOENT") return [];
        throw error;
    }

    return entries.flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return findAddons(full);
        return entry.isFile() && entry.name.endsWith(".node") ? [full] : [];
    });
}

// Where each platform's packed layout keeps the Electron binary and the
// unpacked resources. Linux and Windows are flat; macOS nests everything in
// the .app bundle, whose name comes from productName rather than
// executableName.
const layouts = {
    linux: {
        binary: ({ appOutDir, packager }) =>
            path.join(appOutDir, packager.executableName),
        unpacked: ({ appOutDir }) =>
            path.join(appOutDir, "resources", "app.asar.unpacked"),
    },
    win32: {
        // `executableName` is LinuxPackager-only; the Windows exe is named
        // after the product, like the macOS bundle.
        binary: ({ appOutDir, packager }) =>
            path.join(appOutDir, `${packager.appInfo.productFilename}.exe`),
        unpacked: ({ appOutDir }) =>
            path.join(appOutDir, "resources", "app.asar.unpacked"),
    },
    darwin: {
        binary: ({ appOutDir, packager }) =>
            path.join(
                appOutDir,
                `${packager.appInfo.productFilename}.app`,
                "Contents",
                "MacOS",
                packager.appInfo.productFilename,
            ),
        unpacked: ({ appOutDir, packager }) =>
            path.join(
                appOutDir,
                `${packager.appInfo.productFilename}.app`,
                "Contents",
                "Resources",
                "app.asar.unpacked",
            ),
    },
};

export default async function verifyNativeAbi(context) {
    const { appOutDir, electronPlatformName, packager } = context;

    // A platform this hook does not know how to probe should say plainly that
    // nothing was checked rather than passing by default.
    const layout = layouts[electronPlatformName];
    if (!layout) {
        console.log(
            `  • skipped native ABI check  platform=${electronPlatformName} reason=layout not implemented`,
        );
        return;
    }

    const addons = findAddons(layout.unpacked({ appOutDir, packager }));
    if (addons.length === 0) return;

    // ELECTRON_RUN_AS_NODE gives a plain Node entry point that still reports
    // Electron's NODE_MODULE_VERSION, so this needs no display and works on a
    // headless runner.
    const probe = `
        const bad = [];
        for (const file of ${JSON.stringify(addons)}) {
            try {
                require(file);
            } catch (error) {
                if (/NODE_MODULE_VERSION/.test(error.message)) bad.push(error.message);
            }
        }
        if (bad.length) {
            console.error(bad.join('\\n\\n'));
            process.exit(1);
        }
    `;

    // On the arm64 macOS runner the x64 slice of a dual-arch build executes
    // under Rosetta, which the GitHub images ship with — the probe still runs
    // the exact binary a user would.
    try {
        execFileSync(layout.binary({ appOutDir, packager }), ["-e", probe], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            stdio: "pipe",
            encoding: "utf8",
        });
    } catch (error) {
        throw new Error(
            "A packed native module was built for the wrong Node.js ABI and would crash this build on boot.\n" +
                "The modules are still on Node's ABI: `npm test` rebuilds them for Node, and @electron/rebuild\n" +
                "then skips its own rebuild because build/Release/.forge-meta still claims Electron's ABI.\n" +
                "Run `npm run rebuild:node` (which clears that marker) or delete the marker, then rebuild.\n\n" +
                (error.stderr || error.message || "").trim(),
        );
    }

    console.log(`  • verified native ABI  addons=${addons.length}`);
}
