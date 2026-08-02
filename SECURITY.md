# Security

## Reporting a vulnerability

Please report security issues privately via GitHub's
[private vulnerability reporting](https://github.com/NathanSMB/rerun-tv/security/advisories/new)
rather than in a public issue. I'll acknowledge within a week.

## What the threat model actually is

Rerun TV is a local, single-user desktop app. It has no accounts, no network
service reachable off the machine, and no telemetry. That said, three things are
deliberate and worth knowing:

- **The renderer is fully isolated.** `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, in-window navigation denied, and
  `window.open` restricted to `http(s)`. The renderer reaches the main process
  only through a fixed, typed set of IPC channels in `src/preload/index.ts` —
  there is no general `ipcRenderer` on the page.

- **The stream server is loopback-only and keyed.** It binds 127.0.0.1, rejects
  a non-loopback `Host` (DNS rebinding), routes on **episode ids** rather than
  filesystem paths, and requires a random per-boot key on every URL. The key is
  what keeps out callers that loopback alone doesn't exclude: another process on
  the same machine, or a page in your browser, whose `Host` is legitimately
  loopback. The key is never persisted.

- **ffmpeg is never invoked through a shell.** Arguments are passed as an argv
  array, and the file paths come from rows the scanner wrote — not from anything
  the renderer supplies.

## Out of scope

- Anything requiring an attacker who already runs code as your user. At that
  point they can read your media directly.
- LAN exposure: there isn't any. If that changes, this file changes with it.
- ffmpeg's own vulnerabilities — it is the system binary, and is not bundled or
  redistributed here. Keep it updated through your distribution.
