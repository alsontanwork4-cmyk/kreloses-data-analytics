import { isIsoDate } from "./dates";
import { DEFAULT_DATE_PRESET, isDatePreset, resolveDatePreset } from "./presets";
import type { FilterState, GlobalFilter } from "./types";

/**
 * URL shape of the global filter:
 *
 *   ?range=<preset>            today | this-week | month-to-date | last-month | year-to-date
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   custom range (used when no preset is given)
 *   ?branch=<id>[,<id>…]       branch ids (comma-separated or repeated)
 *   ?doctor=<id>[,<id>…]       doctor ids
 *
 * No params means month to date, all branches, all doctors. Pages may add their own params
 * (e.g. `?measure=aov`); the helpers below leave those alone.
 */
export const FILTER_PARAM_KEYS = ["range", "from", "to", "branch", "doctor"] as const;

/** `URLSearchParams`, or the plain object Next.js passes to pages as `searchParams`. */
export type SearchParamsInput =
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

function getAll(params: SearchParamsInput, key: string): string[] {
  if (params instanceof URLSearchParams) return params.getAll(key);
  const value = params[key];
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : [...value];
}

function parseIds(params: SearchParamsInput, key: string): string[] | undefined {
  const ids = getAll(params, key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => ID.test(value));
  const unique = [...new Set(ids)];
  return unique.length > 0 ? unique : undefined;
}

/** Reads the global filter from URL search params. Invalid or missing input falls back to defaults. */
export function parseFilter(params: SearchParamsInput, now: Date = new Date()): FilterState {
  const ids: Pick<GlobalFilter, "branchIds" | "doctorIds"> = {};
  const branchIds = parseIds(params, "branch");
  const doctorIds = parseIds(params, "doctor");
  if (branchIds) ids.branchIds = branchIds;
  if (doctorIds) ids.doctorIds = doctorIds;

  const range = getAll(params, "range")[0];
  if (isDatePreset(range)) {
    return { range, filter: { ...resolveDatePreset(range, now), ...ids } };
  }

  const from = getAll(params, "from")[0];
  const to = getAll(params, "to")[0];
  if (isIsoDate(from) && isIsoDate(to)) {
    const [dateFrom, dateTo] = from <= to ? [from, to] : [to, from];
    return { range: "custom", filter: { dateFrom, dateTo, ...ids } };
  }

  return {
    range: DEFAULT_DATE_PRESET,
    filter: { ...resolveDatePreset(DEFAULT_DATE_PRESET, now), ...ids },
  };
}

/**
 * The filter as search params (filter keys only). Presets are written by name, custom ranges
 * as from/to, and the default view as nothing at all.
 */
export function serializeFilter(state: FilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.range === "custom") {
    params.set("from", state.filter.dateFrom);
    params.set("to", state.filter.dateTo);
  } else if (state.range !== DEFAULT_DATE_PRESET) {
    params.set("range", state.range);
  }
  if (state.filter.branchIds?.length) params.set("branch", state.filter.branchIds.join(","));
  if (state.filter.doctorIds?.length) params.set("doctor", state.filter.doctorIds.join(","));
  return params;
}

function toUrlSearchParams(params: SearchParamsInput): URLSearchParams {
  if (params instanceof URLSearchParams) return new URLSearchParams(params);
  const copy = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const item of value === undefined ? [] : typeof value === "string" ? [value] : value) {
      copy.append(key, item);
    }
  }
  return copy;
}

/** `current` with its filter params replaced by `state`; other (page-specific) params are kept. */
export function mergeFilterIntoSearchParams(
  current: SearchParamsInput,
  state: FilterState,
): URLSearchParams {
  const merged = toUrlSearchParams(current);
  for (const key of FILTER_PARAM_KEYS) merged.delete(key);
  for (const [key, value] of serializeFilter(state)) merged.append(key, value);
  return merged;
}

/** Only the filter params of `params`, e.g. to carry the filter across links to other pages. */
export function filterSearchParamsOnly(params: SearchParamsInput): URLSearchParams {
  const all = toUrlSearchParams(params);
  const kept = new URLSearchParams();
  for (const [key, value] of all) {
    if ((FILTER_PARAM_KEYS as readonly string[]).includes(key)) kept.append(key, value);
  }
  return kept;
}

/** `path` plus a query string (or just `path` when `params` is empty). */
export function withSearchParams(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
