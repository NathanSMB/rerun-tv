/**
 * Screen 05 · Settings.
 *
 * Every knob in one place — the app never asks anyone to edit JSON (plan §8).
 * Four quiet cards: where the media lives, how it plays, how the interface
 * behaves, and what the system underneath is doing.
 *
 * Post-MVP controls (VAAPI) ship **visible but disabled**, so the settings
 * surface doesn't reshuffle as features land.
 */

import { useEffect, useState, type ReactElement } from 'react'
import type { AppSettings, ScanRoot } from '@shared/types.js'
import { SLEEP_MAX_MIN } from '@shared/types.js'
import { useStore } from '../store.js'
import './Settings.css'

/** x264 preset + CRF travel together, so one control writes both settings. */
const QUALITY_PRESETS = [
  { preset: 'ultrafast', crf: 23, label: 'ultrafast · CRF 23' },
  { preset: 'veryfast', crf: 21, label: 'veryfast · CRF 21' },
  { preset: 'fast', crf: 20, label: 'fast · CRF 20' },
  { preset: 'medium', crf: 19, label: 'medium · CRF 19' }
] as const

const AUDIO_BITRATES = ['128k', '192k', '256k', '320k'] as const

const START_SCREENS: { value: AppSettings['startScreen']; label: string }[] = [
  { value: 'guide', label: 'Guide' },
  { value: 'channels', label: 'Channels' },
  { value: 'library', label: 'Library' },
  { value: 'settings', label: 'Settings' }
]

const OSD_DELAYS = [2, 3, 5, 10]

/**
 * Where the sleep dial opens. Only a starting point now — the panel's dial goes
 * anywhere up to `SLEEP_MAX_MIN` in five-minute steps — so this list is a set of
 * likely answers rather than the whole range the player can reach.
 */
const SLEEP_DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240, SLEEP_MAX_MIN]

/** "45 minutes", "1 h 30 min", "5 hours" — the dropdown's labels. */
function sleepDurationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const hoursLabel = hours === 1 ? '1 hour' : `${hours} hours`
  return rest === 0 ? hoursLabel : `${hours} h ${rest} min`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

