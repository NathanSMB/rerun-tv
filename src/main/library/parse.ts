/**
 * Filename parsing (docs/library.md).
 *
 * The MVP has no network metadata lookups, so a file's identity is whatever we
 * can read off the path: the show from the top-level folder under the scan root,
 * the season/episode from an `SxxExx`-style code in the filename, and the episode
 * title from whatever trails that code.
 *
 * The grammar is deliberately narrow. Anything it can't read lands in the
 * Unmatched bucket where the user assigns it by hand — a wrong guess is worse
 * than no guess, because a mis-parsed file silently airs under the wrong show.
 * Widening the grammar is a case-by-case decision, which is why every accepted
 * form below has a test.
 *
 * Pure string work only: no fs access, so this stays trivially testable.
 */

import { basename, extname, relative, sep } from "node:path";

export interface ParsedEpisode {
    season: number;
    /** First episode number. For a double (`S01E03-E04`) this is 3. */
    episode: number;
    /** Last episode number for a multi-episode file, else null. */
    episodeEnd: number | null;
    /** Cleaned title trailing the code, or null when only release junk followed. */
    title: string | null;
}

/**
 * Containers we are willing to hand to ffprobe. An allowlist rather than a
 * denylist: a scan root full of subtitles, artwork and `.nfo` files should cost
 * nothing, and an unknown extension is far more likely to be junk than video.
 */
const VIDEO_EXTENSIONS = new Set([
    ".mkv",
    ".mp4",
    ".m4v",
    ".avi",
    ".mov",
    ".webm",
    ".ts",
    ".m2ts",
    ".wmv",
    ".flv",
    ".mpg",
    ".mpeg",
    ".ogv",
]);

/**
 * `S01E03`, plus the optional second half of a double episode. The tail accepts
 * `-E04`, `E04` and `-S01E04` because all three are common in the wild and they
 * are unambiguous: the separator group can only be followed by another episode
 * marker, never by title text (`S01E03 Escape` doesn't match — no digits).
 */
const SXXEXX =
    /s(\d{1,3})[\s._-]*e(\d{1,3})(?:[\s._-]*(?:s\d{1,3})?e(\d{1,3}))?/i;

/**
 * The `1x03` form. The leading `(?:^|\D)` guard is what keeps `1920x1080` from
 * parsing as season 20, episode 108 — the digits either start the string or are
 * preceded by a non-digit. The tail covers `1x03-04` and `1x03x04`.
 */
const NXNN = /(?:^|\D)(\d{1,2})x(\d{1,3})(?:[-x](\d{1,3}))?/i;

/**
 * Tokens that mark the start of the release-metadata tail. Once one of these
 * appears, everything from there on is scanner noise rather than title, so the
 * title is truncated at the first hit instead of individual tokens being
 * deleted — that reliably drops trailing group names we've never seen before.
 */
const JUNK_TOKEN =
    /^(?:\d{3,4}[pi]|4k|uhd|hdr|sdr|x264|x265|h264|h265|avc|hevc|divx|xvid|mpeg2|web|webrip|webdl|bluray|bdrip|brrip|dvdrip|dvd|dvdr|hdtv|pdtv|hdrip|remux|proper|repack|internal|extended|uncut|remastered|limited|dubbed|subbed|aac\d?|ac3|eac3|dts|dd\d?|ddp\d?|truehd|atmos|flac|mp3|opus|\d{1,2}bit|hi10p|amzn|nf|hulu|dsnp|itunes)$/i;

/** `WEB-DL` and `Blu-Ray` survive the token split as two halves; catch them whole. */
const JUNK_PHRASE =
    /\b(?:web[\s-]?dl|blu[\s-]?ray|dts[\s-]?hd|dd[p]?[\s-]?\d\.\d)\b.*$/i;

/** A parenthesised or bracketed year, e.g. `(1994)` — always metadata, never title. */
const BRACKETED_YEAR = /[([](?:19|20)\d{2}[)\]]/g;

/** Bracketed release-group tags, e.g. `[GROUP]` or `{edition-x}`. */
const BRACKETED_TAG = /[[{][^\]}]*[\]}]/g;

