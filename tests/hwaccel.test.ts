/**
 * Hardware encode/decode (docs/playback.md, "Hardware encode & decode").
 *
 * The arg builders carry the whole feature, so they are asserted directly: what
 * matters is that each backend produces a command ffmpeg will accept, that the
 * parts *not* meant to change are byte-identical across all three, and that a
 * machine which cannot honour a selection still plays the episode.
 *
 * The probe is tested with injected fakes rather than real hardware, because the
 * interesting behaviour is the *search* — enumerate render nodes, keep the first
 * that works — and that is exactly what a machine-dependent test could not pin
 * down. One skipIf-gated case exercises the real thing where hardware exists.
 */

import { resolveFfmpeg } from "@main/stream/ffmpeg.js";
import {
    effectiveAccel,
    hwDecodeArgs,
    hwVideoArgs,
    probeHardwareAccel,
    qualityTier,
} from "@main/stream/hwaccel.js";
import { transcodeArgs } from "@main/stream/server.js";
import {
    DEFAULT_SETTINGS,
    type HardwareAccel,
    type HwAccelReport,
} from "@shared/types.js";
import { describe, expect, it } from "vitest";
import { ffmpegMissing } from "./ffmpeg-guard.js";

const ffmpeg = resolveFfmpeg();
const noFfmpeg = ffmpegMissing(
    ffmpeg.ffmpegPath !== null,
    "hardware accel probe",
);

const ALL_OK: HwAccelReport = {
    vaapi: "ok",
    nvenc: "ok",
    vaapiDevice: "/dev/dri/renderD129",
};
const NONE: HwAccelReport = {
    vaapi: "failed",
    nvenc: "failed",
    vaapiDevice: null,
};
const PENDING: HwAccelReport = {
    vaapi: "pending",
    nvenc: "pending",
    vaapiDevice: null,
};

describe("hwDecodeArgs", () => {
    it("is empty on software — the path that must not change at all", () => {
        expect(hwDecodeArgs("software", "/dev/dri/renderD129")).toEqual([]);
    });

    it("names the proven VAAPI device rather than letting ffmpeg guess", () => {
        const args = hwDecodeArgs("vaapi", "/dev/dri/renderD129").join(" ");
        expect(args).toContain("-init_hw_device vaapi=va:/dev/dri/renderD129");
        expect(args).toContain("-hwaccel vaapi");
        expect(args).toContain("-hwaccel_output_format vaapi");
        expect(args).toContain("-filter_hw_device va");
    });

    it("falls back to no prefix when VAAPI has no proven device", () => {
        // Better a software decode than an `-init_hw_device` pointing at nothing.
        expect(hwDecodeArgs("vaapi", null)).toEqual([]);
    });

    /**
     * Deliberately *not* `-hwaccel_output_format cuda`: frames land in system
     * memory, so a codec NVDEC cannot decode (every XviD rip in the library) falls
     * back to a software decode and still hardware-encodes.
     */
    it("asks CUDA for a decode without pinning frames to the GPU", () => {
        expect(hwDecodeArgs("nvenc", null)).toEqual(["-hwaccel", "cuda"]);
        expect(hwDecodeArgs("nvenc", null)).not.toContain(
            "-hwaccel_output_format",
        );
    });
});

