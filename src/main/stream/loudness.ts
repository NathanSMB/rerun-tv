/**
 * Loudness equalization (docs/playback.md, "Loudness equalization").
 *
 * Two different complaints, one filter chain:
 *
 * - **Across episodes.** A library is mastered by whoever ripped it. Web
 *   downloads land near modern streaming targets, disc rips sit 5–8 LU quieter,
 *   broadcast captures are anywhere at all — so the volume knob is wrong every
 *   time the schedule crosses a source boundary.
 * - **Within one episode.** Dialogue sits 10–15 LU below the action peaks, which
 *   a single gain change cannot fix: it moves the whole curve at once.
 *
 * `loudnorm` in its **dynamic** mode answers both. It measures continuously and
 * adapts its gain toward the target, so a quiet rip comes up, a hot one comes
 * down, and inside an episode the soft scenes are lifted while the loud ones are
 * held near target. That is the whole of phase 1, and it needs nothing measured
 * in advance.
 *
 * Phase 2 adds the part dynamic mode cannot do: **start correct**. Dynamic mode
 * converges over the first few seconds from an assumption, and since a seek
 * respawns ffmpeg, that opening wobble is paid again on every scrub. So the
 * background scanner measures each episode once and we put a fixed
 * `volume=<offset>dB` *in front of* loudnorm. The input then arrives already at
 * target, which makes frame one right and leaves loudnorm's dynamic gain sitting
 * near unity, doing only the within-episode work.
 *
 * (The obvious-looking alternative — feeding the measured numbers to loudnorm as
 * `measured_I`/`measured_TP`/… — does the wrong thing here. Those options exist
 * to enable **linear** mode, a single scale factor applied to the whole file:
 * that fixes the cross-episode half and throws away the within-episode half. In
 * dynamic mode ffmpeg ignores them entirely. Hence `linear=false` below, spelled
 * out rather than left to the default, and the pre-gain carried by `volume`.)
 */

import { spawn } from "node:child_process";
import { loudnessEqApplies } from "@shared/playback.js";
import type { AppSettings, LoudnessMeasurement } from "@shared/types.js";

/**
 * The target, in EBU R128 terms.
 *
 * −16 LUFS is the streaming-platform convention and the right choice for
 * near-field listening; broadcast's −23 LUFS assumes a cinema-ish playback chain
 * and would leave everything sounding quiet on a desk or a TV's own speakers.
 * −1.5 dBTP keeps headroom for the AAC encoder, whose reconstructed waveform can
 * overshoot the samples it was given. LRA 11 is a conservative loudness range:
 * enough levelling to rescue dialogue, not so much that everything is squashed
 * flat.
 */
export const LOUDNESS_TARGET_I = -16;
export const LOUDNESS_TARGET_TP = -1.5;
export const LOUDNESS_TARGET_LRA = 11;

/**
 * The one `loudnorm` spelling, shared by playback and by the measuring pass so
 * the numbers we store are the numbers the filter would have measured itself.
 *
 * `dual_mono=true` matters for a rerun library specifically: R128 measures a
 * mono track ~3 LU quieter than the identical material dual-mono'd across two
 * speakers, so without it every genuinely mono episode — anything old enough —
 * would be normalised 3 LU too loud.
 */
const LOUDNORM_BASE =
    `loudnorm=I=${LOUDNESS_TARGET_I}:TP=${LOUDNESS_TARGET_TP}:LRA=${LOUDNESS_TARGET_LRA}` +
    ":dual_mono=true:linear=false";

/**
 * `loudnorm` resamples internally and emits 192 kHz double-precision audio. Left
 * alone that reaches the AAC encoder, which neither wants nor can name that rate;
 * 48 kHz is the rate AAC and Chromium are happiest with and what the rest of the
 * pipeline already assumes.
 */
const RESAMPLE_FILTER = "aresample=48000";

/** A pre-gain smaller than this is inaudible and not worth a filter. */
const MIN_PREGAIN_DB = 0.1;

/**
 * Never trust a measurement enough to move a soundtrack further than this. Real
 * material lives inside ±10 dB of target; anything past this is a broken file or
 * a broken measurement, and a 40 dB lift on a mismeasured episode is a much
 * worse outcome than an episode that stays quiet.
 */
const MAX_PREGAIN_DB = 24;

/**
 * How far this episode is from target, in dB, as a fixed pre-gain.
 *
 * Deliberately *not* clamped against the source's true peak, which is the
 * tempting mistake. A quiet-but-peaky master (whispered dialogue under gunshots)
 * genuinely cannot reach −16 LUFS without its peaks crossing the ceiling — but
 * that is a property of the target, not of how the gain is applied: hold the
 * pre-gain back and loudnorm's dynamic stage simply applies the very same gain a
 * few seconds later, through the very same limiter. All the clamp would buy is
 * the convergence wobble this measurement exists to remove.
 *
 * Nothing clips in the meantime: after `volume` the chain is floating point all
 * the way to loudnorm's limiter, so an intermediate sample above full scale is
 * just a number greater than one.
 */
export function preGainDb(measurement: LoudnessMeasurement): number {
    const offset = LOUDNESS_TARGET_I - measurement.i;
    const clamped = Math.max(-MAX_PREGAIN_DB, Math.min(MAX_PREGAIN_DB, offset));
    return Number(clamped.toFixed(2));
}

