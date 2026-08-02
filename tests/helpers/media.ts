/**
 * Test-clip generation.
 *
 * Half a dozen suites need "a real file a real ffmpeg really made" — the stream
 * server, the MSE parser, the loudness measurer — and each of them used to carry
 * its own copy of the same twenty-line `execFileSync` incantation. They drifted
 * in the small ways copies always do (one had `-nostdin`, one did not), which is
 * exactly the kind of difference that turns "the muxer changed" into "why does
 * only that suite fail?".
 *
 * So there is one generator here, parameterised over the axes the call sites
 * actually vary: length, whether there is a picture at all, what the soundtrack
 * is made of, which audio encoder runs, and any extra flags a suite needs to
 * pin (`-g 10` for fragment cutting, `-movflags` for fMP4). Everything else —
 * `testsrc` at 160x120, libx264 `ultrafast`, `yuv420p` — is fixed, because it is
 * fixed at every call site: the clips only have to decode, not look like
 * anything.
 *
 * Nothing here skips itself. Callers already gate on `ffmpegMissing()` and pass
 * the resolved path in, so a suite that forgot to gate fails loudly instead of
 * quietly generating nothing.
 */

import { execFileSync } from "node:child_process";

export interface ClipOptions {
    /** The resolved ffmpeg binary — callers hold it from `resolveFfmpeg()`. */
    ffmpegPath: string;
    /** Output file, or `"pipe:1"` to get the bytes back on stdout instead. */
    out: string;
    /** Clip length in seconds. Default 1 — long enough to mux, short enough to be free. */
    seconds?: number;
    /** False for an audio-only file (the loudness fixtures). Default true. */
    video?: boolean;
    /**
     * `"silence"` uses `anullsrc`, `"tone"` a `sine` at `toneHz`. Silence is
     * enough wherever only the container matters; the loudness suite needs a
     * signal with an actual measurable level.
     */
    audio?: "silence" | "tone";
    /** Frequency of the `sine` source when `audio` is `"tone"`. */
    toneHz?: number;
    /** An `-af` filter chain, e.g. `"volume=-10dB"`. */
    audioFilter?: string | null;
    /** Audio encoder. Default AAC — the one Chromium can always decode. */
    acodec?: string;
    /** Flags spliced in after the video encoder options, before `-c:a`. */
    videoArgs?: string[];
    /** Flags spliced in just before the output target, e.g. `-movflags`/`-f`. */
    outputArgs?: string[];
    /** `execFileSync` stdout cap, for `pipe:1` callers. */
    maxBuffer?: number;
}

/**
 * Mux one clip and return whatever ffmpeg wrote to stdout — meaningful only when
 * `out` is `"pipe:1"`, empty otherwise.
 *
 * `-nostdin` is unconditional: a synchronous ffmpeg that decides to read the
 * test runner's stdin hangs the whole suite with no output at all.
 */
export function makeClip(options: ClipOptions): Buffer {
    const {
        ffmpegPath,
        out,
        seconds = 1,
        video = true,
        audio = "silence",
        toneHz = 440,
        audioFilter = null,
        acodec = "aac",
        videoArgs = [],
        outputArgs = [],
        maxBuffer,
    } = options;

    const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"];

    if (video) {
        args.push(
            "-f",
            "lavfi",
            "-i",
            `testsrc=size=160x120:rate=10:duration=${seconds}`,
        );
    }

    args.push(
        "-f",
        "lavfi",
        "-i",
        audio === "tone"
            ? `sine=frequency=${toneHz}:duration=${seconds}:sample_rate=48000`
            : "anullsrc=r=48000:cl=stereo",
    );

    if (video) {
        // `-shortest` is what stops the (endless) silence source from muxing a
        // file that never finishes.
        args.push(
            "-shortest",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            ...videoArgs,
        );
    }

    if (audioFilter) args.push("-af", audioFilter);
    args.push("-c:a", acodec, ...outputArgs, out);

    // `encoding: "buffer"` is the node default; naming it is what selects the
    // overload that returns bytes rather than `string | Buffer`.
    return execFileSync(ffmpegPath, args, { maxBuffer, encoding: "buffer" });
}
