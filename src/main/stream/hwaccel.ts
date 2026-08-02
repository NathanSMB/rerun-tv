/**
 * Hardware-accelerated transcoding (docs/hwaccel-plan.html).
 *
 * Two jobs, same premise as `ffmpeg.ts`: the GPU is external hardware we do not
 * control. We build the arg recipes that would use it, and we *prove* at startup
 * that this machine can actually honour each one — because the interesting
 * failures here are all silent-until-you-try.
 *
 * Only the **transcode** path is affected. A `direct` file never meets ffmpeg,
 * and a `remux` file copies its video stream byte-for-byte; neither runs a video
 * encoder, so there is nothing here for them to accelerate. On this reference
 * library that is still 476 of 878 episodes.
 *
 * Exactly two segments of the command line change per backend — the decode
 * prefix ahead of `-i`, and the video branch. The seek, the stream maps, the AAC
 * chain (there is no hardware audio encoder, and never was) and the fMP4 mux are
 * byte-identical across all three, which is what makes `'software'` provably the
 * same command line the app shipped with.
 */

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type {
    AppSettings,
    HardwareAccel,
    HwAccelReport,
} from "@shared/types.js";

/**
 * Where DRM render nodes live. A render node is the non-privileged half of a GPU
 * device — the one an unprivileged process may open for compute and video work.
 */
const DRI_DIR = "/dev/dri";

/**
 * How long one probe encode may take before we call the backend unusable.
 *
 * Generous: a cold GPU driver can take a second or two to initialise, and the
 * cost of being wrong is a backend the user paid for going unused. Nothing waits
 * on this — the probe runs behind the window, like `checkCodecs`.
 */
const PROBE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Quality mapping
// ---------------------------------------------------------------------------

/**
 * CRF, CQ and QP are three different scales that happen to share a range.
 *
 * The Settings screen offers four quality tiers spelled as x264 preset + CRF,
 * and each backend has to interpret that intent through its own rate control.
 * Keyed off CRF rather than the preset because CRF is the quality half of the
 * pair; the preset only says how much CPU x264 may spend reaching it, which is
 * meaningless to a fixed-function encoder.
 *
 * **VAAPI's column was calibrated, not guessed.** The first cut mapped the
 * default tier to QP 24 on the theory that a hardware encoder wants a few points
 * of slack. Measured against real content — dark, grainy, 10-bit HEVC — that
 * came out 45–59% *below* libx264's bitrate for the same tier, and the missing
 * bits showed up as visible blocking in shadow, confirmed by eye on three
 * scenes. QP 20 lands within ~10% of libx264 on the same clips and restores the
 * detail. The whole column is shifted by the same four points so the tiers stay
 * ordered relative to one another.
 *
 * The residual spread is inherent, not a mis-calibration: x264's CRF is
 * *adaptive* — it spends per-frame according to complexity — while VAAPI's CQP
 * is a fixed quantizer with no such feedback, so no single QP tracks CRF across
 * all content. Measured at QP 20 the gap ran from −22% to +10% depending on the
 * scene, which is the honest best a constant-quantizer mode can do.
 *
 * NVENC needs no such correction: `-cq` tracked libx264 within +39% on the same
 * clips (erring generous, which is the harmless direction) and was clean by eye.
 */
interface QualityTier {
    /** NVENC's constant-quality target. */
    cq: number;
    /** NVENC's speed/quality preset, `p1` (fastest) … `p7` (slowest). */
    nvencPreset: string;
    /** VAAPI's constant quantizer, calibrated to libx264's bitrate — see above. */
    qp: number;
}

const QUALITY_TIERS: { crf: number; tier: QualityTier }[] = [
    { crf: 23, tier: { cq: 23, nvencPreset: "p2", qp: 22 } },
    { crf: 21, tier: { cq: 21, nvencPreset: "p4", qp: 20 } },
    { crf: 20, tier: { cq: 20, nvencPreset: "p5", qp: 19 } },
    { crf: 19, tier: { cq: 19, nvencPreset: "p6", qp: 18 } },
];

/** The default tier, for a CRF the Settings screen never offered. */
const FALLBACK_TIER: QualityTier = { cq: 21, nvencPreset: "p4", qp: 20 };

/**
 * The tier for a stored CRF. An unknown value (hand-edited, or from a future
 * version) answers the middle of the road rather than refusing to play.
 */