/** Is this a file we should bother probing? Extension allowlist, case-insensitive. */
export function isVideoFile(filePath: string): boolean {
    return VIDEO_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/**
 * Read season/episode (and an optional second episode number) out of a filename.
 *
 * Only the basename is considered — a folder called `Season 01` must not be able
 * to supply the season when the filename itself is unparseable, because then a
 * whole folder of junk would collapse onto episode numbers we invented.
 *
 * Returns null when nothing matches; the caller records the file as unmatched.
 */
export function parseEpisodeFilename(filename: string): ParsedEpisode | null {
    const stem = stripExtension(basename(filename));

    const sxx = SXXEXX.exec(stem);
    const nxn = sxx ? null : NXNN.exec(stem);
    const match = sxx ?? nxn;
    if (!match) return null;

    const season = Number(match[1]);
    const episode = Number(match[2]);
    const end = match[3] === undefined ? null : Number(match[3]);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;

    // `S01E03-E03` and `S01E03-E02` are noise, not a range: keep only sane ends.
    const episodeEnd = end !== null && end > episode ? end : null;

    const tail = stem.slice(match.index + match[0].length);
    return { season, episode, episodeEnd, title: cleanTitle(tail) };
}

/**
 * The show a file belongs to: the first path segment under the scan root.
 *
 * `~/TV` + `~/TV/Gargoyles/Season 01/Gargoyles - S01E03.mkv` → `Gargoyles`, and
 * the same answer regardless of how deep the file sits, so `Specials/` and
 * `Season 01/` land on one show. Files sitting directly in the root have no
 * folder to name them, so the filename's leading text (everything before the
 * episode code) is used instead.
 *
 * A trailing *bracketed* year is stripped (`Gargoyles (1994)` → `Gargoyles`) but
 * a bare trailing number is not — `Space 1999` and `Battlestar Galactica 2003`
 * are titles, and there is no way to tell them from a disambiguating year.
 */
export function deriveShowTitle(rootPath: string, filePath: string): string {
    const rel = relative(rootPath, filePath);
    const segments = rel.split(sep).filter((s) => s.length > 0 && s !== ".");

    // More than one segment means the first one is a folder: that's the show.
    if (segments.length > 1) return tidyShowName(segments[0]);

    const stem = stripExtension(basename(filePath));
    const code = SXXEXX.exec(stem) ?? NXNN.exec(stem);
    const lead = code ? stem.slice(0, code.index) : stem;
    const name = tidyShowName(lead);
    // A file named only `S01E03.mkv` leaves nothing; fall back to the whole stem.
    return name.length > 0 ? name : tidyShowName(stem);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stripExtension(name: string): string {
    const ext = extname(name);
    return ext ? name.slice(0, -ext.length) : name;
}

/** Folder/filename → display name: drop bracketed junk, undo dot separators. */
function tidyShowName(raw: string): string {
    const withoutBrackets = raw
        .replace(BRACKETED_YEAR, " ")
        .replace(BRACKETED_TAG, " ");
    return collapse(dotsToSpaces(withoutBrackets)).replace(
        /^[-–—\s.]+|[-–—\s.,]+$/g,
        "",
    );
}

/**
 * `.` and `_` are always separators in scene naming, so they become spaces.
 * `-` is *not* — `Spider-Man` and `Blu-Ray` look identical to a naive split —
 * so hyphens are only trimmed at the edges and left alone inside words.
 */
function dotsToSpaces(raw: string): string {
    return raw.replace(/[._]+/g, " ");
}

function collapse(raw: string): string {
    return raw.replace(/\s+/g, " ").trim();
}

/**
 * Turn the text trailing the episode code into an episode title, or null.
 *
 * The order matters: bracketed tags go first (they can contain anything),
 * then the multi-word release phrases, then a token-wise truncation at the first
 * release keyword. Note that `(1)` and `Part 2` deliberately survive — the arc
 * heuristic in `arcs.ts` reads them straight off the stored title.
 */
function cleanTitle(tail: string): string | null {
    let text = tail.replace(BRACKETED_YEAR, " ").replace(BRACKETED_TAG, " ");
    text = dotsToSpaces(text);
    text = text.replace(JUNK_PHRASE, " ");

    const words = collapse(text).split(" ");
    const kept: string[] = [];
    for (const word of words) {
        // Hyphenated compounds such as `WEB-DL` or `AMZN-GROUP` count as junk if
        // either half is a known release token.
        const parts = word.split("-").filter(Boolean);
        if (parts.some((p) => JUNK_TOKEN.test(p))) break;
        kept.push(word);
    }

    const title = collapse(kept.join(" ")).replace(
        /^[-–—:_\s]+|[-–—:_\s]+$/g,
        "",
    );
    // Anything with no letters or digits left (a stray `-`, an empty string) is
    // not a title.
    return /[\p{L}\p{N}]/u.test(title) ? title : null;
}
