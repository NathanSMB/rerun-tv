/**
 * The ffmpeg skip guard.
 *
 * Several suites here only mean anything with a real ffmpeg on PATH — they mux
 * fixtures with `lavfi` and assert against bytes the shipping muxer actually
 * produced — so they gate themselves with `describe.skipIf(noFfmpeg)` and stay
 * quiet on a bare machine. That is exactly right on a laptop and exactly wrong
 * in CI: a runner whose ffmpeg install silently failed would skip the entire
 * ffmpeg half of the suite and still report green, which is the failure mode
 * this file exists to make impossible.
 *
 * So the gate stays a skip locally and becomes a hard error when
 * `RERUN_REQUIRE_FFMPEG` is set (the CI workflow sets it). The error is thrown
 * at module scope on purpose: vitest reports it as a collection failure for the
 * whole file, which is louder — and harder to overlook — than one red test.
 */

export const REQUIRE_FFMPEG_ENV = "RERUN_REQUIRE_FFMPEG";

/**
 * Is ffmpeg being *demanded* rather than merely hoped for?
 *
 * Unset, empty, `0` and `false` all mean "not demanded", so that
 * `RERUN_REQUIRE_FFMPEG=0 npm test` behaves like a plain local run instead of
 * tripping on a variable someone exported once and forgot.
 */
export function ffmpegIsRequired(
    env: Record<string, string | undefined> = process.env,
): boolean {
    const raw = (env[REQUIRE_FFMPEG_ENV] ?? "").trim().toLowerCase();
    return raw !== "" && raw !== "0" && raw !== "false";
}

/**
 * Translate "did we find ffmpeg?" into the `skipIf` flag the suites want,
 * throwing first if this environment insisted on having one.
 *
 * `suite` is only ever read by a human staring at a CI log, so it should name
 * the file's subject ("stream server", "MSE pump", …) rather than the path.
 */
export function ffmpegMissing(
    available: boolean,
    suite: string,
    env: Record<string, string | undefined> = process.env,
): boolean {
    if (!available && ffmpegIsRequired(env)) {
        throw new Error(
            `${REQUIRE_FFMPEG_ENV} is set but no ffmpeg/ffprobe was found, so the ` +
                `${suite} tests would have skipped silently. Install ffmpeg (CI: ` +
                `apt-get install -y ffmpeg) or unset ${REQUIRE_FFMPEG_ENV} to allow ` +
                `the skip.`,
        );
    }
    return !available;
}