export function qualityTier(crf: number): QualityTier {
    return (
        QUALITY_TIERS.find((entry) => entry.crf === crf)?.tier ?? FALLBACK_TIER
    );
}

// ---------------------------------------------------------------------------
// Arg recipes
// ---------------------------------------------------------------------------

/**
 * The decode half: everything that must appear *before* `-i`.
 *
 * VAAPI names a specific device, because on a multi-GPU machine the wrong one
 * fails outright (see `probeHardwareAccel`). NVENC deliberately uses plain
 * `-hwaccel cuda` **without** `-hwaccel_output_format cuda`: decoded frames then
 * land in system memory, so a codec NVDEC cannot decode — MPEG-4 ASP, i.e. every
 * XviD rip in the library — falls back to software decode transparently and
 * still hardware-*encodes*. The copy costs CPU (measured: 3.2 cores of burst
 * against libx264's 17) and buys a backend that never refuses a file.
 */
export function hwDecodeArgs(
    accel: HardwareAccel,
    vaapiDevice: string | null,
): string[] {
    if (accel === "vaapi" && vaapiDevice) {
        return [
            "-init_hw_device",
            `vaapi=va:${vaapiDevice}`,
            "-hwaccel",
            "vaapi",
            "-hwaccel_output_format",
            "vaapi",
            "-filter_hw_device",
            "va",
        ];
    }
    if (accel === "nvenc") return ["-hwaccel", "cuda"];
    return [];
}

/**
 * The encode half: the video filter chain and codec branch.
 *
 * The VAAPI filter is doing two jobs at once, and both are load-bearing:
 *
 * - `format=nv12|vaapi,hwupload` accepts frames from *either* kind of decoder. A
 *   VAAPI decode already produced GPU surfaces (`hwupload` passes them through);
 *   a software-decoded XviD produced NV12 in RAM (`hwupload` uploads it). Without
 *   the alternation, one of the two cases fails.
 * - `scale_vaapi=format=nv12` folds 10-bit P010 surfaces down to 8-bit, which
 *   `h264_vaapi` requires — and 10-bit HEVC is the single largest transcode
 *   population in the reference library.
 *
 * `-pix_fmt yuv420p` appears on the two paths whose frames are in system memory
 * and must not appear on VAAPI's, where the pixel format is a property of the
 * GPU surface the filter chain already fixed.
 */
export function hwVideoArgs(
    accel: HardwareAccel,
    settings: AppSettings,
): string[] {
    const tier = qualityTier(settings.transcodeCrf);

    if (accel === "vaapi") {
        return [
            "-vf",
            "format=nv12|vaapi,hwupload,scale_vaapi=format=nv12",
            "-c:v",
            "h264_vaapi",
            "-rc_mode",
            "CQP",
            "-qp",
            String(tier.qp),
        ];
    }

    if (accel === "nvenc") {
        return [
            "-c:v",
            "h264_nvenc",
            "-preset",
            tier.nvencPreset,
            "-rc",
            "vbr",
            "-cq",
            String(tier.cq),
            // `-b:v 0` is what makes `-cq` a *quality* target rather than a ceiling on
            // top of a bitrate target; without it NVENC quietly caps at its default.
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p",
        ];
    }

    // Software: the exact block this module was factored out of.
    return [
        "-c:v",
        "libx264",
        "-preset",
        settings.transcodePreset,
        "-crf",
        String(settings.transcodeCrf),
        "-pix_fmt",
        "yuv420p",
    ];
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/**
 * The escape hatch, matching `RERUN_FFMPEG_PATH`'s convention: name the VAAPI
 * render node explicitly and enumeration is skipped entirely. Useful for odd
 * installs, and it is how the fallback test forces a broken device.
 */
const VAAPI_DEVICE_ENV = "RERUN_VAAPI_DEVICE";

/** `renderD128`, `renderD129`, … in a stable order. */
export function listRenderNodes(dir: string = DRI_DIR): string[] {
    try {
        return readdirSync(dir)
            .filter((name) => name.startsWith("renderD"))
            .sort()
            .map((name) => join(dir, name));
    } catch {
        // No /dev/dri at all: a machine with no GPU, or a container without one.
        return [];
    }
}

/**
 * One throwaway encode, exactly as `checkCodecs` does it: generate a tiny clip
 * with `lavfi`, push it through the backend's real arg recipe, mux nothing.
 *
 * Deliberately runs the *same* builders playback uses, so a probe pass means the
 * command shape works — not that some simplified approximation of it does.
 */
function probeEncode(
    ffmpegPath: string,
    accel: HardwareAccel,
    device: string | null,
): Promise<boolean> {
    const settings = {
        transcodeCrf: 21,
        transcodePreset: "veryfast",
    } as AppSettings;

    const args = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        ...hwDecodeArgs(accel, device),
        "-f",
        "lavfi",
        // 64×64 would be rejected by some VAAPI drivers as below the encoder's
        // minimum; 320×240 is small enough to be instant and large enough to be real.
        "-i",
        "testsrc=size=320x240:rate=25:duration=0.2",
        ...hwVideoArgs(accel, settings),
        "-f",
        "null",
        "-",
    ];

    return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(ffmpegPath, args, {
                stdio: ["ignore", "ignore", "ignore"],
            });
        } catch {
            resolve(false);
            return;
        }

        let settled = false;
        const finish = (ok: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (child.exitCode === null && child.signalCode === null)
                child.kill("SIGKILL");
            resolve(ok);
        };

        const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
        timer.unref();

        child.on("error", () => finish(false));
        child.on("close", (code) => finish(code === 0));
    });
}

