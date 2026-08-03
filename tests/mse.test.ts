/**
 * The MSE pump (docs/playback.md, "The renderer: MediaSource, not `src`").
 *
 * Two halves, tested two ways.
 *
 * The **parser** is checked against bytes a real ffmpeg actually produced, with
 * exactly the arguments `stream/server.ts` uses — because the risk here is not
 * "does my box walk compile" but "does it agree with the muxer we ship against".
 * The awkward cases the muxer won't easily emit (Opus, FLAC, HE-AAC) are built by
 * hand from boxes instead.
 *
 * The **pump** is checked against a scripted reader and a fake source buffer.
 * That is what makes the read-pacing invariant assertable at all: the property
 * that matters — *the reader never asks for bytes while more than `highWaterS`
 * seconds are already buffered* — is invisible from the outside of a browser, and
 * it is the whole reason the stall class goes away.
 */

import { resolveFfmpeg } from "@main/stream/ffmpeg.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
    type BufferPolicy,
    type ByteReader,
    DEFAULT_BUFFER_POLICY,
    type MediaSourceLike,
    Mp4ParseError,
    Mp4SegmentScanner,
    parseInitSegment,
    parseVideoSize,
    type SourceBufferLike,
    STANDBY_BUFFER_POLICY,
    startPump,
    type TimeRangesLike,
} from "../src/renderer/src/player/mse.js";
import { ffmpegMissing } from "./ffmpeg-guard.js";
import { makeClip } from "./helpers/media.js";

const ffmpeg = resolveFfmpeg();
const noFfmpeg = ffmpegMissing(ffmpeg.ffmpegPath !== null, "MSE pump");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A fragmented MP4 on stdout, muxed with the *same* flags the stream server
 * uses. `-g 10` forces a keyframe every second so `frag_keyframe` cuts several
 * fragments — one fragment would not exercise the scanner at all.
 */
function makeFragmentedMp4(acodec: string, seconds = 4): Buffer {
    return makeClip({
        ffmpegPath: ffmpeg.ffmpegPath as string,
        out: "pipe:1",
        seconds,
        acodec,
        videoArgs: ["-g", "10"],
        outputArgs: [
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
        ],
        maxBuffer: 64 * 1024 * 1024,
    });
}

let aacStream: Uint8Array;
/** Null when this ffmpeg has no mp3 encoder; that case is covered by hand below. */
let mp3Stream: Uint8Array | null = null;

beforeAll(() => {
    if (noFfmpeg) return;
    aacStream = new Uint8Array(makeFragmentedMp4("aac"));
    try {
        mp3Stream = new Uint8Array(makeFragmentedMp4("libmp3lame"));
    } catch {
        // A distro build without libmp3lame is not a test failure.
    }
}, 120_000);

/** Feed a stream to the scanner in fixed-size bites, as TCP would. */
function scanAll(
    stream: Uint8Array,
    chunkSize: number,
): ReturnType<Mp4SegmentScanner["drain"]> {
    const scanner = new Mp4SegmentScanner();
    const out: ReturnType<Mp4SegmentScanner["drain"]> = [];
    for (let at = 0; at < stream.length; at += chunkSize) {
        scanner.push(
            stream.subarray(at, Math.min(stream.length, at + chunkSize)),
        );
        out.push(...scanner.drain());
    }
    return out;
}

function boxTypeOf(segment: Uint8Array, at = 0): string {
    return String.fromCharCode(
        segment[at + 4],
        segment[at + 5],
        segment[at + 6],
        segment[at + 7],
    );
}

// ---------------------------------------------------------------------------
// Hand-built boxes, for the sample entries ffmpeg won't easily give us
// ---------------------------------------------------------------------------

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
    const payload = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(8 + payload);
    const size = out.length;
    out[0] = (size >>> 24) & 0xff;
    out[1] = (size >>> 16) & 0xff;
    out[2] = (size >>> 8) & 0xff;
    out[3] = size & 0xff;
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let at = 8;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const zeros = (n: number): Uint8Array => new Uint8Array(n);

function fourCc(type: string): Uint8Array {
    return new Uint8Array([...type].map((c) => c.charCodeAt(0)));
}

/** `hdlr` — FullBox header, pre_defined, then the handler fourcc. */
function hdlr(kind: string): Uint8Array {
    return box("hdlr", zeros(4), zeros(4), fourCc(kind), zeros(12));
}

/** `stsd` — FullBox header, entry_count, then the sample entries. */
function stsd(...entries: Uint8Array[]): Uint8Array {
    return box("stsd", zeros(4), bytes(0, 0, 0, entries.length), ...entries);
}

