#!/usr/bin/env node
/**
 * `npm run dev`, with the window-system setting applied.
 *
 * ## Why the dev server has to be the one to do this
 *
 * "Keep picture-in-picture above other windows" chooses whether Chromium talks
 * to Wayland or to XWayland, because a Wayland client cannot raise itself above
 * other windows (docs/ui.md). Chromium picks that backend during browser-process
 * startup — before the main script runs — so the only way for the app to apply
 * the setting is to start again with `--ozone-platform` on the real command
 * line, which `main/index.ts` does.
 *
 * It cannot do that here. `electron-vite dev` runs the renderer's dev server and
 * launches Electron as its child, and treats that child exiting as "the app was
 * closed": a relaunch takes the dev server down with it and the replacement
 * window comes up pointed at a `localhost` that has stopped listening — a blank
 * app. So the app deliberately skips the relaunch when it is supervised
 * (`boot-config.ts`, `isSupervisedRun`), and the supervisor gets the platform
 * right instead. That is this file.
 *
 * ## The duplication
 *
 * The three-line rule below is a copy of `ozonePlatformOverride()`. It is a copy
 * on purpose: this runs before anything is compiled, and importing the real one
 * would mean a TypeScript loader in the dev path to save three lines. If the
 * rule changes, it changes in both places — `boot-config.ts` is the original.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Mirror of the app's boot config; missing or corrupt means "use the default". */
function keepOnTop() {
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  try {
    const parsed = JSON.parse(readFileSync(join(xdg, 'rerun-tv', 'boot.json'), 'utf8'))
    return parsed?.pipKeepOnTop !== false
  } catch {
    return true // the shipped default
  }
}

/*
 * Everything after a `--` is what electron-vite hands to Electron (it forwards
 * them through `ELECTRON_CLI_ARGS`). Anything before it is electron-vite's own,
 * and it rejects options it does not recognise — so the flag cannot simply be
 * appended to the command line, and `ELECTRON_OZONE_PLATFORM_HINT` is no help
 * either: this Electron ignores it outright. Measured on 38.8.6 — the hint left
 * the app on Wayland, the flag put it on X11.
 */
const passthrough = process.argv.slice(2)
const separator = passthrough.indexOf('--')
const viteArgs = separator === -1 ? passthrough : passthrough.slice(0, separator)
const electronArgs = separator === -1 ? [] : passthrough.slice(separator + 1)

const wayland =
  process.platform === 'linux' &&
  (process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY))
const chosen = electronArgs.some((arg) => arg.startsWith('--ozone-platform'))

if (!chosen && wayland && keepOnTop()) {
  // The same flag the packaged app relaunches itself with. Turning the setting
  // off in Settings leaves this alone, and dev runs on native Wayland.
  electronArgs.push('--ozone-platform=x11')
  console.log(
    '[dev] running on XWayland so picture-in-picture can stay on top ' +
      '(Settings → "Keep picture-in-picture above other windows")'
  )
}

const args = ['dev', ...viteArgs, ...(electronArgs.length > 0 ? ['--', ...electronArgs] : [])]
const bin = join('node_modules', '.bin', 'electron-vite')
const child = spawn(process.platform === 'win32' ? `${bin}.cmd` : bin, args, {
  stdio: 'inherit'
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