export interface ProbeOptions {
    /** Injectable for tests; defaults to reading `/dev/dri`. */
    listNodes?: () => string[];
    /** Injectable for tests; defaults to the real ffmpeg test encode. */
    encode?: (accel: HardwareAccel, device: string | null) => Promise<boolean>;
    /** Injectable for tests; defaults to `process.env[RERUN_VAAPI_DEVICE]`. */
    deviceOverride?: string | null;
}

/**
 * Prove what this machine can actually do, once per process.
 *
 * NVENC is a single yes/no. VAAPI is not: **the device is not guessable.** On
 * the reference machine `/dev/dri/renderD128` is an RTX 5080 whose VAAPI driver
 * exposes decode but *no* H.264 encode entrypoint (`No usable encoding
 * entrypoint found for profile VAProfileH264High`), while `renderD129` is the
 * AMD iGPU that works. Every VAAPI example on the internet hardcodes renderD128;
 * doing that here would report "VAAPI unavailable" on a machine with a working
 * VAAPI encoder in it. So we enumerate and test-encode until one passes.
 *
 * Never throws and never blocks startup: a machine with no GPU simply reports
 * `failed` for both, and the software path — which is the default — is unmoved.
 */
export async function probeHardwareAccel(
    ffmpegPath: string | null,
    opts: ProbeOptions = {},
): Promise<HwAccelReport> {
    if (!ffmpegPath)
        return { vaapi: "failed", nvenc: "failed", vaapiDevice: null };

    const encode =
        opts.encode ??
        ((accel, device) => probeEncode(ffmpegPath, accel, device));
    const listNodes = opts.listNodes ?? (() => listRenderNodes());
    const override =
        opts.deviceOverride !== undefined
            ? opts.deviceOverride
            : (process.env[VAAPI_DEVICE_ENV] ?? null);

    const candidates = override ? [override] : listNodes();

    // NVENC's probe is independent of VAAPI's, so it runs alongside the whole
    // device sweep rather than behind it.
    const nvencProbe = encode("nvenc", null);

    let vaapiDevice: string | null = null;
    for (const device of candidates) {
        if (await encode("vaapi", device)) {
            vaapiDevice = device;
            break;
        }
    }

    const nvenc = await nvencProbe;

    return {
        vaapi: vaapiDevice ? "ok" : "failed",
        nvenc: nvenc ? "ok" : "failed",
        vaapiDevice,
    };
}

/**
 * The backend a stream will *actually* use, which is not always the one the user
 * selected — the same shape of question `effectivePlaybackPath` answers for the
 * loudness setting.
 *
 * A selection whose probe has not passed answers `software`. `pending` answers
 * software too: a probe takes a couple of seconds after launch, and an episode
 * tuned in during that window must start now on a path that certainly works
 * rather than wait to find out whether a faster one exists.
 */
export function effectiveAccel(
    selected: HardwareAccel,
    report: HwAccelReport,
): HardwareAccel {
    if (selected === "vaapi")
        return report.vaapi === "ok" ? "vaapi" : "software";
    if (selected === "nvenc")
        return report.nvenc === "ok" ? "nvenc" : "software";
    // Anything else — including a hand-edited settings row naming a backend this
    // version has never heard of — is software.
    return "software";
}