function trak(kind: string, description: Uint8Array): Uint8Array {
    return box(
        "trak",
        box("mdia", hdlr(kind), box("minf", box("stbl", description))),
    );
}

/** A `VisualSampleEntry`: 78 bytes of fixed fields, then `avcC`. */
function avcEntry(
    profile: number,
    compatibility: number,
    level: number,
): Uint8Array {
    const fixed = zeros(78);
    // width / height, 24 bytes in — read back by parseVideoSize.
    fixed[24] = 0;
    fixed[25] = 160;
    fixed[26] = 0;
    fixed[27] = 120;
    return box(
        "avc1",
        fixed,
        box("avcC", bytes(1, profile, compatibility, level)),
    );
}

/** A version-0 `AudioSampleEntry`: 28 bytes of fixed fields, then children. */
function audioEntry(type: string, ...children: Uint8Array[]): Uint8Array {
    return box(type, zeros(28), ...children);
}

/** An `esds` carrying one object type, and optionally an AudioSpecificConfig. */
function esds(
    objectType: number,
    audioSpecificConfig?: Uint8Array,
): Uint8Array {
    const decoderSpecific = audioSpecificConfig
        ? bytes(0x05, audioSpecificConfig.length)
        : new Uint8Array(0);
    const configPayload = new Uint8Array([
        objectType,
        0x15, // streamType = audio
        0,
        0,
        0, // bufferSizeDB
        0,
        0,
        0,
        0, // maxBitrate
        0,
        0,
        0,
        0, // avgBitrate
        ...decoderSpecific,
        ...(audioSpecificConfig ?? []),
    ]);
    const config = new Uint8Array([
        0x04,
        configPayload.length,
        ...configPayload,
    ]);
    const esPayload = new Uint8Array([0x00, 0x01, 0x00, ...config]);
    return box("esds", zeros(4), bytes(0x03, esPayload.length), esPayload);
}

