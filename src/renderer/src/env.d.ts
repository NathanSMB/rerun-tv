/// <reference types="vite/client" />

import type { RerunApi } from '../../shared/ipc.js'

declare global {
  interface Window {
    /** Injected by the preload bridge. See `src/preload/index.ts`. */
    rerun: RerunApi
  }
}

export {}
