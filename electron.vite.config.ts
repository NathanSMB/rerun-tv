import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        resolve: {
            alias: {
                "@shared": resolve("src/shared"),
                "@main": resolve("src/main"),
            },
        },
        build: {
            outDir: "dist/main",
            rollupOptions: { input: { index: resolve("src/main/index.ts") } },
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        resolve: {
            alias: { "@shared": resolve("src/shared") },
        },
        build: {
            outDir: "dist/preload",
            rollupOptions: {
                input: { index: resolve("src/preload/index.ts") },
                // Sandboxed Electron preloads run in a restricted CommonJS context.
                // The package itself is ESM, so use an explicit .cjs extension to keep
                // Node's package-type detection from treating the bridge as ESM.
                output: {
                    format: "cjs",
                    entryFileNames: "[name].cjs",
                },
            },
        },
    },
    renderer: {
        root: resolve("src/renderer"),
        plugins: [react()],
        resolve: {
            alias: {
                "@shared": resolve("src/shared"),
                "@renderer": resolve("src/renderer/src"),
            },
        },
        build: {
            outDir: resolve("dist/renderer"),
            rollupOptions: {
                input: { index: resolve("src/renderer/index.html") },
            },
        },
    },
});
