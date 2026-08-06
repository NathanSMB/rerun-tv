/**
 * Show metadata lookup — the TVmaze client and the join
 * (docs/metadata-lookup-plan.html, "Provider: TVmaze" and "Join semantics").
 *
 * Two halves that deliberately never touch each other. The client is the only
 * part of this app besides the ffmpeg manifest that talks to the internet, and
 * it is modelled on that one (`services/ffmpeg-manager.ts`): Electron's
 * `net.fetch` so the app's proxy settings apply, an `AbortSignal.timeout` so a
 * hung provider can't wedge an IPC call forever, and a deps seam so the tests
 * drive a fake network. The one difference is what happens on failure — the
 * manifest client falls back to a shipped copy and stays silent, while a lookup
 * has nothing to fall back to, so every failure becomes a readable message the
 * renderer prints verbatim next to the input. Nothing is ever retried silently:
 * TVmaze rate-limits at ~20 requests per 10 seconds, and a retry loop is the
 * one way a single-user desktop app could reach that.
 *
 * `buildPlan` is the other half and is pure — no database, no network. That is
 * what makes the preview/apply split honest: the plan the user saw is the exact
 * set of writes, so apply needs neither the provider nor a re-join, and every
 * awkward case (spans, half-missing spans, unnumbered specials) is unit-
 * testable against two plain arrays.
 */

import { net } from "electron";
import type {
    Episode,
    MetadataCandidate,
    MetadataPlan,
} from "../../shared/types.js";

/** Stored in `shows.metadata_source`; the column exists so this can grow. */
export const METADATA_PROVIDER = "tvmaze";

const API_BASE = "https://api.tvmaze.com";

/**
 * Long enough for a cold provider, short enough that the user re-types instead
 * of wondering. The typeahead aborts in-flight searches on its own, so this
 * only bounds the last keystroke and the episode fetch behind a preview.
 */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Search results past the first handful are noise the picker can't use — TVmaze
 * scores fuzzily and happily returns twenty descending near-misses for a
 * three-letter query.
 */
const MAX_CANDIDATES = 10;

/** Multi-episode files get every part's title, in order, joined with this. */
const SPAN_SEPARATOR = " / ";

// ---------------------------------------------------------------------------
// Injection seam
// ---------------------------------------------------------------------------

/**
 * The one thing this module reaches outside itself for.
 *
 * Same shape and same reasoning as `ManagerDeps` in `ffmpeg-manager.ts`: the
 * interesting behaviour here is all about what the network does wrong (a 429, a
 * 503, a timeout, a body that isn't the shape we asked for), and none of that is
 * reachable from a test that has to call the real TVmaze.
 */
export interface MetadataDeps {
    fetch: typeof globalThis.fetch;
}

const defaultDeps: MetadataDeps = {
    // Electron's fetch rather than Node's: it follows the app's proxy settings,
    // which is the difference between working and not on a corporate machine.
    fetch: (input, init) => net.fetch(input as string, init),
};

// ---------------------------------------------------------------------------
// Provider shapes
// ---------------------------------------------------------------------------

/** One provider episode, after the nulls have been dropped. */
export interface ProviderEpisode {
    season: number;
    number: number;
    name: string;
}

/** Just enough of a picked candidate to build a plan against a local show. */
export interface PlanTarget {
    showId: number;
    providerShowId: string;
    /** The provider's series name — becomes `shows.display_title`. */
    name: string;
}

/** The local side of the join: the columns `buildPlan` actually reads. */
export type LocalEpisode = Pick<
    Episode,
    "id" | "season" | "episode" | "episodeEnd"
>;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Every failure mode of a provider call, turned into one sentence for the user.
 *
 * The renderer prints these verbatim (the `AssignPanel` precedent), so they have
 * to read like advice rather than a stack trace. A 429 gets its own wording
 * because it is the only failure where the right move is "wait a second and do
 * exactly what you just did"; everything else is either broken connectivity or a
 * provider outage, and both mean "not now".
 */
