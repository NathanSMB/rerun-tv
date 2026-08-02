#!/usr/bin/env node
/**
 * The playback soak harness (docs/stall-fix-plan.html, "Verification & rollout").
 *
 * This is the rig that found the stall bug, promoted into a regression test. It
 * drives the real app over the Chrome DevTools Protocol: tunes in, plays several
 * episodes at an accelerated rate, and fails if playback ever stalls or if a
 * channel spawns more encoders than it should.
 *
 * Two failure signatures matter, and they are the two the investigation found:
 *
 *  1. **A stall.** `currentTime` stops moving while the element is unpaused and
 *     not seeking. Before the fix these ran to 159 seconds.
 *  2. **A phantom encoder.** Chromium dropping and re-requesting a stream is
 *     invisible from inside the page — the only tell is a *second* ffmpeg for the
 *     same episode. The investigation counted 14 encoders across 6 episodes where
 *     there should have been 6.
 *
 * It is deliberately not part of `npm test`: it needs a real library, a display,
 * and minutes rather than milliseconds. Run `npm run build` first — it drives the
 * built app in `dist/`, not the dev server — and `npm run rebuild:electron`, since
 * `npm test` leaves `better-sqlite3` on the Node ABI and the app will not boot on
 * that.
 *
 *   node scripts/soak.mjs                     # 6 episodes at 8×, channel 1
 *   node scripts/soak.mjs --episodes 12 --rate 4 --channel 3
 *   node scripts/soak.mjs --max-stall 3 --keep-open
 *   node scripts/soak.mjs --eval 'document.title'   # see below
 *
 * A run prints one line per episode:
 *
 *   [soak] episode 1/4 — id 317
 *   [soak]   buffered ahead 4–66s · peak encoders 1
 *
 * **`peak encoders 1` is the number to read.** One encoder for a whole episode is
 * the fix working. Two is legal during a handoff (current plus prewarming). A
 * sustained three or more is the original bug back: a stream was dropped and
 * silently re-requested. `buffered ahead` should sit in the 15–60s band, give or
 * take one fragment of overshoot at the top and a low reading right after a swap.
 *
 * `--eval '<expression>'` is the debugging mode, and the reason the harness is
 * worth more than its test-runner role: it attaches to the real renderer, runs one
 * expression (awaiting a promise if you return one), and prints the result as
 * JSON. Bisecting an MSE initialisation segment inside the real app is how all
 * three constraints in docs/playback.md were found; none of them were guessable
 * from the spec. It uses `globalThis.__rerunStore` (exposed in
 * `renderer/src/main.tsx`) to drive the app rather than poking at the DOM.
 *
 * With the app *already running* under `--remote-debugging-port=N`, point the
 * harness at it and stop it launching a second copy:
 *
 *   RERUN_SOAK_BIN=/bin/true node scripts/soak.mjs --port N --eval '…'
 *
 * Exits 0 on a clean run, 1 on any violation, 2 if it could not get started,
 * 130 if interrupted.
 *
 * Environment:
 *   RERUN_SOAK_BIN   launch command; default `npx electron .`
 *   RERUN_SOAK_ARGS  space-separated args for it (only used with RERUN_SOAK_BIN)
 *   XDG_DATA_HOME    where the app keeps its database — see `dataDir()` in
 *                    `main/paths.ts`. Point it at a directory holding a
 *                    `rerun-tv/library.db` you don't mind touching and the soak
 *                    cannot affect your real library. Note it does *not* copy
 *                    anything for you: an empty directory means an empty library
 *                    and the run fails with "no channel numbered N".
 *   HEADLESS=1       run under `xvfb-run`. Chromium's media stack behaves
 *                    differently without a real compositor, so a headed run is
 *                    the trustworthy one.
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeSync } from "node:fs";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const options = {
        episodes: 6,
        /** `playbackRate`. 8× turns a 3-hour soak into ~20 minutes. */
        rate: 8,
        channel: 1,
        /** Seconds of frozen `currentTime` that counts as a stall. */
        maxStall: 3,
        /** Encoders one channel may own. Two is legal during a prewarmed handoff. */
        maxEncoders: 2,
        port: 9222,
        /** Give up on a single episode after this long. */
        episodeTimeoutS: 900,
        keepOpen: false,
        /** Evaluate one expression in the renderer and print it, instead of soaking. */
        evaluate: null,
    };
    for (let i = 2; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        switch (flag) {
            case "--episodes":
            case "--rate":
            case "--channel":
            case "--max-stall":
            case "--max-encoders":
            case "--port":
            case "--episode-timeout": {
                const key = {
                    "--episodes": "episodes",
                    "--rate": "rate",
                    "--channel": "channel",
                    "--max-stall": "maxStall",
                    "--max-encoders": "maxEncoders",
                    "--port": "port",
                    "--episode-timeout": "episodeTimeoutS",
                }[flag];
                options[key] = Number(value);
                i++;
                break;
            }
            case "--keep-open":
                options.keepOpen = true;
                break;
            case "--eval":
                options.evaluate = value;
                i++;
                break;
            case "--help":
            case "-h":
                console.log(
                    [
                        "usage: node scripts/soak.mjs [options]",
                        "",
                        "  --episodes N          episodes to play (default 6)",
                        "  --rate N              playbackRate; 8 turns a 3-hour soak into ~20 min (default 8)",
                        "  --channel N           dial number to tune (default 1)",
                        "  --max-stall S         seconds of frozen playback that fails the run (default 3)",
                        "  --max-encoders N      encoders one channel may own (default 2: on air + prewarming)",
                        "  --episode-timeout S   give up on one episode after this long (default 900)",
                        "  --port N              debugger port (default 9222)",
                        "  --keep-open           leave the app running afterwards",
                        "  --eval <expression>   attach, evaluate one expression, print it as JSON,",
                        "                        and exit — the debugging mode; see the file header",
                        "",
                        "Needs `npm run build` and `npm run rebuild:electron` first.",
                        "See docs/development.md for reading the output and for sandboxing the library.",
                    ].join("\n"),
                );
                process.exit(0);
                break;
            default:
                fail(2, `unknown flag ${flag}`);
        }
    }
    return options;
}

