import {
    deriveShowTitle,
    isVideoFile,
    parseEpisodeFilename,
} from "@main/library/parse.js";
import { describe, expect, it } from "vitest";

describe("parseEpisodeFilename — accepted grammar", () => {
    it("parses the canonical SxxExx form", () => {
        expect(parseEpisodeFilename("Gargoyles - S01E03.mkv")).toEqual({
            season: 1,
            episode: 3,
            episodeEnd: null,
            title: null,
        });
    });

    it("is case-insensitive", () => {
        expect(parseEpisodeFilename("gargoyles.s01e03.mkv")).toMatchObject({
            season: 1,
            episode: 3,
        });
        expect(parseEpisodeFilename("GARGOYLES.S01E03.MKV")).toMatchObject({
            season: 1,
            episode: 3,
        });
    });

    it("parses the 1x03 form", () => {
        expect(
            parseEpisodeFilename("Gargoyles - 1x03 - Enter Macbeth.mkv"),
        ).toEqual({
            season: 1,
            episode: 3,
            episodeEnd: null,
            title: "Enter Macbeth",
        });
    });

    it("parses three-digit episode numbers", () => {
        expect(parseEpisodeFilename("Show S02E101.mkv")).toMatchObject({
            season: 2,
            episode: 101,
        });
    });

    it("parses separators between the season and episode markers", () => {
        expect(parseEpisodeFilename("Show S01 E03.mkv")).toMatchObject({
            season: 1,
            episode: 3,
        });
        expect(parseEpisodeFilename("Show.S01.E03.mkv")).toMatchObject({
            season: 1,
            episode: 3,
        });
    });
});

describe("parseEpisodeFilename — double episodes", () => {
    it("parses S01E03-E04", () => {
        expect(
            parseEpisodeFilename("Gargoyles - S01E03-E04 - Awakening.mkv"),
        ).toMatchObject({
            season: 1,
            episode: 3,
            episodeEnd: 4,
        });
    });

    it("parses S01E03E04", () => {
        expect(parseEpisodeFilename("Gargoyles.S01E03E04.mkv")).toMatchObject({
            episode: 3,
            episodeEnd: 4,
        });
    });

    it("parses S01E03-S01E04", () => {
        expect(
            parseEpisodeFilename("Gargoyles.S01E03-S01E04.mkv"),
        ).toMatchObject({
            episode: 3,
            episodeEnd: 4,
        });
    });

    it("parses 1x03-04", () => {
        expect(parseEpisodeFilename("Gargoyles - 1x03-04.mkv")).toMatchObject({
            episode: 3,
            episodeEnd: 4,
        });
    });

    it("ignores a nonsensical range end", () => {
        expect(parseEpisodeFilename("Show S01E05-E05.mkv")).toMatchObject({
            episode: 5,
            episodeEnd: null,
        });
        expect(parseEpisodeFilename("Show S01E05-E02.mkv")).toMatchObject({
            episode: 5,
            episodeEnd: null,
        });
    });
});

describe("parseEpisodeFilename — titles", () => {
    it("keeps the text trailing the code", () => {
        expect(
            parseEpisodeFilename("Gargoyles - S01E03 - Enter Macbeth.mkv")
                ?.title,
        ).toBe("Enter Macbeth");
    });

    it("treats dots and underscores as separators", () => {
        expect(
            parseEpisodeFilename("Gargoyles.S01E03.Enter_Macbeth.mkv")?.title,
        ).toBe("Enter Macbeth");
    });

    it("keeps hyphens inside words", () => {
        expect(
            parseEpisodeFilename("Show.S01E03.The Spider-Man Problem.mkv")
                ?.title,
        ).toBe("The Spider-Man Problem");
    });

    it("strips resolution, codec and group junk", () => {
        expect(
            parseEpisodeFilename(
                "Show.S01E03.Enter.Macbeth.1080p.x264-GROUP.mkv",
            )?.title,
        ).toBe("Enter Macbeth");
        expect(
            parseEpisodeFilename("Show.S01E03.Enter.Macbeth.720p.HDTV.mkv")
                ?.title,
        ).toBe("Enter Macbeth");
        expect(
            parseEpisodeFilename("Show.S01E03.Enter.Macbeth.WEB-DL.DD5.1.mkv")
                ?.title,
        ).toBe("Enter Macbeth");
    });

    it("strips bracketed tags and years", () => {
        expect(
            parseEpisodeFilename("Show - S01E03 - Enter Macbeth [GROUP].mkv")
                ?.title,
        ).toBe("Enter Macbeth");
        expect(
            parseEpisodeFilename("Show - S01E03 - Enter Macbeth (1994).mkv")
                ?.title,
        ).toBe("Enter Macbeth");
    });

    it("returns null when only junk trails the code", () => {
        expect(
            parseEpisodeFilename("Gargoyles - S01E03.mkv")?.title,
        ).toBeNull();
        expect(
            parseEpisodeFilename("Show.S01E03.1080p.WEB-DL.x264-GROUP.mkv")
                ?.title,
        ).toBeNull();
        expect(parseEpisodeFilename("Show - S01E03 -.mkv")?.title).toBeNull();
    });

    it("preserves part markers the arc heuristic needs", () => {
        expect(
            parseEpisodeFilename("Gargoyles - S01E01 - Awakening, Part 1.mkv")
                ?.title,
        ).toBe("Awakening, Part 1");
        expect(
            parseEpisodeFilename("Gargoyles - S01E01 - Awakening (1).mkv")
                ?.title,
        ).toBe("Awakening (1)");
    });
});