async function getJson(
    url: string,
    deps: MetadataDeps,
    signal?: AbortSignal,
): Promise<unknown> {
    let response: Response;
    try {
        response = await deps.fetch(url, {
            // Composed, not chosen: a caller's signal cancels this request, but
            // it must not also cancel the timeout, or a caller that never
            // aborts (every caller today) waits on a hung provider forever.
            signal:
                signal == null
                    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                    : AbortSignal.any([
                          signal,
                          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                      ]),
        });
    } catch (err) {
        // Offline, DNS failure, or our own timeout firing. `TimeoutError` is
        // named separately because "no response in 8 seconds" and "no network at
        // all" call for different patience from the user.
        const timedOut =
            err instanceof Error &&
            (err.name === "TimeoutError" || err.name === "AbortError");
        throw new Error(
            timedOut
                ? "TVmaze did not respond in time — check your connection and try again"
                : `Could not reach TVmaze — check your connection (${
                      err instanceof Error ? err.message : String(err)
                  })`,
        );
    }
    if (response.status === 429)
        throw new Error("TVmaze is rate-limiting — try again in a moment");
    if (!response.ok)
        throw new Error(
            `TVmaze returned HTTP ${response.status} — try again in a moment`,
        );
    try {
        return await response.json();
    } catch {
        throw new Error("TVmaze returned a response we could not read");
    }
}

/** Narrow an unknown JSON node to an object without trusting any of its keys. */
function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

const asString = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Autocomplete candidates for a query.
 *
 * `/search/shows` answers with `{ score, show }` pairs already ordered best
 * first, so the mapping keeps that order and just trims the tail. Entries
 * without a usable id or name are dropped rather than rendered as a blank row —
 * the picker's whole job is telling two similarly named series apart.
 */
export async function searchShows(
    query: string,
    deps: MetadataDeps = defaultDeps,
    signal?: AbortSignal,
): Promise<MetadataCandidate[]> {
    const trimmed = query.trim();
    // A blank query is the empty input, not an error — and TVmaze 400s on it.
    if (!trimmed) return [];

    const body = await getJson(
        `${API_BASE}/search/shows?q=${encodeURIComponent(trimmed)}`,
        deps,
        signal,
    );
    if (!Array.isArray(body)) return [];

    const candidates: MetadataCandidate[] = [];
    for (const entry of body) {
        const show = asRecord(asRecord(entry)?.show);
        if (!show) continue;
        const name = asString(show.name);
        if (name === null || show.id === undefined || show.id === null)
            continue;

        const premiered = asString(show.premiered);
        candidates.push({
            providerShowId: String(show.id),
            name,
            premiered,
            // The year is what the picker actually shows; deriving it here keeps
            // date parsing out of the renderer, and a malformed date simply
            // means no year rather than a NaN on screen.
            year: premiered ? yearOf(premiered) : null,
            // A web-only series has no `network` but does have a `webChannel`,
            // and "Netflix" is exactly as identifying as "ABC".
            network:
                asString(asRecord(show.network)?.name) ??
                asString(asRecord(show.webChannel)?.name),
            status: asString(show.status),
        });
        if (candidates.length === MAX_CANDIDATES) break;
    }
    return candidates;
}

/**
 * The provider's name for one series.
 *
 * Needed because the episode list carries no series name, and the display title
 * has to come from the provider rather than from whatever the renderer echoed
 * back: `Refresh` re-previews from the *stored* `metadata_id` with no search
 * behind it, so there is no candidate in hand to read a name off.
 */
export async function fetchShowName(
    providerShowId: string,
    deps: MetadataDeps = defaultDeps,
    signal?: AbortSignal,
): Promise<string | null> {
    const body = await getJson(
        `${API_BASE}/shows/${encodeURIComponent(providerShowId)}`,
        deps,
        signal,
    );
    return asString(asRecord(body)?.name);
}

function yearOf(premiered: string): number | null {
    const year = Number.parseInt(premiered.slice(0, 4), 10);
    return Number.isFinite(year) ? year : null;
}

/**
 * The provider's full episode list for one series.
 *
 * `specials=1` is asked for because season-0 files are ordinary local episodes
 * to us — the scanner numbers them like anything else. What comes back with a
 * null season or number is a special TVmaze itself couldn't place, and those are
 * dropped *here*, before the join, so `buildPlan` never has to reason about a
 * key that doesn't exist.
 */