/**
 * A giving-up condition: could not launch, could not attach, no such channel.
 *
 * Thrown rather than `process.exit`ed, for two reasons that both bit during
 * development. `process.exit` discards buffered stdout, so piping the harness
 * through `grep` lost the very message explaining the failure; and it skips the
 * `finally` that kills the app, stranding an Electron and its encoders to
 * confuse the *next* run's numbers.
 */
class SoakError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "SoakError";
        this.code = code;
    }
}

function fail(code, message) {
    throw new SoakError(code, message);
}

const log = (message) => console.log(`[soak] ${message}`);

// ---------------------------------------------------------------------------
// A very small CDP client
// ---------------------------------------------------------------------------

/**
 * Rather than take a WebSocket dependency, speak the protocol by hand. The
 * handshake and the frame format are both tiny, and a soak harness that pulls in
 * a dependency tree is a soak harness nobody runs.
 */
class Cdp {
    #socket;
    #nextId = 1;
    #pending = new Map();
    #buffer = Buffer.alloc(0);

    static async connect(wsUrl) {
        const url = new URL(wsUrl);
        const socket = createConnection({
            host: url.hostname,
            port: Number(url.port || 80),
        });
        await once(socket, "connect");

        const key = Buffer.from(
            Array.from({ length: 16 }, (_, i) => (i * 37 + 11) % 256),
        ).toString("base64");
        socket.write(
            `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
                `Host: ${url.host}\r\n` +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                `Sec-WebSocket-Key: ${key}\r\n` +
                "Sec-WebSocket-Version: 13\r\n\r\n",
        );

        // Read until the end of the HTTP upgrade response, keeping any frame bytes
        // that arrived in the same packet.
        let head = Buffer.alloc(0);
        while (true) {
            const [chunk] = await once(socket, "data");
            head = Buffer.concat([head, chunk]);
            const end = head.indexOf("\r\n\r\n");
            if (end !== -1) {
                if (!head.subarray(0, end).toString("latin1").includes("101")) {
                    throw new Error(
                        `the debugger refused the upgrade: ${head.subarray(0, end)}`,
                    );
                }
                const client = new Cdp(socket);
                client.#feed(head.subarray(end + 4));
                return client;
            }
        }
    }

    /** Protocol events, by method. The harness only listens for console output. */
    #listeners = new Map();

    constructor(socket) {
        this.#socket = socket;
        socket.on("data", (chunk) => this.#feed(chunk));
        socket.on("close", () => {
            for (const { reject } of this.#pending.values()) {
                reject(new Error("the debugger connection closed"));
            }
            this.#pending.clear();
        });
        socket.on("error", () => {
            /* Surfaced through the pending rejections above. */
        });
    }

    /** Subscribe to a protocol event, e.g. `Runtime.consoleAPICalled`. */
    on(method, handler) {
        this.#listeners.set(method, handler);
    }

    send(method, params = {}) {
        const id = this.#nextId++;
        const payload = JSON.stringify({ id, method, params });
        this.#writeFrame(payload);
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
        });
    }

    /**
     * Evaluate an expression in the page and return its value.
     *
     * `userGesture` is on so `--eval` can reach the APIs Chromium gates behind
     * user activation — `requestPictureInPicture()` and `requestFullscreen()`,
     * neither of which can be driven from a bare evaluate. The cost is that this
     * harness cannot observe the *absence* of activation; that rule is pinned in
     * `tests/renderer/pip.test.tsx`, where the model enforces it.
     */
    async evaluate(expression) {
        const result = await this.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,
        });
        if (result.exceptionDetails) {
            throw new Error(
                `page threw: ${result.exceptionDetails.exception?.description ?? "unknown"}`,
            );
        }
        return result.result?.value;
    }

    close() {
        this.#socket.destroy();
    }

    // ---- framing ----------------------------------------------------------

    #writeFrame(text) {
        const body = Buffer.from(text, "utf8");
        const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
        let header;
        if (body.length < 126) {
            header = Buffer.from([0x81, 0x80 | body.length]);
        } else if (body.length < 65536) {
            header = Buffer.from([
                0x81,
                0xfe,
                body.length >> 8,
                body.length & 0xff,
            ]);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x81;
            header[1] = 0xff;
            header.writeUInt32BE(0, 2);
            header.writeUInt32BE(body.length, 6);
        }
        const masked = Buffer.from(body);
        for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
        this.#socket.write(Buffer.concat([header, mask, masked]));
    }

    #feed(chunk) {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        for (;;) {
            const frame = this.#readFrame();
            if (!frame) return;
            if (frame.opcode === 0x8) {
                this.#socket.destroy();
                return;
            }
            if (frame.opcode !== 0x1) continue;
            let message;
            try {
                message = JSON.parse(frame.payload.toString("utf8"));
            } catch {
                continue;
            }
            if (message.id === undefined) {
                // Playback state is polled; only the page's own diagnostics are pushed,
                // and those are worth having when a run fails.
                this.#listeners.get(message.method)?.(message.params ?? {});
                continue;
            }
            const pending = this.#pending.get(message.id);
            if (!pending) continue;
            this.#pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
        }
    }

    #readFrame() {
        const buffer = this.#buffer;
        if (buffer.length < 2) return null;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let at = 2;
        if (length === 126) {
            if (buffer.length < at + 2) return null;
            length = buffer.readUInt16BE(at);
            at += 2;
        } else if (length === 127) {
            if (buffer.length < at + 8) return null;
            length = Number(buffer.readBigUInt64BE(at));
            at += 8;
        }
        // The server never masks, but honour the bit rather than corrupt a payload.
        const maskKey = masked ? buffer.subarray(at, at + 4) : null;
        if (masked) at += 4;
        if (buffer.length < at + length) return null;

        const payload = Buffer.from(buffer.subarray(at, at + length));
        if (maskKey)
            for (let i = 0; i < payload.length; i++)
                payload[i] ^= maskKey[i % 4];
        this.#buffer = buffer.subarray(at + length);
        return { opcode, payload };
    }
}

// ---------------------------------------------------------------------------
// Launching, and finding the renderer target
// ---------------------------------------------------------------------------

function launch(options) {
    // Default: the local Electron on the built `dist/` tree, which is what `main` in
    // package.json points at — so `npm run build` first.
    const command = process.env.RERUN_SOAK_BIN ?? "npx";
    const leading = process.env.RERUN_SOAK_BIN
        ? (process.env.RERUN_SOAK_ARGS ?? "").split(" ").filter(Boolean)
        : ["electron", "."];
    const args = [
        ...leading,
        `--remote-debugging-port=${options.port}`,
        "--mute-audio",
    ];

    /**
     * `ELECTRON_RUN_AS_NODE` makes the Electron binary boot as a plain Node
     * interpreter: no window, no renderer, no debugger port — and no message saying
     * so. Some shells and tool wrappers export it, and inheriting it here is
     * indistinguishable from the app failing to start.
     */
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    const useXvfb = process.env.HEADLESS === "1";
    const child = spawn(
        useXvfb ? "xvfb-run" : command,
        useXvfb ? ["-a", command, ...args] : args,
        { stdio: ["ignore", "inherit", "inherit"], env },
    );
    child.on("error", (err) =>
        fail(2, `could not launch the app: ${err.message}`),
    );
    return child;
}

/**
 * Poll `/json/list` until *our* renderer shows up.
 *
 * Matched on the URL rather than taking the first page: an Electron that was
 * handed no app path serves its own default page, which would otherwise look like
 * a successful attach and then fail confusingly at the first `evaluate`.
 */
async function findRenderer(port, deadlineMs) {
    while (Date.now() < deadlineMs) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            const targets = await response.json();
            const page = targets.find(
                (target) =>
                    target.type === "page" &&
                    typeof target.webSocketDebuggerUrl === "string" &&
                    /^app:\/\/|\/renderer\/index\.html|localhost:\d+/.test(
                        target.url ?? "",
                    ),
            );
            if (page) return page.webSocketDebuggerUrl;
        } catch {
            /* The debugger isn't listening yet. */
        }
        await sleep(400);
    }
    return null;
}

// ---------------------------------------------------------------------------
// Encoder counting
// ---------------------------------------------------------------------------

/**
 * How many of our encoders are running right now.
 *
 * This is the measurement that mattered: Chromium dropping a stream and silently
 * re-requesting it is invisible from inside the page, and the *only* tell is a
 * second ffmpeg for an episode that already had one. The investigation counted 14
 * across 6 episodes.
 *
 * Identified by argv[0] being an ffmpeg *and* the command line carrying our exact
 * `-movflags`. Both halves are needed: matching the flags alone also matches any
 * shell whose command line happens to mention them — including, embarrassingly,
 * a `pgrep` invocation looking for them.
 *
 * It will still count an unrelated fragmented-MP4 ffmpeg if you happen to be
 * running one. This is a harness, not an accountant.
 */
function countEncoders() {
    const out = spawnSync("ps", ["-eo", "args="], { encoding: "utf8" });
    if (!out.stdout) return 0;
    return out.stdout
        .split("\n")
        .filter(
            (line) =>
                /^\S*\bffmpeg\S*\s/.test(line) &&
                line.includes("frag_keyframe+empty_moov"),
        ).length;
}

// ---------------------------------------------------------------------------
// The soak
// ---------------------------------------------------------------------------

/** Everything the harness can see about playback, in one round trip. */
const PROBE = `(() => {
  const store = globalThis.__rerunStore
  const video = document.querySelector('.stage .video.is-active')
  const buffered = (() => {
    if (!video || video.buffered.length === 0) return 0
    const t = video.currentTime
    for (let i = 0; i < video.buffered.length; i++) {
      if (t >= video.buffered.start(i) - 0.5 && t <= video.buffered.end(i)) {
        return video.buffered.end(i) - t
      }
    }
    return 0
  })()
  return {
    hasVideo: video != null,
    currentTime: video ? video.currentTime : 0,
    paused: video ? video.paused : true,
    seeking: video ? video.seeking : false,
    readyState: video ? video.readyState : 0,
    error: video && video.error ? video.error.code : null,
    errorMessage: video && video.error ? video.error.message : null,
    bufferedAhead: buffered,
    videos: document.querySelectorAll('.stage .video').length,
    episodeId: store ? (store.getState().nowPlaying?.episode.id ?? null) : null,
    pendingId: store ? (store.getState().pendingNext?.episode.id ?? null) : null
  }
})()`;

async function soak(cdp, options) {
    const violations = [];
    const seenEpisodes = [];
    /** Peak encoder count observed while a single episode was on air. */
    let peakEncoders = 0;

    await cdp.send("Runtime.enable");

    /**
     * The page's own warnings and errors, echoed as they happen.
     *
     * `VideoSurface` logs the reason whenever a stream defeats the MSE parser and
     * falls back — which is a *silent* degradation from the outside, and exactly the
     * kind of thing a soak run needs to surface rather than pass over.
     */
    cdp.on("Runtime.consoleAPICalled", (event) => {
        if (event.type !== "error" && event.type !== "warning") return;
        const text = (event.args ?? [])
            .map((arg) => arg.value ?? arg.description ?? "")
            .join(" ")
            .trim();
        if (text) console.error(`  [page ${event.type}] ${text}`);
    });
    cdp.on("Runtime.exceptionThrown", (event) => {
        const details = event.exceptionDetails ?? {};
        console.error(
            `  [page exception] ${details.exception?.description ?? details.text ?? "unknown"}`,
        );
    });

    log(`tuning channel ${options.channel}`);
    const tuned = await cdp.evaluate(`(async () => {
    const store = globalThis.__rerunStore
    if (!store) return 'no store on the page — is this a Rerun TV renderer?'
    const channel = store.getState().channels.find((c) => c.channel.number === ${options.channel})
    if (!channel) return 'no channel numbered ${options.channel}'
    await store.getState().tune(channel.channel.id)
    return null
  })()`);
    if (tuned) fail(2, tuned);

    /**
     * The episode the previous iteration watched. Carried across iterations because
     * the store advances a beat after the element ends, and without this the next
     * iteration re-reads the old id and reports one episode as two.
     */
    let lastEpisodeId = null;
    /** Consecutive polls that saw more encoders than the budget allows. */
    let overBudgetPolls = 0;

    for (let index = 0; index < options.episodes; index++) {
        const started = Date.now();
        let previousTime = -1;
        let frozenSince = null;
        let episodeId = null;
        let maxBuffered = 0;
        let minBuffered = Infinity;

        // Accelerate. Re-applied every poll because a source swap resets it.
        const applyRate = `(() => {
      for (const v of document.querySelectorAll('.stage .video')) {
        if (v.classList.contains('is-active')) v.playbackRate = ${options.rate}
      }
    })()`;

        for (;;) {
            await cdp.evaluate(applyRate);
            const probe = await cdp.evaluate(PROBE);

            if (probe.error !== null) {
                violations.push(
                    `episode ${probe.episodeId}: media error ${probe.error}` +
                        (probe.errorMessage ? ` — ${probe.errorMessage}` : ""),
                );
                break;
            }
            if (episodeId === null) {
                // Wait for the store to actually be on a new episode before measuring
                // anything, or the handoff's one-poll lag counts one episode twice.
                if (
                    probe.episodeId === null ||
                    probe.episodeId === lastEpisodeId
                ) {
                    await sleep(200);
                    continue;
                }
                episodeId = probe.episodeId;
                lastEpisodeId = episodeId;
                seenEpisodes.push(episodeId);
                log(
                    `episode ${index + 1}/${options.episodes} — id ${episodeId}`,
                );
            }
            // The store advanced: this episode is done.
            if (probe.episodeId !== episodeId) break;

            if (probe.hasVideo && !probe.paused && !probe.seeking) {
                if (probe.currentTime > previousTime + 0.01) {
                    previousTime = probe.currentTime;
                    frozenSince = null;
                } else if (frozenSince === null) {
                    frozenSince = Date.now();
                } else {
                    const stalledS = (Date.now() - frozenSince) / 1000;
                    if (stalledS > options.maxStall) {
                        violations.push(
                            `episode ${episodeId}: playback frozen ${stalledS.toFixed(1)}s at ` +
                                `${probe.currentTime.toFixed(1)}s (buffered ahead ${probe.bufferedAhead.toFixed(1)}s)`,
                        );
                        frozenSince = Date.now();
                    }
                }
                maxBuffered = Math.max(maxBuffered, probe.bufferedAhead);
                minBuffered = Math.min(minBuffered, probe.bufferedAhead);
            }

            /**
             * A transient overshoot is normal and not a bug: the supervisor SIGTERMs an
             * outgoing encoder and gives it 750ms before SIGKILL, so a dying job is
             * still in `ps` for a moment during every handoff. A *phantom* encoder — the
             * signature this harness exists to catch — lives for the rest of the
             * episode, so require the overshoot to persist across several polls.
             */
            const encoders = countEncoders();
            peakEncoders = Math.max(peakEncoders, encoders);
            overBudgetPolls =
                encoders > options.maxEncoders ? overBudgetPolls + 1 : 0;
            if (overBudgetPolls === 4) {
                violations.push(
                    `episode ${episodeId}: ${encoders} encoders running for over 2s, budget is ` +
                        `${options.maxEncoders} (one on air plus one prewarming) — a stream was ` +
                        "dropped and re-requested",
                );
            }

            if ((Date.now() - started) / 1000 > options.episodeTimeoutS) {
                violations.push(
                    `episode ${episodeId}: did not finish within ${options.episodeTimeoutS}s`,
                );
                break;
            }
            await sleep(500);
        }

        if (minBuffered !== Infinity) {
            log(
                `  buffered ahead ${minBuffered.toFixed(0)}–${maxBuffered.toFixed(0)}s · ` +
                    `peak encoders ${peakEncoders}`,
            );
        }
    }

    log(
        `peak encoders seen: ${peakEncoders} (budget ${options.maxEncoders} + dying jobs)`,
    );

    const repeats = seenEpisodes.length - new Set(seenEpisodes).size;
    if (repeats > 0) {
        violations.push(
            `${repeats} episode(s) aired twice — the schedule is double-advancing`,
        );
    }

    return { violations, seenEpisodes };
}

// ---------------------------------------------------------------------------

async function main() {
    const options = parseArgs(process.argv);
    if (options.evaluate === null) {
        log(
            `${options.episodes} episodes at ${options.rate}× on channel ${options.channel}; ` +
                `failing on any stall over ${options.maxStall}s`,
        );
    }

    const app = launch(options);
    let cdp = null;
    let exitCode = 1;

    /**
     * A killed harness must still take the app — and its encoders — with it.
     * Without this, `timeout`-ing a run leaves an Electron and an ffmpeg behind,
     * which then poison the next run's encoder count.
     */
    const bail = (signal) => {
        // `writeSync`, not console.error: this path ends in `process.exit`, which
        // throws away anything still sitting in a piped stdout buffer.
        writeSync(2, `\nsoak: interrupted by ${signal}\n`);
        cdp?.close();
        app.kill("SIGKILL");
        process.exit(130);
    };
    process.once("SIGINT", () => bail("SIGINT"));
    process.once("SIGTERM", () => bail("SIGTERM"));

    try {
        const wsUrl = await findRenderer(options.port, Date.now() + 60_000);
        if (!wsUrl) {
            fail(2, `no debugger target on port ${options.port} after 60s`);
        }
        cdp = await Cdp.connect(wsUrl);

        // The renderer has to be ready before we can drive the store.
        for (let attempt = 0; attempt < 120; attempt++) {
            const ready = await cdp
                .evaluate("Boolean(globalThis.__rerunStore?.getState().ready)")
                .catch(() => false);
            if (ready) break;
            if (attempt === 119) fail(2, "the renderer never became ready");
            await sleep(500);
        }

        // `--eval` is the debugging escape hatch: attach to the real renderer, run one
        // expression, print it. It is how the MediaSource attachment question got
        // answered against real Electron instead of guessed at.
        if (options.evaluate !== null) {
            await cdp.send("Runtime.enable");
            console.log(
                JSON.stringify(await cdp.evaluate(options.evaluate), null, 2),
            );
            exitCode = 0;
        } else {
            const { violations, seenEpisodes } = await soak(cdp, options);

            console.log("");
            log(`played ${seenEpisodes.length} episode(s)`);
            if (violations.length === 0) {
                log("PASS — no stalls, no phantom encoders, no repeats");
                exitCode = 0;
            } else {
                log(`FAIL — ${violations.length} violation(s):`);
                for (const violation of violations)
                    console.error(`  · ${violation}`);
            }
        }
    } catch (err) {
        console.error(
            `soak: ${err instanceof Error ? err.message : String(err)}`,
        );
        exitCode = err instanceof SoakError ? err.code : 2;
    } finally {
        cdp?.close();
        if (!options.keepOpen) {
            app.kill("SIGTERM");
            // Give Electron a moment to take its ffmpeg children with it.
            await sleep(1500);
            if (app.exitCode === null) app.kill("SIGKILL");
        }
    }

    // `process.exitCode` rather than `process.exit()`: exiting outright truncates a
    // piped stdout, which silently swallowed the failure message whenever this was
    // run through `grep`. The timer is only a backstop against some stray handle
    // hanging a CI run, and is unref'd so it never delays a clean exit.
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), 5000).unref();
}

await main();