describe("hwVideoArgs", () => {
    it("is exactly the libx264 block on software", () => {
        expect(hwVideoArgs("software", DEFAULT_SETTINGS)).toEqual([
            "-c:v",
            "libx264",
            "-preset",
            DEFAULT_SETTINGS.transcodePreset,
            "-crf",
            String(DEFAULT_SETTINGS.transcodeCrf),
            "-pix_fmt",
            "yuv420p",
        ]);
    });

    /**
     * Both halves of the VAAPI filter are load-bearing: the `nv12|vaapi`
     * alternation accepts frames from a hardware *or* a software decoder, and
     * `scale_vaapi=format=nv12` folds 10-bit P010 down to the 8-bit surface
     * `h264_vaapi` requires — 10-bit HEVC being the largest transcode population
     * in the reference library.
     */
    it("builds a VAAPI chain that survives a software decode and 10-bit input", () => {
        const args = hwVideoArgs("vaapi", DEFAULT_SETTINGS).join(" ");
        expect(args).toContain(
            "-vf format=nv12|vaapi,hwupload,scale_vaapi=format=nv12",
        );
        expect(args).toContain("-c:v h264_vaapi");
        expect(args).toContain("-rc_mode CQP");
    });

    it("never puts -pix_fmt on the VAAPI path, where the format is the surface’s", () => {
        expect(hwVideoArgs("vaapi", DEFAULT_SETTINGS)).not.toContain(
            "-pix_fmt",
        );
    });

    /** `-b:v 0` is what makes `-cq` a quality target instead of a cap on a bitrate. */
    it("gives NVENC a constant-quality target, not a bitrate ceiling", () => {
        const args = hwVideoArgs("nvenc", DEFAULT_SETTINGS).join(" ");
        expect(args).toContain("-c:v h264_nvenc");
        expect(args).toContain("-rc vbr");
        expect(args).toContain("-cq 21");
        expect(args).toContain("-b:v 0");
    });

    it("never sends a hardware encoder x264’s knobs", () => {
        for (const accel of ["vaapi", "nvenc"] as HardwareAccel[]) {
            const args = hwVideoArgs(accel, DEFAULT_SETTINGS);
            expect(args).not.toContain("-crf");
            expect(args).not.toContain("libx264");
            // x264 preset names would be rejected outright by both encoders.
            expect(args).not.toContain(DEFAULT_SETTINGS.transcodePreset);
        }
    });
});

describe("qualityTier", () => {
    it("maps each Settings tier onto every backend’s own scale", () => {
        expect(qualityTier(23)).toEqual({ cq: 23, nvencPreset: "p2", qp: 22 });
        expect(qualityTier(19)).toEqual({ cq: 19, nvencPreset: "p6", qp: 18 });
    });

    /**
     * The regression that matters. QP 24 for the default tier — the first,
     * uncalibrated guess — ran 45–59% under libx264's bitrate on real 10-bit HEVC
     * and produced visible blocking in shadow. QP 20 measured within ~10% of
     * libx264 on the same clips. A drift back toward the looser end would bring
     * the artifacts back, silently.
     */
    it("keeps VAAPI near libx264’s bitrate rather than a few points looser", () => {
        expect(qualityTier(21).qp).toBe(20);
        for (const { tier } of [23, 21, 20, 19].map((crf) => ({
            tier: qualityTier(crf),
        }))) {
            expect(tier.qp).toBeLessThanOrEqual(22);
        }
    });

    it("answers the default tier for a CRF no version ever offered", () => {
        expect(qualityTier(14)).toEqual(qualityTier(21));
    });

    it("moves all three scales in the same direction", () => {
        // Higher quality (lower CRF) must not mean a looser hardware quantizer.
        expect(qualityTier(19).qp).toBeLessThan(qualityTier(23).qp);
        expect(qualityTier(19).cq).toBeLessThan(qualityTier(23).cq);
    });
});

describe("effectiveAccel", () => {
    it("honours a selection the probe proved", () => {
        expect(effectiveAccel("vaapi", ALL_OK)).toBe("vaapi");
        expect(effectiveAccel("nvenc", ALL_OK)).toBe("nvenc");
    });

    it("degrades a selection this machine cannot honour", () => {
        expect(effectiveAccel("vaapi", NONE)).toBe("software");
        expect(effectiveAccel("nvenc", NONE)).toBe("software");
    });

    /**
     * A probe takes a couple of seconds after launch. An episode tuned in during
     * that window must start now on a path that certainly works, rather than wait
     * to learn whether a faster one exists.
     */
    it("treats a probe still running as software", () => {
        expect(effectiveAccel("vaapi", PENDING)).toBe("software");
        expect(effectiveAccel("nvenc", PENDING)).toBe("software");
    });

    it("degrades a backend this version has never heard of", () => {
        expect(effectiveAccel("quicksync" as HardwareAccel, ALL_OK)).toBe(
            "software",
        );
    });

    it("leaves software alone whatever the probe says", () => {
        expect(effectiveAccel("software", ALL_OK)).toBe("software");
    });
});