/**
 * The loudness filters for one episode, in order, or `null` when the feature has
 * nothing to do here (switched off, or a silent file).
 *
 * `null` is load-bearing rather than just an empty list: it is also what tells
 * `remuxArgs` it may keep its stream copy.
 */
export function planLoudness(
    settings: AppSettings,
    acodec: string,
    measurement: LoudnessMeasurement | null,
): string[] | null {
    if (!loudnessEqApplies(acodec, settings.loudnessEq)) return null;

    const filters: string[] = [];
    if (measurement) {
        const gain = preGainDb(measurement);
        if (Math.abs(gain) >= MIN_PREGAIN_DB)
            filters.push(`volume=${gain.toFixed(2)}dB`);
    }
    filters.push(LOUDNORM_BASE, RESAMPLE_FILTER);
    return filters;
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

/** A measuring pass decodes audio only, but a long file is still a long file. */
const MEASURE_TIMEOUT_MS = 15 * 60_000;

/** Keep only the tail of stderr: the JSON block is the last thing printed. */
const STDERR_TAIL_CHARS = 64 * 1024;

/**
 * The measuring pass: decode the soundtrack, print what loudnorm measured, mux
 * nothing (`-f null`).
 *
 * Only the audio stream is mapped, so the video is never even decoded — this is
 * a fraction of real time on any modern machine, not the full-file re-encode the
 * `-f null` shape can look like. `-threads 1` because it is background work that
 * must not compete with an encoder feeding a player, and `-loglevel info`
 * because loudnorm prints its JSON at info level (the streaming paths run at
 * `error`, which would swallow the entire result).
 */
export function measureArgs(file: string): string[] {
    return [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "info",
        "-nostats",
        "-threads",
        "1",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-af",
        `${LOUDNORM_BASE}:print_format=json`,
        "-f",
        "null",
        "-",
    ];
}

/**
 * Pull the measurement out of ffmpeg's stderr.
 *
 * loudnorm prints a JSON object after the log prefix, so the last `{…}` block is
 * taken rather than the whole stream parsed. Digital silence reports `-inf`,
 * which is not a number we can offset from — that answers `null`, and the caller
 * records the attempt so a silent file is never measured twice.
 */
export function parseLoudnessJson(stderr: string): LoudnessMeasurement | null {
    const start = stderr.lastIndexOf("{");
    const end = stderr.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;

    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(stderr.slice(start, end + 1)) as Record<
            string,
            unknown
        >;
    } catch {
        return null;
    }

    const measurement = {
        i: numberFrom(parsed.input_i),
        tp: numberFrom(parsed.input_tp),
        lra: numberFrom(parsed.input_lra),
        thresh: numberFrom(parsed.input_thresh),
    };
    const values = Object.values(measurement);
    if (values.some((value) => value === null)) return null;
    return measurement as LoudnessMeasurement;
}

/** loudnorm reports its numbers as strings, and `-inf` for a silent track. */
function numberFrom(raw: unknown): number | null {
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

export interface MeasureResult {
    measurement: LoudnessMeasurement | null;
    /** Set when ffmpeg itself failed, as opposed to reporting an unusable track. */
    error: string | null;
}

/**
 * Run one measuring pass. Resolves either way — a file that will not decode is a
 * file we skip, never a crash — and the child is killed if `signal` aborts or the
 * timeout fires.
 */
export function measureLoudness(
    ffmpegPath: string,
    file: string,
    signal?: AbortSignal,
): Promise<MeasureResult> {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve({ measurement: null, error: "aborted" });
            return;
        }

        const child = spawn(ffmpegPath, measureArgs(file), {
            stdio: ["ignore", "ignore", "pipe"],
        });

        let stderr = "";
        let settled = false;
        const finish = (result: MeasureResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (child.exitCode === null && child.signalCode === null)
                child.kill("SIGKILL");
            resolve(result);
        };

        const onAbort = (): void =>
            finish({ measurement: null, error: "aborted" });
        signal?.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(
            () =>
                finish({
                    measurement: null,
                    error: `timed out after ${MEASURE_TIMEOUT_MS} ms`,
                }),
            MEASURE_TIMEOUT_MS,
        );
        timer.unref();

        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            stderr += chunk;
            if (stderr.length > STDERR_TAIL_CHARS)
                stderr = stderr.slice(-STDERR_TAIL_CHARS);
        });
        child.stderr?.on("error", () => {
            /* Losing the log pipe only costs us this one measurement. */
        });

        child.on("error", (err) =>
            finish({ measurement: null, error: err.message }),
        );
        child.on("close", (code, killedBy) => {
            if (killedBy !== null)
                return finish({ measurement: null, error: "aborted" });
            if (code !== 0) {
                return finish({
                    measurement: null,
                    error: `ffmpeg exited ${code}: ${stderr.split("\n").slice(-3).join(" ").trim()}`,
                });
            }
            // A clean exit with no usable JSON means a silent or unmeasurable track,
            // which is a real answer: nothing to correct.
            finish({ measurement: parseLoudnessJson(stderr), error: null });
        });
    });
}
