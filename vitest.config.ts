import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@shared": resolve("src/shared"),
            "@main": resolve("src/main"),
            "@renderer": resolve("src/renderer/src"),
            // Electron is a process boundary, not a dependency we can load in
            // Node — aliasing it to a recording stub is what lets `handlers.ts`
            // be tested for real. See the stub's header.
            electron: resolve("tests/helpers/electron.ts"),
        },
    },
    // The renderer tests are `.tsx` and mount real components; everything else in
    // `tests/` is plain TypeScript with no JSX at all.
    esbuild: { jsx: "automatic" },
    test: {
        include: ["tests/**/*.test.{ts,tsx}"],
        // The job suite holds encoders open through a shebang-script ffmpeg
        // stub, which Windows cannot spawn (and Node refuses .cmd wrappers
        // without a shell). The supervisor it tests is platform-independent
        // and stays covered by the Linux and macOS runs.
        exclude: [
            ...configDefaults.exclude,
            ...(process.platform === "win32"
                ? ["tests/stream-jobs.test.ts"]
                : []),
        ],
        // Node stays the default. `tests/renderer/` opts itself out per file with a
        // `@vitest-environment happy-dom` docblock, so nothing else pays for a DOM.
        environment: "node",
        coverage: {
            provider: "v8",
            // Only our own source counts. `tests/`, config files and scripts are
            // tooling, not the thing under test.
            include: ["src/**"],
            exclude: [
                // Types disappear at runtime, so v8 reports them as 0% forever.
                "**/*.d.ts",
                "src/**/*.css",
                "src/renderer/index.html",
                "src/renderer/src/assets/**",
            ],
            // `json-summary` writes coverage/coverage-summary.json, which
            // scripts/coverage-badge.mjs turns into the README badge in CI.
            reporter: ["text", "html", "json-summary"],
            // A floor, not a target. Raised to 75 once the IPC handler and
            // Library screen suites landed and took the numbers to ~80% lines /
            // 77% functions / 82% branches — the floor sits a few points under
            // the real figure so ordinary churn doesn't trip it, and moves up
            // again as the backfill continues. Only applies with `--coverage`,
            // so plain `npm test` still never fails on a number.
            thresholds: {
                statements: 75,
                branches: 75,
                functions: 75,
                lines: 75,
            },
        },
    },
});