/** Wrap tracks in a `moov` — enough for `parseInitSegment` to walk. */
function moov(...traks: Uint8Array[]): Uint8Array {
    return box("moov", ...traks);
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

describe.skipIf(noFfmpeg)(
    "Mp4SegmentScanner against real ffmpeg output",
    () => {
        it("splits the stream into one init segment and a run of moof+mdat pairs", () => {
            const segments = scanAll(aacStream, 64 * 1024);

            expect(segments[0].kind).toBe("init");
            expect(boxTypeOf(segments[0].data)).toBe("ftyp");
            // The init segment is ftyp followed by moov, concatenated.
            const ftypSize =
                (segments[0].data[0] << 24) |
                (segments[0].data[1] << 16) |
                (segments[0].data[2] << 8) |
                segments[0].data[3];
            expect(boxTypeOf(segments[0].data, ftypSize)).toBe("moov");

            const media = segments.slice(1);
            expect(media.length).toBeGreaterThan(1);
            expect(media.every((s) => s.kind === "media")).toBe(true);
            for (const segment of media)
                expect(boxTypeOf(segment.data)).toBe("moof");
            expect(segments.filter((s) => s.kind === "init")).toHaveLength(1);
        });

        it("is indifferent to how the bytes are chopped up", () => {
            const reference = scanAll(aacStream, 64 * 1024);
            // A byte at a time is the pathological case: every box header arrives split.
            for (const chunkSize of [1, 3, 7, 511, 4096]) {
                const segments = scanAll(aacStream, chunkSize);
                expect(
                    segments.map((s) => `${s.kind}:${s.data.length}`),
                ).toEqual(reference.map((s) => `${s.kind}:${s.data.length}`));
            }
        });

        it("accounts for every byte of the stream", () => {
            const segments = scanAll(aacStream, 8192);
            // Nothing dropped, nothing duplicated — except boxes we deliberately ignore
            // (ffmpeg writes an `mfra` index when it closes the file).
            const emitted = segments.reduce((sum, s) => sum + s.data.length, 0);
            expect(emitted).toBeGreaterThan(aacStream.length * 0.95);
            expect(emitted).toBeLessThanOrEqual(aacStream.length);
        });

        it("reports when it has seen the moov", () => {
            const scanner = new Mp4SegmentScanner();
            expect(scanner.initialised).toBe(false);
            scanner.push(aacStream.subarray(0, 64 * 1024));
            scanner.drain();
            expect(scanner.initialised).toBe(true);
        });
    },
);

describe("Mp4SegmentScanner error handling", () => {
    it("rejects a stream that does not open with ftyp/moov", () => {
        const scanner = new Mp4SegmentScanner();
        // A well-formed box of the wrong kind: 16 bytes of `mdat`.
        scanner.push(
            new Uint8Array([
                0,
                0,
                0,
                16,
                ...fourCc("mdat"),
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
            ]),
        );
        expect(() => scanner.drain()).toThrow(Mp4ParseError);
    });

    it("rejects an open-ended box, which a live pipe can never terminate", () => {
        const scanner = new Mp4SegmentScanner();
        scanner.push(new Uint8Array([0, 0, 0, 0, ...fourCc("mdat")]));
        expect(() => scanner.drain()).toThrow(/end-of-file/);
    });

    it("rejects a box declaring a size smaller than its own header", () => {
        const scanner = new Mp4SegmentScanner();
        scanner.push(new Uint8Array([0, 0, 0, 4, ...fourCc("ftyp")]));
        expect(() => scanner.drain()).toThrow(/impossible size/);
    });

    it("rejects a moof with no mdat behind it", () => {
        const scanner = new Mp4SegmentScanner();
        scanner.push(box("ftyp", zeros(8)));
        scanner.push(moov(trak("vide", stsd(avcEntry(0x64, 0x00, 0x28)))));
        expect(scanner.drain().map((s) => s.kind)).toEqual(["init"]);
        scanner.push(box("moof", zeros(8)));
        scanner.push(box("moof", zeros(8)));
        expect(() => scanner.drain()).toThrow(/no mdat/);
    });

    it("rejects an mdat with no moof in front of it", () => {
        // The mirror of the case above, and the one that actually happens: a moof
        // lost to a short read or a resumed connection leaves samples with no
        // track-fragment header describing them. Appending them alone would put
        // Chromium's demuxer into a state it never recovers from, so the scanner
        // has to notice here — after the moov, where the "before the moov box"
        // guard no longer covers us.
        const scanner = new Mp4SegmentScanner();
        scanner.push(box("ftyp", zeros(8)));
        scanner.push(moov(trak("vide", stsd(avcEntry(0x64, 0x00, 0x28)))));
        scanner.push(box("moof", zeros(8)));
        scanner.push(box("mdat", zeros(64)));
        expect(scanner.drain().map((s) => s.kind)).toEqual(["init", "media"]);

        // The pair is consumed, so a second mdat has nothing left to pair with.
        scanner.push(box("mdat", zeros(64)));
        expect(() => scanner.drain()).toThrow(/no moof/);
    });

    it("skips the trailing boxes ffmpeg writes when it closes the file", () => {
        const scanner = new Mp4SegmentScanner();
        scanner.push(box("ftyp", zeros(8)));
        scanner.push(moov(trak("vide", stsd(avcEntry(0x64, 0x00, 0x28)))));
        scanner.push(box("moof", zeros(8)));
        scanner.push(box("mdat", zeros(64)));
        scanner.push(box("mfra", zeros(16)));
        scanner.push(box("free", zeros(4)));
        expect(scanner.drain().map((s) => s.kind)).toEqual(["init", "media"]);
    });

    it("holds back an incomplete box instead of guessing", () => {
        const scanner = new Mp4SegmentScanner();
        const ftyp = box("ftyp", zeros(8));
        scanner.push(ftyp.subarray(0, 5));
        expect(scanner.drain()).toEqual([]);
        scanner.push(ftyp.subarray(5));
        expect(scanner.drain()).toEqual([]);
        expect(scanner.initialised).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Codec strings
// ---------------------------------------------------------------------------

describe.skipIf(noFfmpeg)("parseInitSegment against real ffmpeg output", () => {
    it("derives an H.264 + AAC codec string Chromium will accept", () => {
        const init = scanAll(aacStream, 64 * 1024)[0];
        const info = parseInitSegment(init.data);

        expect(info).not.toBeNull();
        // Profile/compatibility/level as three hex bytes, per RFC 6381. ultrafast
        // gives baseline-ish profile, so assert the shape rather than the number.
        expect(info?.video).toMatch(/^avc[13]\.[0-9A-F]{6}$/);
        expect(info?.audio).toBe("mp4a.40.2");
        expect(info?.mime).toBe(`video/mp4; codecs="${info?.video},mp4a.40.2"`);
    });

    it("reads the real sample description, not a lucky offset", () => {
        const init = scanAll(aacStream, 64 * 1024)[0];
        // Proof the VisualSampleEntry prefix length is right: width/height land where
        // they should, and they are what we asked lavfi for.
        expect(parseVideoSize(init.data)).toEqual({ width: 160, height: 120 });
    });

    it("names an mp3 soundtrack from its esds object type", () => {
        if (mp3Stream === null) return;
        const init = scanAll(mp3Stream, 64 * 1024)[0];
        expect(parseInitSegment(init.data)?.audio).toBe("mp4a.6b");
    });
});

describe("parseInitSegment", () => {
    const avc = trak("vide", stsd(avcEntry(0x64, 0x00, 0x28)));

    it("formats the avcC bytes as RFC 6381 wants them", () => {
        expect(parseInitSegment(moov(avc))?.video).toBe("avc1.640028");
        expect(
            parseInitSegment(
                moov(trak("vide", stsd(avcEntry(0x42, 0xe0, 0x1e)))),
            )?.video,
        ).toBe("avc1.42E01E");
    });

    it("accepts a silent stream — the remux path really does serve those", () => {
        const info = parseInitSegment(moov(avc));
        expect(info?.audio).toBeNull();
        expect(info?.mime).toBe('video/mp4; codecs="avc1.640028"');
    });

    it("names AAC-LC, HE-AAC and mp3 from the esds descriptor tree", () => {
        const withAudio = (entry: Uint8Array): string | null | undefined =>
            parseInitSegment(moov(avc, trak("soun", stsd(entry))))?.audio;

        // AudioSpecificConfig: five bits of audio object type at the top.
        expect(
            withAudio(audioEntry("mp4a", esds(0x40, bytes(0x12, 0x10)))),
        ).toBe("mp4a.40.2");
        expect(
            withAudio(audioEntry("mp4a", esds(0x40, bytes(0x28, 0x10)))),
        ).toBe("mp4a.40.5");
        expect(
            withAudio(audioEntry("mp4a", esds(0x40, bytes(0xe8, 0x10)))),
        ).toBe("mp4a.40.29");
        expect(withAudio(audioEntry("mp4a", esds(0x6b)))).toBe("mp4a.6b");
        expect(withAudio(audioEntry("mp4a", esds(0x69)))).toBe("mp4a.6b");
    });

    it("falls back to AAC-LC for an mp4a entry with no readable esds", () => {
        const info = parseInitSegment(
            moov(avc, trak("soun", stsd(audioEntry("mp4a")))),
        );
        expect(info?.audio).toBe("mp4a.40.2");
    });

    it("names the other three soundtracks the remux path can carry", () => {
        const withAudio = (entry: Uint8Array): string | null | undefined =>
            parseInitSegment(moov(avc, trak("soun", stsd(entry))))?.audio;

        expect(withAudio(audioEntry("Opus", box("dOps", zeros(11))))).toBe(
            "opus",
        );
        expect(withAudio(audioEntry("fLaC", box("dfLa", zeros(34))))).toBe(
            "flac",
        );
        expect(withAudio(audioEntry(".mp3"))).toBe("mp4a.6b");
    });

    /**
     * The fallback contract. Returning null is not a failure — it is how an exotic
     * stream keeps playing, on the old plain-`src` path, instead of not playing.
     */
    it("returns null rather than guessing at a stream it cannot describe", () => {
        // No moov at all.
        expect(parseInitSegment(box("ftyp", zeros(8)))).toBeNull();
        // A video codec outside the parser's scope (HEVC, VP9, AV1 …).
        expect(
            parseInitSegment(moov(trak("vide", stsd(box("hvc1", zeros(78)))))),
        ).toBeNull();
        // A video track with an unreadable avcC.
        expect(
            parseInitSegment(moov(trak("vide", stsd(box("avc1", zeros(78)))))),
        ).toBeNull();
        // Audio present but unnameable: refuse rather than drop the track silently.
        expect(
            parseInitSegment(moov(avc, trak("soun", stsd(audioEntry("ac-3"))))),
        ).toBeNull();
        // Audio-only: these are television episodes.
        expect(
            parseInitSegment(moov(trak("soun", stsd(audioEntry("mp4a"))))),
        ).toBeNull();
    });

    it("ignores tracks that are neither video nor audio", () => {
        const withSubtitles = moov(
            avc,
            trak("sbtl", stsd(box("tx3g", zeros(8)))),
        );
        expect(parseInitSegment(withSubtitles)?.mime).toBe(
            'video/mp4; codecs="avc1.640028"',
        );
    });
});

// ---------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------

/**
 * A `SourceBuffer` that models the two things the pump reasons about: whether it
 * is `updating`, and what it has `buffered`. Each successful append advances the
 * buffered end by `secondsPerAppend`; `remove` moves the start.
 */
class FakeSourceBuffer implements SourceBufferLike {
    updating = false;
    bufferedStart = 0;
    bufferedEnd = 0;
    secondsPerAppend = 2;
    /** Reject this many appends with a QuotaExceededError before succeeding. */
    quotaFailures = 0;
    /**
     * From this append onwards (1-based), fire `error` instead of `updateend` —
     * how Chromium reports data its MSE demuxer refuses. Nothing is thrown: the
     * call returns normally and the rejection arrives as an event.
     */
    errorFromAppend: number | null = null;
    appends = 0;
    removals: Array<[number, number]> = [];
    private readonly listeners = new Map<string, Set<() => void>>();

    get buffered(): TimeRangesLike {
        const start = this.bufferedStart;
        const end = this.bufferedEnd;
        return {
            length: end > start ? 1 : 0,
            start: () => start,
            end: () => end,
        };
    }

    appendBuffer(): void {
        if (this.quotaFailures > 0) {
            this.quotaFailures -= 1;
            const err = new Error("buffer full");
            err.name = "QuotaExceededError";
            throw err;
        }
        this.updating = true;
        this.appends += 1;
        const nth = this.appends;
        queueMicrotask(() => {
            this.updating = false;
            if (this.errorFromAppend !== null && nth >= this.errorFromAppend) {
                this.emit("error");
                return;
            }
            this.bufferedEnd += this.secondsPerAppend;
            this.emit("updateend");
        });
    }

    remove(start: number, end: number): void {
        this.updating = true;
        this.removals.push([start, end]);
        queueMicrotask(() => {
            this.updating = false;
            this.bufferedStart = Math.max(this.bufferedStart, end);
            this.emit("updateend");
        });
    }

    addEventListener(type: string, listener: () => void): void {
        const set = this.listeners.get(type) ?? new Set();
        set.add(listener);
        this.listeners.set(type, set);
    }

    removeEventListener(type: string, listener: () => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    private emit(type: string): void {
        for (const listener of [...(this.listeners.get(type) ?? [])])
            listener();
    }
}

class FakeMediaSource implements MediaSourceLike {
    readyState = "open";
    duration = NaN;
    ended = false;
    mimes: string[] = [];
    buffers: FakeSourceBuffer[] = [];

    constructor(
        private readonly configure: (sb: FakeSourceBuffer) => void = () => {},
    ) {}

    addSourceBuffer(type: string): SourceBufferLike {
        this.mimes.push(type);
        const sb = new FakeSourceBuffer();
        this.configure(sb);
        this.buffers.push(sb);
        return sb;
    }

    endOfStream(): void {
        this.ended = true;
        this.readyState = "ended";
    }
}

interface ScriptedReader extends ByteReader {
    reads: number;
    cancelled: boolean;
}

/** A reader that hands out `chunks` in order, then reports done. */
function scriptedReader(
    chunks: Uint8Array[],
    onRead?: () => void,
): ScriptedReader {
    let index = 0;
    return {
        reads: 0,
        cancelled: false,
        async read() {
            this.reads += 1;
            onRead?.();
            if (index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
        },
        cancel() {
            this.cancelled = true;
        },
    };
}

/**
 * A reader that hands out `gateAfter` chunks and then blocks, the way a real
 * socket blocks when ffmpeg hasn't produced the next fragment yet. `cancel()`
 * releases the parked read as `done` — exactly what aborting a `fetch` does.
 */
function gatedReader(chunks: Uint8Array[], gateAfter: number): ScriptedReader {
    let index = 0;
    let release: (() => void) | null = null;
    return {
        reads: 0,
        cancelled: false,
        async read() {
            this.reads += 1;
            if (this.reads > gateAfter && !this.cancelled) {
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
            }
            if (this.cancelled || index >= chunks.length) return { done: true };
            return { done: false, value: chunks[index++] };
        },
        cancel() {
            this.cancelled = true;
            release?.();
            release = null;
        },
    };
}

/** Split a stream into `count`-ish equal bites. */
function slice(stream: Uint8Array, size: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let at = 0; at < stream.length; at += size) {
        out.push(stream.subarray(at, Math.min(stream.length, at + size)));
    }
    return out;
}

const noSleep = (): Promise<void> => Promise.resolve();

describe.skipIf(noFfmpeg)("startPump against real ffmpeg output", () => {
    it("appends the init segment, then every fragment, then ends the stream", async () => {
        const mediaSource = new FakeMediaSource();
        const reader = scriptedReader(slice(aacStream, 8192));
        const pump = startPump({
            openReader: () => Promise.resolve(reader),
            mediaSource,
            clock: { currentTime: 0 },
            durationS: 1320,
            sleep: noSleep,
            // A generous ceiling so this test is about correctness, not pacing.
            policy: { highWaterS: 1e9, backBufferS: 1e9 },
        });

        await pump.done;

        const sb = mediaSource.buffers[0];
        expect(mediaSource.buffers).toHaveLength(1);
        expect(mediaSource.mimes[0]).toMatch(/^video\/mp4; codecs="avc[13]\./);
        // init + every media fragment.
        expect(sb.appends).toBe(pump.stats.segments + 1);
        expect(pump.stats.segments).toBeGreaterThan(1);
        expect(pump.stats.bytes).toBe(aacStream.length);
        expect(mediaSource.ended).toBe(true);
        expect(pump.stats.endedStream).toBe(true);
        // A real duration is the other thing MSE buys us: the scrub bar stops guessing.
        expect(mediaSource.duration).toBe(1320);
        expect(reader.cancelled).toBe(true);
    });

    /**
     * The invariant the whole phase exists for. Before this, Chromium decided when
     * to stop reading and then dropped the connection; now the pump decides, and
     * simply not calling `read()` is what applies backpressure to ffmpeg.
     */
    it("never reads while the buffer is already full, and resumes when it drains", async () => {
        const clock = { currentTime: 0 };
        const policy: Partial<BufferPolicy> = {
            highWaterS: 60,
            lowWaterS: 15,
            backBufferS: 1e9,
            pollMs: 0,
        };
        // 30s of media per fragment, so the ceiling is crossed after two appends.
        const mediaSource = new FakeMediaSource((sb) => {
            sb.secondsPerAppend = 30;
        });

        const aheadAtEachRead: number[] = [];
        const readingSamples: boolean[] = [];
        const reader = scriptedReader(slice(aacStream, 4096), () => {
            const sb = mediaSource.buffers[0];
            if (sb) aheadAtEachRead.push(sb.bufferedEnd - clock.currentTime);
        });

        const pump = startPump({
            openReader: () => Promise.resolve(reader),
            mediaSource,
            clock,
            policy,
            // Each parked poll is a tick of playback: the playhead advances, the
            // buffer drains, and the reader is eventually allowed to continue.
            sleep: () => {
                readingSamples.push(pump.stats.reading);
                clock.currentTime += 5;
                return Promise.resolve();
            },
        });

        await pump.done;

        expect(pump.stats.segments).toBeGreaterThan(2);
        // Not one read happened above the ceiling.
        expect(Math.max(...aheadAtEachRead)).toBeLessThan(60);
        // It genuinely parked (rather than never filling up) …
        expect(readingSamples.length).toBeGreaterThan(0);
        expect(readingSamples).toContain(false);
        // … and it genuinely resumed.
        expect(mediaSource.ended).toBe(true);
        expect(pump.stats.reading).toBe(true);
    });

    it("evicts the back buffer so renderer memory stays flat across an episode", async () => {
        const clock = { currentTime: 600 };
        const mediaSource = new FakeMediaSource((sb) => {
            sb.secondsPerAppend = 10;
            sb.bufferedEnd = 600;
        });
        const pump = startPump({
            openReader: () =>
                Promise.resolve(scriptedReader(slice(aacStream, 8192))),
            mediaSource,
            clock,
            sleep: noSleep,
            policy: { highWaterS: 1e9, backBufferS: 120, pollMs: 0 },
        });

        await pump.done;

        const sb = mediaSource.buffers[0];
        expect(pump.stats.trims).toBeGreaterThan(0);
        // Everything more than 120s behind the playhead is gone, and nothing ahead
        // of it was touched.
        expect(sb.removals[0][0]).toBe(0);
        expect(sb.removals[0][1]).toBeCloseTo(480, 5);
        for (const [, end] of sb.removals)
            expect(end).toBeLessThanOrEqual(clock.currentTime);
    });

    it("evicts harder and retries when the buffer reports QuotaExceededError", async () => {
        const clock = { currentTime: 300 };
        const mediaSource = new FakeMediaSource((sb) => {
            sb.bufferedEnd = 300;
            // Two refusals in a row: the second forces the "evict everything behind
            // the playhead" last resort rather than the ordinary retry.
            sb.quotaFailures = 2;
        });
        const pump = startPump({
            openReader: () =>
                Promise.resolve(scriptedReader(slice(aacStream, 8192))),
            mediaSource,
            clock,
            sleep: noSleep,
            policy: {
                highWaterS: 1e9,
                backBufferS: 1e9,
                tightBackBufferS: 10,
                pollMs: 0,
            },
        });

        await pump.done;

        const sb = mediaSource.buffers[0];
        expect(pump.stats.quotaRetries).toBe(1);
        // The retry trims to `tightBackBufferS`, i.e. 10s behind the playhead …
        expect(sb.removals.some(([, end]) => Math.abs(end - 290) < 1e-6)).toBe(
            true,
        );
        // … and the last resort takes the rest of the back buffer.
        expect(sb.removals.some(([, end]) => Math.abs(end - 300) < 1e-6)).toBe(
            true,
        );
        // The data still made it in: a full buffer must never break the stream.
        expect(mediaSource.ended).toBe(true);
        expect(pump.stats.segments).toBeGreaterThan(0);
    });

    it("falls back when the source buffer rejects an append outright", async () => {
        // The real-world failure this exists for: Chromium's MSE demuxer is
        // stricter than its progressive one, so a stream `<video src>` plays fine
        // can still make `appendBuffer` fire `error` — mid-episode, with no
        // exception thrown and nothing on the console. Every other fallback in this
        // suite is decided *before* a byte is appended; this one is decided after,
        // which is the branch in `operate()`'s error listener.
        const mediaSource = new FakeMediaSource((sb) => {
            // Init and the first fragment land, then the buffer turns on us.
            sb.errorFromAppend = 3;
        });
        let reason: string | null = null;
        const pump = startPump({
            openReader: () =>
                Promise.resolve(scriptedReader(slice(aacStream, 8192))),
            mediaSource,
            clock: { currentTime: 0 },
            sleep: noSleep,
            policy: { highWaterS: 1e9, backBufferS: 1e9, pollMs: 0 },
            onFallback: (why) => {
                reason = why;
            },
            onError: () => {
                throw new Error(
                    "a rejected append is a fallback, not a failure card",
                );
            },
        });

        await pump.done;

        expect(pump.stats.fellBack).toBe(true);
        expect(reason).toMatch(/rejected the data/);
        // It gave up where the rejection happened rather than pushing on …
        expect(mediaSource.buffers[0].appends).toBe(3);
        // … and never told the element the episode was complete, which would have
        // stranded the viewer on a half-buffered stream instead of reloading it.
        expect(mediaSource.ended).toBe(false);
        expect(pump.stats.endedStream).toBe(false);
    });

    it("falls back when the browser refuses the codecs we derived", async () => {
        const mediaSource = new FakeMediaSource();
        mediaSource.addSourceBuffer = (): never => {
            const err = new Error("unsupported");
            err.name = "NotSupportedError";
            throw err;
        };
        let reason: string | null = null;
        const pump = startPump({
            openReader: () =>
                Promise.resolve(scriptedReader(slice(aacStream, 8192))),
            mediaSource,
            clock: { currentTime: 0 },
            sleep: noSleep,
            onFallback: (why) => {
                reason = why;
            },
            onError: () => {
                throw new Error(
                    "an unsupported codec is a fallback, not an error",
                );
            },
        });

        await pump.done;
        expect(pump.stats.fellBack).toBe(true);
        expect(reason).toMatch(/refused codecs video\/mp4/);
    });

    it("stays silent when the pump is stopped mid-stream, and frees the reader", async () => {
        const mediaSource = new FakeMediaSource();
        const chunks = slice(aacStream, 512);
        const reader = gatedReader(chunks, 3);
        const pump = startPump({
            openReader: () => Promise.resolve(reader),
            mediaSource,
            clock: { currentTime: 0 },
            sleep: noSleep,
            policy: { highWaterS: 1e9 },
            onError: () => {
                throw new Error("teardown is not an error");
            },
        });

        // Wait until the reader is parked mid-episode, then tear the pump down the
        // way a seek, a skip or leaving the player does.
        while (reader.reads <= 3)
            await new Promise((resolve) => setTimeout(resolve, 1));
        pump.stop();
        await pump.done;

        expect(reader.cancelled).toBe(true);
        // Only what it had already read — the point is that it stopped early.
        expect(pump.stats.bytes).toBe(
            chunks.slice(0, 3).reduce((n, c) => n + c.length, 0),
        );
        expect(pump.stats.bytes).toBeLessThan(aacStream.length);
        // Cancelling a stream mid-episode must not tell the element it is complete.
        expect(mediaSource.ended).toBe(false);
        expect(pump.stats.endedStream).toBe(false);
    });

    /** Phase 3: a hidden standby buffers a few seconds, then behaves normally. */
    it("promote() raises a standby pump to the full read targets", async () => {
        const clock = { currentTime: 0 };
        const mediaSource = new FakeMediaSource((sb) => {
            sb.secondsPerAppend = 8;
        });
        /** Buffered-ahead at each read, and whether promotion had happened by then. */
        const observations: Array<{ ahead: number; promoted: boolean }> = [];
        let promoted = false;

        const reader = scriptedReader(slice(aacStream, 2048), () => {
            const sb = mediaSource.buffers[0];
            if (sb)
                observations.push({
                    ahead: sb.bufferedEnd - clock.currentTime,
                    promoted,
                });
        });

        const pump = startPump({
            openReader: () => Promise.resolve(reader),
            mediaSource,
            clock,
            policy: { ...STANDBY_BUFFER_POLICY, pollMs: 0 },
            promotedPolicy: { ...DEFAULT_BUFFER_POLICY, pollMs: 0 },
            sleep: () => {
                // Parked. The first time that happens the standby has reached its cap,
                // which is exactly when the handoff would promote it.
                if (!promoted) {
                    promoted = true;
                    pump.promote();
                }
                // Now it is the picture on screen, so the playhead advances and drains.
                clock.currentTime += 1;
                return Promise.resolve();
            },
        });

        await pump.done;

        expect(promoted).toBe(true);
        // While hidden it never buffered past the standby ceiling …
        const whileStandby = observations
            .filter((o) => !o.promoted)
            .map((o) => o.ahead);
        expect(whileStandby.length).toBeGreaterThan(1);
        expect(Math.max(...whileStandby)).toBeLessThan(
            STANDBY_BUFFER_POLICY.highWaterS,
        );
        // … and once promoted it read on well past it, which only the full policy allows.
        const afterPromotion = observations
            .filter((o) => o.promoted)
            .map((o) => o.ahead);
        expect(Math.max(...afterPromotion)).toBeGreaterThan(
            STANDBY_BUFFER_POLICY.highWaterS,
        );
        expect(mediaSource.ended).toBe(true);
    });
});

/**
 * The pump's failure paths, none of which need a byte ffmpeg produced.
 *
 * These used to sit inside the ffmpeg-gated `startPump` block, which meant a
 * machine without ffmpeg silently tested none of the pump's error handling —
 * the branches most likely to rot, because nothing in normal playback exercises
 * them. They are deliberately ungated: the inputs are hand-built boxes, a
 * rejected request, or no bytes at all.
 */
describe("startPump failure paths", () => {
    it("falls back rather than failing when the stream defeats the parser", async () => {
        const mediaSource = new FakeMediaSource();
        let reason: string | null = null;
        // A well-formed box that is not the fMP4 shape we asked ffmpeg for.
        const junk = new Uint8Array([
            0,
            0,
            0,
            16,
            ...fourCc("mdat"),
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ]);
        const pump = startPump({
            openReader: () => Promise.resolve(scriptedReader([junk])),
            mediaSource,
            clock: { currentTime: 0 },
            sleep: noSleep,
            onFallback: (why) => {
                reason = why;
            },
            onError: () => {
                throw new Error(
                    "a parse failure must not be reported as an error",
                );
            },
        });

        await pump.done;

        expect(pump.stats.fellBack).toBe(true);
        expect(reason).toMatch(/moov/);
        expect(mediaSource.buffers).toHaveLength(0);
        expect(mediaSource.ended).toBe(false);
    });

    it("falls back when the codecs cannot be named", async () => {
        const mediaSource = new FakeMediaSource();
        let reason: string | null = null;
        const pump = startPump({
            openReader: () =>
                Promise.resolve(
                    scriptedReader([
                        box("ftyp", zeros(8)),
                        moov(trak("vide", stsd(box("hvc1", zeros(78))))),
                    ]),
                ),
            mediaSource,
            clock: { currentTime: 0 },
            sleep: noSleep,
            onFallback: (why) => {
                reason = why;
            },
        });

        await pump.done;
        expect(reason).toMatch(/codec string/);
        expect(mediaSource.buffers).toHaveLength(0);
    });

    it("reports a failed request as an error, not a fallback", async () => {
        const mediaSource = new FakeMediaSource();
        const errors: Error[] = [];
        const pump = startPump({
            openReader: () => Promise.reject(new Error("503 no ffmpeg")),
            mediaSource,
            clock: { currentTime: 0 },
            sleep: noSleep,
            onError: (err) => errors.push(err),
        });

        await pump.done;
        expect(errors.map((e) => e.message)).toEqual(["503 no ffmpeg"]);
        expect(pump.stats.fellBack).toBe(false);
    });

    it("honours an external abort signal without reading anything", async () => {
        const mediaSource = new FakeMediaSource();
        // A perfectly good init segment: the point is that an already-aborted
        // signal short-circuits before the reader is ever touched, not that the
        // stream was unusable.
        const reader = scriptedReader([
            box("ftyp", zeros(8)),
            moov(trak("vide", stsd(avcEntry(0x64, 0x00, 0x1f)))),
        ]);
        const pump = startPump({
            openReader: () => Promise.resolve(reader),
            mediaSource,
            clock: { currentTime: 0 },
            sleep: noSleep,
            signal: { aborted: true },
        });

        await pump.done;
        expect(reader.reads).toBe(0);
        expect(mediaSource.ended).toBe(false);
    });
});