export async function fetchEpisodes(
    providerShowId: string,
    deps: MetadataDeps = defaultDeps,
    signal?: AbortSignal,
): Promise<ProviderEpisode[]> {
    const body = await getJson(
        `${API_BASE}/shows/${encodeURIComponent(providerShowId)}/episodes?specials=1`,
        deps,
        signal,
    );
    if (!Array.isArray(body)) return [];

    const episodes: ProviderEpisode[] = [];
    for (const entry of body) {
        const ep = asRecord(entry);
        if (!ep) continue;
        const season = ep.season;
        const number = ep.number;
        if (typeof season !== "number" || typeof number !== "number") continue;
        const name = asString(ep.name);
        // A numbered entry with no name has nothing to write; leaving it out
        // means the local file falls through to "unmatched" and keeps the
        // filename title, which is strictly more information than "".
        if (name === null) continue;
        episodes.push({ season, number, name });
    }
    return episodes;
}

// ---------------------------------------------------------------------------
// The join
// ---------------------------------------------------------------------------

/**
 * Everything an apply will write, computed from two plain arrays.
 *
 * The join is deliberately dumb — a local episode pairs with the provider entry
 * at the same `(season, episode)`, using numbers the scanner already parsed. No
 * fuzzy titles, no air dates: a file whose numbering doesn't line up is left
 * alone and *counted*, so the preview can say "12 keep filename titles" before
 * anything is written. Provider episodes with no local file are ignored
 * outright; the plan only ever names episode ids that exist here.
 *
 * The three counts partition the local files, not the provider's: `matchedCount`
 * is one file to one entry, `multiCount` is a span (`episode_end` set) that got
 * at least one part's title, and `unmatchedCount` is every local file this plan
 * writes nothing for. A span with only one of its two parts present is still a
 * multi — half a title is the best available answer and the preview shows it —
 * but a span with neither part is unmatched like any other miss.
 */
export function buildPlan(
    show: PlanTarget,
    providerEpisodes: ProviderEpisode[],
    localEpisodes: LocalEpisode[],
): MetadataPlan {
    const byNumber = new Map<string, string>();
    // Last write wins on a duplicate key, which TVmaze does produce occasionally
    // for re-aired specials. Either title is defensible; picking one silently is
    // better than failing the whole lookup over it.
    for (const ep of providerEpisodes)
        byNumber.set(`${ep.season}x${ep.number}`, ep.name);

    const episodes: MetadataPlan["episodes"] = [];
    let matchedCount = 0;
    let multiCount = 0;
    let unmatchedCount = 0;

    for (const local of localEpisodes) {
        // `episodeEnd` equal to `episode` is a one-episode file that happened to
        // be written as a range; treating it as a span would misreport it as a
        // multi in the preview counts.
        const end =
            local.episodeEnd !== null && local.episodeEnd > local.episode
                ? local.episodeEnd
                : null;

        if (end === null) {
            const title = byNumber.get(`${local.season}x${local.episode}`);
            if (title === undefined) {
                unmatchedCount++;
                continue;
            }
            episodes.push({ episodeId: local.id, title });
            matchedCount++;
            continue;
        }

        const parts: string[] = [];
        for (let n = local.episode; n <= end; n++) {
            const title = byNumber.get(`${local.season}x${n}`);
            if (title !== undefined) parts.push(title);
        }
        if (parts.length === 0) {
            unmatchedCount++;
            continue;
        }
        episodes.push({
            episodeId: local.id,
            title: parts.join(SPAN_SEPARATOR),
        });
        multiCount++;
    }

    return {
        showId: show.showId,
        provider: METADATA_PROVIDER,
        providerShowId: show.providerShowId,
        displayTitle: show.name,
        episodes,
        matchedCount,
        multiCount,
        unmatchedCount,
    };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * What the handlers hold.
 *
 * An object rather than four free functions so `HandlerContext` can carry it
 * like every other subsystem, and so the handler tests can hand in a recording
 * fake without a module mock — the same shape the scanner and stream server
 * already have in `tests/handlers.test.ts`.
 */
export interface MetadataService {
    search(query: string, signal?: AbortSignal): Promise<MetadataCandidate[]>;
    fetchEpisodes(
        providerShowId: string,
        signal?: AbortSignal,
    ): Promise<ProviderEpisode[]>;
    /** The series name for the display title, which the episode list omits. */
    fetchShowName(
        providerShowId: string,
        signal?: AbortSignal,
    ): Promise<string | null>;
}

export function createMetadataService(
    deps: MetadataDeps = defaultDeps,
): MetadataService {
    return {
        search: (query, signal) => searchShows(query, deps, signal),
        fetchEpisodes: (id, signal) => fetchEpisodes(id, deps, signal),
        fetchShowName: (id, signal) => fetchShowName(id, deps, signal),
    };
}
