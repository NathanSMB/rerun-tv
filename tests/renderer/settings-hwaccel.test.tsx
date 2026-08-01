/**
 * @vitest-environment happy-dom
 *
 * Screen 05 · the hardware acceleration control (docs/hwaccel-plan.html).
 *
 * The dropdown replaced a toggle that shipped disabled and was wired to nothing,
 * so the things worth pinning are the ones that make it *not* that: it writes
 * the setting, it reports what the startup probe found, and — the load-bearing
 * one — it stays selectable when the probe says the hardware is absent. A
 * selection this machine cannot honour is harmless by design (the stream server
 * falls back to software on its own), and a disabled control would take that
 * choice away from a user whose driver simply loaded late.
 *
 * Mounted against the real component and the real store, with only the preload
 * bridge faked — the same seam the Player harness uses.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RerunApi } from '@shared/ipc.js'
import {
  DEFAULT_SETTINGS,
  PENDING_HW_ACCEL,
  type AppSettings,
  type HwAccelReport,
  type SystemInfo
} from '@shared/types.js'
import Settings from '../../src/renderer/src/screens/Settings.js'
import { useStore } from '../../src/renderer/src/store.js'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

function systemInfo(hwAccel: HwAccelReport): SystemInfo {
  return {
    appVersion: '0.1.0',
    ffmpegPath: '/usr/bin/ffmpeg',
    ffprobePath: '/usr/bin/ffprobe',
    ffmpegVersion: 'n8.1.2',
    ffmpegSource: 'system',
    codecCheck: 'ok',
    hwAccel,
    dbPath: '/tmp/library.db',
    dbSizeBytes: 1024,
    streamPort: 9,
    lastRestore: null
  }
}

/** Settings written across the bridge, in order. */
let written: { key: string; value: unknown }[] = []
let container: HTMLDivElement
let root: Root

/** The bridge surface this screen actually touches. */
function bridge(settings: AppSettings): RerunApi {
  return {
    settings: {
      getAll: async () => settings,
      set: async (key: string, value: unknown) => {
        written.push({ key, value })
        return { ...settings, [key]: value } as AppSettings
      }
    },
    library: {
      listRoots: async () => [],
      addRoot: async () => [],
      removeRoot: async () => [],
      rescan: async () => undefined,
      getOverview: async () => ({ shows: [], unmatched: [], totalEpisodes: 0 })
    },
    system: { getInfo: async () => systemInfo(PENDING_HW_ACCEL) }
  } as unknown as RerunApi
}

/**
 * Mount and let the screen's folder-list effect settle. Without the flush its
 * `listRoots()` promise resolves *after* the test body, which React reports as
 * an un-acted update — a real warning about a real state change, not noise.
 */
async function mount(settings: AppSettings, hwAccel: HwAccelReport): Promise<void> {
  ;(window as unknown as { rerun: RerunApi }).rerun = bridge(settings)
  useStore.setState({ settings, system: systemInfo(hwAccel) })
  await act(async () => {
    root.render(<Settings />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function select(): HTMLSelectElement {
  const node = container.querySelector('#set-hwaccel')
  if (!(node instanceof HTMLSelectElement)) throw new Error('hardware dropdown not rendered')
  return node
}

function optionLabels(): string[] {
  return [...select().options].map((option) => option.textContent ?? '')
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  written = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useStore.setState({ settings: DEFAULT_SETTINGS, system: null })
})

const ALL_OK: HwAccelReport = { vaapi: 'ok', nvenc: 'ok', vaapiDevice: '/dev/dri/renderD129' }
const NONE: HwAccelReport = { vaapi: 'failed', nvenc: 'failed', vaapiDevice: null }

describe('the hardware acceleration dropdown', () => {
  it('offers all three backends and shows the stored one', async () => {
    await mount({ ...DEFAULT_SETTINGS, hardwareAccel: 'nvenc' }, ALL_OK)
    expect(select().value).toBe('nvenc')
    expect([...select().options].map((o) => o.value)).toEqual(['software', 'vaapi', 'nvenc'])
  })

  it('defaults to software', async () => {
    await mount(DEFAULT_SETTINGS, ALL_OK)
    expect(select().value).toBe('software')
  })

  it('writes the chosen backend across the bridge', async () => {
    await mount(DEFAULT_SETTINGS, ALL_OK)
    const node = select()
    await act(async () => {
      node.value = 'vaapi'
      node.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(written).toEqual([{ key: 'hardwareAccel', value: 'vaapi' }])
  })

  it('reports what the probe found, per backend', async () => {
    await mount(DEFAULT_SETTINGS, { vaapi: 'ok', nvenc: 'failed', vaapiDevice: '/dev/dri/renderD129' })
    const labels = optionLabels()
    expect(labels[1]).toContain('available')
    expect(labels[2]).toContain('not detected')
    // Software is always there; annotating it would be noise.
    expect(labels[0]).toBe('Software (libx264)')
  })

  it('says the probe is still running rather than claiming a verdict', async () => {
    await mount(DEFAULT_SETTINGS, PENDING_HW_ACCEL)
    expect(optionLabels()[1]).toContain('checking…')
    expect(optionLabels()[2]).toContain('checking…')
  })

  /**
   * The point of the whole control. A probe can be wrong — a driver that loads
   * late, an eGPU plugged in after launch — and picking a backend this machine
   * currently can't honour costs nothing, because the stream server falls back
   * to software on its own. Disabling the option would be the app overruling the
   * user on a guess.
   */
  it('stays selectable when the probe found nothing', async () => {
    await mount(DEFAULT_SETTINGS, NONE)
    expect(select().disabled).toBe(false)
    for (const option of [...select().options]) expect(option.disabled).toBe(false)
  })

  it('warns, without blocking, when the selected backend is unavailable', async () => {
    await mount({ ...DEFAULT_SETTINGS, hardwareAccel: 'vaapi' }, NONE)
    expect(container.textContent).toContain('transcodes will run on software')
    expect(select().disabled).toBe(false)
  })

  it('says nothing extra when the selection is honoured', async () => {
    await mount({ ...DEFAULT_SETTINGS, hardwareAccel: 'vaapi' }, ALL_OK)
    expect(container.textContent).not.toContain('transcodes will run on software')
  })

  it('names the render node VAAPI proved out, which is never guessable', async () => {
    await mount(DEFAULT_SETTINGS, ALL_OK)
    expect(container.textContent).toContain('/dev/dri/renderD129')
  })

  /** The hint has to keep saying which episodes this affects — most are not on it. */
  it('explains that only full transcodes are accelerated', async () => {
    await mount(DEFAULT_SETTINGS, ALL_OK)
    expect(container.textContent).toContain('full transcode')
  })
})