/**
 * The device is not guessable. On the reference machine `/dev/dri/renderD128`
 * is an RTX 5080 whose VAAPI driver exposes decode but no H.264 *encode*
 * entrypoint, while `renderD129` is the AMD iGPU that works — so a probe that
 * hardcoded renderD128, as every VAAPI example does, would report "unavailable"
 * on a machine with a working VAAPI encoder in it.
 */
describe("probeHardwareAccel", () => {
    it("keeps looking past a render node that cannot encode", async () => {
        const tried: string[] = [];
        const report = await probeHardwareAccel("/usr/bin/ffmpeg", {
            listNodes: () => ["/dev/dri/renderD128", "/dev/dri/renderD129"],
            deviceOverride: null,
            encode: async (accel, device) => {
                if (accel !== "vaapi") return false;
                tried.push(device as string);
                return device === "/dev/dri/renderD129";
            },
        });

        expect(tried).toEqual(["/dev/dri/renderD128", "/dev/dri/renderD129"]);
        expect(report.vaapi).toBe("ok");
        expect(report.vaapiDevice).toBe("/dev/dri/renderD129");
    });

    it("stops at the first device that works", async () => {
        const tried: string[] = [];
        await probeHardwareAccel("/usr/bin/ffmpeg", {
            listNodes: () => ["/dev/dri/renderD128", "/dev/dri/renderD129"],
            deviceOverride: null,
            encode: async (accel, device) => {
                if (accel !== "vaapi") return false;
                tried.push(device as string);
                return true;
            },
        });
        expect(tried).toEqual(["/dev/dri/renderD128"]);
    });

    it("reports failure when no node can encode", async () => {
        const report = await probeHardwareAccel("/usr/bin/ffmpeg", {
            listNodes: () => ["/dev/dri/renderD128"],
            deviceOverride: null,
            encode: async () => false,
        });
        expect(report).toEqual({
            vaapi: "failed",
            nvenc: "failed",
            vaapiDevice: null,
        });
    });

    it("probes NVENC independently of any render node", async () => {
        const report = await probeHardwareAccel("/usr/bin/ffmpeg", {
            listNodes: () => [],
            deviceOverride: null,
            encode: async (accel) => accel === "nvenc",
        });
        expect(report.nvenc).toBe("ok");
        expect(report.vaapi).toBe("failed");
    });

    it("takes the device override instead of enumerating", async () => {
        const tried: string[] = [];
        const report = await probeHardwareAccel("/usr/bin/ffmpeg", {
            listNodes: () => ["/dev/dri/renderD128", "/dev/dri/renderD129"],
            deviceOverride: "/dev/dri/renderD200",
            encode: async (accel, device) => {
                if (accel !== "vaapi") return false;
                tried.push(device as string);
                return true;
            },
        });
        expect(tried).toEqual(["/dev/dri/renderD200"]);
        expect(report.vaapiDevice).toBe("/dev/dri/renderD200");
    });

    it("is not fatal on a machine with no ffmpeg at all", async () => {
        await expect(probeHardwareAccel(null)).resolves.toEqual({
            vaapi: "failed",
            nvenc: "failed",
            vaapiDevice: null,
        });
    });

    /** The real thing, where there is hardware to ask. Never asserts a verdict. */
    it.skipIf(noFfmpeg)(
        "answers without throwing against real hardware",
        async () => {
            const report = await probeHardwareAccel(ffmpeg.ffmpegPath);
            expect(["ok", "failed"]).toContain(report.vaapi);
            expect(["ok", "failed"]).toContain(report.nvenc);
            if (report.vaapi === "ok")
                expect(report.vaapiDevice).toMatch(/^\/dev\/dri\/renderD\d+$/);
            else expect(report.vaapiDevice).toBeNull();
        },
        40_000,
    );
});

/**
 * The composition itself: only two segments may move between backends. Everything
 * else — the seek, the stream maps, the AAC chain, the fMP4 mux — is what the
 * player and the MSE pump depend on, and none of it is the GPU's business.
 */