/** The mockup's pill switch, wired as a real `role="switch"` control. */
function Toggle({
  checked,
  label,
  disabled,
  onChange
}: {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (next: boolean) => void
}): ReactElement {
  return (
    <button
      type="button"
      className={`toggle${checked ? ' on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

export default function Settings(): ReactElement {
  const settings = useStore((s) => s.settings)
  const system = useStore((s) => s.system)
  const setSetting = useStore((s) => s.setSetting)
  const refreshLibrary = useStore((s) => s.refreshLibrary)

  const [roots, setRoots] = useState<ScanRoot[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const locked = busy !== null

  useEffect(() => {
    let alive = true
    window.rerun.library
      .listRoots()
      .then((next) => {
        if (alive) setRoots(next)
      })
      .catch((err: unknown) => {
        if (alive) {
          setRoots([])
          setError(errorText(err))
        }
      })
    return () => {
      alive = false
    }
  }, [])

  /** Run one settings/system call with a lock, a note on success and a visible error. */
  async function run(key: string, fn: () => Promise<string | null>): Promise<void> {
    setBusy(key)
    setError(null)
    setNote(null)
    try {
      const message = await fn()
      if (message != null) setNote(message)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    void run(`setting:${String(key)}`, async () => {
      await setSetting(key, value)
      return null
    })
  }

  function onQualityChange(value: string): void {
    const chosen = QUALITY_PRESETS.find((q) => `${q.preset}:${q.crf}` === value)
    if (chosen == null) return
    void run('setting:quality', async () => {
      await setSetting('transcodePreset', chosen.preset)
      await setSetting('transcodeCrf', chosen.crf)
      return null
    })
  }

  function onAddFolder(): void {
    void run('addRoot', async () => {
      const path = await window.rerun.system.pickFolder()
      if (path == null) return null
      setRoots(await window.rerun.library.addRoot(path))
      await refreshLibrary()
      return `Added ${path}. It will be scanned on the next pass.`
    })
  }

  function onRemoveRoot(root: ScanRoot): void {
    const ok = window.confirm(
      `Remove ${root.path} from the library?\n\nEpisodes found only under this folder stop being scheduled. Files on disk are not touched.`
    )
    if (!ok) return
    void run(`removeRoot:${root.id}`, async () => {
      setRoots(await window.rerun.library.removeRoot(root.id))
      await refreshLibrary()
      return `Removed ${root.path}.`
    })
  }

  function onRescanAll(): void {
    void run('rescan', async () => {
      await window.rerun.library.rescan(true)
      return 'Full rescan started — every file is being re-probed.'
    })
  }

  function onBackup(): void {
    void run('backup', async () => {
      const path = await window.rerun.system.backupDb()
      return path == null ? 'Backup cancelled.' : `Database backed up to ${path}`
    })
  }

  /**
   * The picker, the validation and the confirm all live in main — it's the only
   * side that can report what's actually in the file being imported. All that
   * comes back is whether the user went through with it.
   */
  function onImport(): void {
    void run('import', async () => {
      const started = await window.rerun.system.importDb()
      return started ? 'Importing — Rerun TV is restarting…' : 'Import cancelled.'
    })
  }

  const qualityKey = `${settings.transcodePreset}:${settings.transcodeCrf}`
  const knownQuality = QUALITY_PRESETS.some((q) => `${q.preset}:${q.crf}` === qualityKey)

  const ffmpegOk = system != null && system.ffmpegPath != null && system.ffmpegSource !== 'missing'

  return (
    <div className="set-body">
      {(error != null || note != null) && (
        <div className="set-status" role={error != null ? 'alert' : 'status'}>
          {error != null ? <span className="set-status-error">{error}</span> : <span>{note}</span>}
        </div>
      )}

      {/* ---- library folders ---- */}
      <section className="set-card" aria-label="Library folders">
        <div className="caption side-caption">Library folders</div>

        {roots == null && <div className="set-row set-muted">Loading folders…</div>}
        {roots != null && roots.length === 0 && (
          <div className="set-row set-muted">
            No folders yet — add one and the scanner will walk it.
          </div>
        )}
        {(roots ?? []).map((root) => (
          <div className="set-row" key={root.id}>
            <span className="folder-path">{root.path}</span>
            <span className="set-value">
              {settings.watchFolders && (
                <>
                  <span className="status-dot" />
                  watching
                </>
              )}
              <button
                type="button"
                className="remove"
                aria-label={`Remove ${root.path}`}
                disabled={locked}
                onClick={() => onRemoveRoot(root)}
              >
                ✕
              </button>
            </span>
          </div>
        ))}

        <div className="set-row">
          <div>
            <div className="set-label">Watch folders for new episodes</div>
            <div className="set-hint">New files are parsed and probed as they appear</div>
          </div>
          <Toggle
            checked={settings.watchFolders}
            label="Watch folders for new episodes"
            disabled={locked}
            onChange={(next) => update('watchFolders', next)}
          />
        </div>

        <div className="set-row">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={locked}
            onClick={onAddFolder}
          >
            {busy === 'addRoot' ? 'Choosing…' : '+ Add folder'}
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={locked || roots == null || roots.length === 0}
            onClick={onRescanAll}
          >
            {busy === 'rescan' ? 'Starting…' : 'Rescan everything'}
          </button>
        </div>
      </section>

      {/* ---- playback ---- */}
      <section className="set-card" aria-label="Playback">
        <div className="caption side-caption">Playback</div>

        <div className="set-row">
          <div>
            <label className="set-label" htmlFor="set-quality">
              Transcode quality
            </label>
            <div className="set-hint">Only used when a file can&rsquo;t direct-play or remux</div>
          </div>
          <select
            id="set-quality"
            className="selectbox"
            value={qualityKey}
            disabled={locked}
            onChange={(event) => onQualityChange(event.target.value)}
          >
            {!knownQuality && (
              <option value={qualityKey}>
                {settings.transcodePreset} · CRF {settings.transcodeCrf}
              </option>
            )}
            {QUALITY_PRESETS.map((q) => (
              <option key={q.label} value={`${q.preset}:${q.crf}`}>
                {q.label}
              </option>
            ))}
          </select>
        </div>

        <div className="set-row">
          <label className="set-label" htmlFor="set-audio">
            Audio bitrate (transcode)
          </label>
          <select
            id="set-audio"
            className="selectbox"
            value={settings.transcodeAudioBitrate}
            disabled={locked}
            onChange={(event) => update('transcodeAudioBitrate', event.target.value)}
          >
            {!AUDIO_BITRATES.includes(
              settings.transcodeAudioBitrate as (typeof AUDIO_BITRATES)[number]
            ) && (
              <option value={settings.transcodeAudioBitrate}>
                {settings.transcodeAudioBitrate}
              </option>
            )}
            {AUDIO_BITRATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate.replace('k', '')} kbps
              </option>
            ))}
          </select>
        </div>

        <div className="set-row">
          <div>
            <div className="set-label">
              Hardware encode (VAAPI)
              <span className="postmvp">POST-MVP</span>
            </div>
            <div className="set-hint">GPU-assisted transcoding on Intel/AMD</div>
          </div>
          <Toggle
            checked={settings.hardwareEncode}
            label="Hardware encode (VAAPI) — not available yet"
            disabled
            onChange={() => undefined}
          />
        </div>

        <div className="set-row">
          <div>
            <div className="set-label">Loudness equalization</div>
            <div className="set-hint">
              Even out volume across episodes and between quiet and loud scenes, targeting
              &minus;16 LUFS. Episodes are measured in the background while nothing is playing.
            </div>
          </div>
          <Toggle
            checked={settings.loudnessEq}
            label="Loudness equalization"
            disabled={locked}
            onChange={(next) => update('loudnessEq', next)}
          />
        </div>

        <div className="set-row">
          <div>
            <div className="set-label">Pre-warm next episode</div>
            <div className="set-hint">
              Buffer the next episode during the last 30 s so handoffs cut instantly. Runs a
              second stream for that half-minute.
            </div>
          </div>
          <Toggle
            checked={settings.prewarmNext}
            label="Pre-warm next episode"
            disabled={locked}
            onChange={(next) => update('prewarmNext', next)}
          />
        </div>
      </section>

      {/* ---- interface ---- */}
      <section className="set-card" aria-label="Interface">
        <div className="caption side-caption">Interface</div>

        <div className="set-row">
          <label className="set-label" htmlFor="set-start">
            Start on
          </label>
          <select
            id="set-start"
            className="selectbox"
            value={settings.startScreen}
            disabled={locked}
            onChange={(event) =>
              update('startScreen', event.target.value as AppSettings['startScreen'])
            }
          >
            {START_SCREENS.map((screen) => (
              <option key={screen.value} value={screen.value}>
                {screen.label}
              </option>
            ))}
          </select>
        </div>

        <div className="set-row">
          <label className="set-label" htmlFor="set-osd">
            Hide player controls after
          </label>
          <select
            id="set-osd"
            className="selectbox"
            value={String(settings.osdHideAfterS)}
            disabled={locked}
            onChange={(event) => update('osdHideAfterS', Number(event.target.value))}
          >
            {!OSD_DELAYS.includes(settings.osdHideAfterS) && (
              <option value={String(settings.osdHideAfterS)}>
                {settings.osdHideAfterS} seconds
              </option>
            )}
            {OSD_DELAYS.map((seconds) => (
              <option key={seconds} value={String(seconds)}>
                {seconds} seconds
              </option>
            ))}
          </select>
        </div>

        <div className="set-row">
          <div>
            <label className="set-label" htmlFor="set-sleep">
              Sleep timer starts at
            </label>
            <div className="set-hint">
              Where the dial opens on the first press of <kbd>S</kbd>; drag it anywhere up
              to 5 hours. Playback stops at the end of the episode or arc
            </div>
          </div>
          <select
            id="set-sleep"
            className="selectbox"
            value={String(settings.sleepTimerDefaultMin)}
            disabled={locked}
            onChange={(event) => update('sleepTimerDefaultMin', Number(event.target.value))}
          >
            {!SLEEP_DURATIONS.includes(settings.sleepTimerDefaultMin) && (
              <option value={String(settings.sleepTimerDefaultMin)}>
                {sleepDurationLabel(settings.sleepTimerDefaultMin)}
              </option>
            )}
            {SLEEP_DURATIONS.map((minutes) => (
              <option key={minutes} value={String(minutes)}>
                {sleepDurationLabel(minutes)}
              </option>
            ))}
          </select>
        </div>

        <div className="set-row">
          <div>
            <div className="set-label">Remember volume</div>
            <div className="set-hint">Restore last volume and mute state on launch</div>
          </div>
          <Toggle
            checked={settings.rememberVolume}
            label="Remember volume"
            disabled={locked}
            onChange={(next) => update('rememberVolume', next)}
          />
        </div>

        {/*
          Only on Wayland, because that is the only session where the answer
          changes anything: an X11 session is already where this would send us.
        */}
        {system?.session === 'wayland' && (
          <div className="set-row">
            <div>
              <div className="set-label">Keep picture-in-picture above other windows</div>
              <div className="set-hint">
                Runs the app through XWayland, the only way a window can pin itself above
                others &mdash; Wayland has no protocol for it. Costs crisp fractional
                scaling.{' '}
                {settings.pipKeepOnTop === (system.windowSystem === 'x11') ? (
                  <>
                    Currently on <b>{system.windowSystem === 'x11' ? 'XWayland' : 'Wayland'}</b>.
                  </>
                ) : (
                  <b>Restart to apply.</b>
                )}{' '}
                On KDE it also installs a window rule so full-screen windows can&rsquo;t
                cover it; switching this off removes the rule again.
              </div>
            </div>
            <Toggle
              checked={settings.pipKeepOnTop}
              label="Keep picture-in-picture above other windows"
              disabled={locked}
              onChange={(next) => update('pipKeepOnTop', next)}
            />
          </div>
        )}

        <div className="shortcuts" aria-label="Keyboard shortcuts">
          <span>
            <kbd>Space</kbd>pause
          </span>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>volume
          </span>
          <span>
            <kbd>→</kbd>skip
          </span>
          <span>
            <kbd>S</kbd>sleep timer
          </span>
          <span>
            <kbd>P</kbd>picture-in-picture
          </span>
          <span>
            <kbd>F</kbd>fullscreen
          </span>
          <span>
            <kbd>Esc</kbd>guide
          </span>
        </div>
      </section>

      {/* ---- system ---- */}
      <section className="set-card" aria-label="System">
        <div className="caption side-caption">System</div>

        <div className="set-row">
          <div>
            <div className="set-label">ffmpeg</div>
            <div className="set-hint">
              {ffmpegOk
                ? 'System binary preferred; bundled fallback if missing'
                : 'Install it with pacman -S ffmpeg, then restart Rerun TV'}
            </div>
          </div>
          <span className="set-value">
            {system == null ? (
              <>
                <span className="status-dot warn" />
                checking…
              </>
            ) : ffmpegOk ? (
              <>
                <span className="status-dot" />
                <b>{system.ffmpegVersion ?? 'installed'}</b>· {system.ffmpegPath}
              </>
            ) : (
              <>
                <span className="status-dot bad" />
                not found
              </>
            )}
          </span>
        </div>

        <div className="set-row">
          <div>
            <div className="set-label">Codec check</div>
            <div className="set-hint">H.264/AAC decode asserted at startup</div>
          </div>
          <span className="set-value">
            {system == null || system.codecCheck === 'pending' ? (
              <>
                <span className="status-dot warn" />
                pending
              </>
            ) : system.codecCheck === 'ok' ? (
              <>
                <span className="status-dot" />
                OK
              </>
            ) : (
              <>
                <span className="status-dot bad" />
                FAILED
              </>
            )}
          </span>
        </div>

        <div className="set-row">
          <div>
            <div className="set-label">Database</div>
            <div className="set-hint">
              {system == null
                ? '—'
                : `${system.dbPath} · ${formatMb(system.dbSizeBytes)}`}
            </div>
            {/* The restart eats the status banner, so the receipt is the only
                thing left to say where the replaced database went. */}
            {system?.lastRestore != null && (
              <div className="set-hint">
                Restored from {baseName(system.lastRestore.sourcePath)} on{' '}
                {formatDate(system.lastRestore.restoredAt)}
                {system.lastRestore.backupPath != null &&
                  ` · previous database saved at ${system.lastRestore.backupPath}`}
              </div>
            )}
          </div>
          <span className="set-value">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={locked || system == null}
              onClick={onBackup}
            >
              {busy === 'backup' ? 'Backing up…' : 'Back up…'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={locked || system == null}
              onClick={onImport}
            >
              {busy === 'import' ? 'Importing…' : 'Import…'}
            </button>
          </span>
        </div>

        <div className="set-row">
          <div>
            <div className="set-label">Rerun TV</div>
            <div className="set-hint">
              {system?.streamPort != null
                ? `Stream server on localhost:${system.streamPort}`
                : 'Stream server idle'}
            </div>
          </div>
          <span className="set-value">
            <b>{system?.appVersion ?? '—'}</b>
          </span>
        </div>
      </section>
    </div>
  )
}
