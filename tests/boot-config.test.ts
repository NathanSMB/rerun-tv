/**
 * The boot config (docs/pip-plan.html §7, docs/ui.md).
 *
 * One setting lives outside the database, and it is worth a test precisely
 * because of *why*: Chromium picks its window system from the command line
 * before `app.whenReady()`, while the database is not open until after the
 * staged-import swap — so `pipKeepOnTop` is mirrored to a JSON file that can be
 * read synchronously with no Electron and no migrations.
 *
 * Everything here is about that file being **advisory**. It is a cache, not a
 * source of truth, and the failure mode it must never have is an app that
 * refuses to start because a convenience got corrupted. So the cases below are
 * mostly "this file is wrong in some way; boot anyway".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_BOOT_CONFIG,
  isSupervisedRun,
  isWaylandSession,
  ozonePlatformOverride,
  readBootConfig,
  relaunchPlatform,
  writeBootConfig
} from '@main/boot-config.js'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rerun-boot-'))
  path = join(dir, 'boot.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const WAYLAND = { XDG_SESSION_TYPE: 'wayland' } as NodeJS.ProcessEnv
const X11 = { XDG_SESSION_TYPE: 'x11' } as NodeJS.ProcessEnv

describe('reading', () => {
  it('round-trips a written config', () => {
    writeBootConfig({ pipKeepOnTop: false }, path)

    expect(readBootConfig(path)).toEqual({ pipKeepOnTop: false })
  })

  it('falls back to the defaults on a first run', () => {
    expect(readBootConfig(join(dir, 'absent.json'))).toEqual(DEFAULT_BOOT_CONFIG)
  })

  it('falls back rather than throwing on a corrupt file', () => {
    // The whole reason this is wrapped: a half-written or hand-edited file must
    // not be the thing that stops the app from starting.
    writeFileSync(path, '{ this is not json')

    expect(readBootConfig(path)).toEqual(DEFAULT_BOOT_CONFIG)
  })

  it('ignores a value of the wrong type', () => {
    writeFileSync(path, JSON.stringify({ pipKeepOnTop: 'yes please' }))

    expect(readBootConfig(path)).toEqual(DEFAULT_BOOT_CONFIG)
  })

  it('ignores valid JSON that is not an object', () => {
    writeFileSync(path, '"wayland"')

    expect(readBootConfig(path)).toEqual(DEFAULT_BOOT_CONFIG)
  })

  it('does not throw when the file cannot be written', () => {
    // A read-only data directory is somebody else's problem to fix; failing to
    // cache a preference must not fail the write that persisted it.
    expect(() => writeBootConfig({ pipKeepOnTop: true }, join(dir, 'no', 'such', 'dir.json')))
      .not.toThrow()
  })
})

describe('choosing the window system', () => {
  it('sends a Wayland session through XWayland when the setting is on', () => {
    // The measured reason: a Wayland client cannot raise itself above other
    // windows, so this is the only way the floating window stays put.
    expect(ozonePlatformOverride({ pipKeepOnTop: true }, WAYLAND)).toBe('x11')
  })

  it('leaves a Wayland session alone when the setting is off', () => {
    expect(ozonePlatformOverride({ pipKeepOnTop: false }, WAYLAND)).toBeNull()
  })

  it('changes nothing on an X11 session', () => {
    // Already where the setting would send it — overriding would be noise.
    expect(ozonePlatformOverride({ pipKeepOnTop: true }, X11)).toBeNull()
  })

  it('treats a bare WAYLAND_DISPLAY as a Wayland session', () => {
    expect(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-0' } as NodeJS.ProcessEnv)).toBe(true)
    expect(isWaylandSession(X11)).toBe(false)
  })

  it('defers to an explicit flag from whoever launched the app', () => {
    // Someone who typed `--ozone-platform=wayland` meant it, and a setting they
    // have not looked at today should not quietly overrule them.
    const argv = [...process.argv]
    process.argv = [...argv, '--ozone-platform=wayland']
    try {
      expect(ozonePlatformOverride({ pipKeepOnTop: true }, WAYLAND)).toBeNull()
    } finally {
      process.argv = argv
    }
  })

  /**
   * The regression this function exists for, and it is worth stating plainly
   * because the symptom was so far from the cause: applying the platform means
   * relaunching, `electron-vite dev` treats its Electron child exiting as the
   * app closing, so the relaunch took the dev server with it — and the new
   * window came up pointed at a `localhost` that had stopped listening. A blank
   * app, and a shell prompt back, from a setting about window stacking.
   */
  it('never relaunches while a dev server is supervising the process', () => {
    const dev = { ...WAYLAND, ELECTRON_RENDERER_URL: 'http://localhost:5173' }

    // The setting still *wants* XWayland…
    expect(ozonePlatformOverride({ pipKeepOnTop: true }, dev)).toBe('x11')
    // …and we still must not take it, because leaving kills the dev server.
    expect(relaunchPlatform({ pipKeepOnTop: true }, dev)).toBeNull()
    expect(isSupervisedRun(dev)).toBe(true)
  })

  it('relaunches in a real run, where nothing is supervising us', () => {
    expect(relaunchPlatform({ pipKeepOnTop: true }, WAYLAND)).toBe('x11')
    expect(isSupervisedRun(WAYLAND)).toBe(false)
  })

  it('defaults to keeping the window on top', () => {
    // The default matters: it is what makes picture-in-picture behave like
    // picture-in-picture without anyone visiting Settings first.
    expect(DEFAULT_BOOT_CONFIG.pipKeepOnTop).toBe(true)
    expect(ozonePlatformOverride(readBootConfig(join(dir, 'absent.json')), WAYLAND)).toBe('x11')
  })
})
