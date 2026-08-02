/**
 * The one thing a window cannot ask for: KWin's overlay layer.
 *
 * ## Why this file exists
 *
 * Nothing a client can say keeps a window above a **full-screen** window. KWin
 * stacks windows in fixed layers, and `_NET_WM_STATE_ABOVE` — which Chromium
 * already sets, and which is everything the X11 protocol offers a client here —
 * lands in `AboveLayer`, *below* the layer a full-screen game occupies. On
 * Wayland there is not even that: no protocol exists for raising yourself, so
 * the request is silently a no-op. The layers that outrank a full-screen window
 * are assignable only by the compositor, from a **window rule**. There is no
 * property, no window type and no Electron API that reaches them.
 *
 * So the rule is the mechanism, and the only question is who writes it. Making
 * the viewer add it by hand is a poor answer for a feature that is meant to work
 * out of the box. This module writes it instead. (The manual route does exist:
 * as of Electron 43, right-clicking the floating window forwards to KWin's
 * window menu — `xdg_toplevel.show_window_menu` — so Configure Special Window
 * Settings is reachable by hand; on Electron 38 that click was swallowed. The
 * rule still wins on automation, and manual "Keep Above" only buys `AboveLayer`,
 * not the overlay layer this file is about.)
 *
 * Because the rule is enforced by the compositor rather than requested by the
 * client, it works the same on Wayland and on X11 — which is why this is now the
 * *whole* mechanism. An earlier build also relaunched itself onto XWayland to
 * borrow `_NET_WM_STATE_ABOVE`; that only ever bought a subset of what the rule
 * already does, and cost per-monitor DPI and crisp fractional scaling to buy it.
 *
 * ## What it is careful about
 *
 * It is editing a file that belongs to someone else — KDE's, hand-edited through
 * System Settings — so:
 *
 * - **Everything else in the file is preserved**, including rules the viewer
 *   wrote, in their original order and with their original keys.
 * - **It owns exactly one group**, identified by a fixed id. Running twice
 *   changes nothing, so every boot can call `ensureKwinPipRule()` blindly; a
 *   viewer who edits our rule keeps their edits until the next boot, at which
 *   point ours is authoritative again.
 * - **It does nothing at all off KDE.** No KWin, no rules file, no business
 *   writing one.
 *
 * The rule is standing infrastructure, not a preference: there is no setting to
 * turn it off, and uninstalling it is System Settings → Window Management →
 * Window Rules, where it appears under its description like any other. The
 * removal half of the merge stays exercised by the tests and is one call away if
 * a cleanup path is ever wanted.
 *
 * The matching is by window *title*, because under XWayland Chromium's
 * picture-in-picture window carries no `WM_CLASS` and no window role —
 * measured; the title is the only handle it offers. That is a slightly broad
 * match: another Chromium-based browser's PiP window uses the same title and
 * would be lifted too. Narrower is not available, and the failure mode is
 * "another video window also stays on top", which is what someone watching a
 * show over a game wants anyway.
 */

import { execFile } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Our group name in `kwinrulesrc`. A fixed UUID because that is the shape KDE's
 * own rules editor writes and expects; it never changes, which is what makes
 * every write idempotent.
 */
export const PIP_RULE_ID = 'b7c1f0d2-5a3e-4a91-9f2b-rerun-tv-pip00'

/** What Chromium titles the floating window. The only thing it can be matched on. */
export const PIP_WINDOW_TITLE = 'Picture in picture'

/**
 * The rule itself.
 *
 * `layer=overlay` + `layerrule=2` is Force → Overlay, the pair KDE's editor
 * writes for that combination. `titlematch=1` is an exact title match and
 * `types=1` is "normal window"; `wmclassmatch` is deliberately absent, which is
 * the file's way of spelling "window class: unimportant".
 */
function ruleBody(): string[] {
  return [
    'Description=Rerun TV — picture-in-picture above full-screen windows',
    'layer=overlay',
    'layerrule=2',
    `title=${PIP_WINDOW_TITLE}`,
    'titlematch=1',
    'types=1'
  ]
}

export function kwinRulesPath(env: NodeJS.ProcessEnv = process.env): string {
  const config = env['XDG_CONFIG_HOME'] || join(homedir(), '.config')
  return join(config, 'kwinrulesrc')
}

/** KWin is the only compositor with this concept, so this is the whole gate. */
export function isKwinSession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== 'linux') return false
  const desktop = `${env['XDG_CURRENT_DESKTOP'] ?? ''} ${env['XDG_SESSION_DESKTOP'] ?? ''}`
  return /kde|plasma/i.test(desktop)
}

// ---------------------------------------------------------------------------
// The INI, edited as text
// ---------------------------------------------------------------------------

interface IniGroup {
  name: string
  lines: string[]
}

