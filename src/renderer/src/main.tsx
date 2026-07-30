import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import { useStore } from './store.js'
import './styles/global.css'

/**
 * The store, on the global, for `scripts/soak.mjs`.
 *
 * The soak harness drives the real app over the DevTools protocol — tune a
 * channel, watch six episodes, fail on a stall — and it needs some way to say
 * "tune channel 1" and to read which episode is on air. Poking at the DOM for
 * that would make the harness a test of the markup; this is the seam it should
 * be using instead.
 *
 * Not gated on a build flag: the renderer is a local UI with no untrusted script
 * in it, and a diagnostic that only exists in development is a diagnostic that
 * has never been run against the thing being shipped.
 */
;(globalThis as { __rerunStore?: typeof useStore }).__rerunStore = useStore

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
