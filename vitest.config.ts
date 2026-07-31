import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main')
    }
  },
  // The renderer tests are `.tsx` and mount real components; everything else in
  // `tests/` is plain TypeScript with no JSX at all.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    // Node stays the default. `tests/renderer/` opts itself out per file with a
    // `@vitest-environment happy-dom` docblock, so nothing else pays for a DOM.
    environment: 'node'
  }
})
