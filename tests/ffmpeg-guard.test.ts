/**
 * Tests for the ffmpeg skip guard itself.
 *
 * The guard is the only thing standing between "CI has no ffmpeg" and "CI is
 * green with half the suite skipped", and it is invisible in a normal run —
 * on a machine with ffmpeg it never fires, so a regression in it would go
 * unnoticed until the day it was needed. Hence these, which drive the decision
 * directly with an injected environment instead of `process.env`.
 */

import { describe, expect, it } from "vitest";
import { ffmpegIsRequired, ffmpegMissing } from "./ffmpeg-guard.js";

describe("ffmpegIsRequired", () => {
    it("is off when the variable is absent, so a plain local run still skips", () => {
        expect(ffmpegIsRequired({})).toBe(false);
    });

    it("treats empty, 0 and false as off", () => {
        // Someone exporting RERUN_REQUIRE_FFMPEG=0 in a shell profile should get
        // laptop behaviour, not a suite that refuses to run without ffmpeg.
        expect(ffmpegIsRequired({ RERUN_REQUIRE_FFMPEG: "" })).toBe(false);
        expect(ffmpegIsRequired({ RERUN_REQUIRE_FFMPEG: "0" })).toBe(false);
        expect(ffmpegIsRequired({ RERUN_REQUIRE_FFMPEG: "false" })).toBe(false);
        expect(ffmpegIsRequired({ RERUN_REQUIRE_FFMPEG: " FALSE " })).toBe(
            false,
        );
    });

    it("is on for the value CI sets", () => {
        expect(ffmpegIsRequired({ RERUN_REQUIRE_FFMPEG: "1" })).toBe(true);
    });
});

describe("ffmpegMissing", () => {
    it("reports the skip flag and stays silent with no variable set", () => {
        expect(ffmpegMissing(false, "example", {})).toBe(true);
        expect(ffmpegMissing(true, "example", {})).toBe(false);
    });

    it("throws when ffmpeg is demanded and absent", () => {
        // This is the whole point: on CI the suites must not be allowed to
        // quietly disappear.
        expect(() =>
            ffmpegMissing(false, "example", { RERUN_REQUIRE_FFMPEG: "1" }),
        ).toThrow(/RERUN_REQUIRE_FFMPEG/);
        // …and the message names the suite, so the log says what went missing.
        expect(() =>
            ffmpegMissing(false, "example", { RERUN_REQUIRE_FFMPEG: "1" }),
        ).toThrow(/example/);
    });

    it("does not throw when ffmpeg is demanded and present", () => {
        expect(
            ffmpegMissing(true, "example", { RERUN_REQUIRE_FFMPEG: "1" }),
        ).toBe(false);
    });
});