/**
 * Parsed as a list of groups rather than a map: `kwinrulesrc` is an ordered file
 * a human reads in System Settings, and rewriting it as a normalised map would
 * reorder and re-case keys we never meant to touch.
 */
function parseGroups(text: string): IniGroup[] {
  const groups: IniGroup[] = []
  let current: IniGroup | null = null
  for (const line of text.split('\n')) {
    const header = /^\[(.+)\]\s*$/.exec(line.trim())
    if (header) {
      current = { name: header[1], lines: [] }
      groups.push(current)
    } else if (current) {
      current.lines.push(line)
    }
    // Anything before the first header is a stray comment; dropping it is the
    // only lossy case, and KConfig never writes one.
  }
  return groups
}

function render(groups: IniGroup[]): string {
  const chunks = groups.map((group) => {
    const body = group.lines.join('\n').replace(/\s+$/, '')
    return body === '' ? `[${group.name}]\n` : `[${group.name}]\n${body}\n`
  })
  return `${chunks.join('\n')}`
}

/**
 * Add or remove our rule, leaving every other byte of the file alone.
 *
 * Exported and pure so the whole merge — the part with a way to be wrong — is
 * testable without a KDE session or a filesystem.
 */
export function applyPipRule(existing: string, enabled: boolean): string {
  const groups = parseGroups(existing).filter((group) => group.name !== PIP_RULE_ID)

  if (enabled) {
    // Appended after the other rules and before `[General]` is not required by
    // KConfig, but it keeps the file looking like one KDE wrote.
    const generalAt = groups.findIndex((group) => group.name === 'General')
    const rule: IniGroup = { name: PIP_RULE_ID, lines: ruleBody() }
    if (generalAt === -1) groups.push(rule)
    else groups.splice(generalAt, 0, rule)
  }

  // `[General]` indexes the rules; a rule KWin cannot find in that list is a
  // rule it will not apply, however correct the group itself is.
  const ids = groups.filter((group) => group.name !== 'General').map((group) => group.name)
  let general = groups.find((group) => group.name === 'General')
  if (!general) {
    general = { name: 'General', lines: [] }
    groups.push(general)
  }
  general.lines = [`count=${ids.length}`, `rules=${ids.join(',')}`]

  // A file whose only rule was ours, now removed, should be an empty file rather
  // than an orphaned `[General]` claiming zero rules.
  if (ids.length === 0) return ''
  return render(groups)
}

// ---------------------------------------------------------------------------
// Talking to KWin
// ---------------------------------------------------------------------------

/**
 * Ask KWin to re-read its configuration. Fire-and-forget on purpose: the rule is
 * on disk either way and will be picked up at the next login, so a compositor
 * that does not answer is a delay, not a failure.
 */
function reconfigureKwin(): void {
  execFile(
    'dbus-send',
    [
      '--session',
      '--type=method_call',
      '--dest=org.kde.KWin',
      '/KWin',
      'org.kde.KWin.reconfigure'
    ],
    (error) => {
      if (error) console.warn('[kwin] could not ask KWin to reload its rules:', error.message)
    }
  )
}

/**
 * Write the rule, or take it away. Safe to call on every boot.
 *
 * Returns whether the file was actually changed, which is the only reason to
 * disturb KWin. Never throws: this is a nicety layered on a nicety, and a
 * read-only config directory must not stop the television from starting.
 *
 * `ensureKwinPipRule()` is the caller boot uses; `enabled: false` is kept for
 * the tests and for whoever eventually wants an uninstall path.
 */
export function syncKwinPipRule(
  enabled: boolean,
  path = kwinRulesPath(),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!isKwinSession(env)) return false

  let existing = ''
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    // No file yet: KDE writes one the first time a rule is made, and so do we.
  }

  let updated: string
  try {
    updated = applyPipRule(existing, enabled)
  } catch (error) {
    console.warn('[kwin] could not merge the picture-in-picture rule:', error)
    return false
  }
  if (updated === existing) return false

  try {
    // Through a temporary file: a half-written `kwinrulesrc` would take the
    // viewer's own rules with it.
    const temp = `${path}.rerun-tmp`
    writeFileSync(temp, updated, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    console.warn('[kwin] could not write the picture-in-picture rule:', error)
    return false
  }

  console.info(
    enabled
      ? '[kwin] installed the picture-in-picture window rule (overlay layer)'
      : '[kwin] removed the picture-in-picture window rule'
  )
  reconfigureKwin()
  return true
}

/**
 * Install the rule. What boot calls, on every session and every platform.
 *
 * Unconditional by design: the rule is how picture-in-picture stays above a
 * full-screen window at all, it is the same rule whether Chromium spoke Wayland
 * or X11 to get here, and `isKwinSession` already declines everywhere it would
 * mean nothing.
 */
export function ensureKwinPipRule(
  path = kwinRulesPath(),
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return syncKwinPipRule(true, path, env)
}