describe("transcodeArgs across backends", () => {
    it("is byte-identical to the pre-hardware command on software", () => {
        expect(transcodeArgs("/tv/ep.mkv", 0, DEFAULT_SETTINGS)).toEqual([
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            "/tv/ep.mkv",
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-map_chapters",
            "-1",
            "-c:v",
            "libx264",
            "-preset",
            DEFAULT_SETTINGS.transcodePreset,
            "-crf",
            String(DEFAULT_SETTINGS.transcodeCrf),
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            DEFAULT_SETTINGS.transcodeAudioBitrate,
            "-af",
            "aformat=channel_layouts=mono|stereo|3.0|4.0|5.0|5.1|7.1",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            "pipe:1",
        ]);
    });

    it("keeps the mux, the maps and the chapter drop on every backend", () => {
        for (const accel of ["software", "vaapi", "nvenc"] as HardwareAccel[]) {
            const args = transcodeArgs(
                "/tv/ep.mkv",
                0,
                DEFAULT_SETTINGS,
                null,
                accel,
                "/dev/dri/renderD129",
            );
            const joined = args.join(" ");
            expect(joined).toContain("-map 0:v:0");
            expect(joined).toContain("-map 0:a:0?");
            expect(joined).toContain("-map_chapters -1");
            expect(joined).toContain(
                "-movflags frag_keyframe+empty_moov+default_base_moof",
            );
            expect(args.at(-1)).toBe("pipe:1");
        }
    });

    /** Audio is always a software AAC encode — no hardware audio encoder exists. */
    it("encodes audio identically on every backend", () => {
        for (const accel of ["software", "vaapi", "nvenc"] as HardwareAccel[]) {
            const joined = transcodeArgs(
                "/tv/ep.mkv",
                0,
                DEFAULT_SETTINGS,
                null,
                accel,
            ).join(" ");
            expect(joined).toContain(
                `-c:a aac -b:a ${DEFAULT_SETTINGS.transcodeAudioBitrate}`,
            );
        }
    });

    /**
     * `-hwaccel` is a per-input option, so it must precede `-i` — and `-ss` has to
     * stay before `-i` too, which is what makes the seek a fast keyframe seek.
     */
    it("puts the decode prefix and the seek ahead of the input", () => {
        const args = transcodeArgs(
            "/tv/ep.mkv",
            90,
            DEFAULT_SETTINGS,
            null,
            "vaapi",
            "/dev/dri/renderD129",
        );
        const input = args.indexOf("-i");
        expect(args.indexOf("-init_hw_device")).toBeLessThan(input);
        expect(args.indexOf("-hwaccel")).toBeLessThan(input);
        expect(args.indexOf("-ss")).toBeLessThan(input);
        expect(args[args.indexOf("-ss") + 1]).toBe("90");
    });

    it("composes the loudness chain the same way on every backend", () => {
        for (const accel of ["software", "vaapi", "nvenc"] as HardwareAccel[]) {
            const joined = transcodeArgs(
                "/tv/ep.mkv",
                0,
                DEFAULT_SETTINGS,
                ["volume=3.00dB", "loudnorm=I=-16"],
                accel,
            ).join(" ");
            // The audio filter chain is one `-af`; a second would silently replace it.
            expect(joined).toContain(
                "-af volume=3.00dB,loudnorm=I=-16,aformat=channel_layouts=",
            );
            expect(joined.match(/-af /g)).toHaveLength(1);
        }
    });

    /**
     * The video filter belongs to VAAPI alone, and it must not collide with the
     * audio filter — `-vf` and `-af` are different options, which is exactly why
     * the loudness chain can ride along unchanged.
     */
    it("gives VAAPI a video filter without disturbing the audio filter", () => {
        const joined = transcodeArgs(
            "/tv/ep.mkv",
            0,
            DEFAULT_SETTINGS,
            ["loudnorm=I=-16"],
            "vaapi",
            "/dev/dri/renderD129",
        ).join(" ");
        expect(joined).toContain("-vf format=nv12|vaapi,hwupload");
        expect(joined).toContain("-af loudnorm=I=-16,aformat=channel_layouts=");
    });
});
