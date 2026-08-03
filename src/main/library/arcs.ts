/**
 * Multipart arc detection (docs/library.md).
 *
 * A "Part 1 / Part 2" pair is the one piece of structure that filenames reliably
 * carry, and it matters more than it looks: an arc is a single *playable unit*
 * (see `PlayableUnit` in shared/types), so detecting it correctly is what stops
 * the scheduler airing a two-parter's conclusion first.
 *
 * The heuristic is intentionally conservative — it is a head start, not the
 * source of truth. Anything it misses (or invents) the user fixes in the Library
 * screen, and manual arcs always win: the scanner only ever rewrites arcs it
 * created itself.
 *
 * Pure function over already-parsed episodes, so it can be tested without a db.
 */

export interface ArcCandidate {
    id: number;
    season: number;
    episode: number;
    title: string | null;
}

export interface DetectedArc {
    /** The shared stem, e.g. `The Gathering` for `The Gathering - Part 1/2`. */
    title: string;
    /** Member episode ids in airing order. */
    episodeIds: number[];
}

/** Word forms scene releases actually use. Beyond twelve, digits are the norm. */
const WORD_NUMBERS: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
};

/**
 * The part marker must sit at the *end* of the title, because that is the only
 * position where it is unambiguous: `Part 2` mid-title is usually prose ("The
 * Part 2 Solution"), while a trailing marker is a numbering convention.
 *
 * Accepted: `Part 3`, `Pt. 3`, `Pt 3`, `Part Three`, `(3)`. Roman numerals are
 * deliberately *not* accepted — `Part I` is indistinguishable from a title
 * ending in a stray initial, and a false arc is worse than a missed one.
 */
const PART_MARKER = new RegExp(
    `^(?<stem>.*?)` +
        String.raw`(?:[\s,:;–—-]*\(\s*(?<paren>\d{1,2})\s*\)` +
        String.raw`|[\s,:;–—-]+(?:part|pt\.?)\s*(?<num>\d{1,2}|[a-z]+))\s*$`,
    "i",
);

interface Marked {
    candidate: ArcCandidate;
    /** Lower-cased, punctuation-trimmed stem used for run comparison. */
    key: string;
    /** Stem in its original casing — becomes the arc title. */
    display: string;
    part: number;
}

/**
 * Group consecutive same-stem `Part N` episodes into arcs.
 *
 * Rules, all of them there to avoid false positives:
 * - members must share a season and run over contiguous episode numbers, so an
 *   unrelated episode sitting between two parts breaks the arc;
 * - part numbers must run 1, 2, 3… with no gaps and must start at 1, so a
 *   library missing Part 1 produces nothing rather than a headless arc;
 * - at least two parts.
 *
 * Input is normally already sorted, but it is sorted defensively here so a
 * caller passing raw query output can't silently produce a scrambled arc.
 */
export function detectArcs(episodes: ArcCandidate[]): DetectedArc[] {
    const sorted = [...episodes].sort(
        (a, b) => a.season - b.season || a.episode - b.episode,
    );

    const arcs: DetectedArc[] = [];
    let run: Marked[] = [];

    const flush = (): void => {
        // A run only counts if it is a complete 1..N sequence of at least two parts.
        // (Runs are built so that part numbers already increment by one, so it is
        // enough to check the head.)
        if (run.length >= 2 && run[0].part === 1) {
            arcs.push({
                title: run[0].display,
                episodeIds: run.map((m) => m.candidate.id),
            });
        }
        run = [];
    };

    for (const candidate of sorted) {
        const marked = mark(candidate);
        if (!marked) {
            flush();
            continue;
        }
        const prev = run[run.length - 1];
        const continues =
            prev !== undefined &&
            prev.candidate.season === marked.candidate.season &&
            prev.candidate.episode + 1 === marked.candidate.episode &&
            prev.key === marked.key &&
            prev.part + 1 === marked.part;
        if (!continues) flush();
        run.push(marked);
    }
    flush();

    return arcs;
}

/** Split a title into stem + part number, or null when it isn't a part. */
function mark(candidate: ArcCandidate): Marked | null {
    if (!candidate.title) return null;
    const m = PART_MARKER.exec(candidate.title.trim());
    if (!m?.groups) return null;

    const raw = m.groups.paren ?? m.groups.num;
    const part = /^\d+$/.test(raw)
        ? Number(raw)
        : WORD_NUMBERS[raw.toLowerCase()];
    if (!part) return null;

    const display = trimPunctuation(m.groups.stem);
    // `(2)` with nothing before it, or a bare `Part 2`, has no stem to match on —
    // grouping those would join every unrelated two-parter in the season.
    if (!display) return null;

    return { candidate, key: display.toLowerCase(), display, part };
}

/** Drop the separator debris a marker leaves behind (`The Gathering -` → `The Gathering`). */
function trimPunctuation(raw: string): string {
    return raw.replace(/^[\s,:;.–—-]+|[\s,:;.–—-]+$/g, "");
}