describe("parseEpisodeFilename — rejection", () => {
    it("rejects filenames with no episode code", () => {
        expect(parseEpisodeFilename("Gargoyles.mkv")).toBeNull();
        expect(parseEpisodeFilename("random home video.mp4")).toBeNull();
        expect(parseEpisodeFilename("Episode Three.mkv")).toBeNull();
    });

    it("does not mistake a resolution for a 1x03 code", () => {
        expect(parseEpisodeFilename("holiday.1920x1080.mp4")).toBeNull();
    });

    it("does not mistake a title word for a season marker", () => {
        expect(parseEpisodeFilename("Seinfeld Season Finale.mkv")).toBeNull();
    });
});

describe("deriveShowTitle", () => {
    it("uses the top-level folder under the root", () => {
        expect(
            deriveShowTitle(
                "/home/n/TV",
                "/home/n/TV/Gargoyles/Season 01/Gargoyles - S01E03.mkv",
            ),
        ).toBe("Gargoyles");
    });

    it("is unaffected by how deep the file sits", () => {
        expect(
            deriveShowTitle(
                "/home/n/TV",
                "/home/n/TV/Gargoyles/Specials/a/b/x - S01E03.mkv",
            ),
        ).toBe("Gargoyles");
    });

    it("strips a bracketed year", () => {
        expect(
            deriveShowTitle(
                "/home/n/TV",
                "/home/n/TV/Gargoyles (1994)/S01E03.mkv",
            ),
        ).toBe("Gargoyles");
        expect(
            deriveShowTitle(
                "/home/n/TV",
                "/home/n/TV/Gargoyles [1994]/S01E03.mkv",
            ),
        ).toBe("Gargoyles");
    });

    it("keeps a bare trailing number, which is usually part of the title", () => {
        expect(
            deriveShowTitle("/home/n/TV", "/home/n/TV/Space 1999/S01E03.mkv"),
        ).toBe("Space 1999");
    });

    it("undoes dot separators in folder names", () => {
        expect(
            deriveShowTitle(
                "/home/n/TV",
                "/home/n/TV/Star.Trek.TNG/S01E03.mkv",
            ),
        ).toBe("Star Trek TNG");
    });

    it("falls back to the filename when the file sits in the root", () => {
        expect(
            deriveShowTitle("/home/n/TV", "/home/n/TV/Gargoyles - S01E03.mkv"),
        ).toBe("Gargoyles");
        expect(
            deriveShowTitle(
                "/home/n/TV",
                "/home/n/TV/Gargoyles.S01E03.1080p.mkv",
            ),
        ).toBe("Gargoyles");
    });

    it("falls back to the whole stem when there is no leading text", () => {
        expect(deriveShowTitle("/home/n/TV", "/home/n/TV/S01E03.mkv")).toBe(
            "S01E03",
        );
    });

    it("handles a trailing separator on the root path", () => {
        expect(
            deriveShowTitle("/home/n/TV/", "/home/n/TV/Gargoyles/S01E03.mkv"),
        ).toBe("Gargoyles");
    });
});

describe("isVideoFile", () => {
    it("accepts the allowlisted containers", () => {
        for (const ext of [
            "mkv",
            "mp4",
            "m4v",
            "avi",
            "mov",
            "webm",
            "ts",
            "m2ts",
            "wmv",
            "flv",
            "mpg",
            "mpeg",
            "ogv",
        ]) {
            expect(isVideoFile(`/tv/show.${ext}`), ext).toBe(true);
        }
    });

    it("is case-insensitive", () => {
        expect(isVideoFile("/tv/Show.MKV")).toBe(true);
    });

    it("rejects everything else", () => {
        expect(isVideoFile("/tv/show.srt")).toBe(false);
        expect(isVideoFile("/tv/show.nfo")).toBe(false);
        expect(isVideoFile("/tv/poster.jpg")).toBe(false);
        expect(isVideoFile("/tv/show")).toBe(false);
    });
});
