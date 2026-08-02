import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@shared": resolve("src/shared"),
            "@main": resolve("src/main"),
        },
    },
    // The renderer tests are `.tsx` and mount real components; everything else in
    // `tests/` is plain TypeScript with no JSX at all.
    esbuild: { jsx: "automatic" },
    test: {
        include: ["tests/**/*.test.{ts,tsx}"],
        // Node stays the default. `tests/renderer/` opts itself out per file with a
        // `@vitest-environment happy-dom` docblock, so nothing else pays for a DOM.
        environment: "node",
        // Coverage is reporting-only for now: no thresholds, so `npm test` never
        // fails on a number. It exists so gaps are visible while we backfill tests.
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
        },
    },
});
