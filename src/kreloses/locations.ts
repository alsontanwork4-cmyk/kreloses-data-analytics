import { LayoutChanged } from "./errors";
import type { KrelosesSession } from "./session";

/** A Kreloses location (one clinic branch) that a login can see. */
export interface KrelosesLocation {
  /** Kreloses's own location id, as a string. */
  id: string;
  name: string;
}

/** Kreloses report id of the Sale List; its filter template includes the Location filter. */
export const SALE_LIST_REPORT = 14;

/**
 * The filter template of a Kreloses report (`POST /Report/GetFilter {report}`), as raw JSON.
 * The Sale List's template (report 14) is what `listInvoices` passes back as `filter` (ticket #4).
 */
export function fetchFilterTemplate(session: KrelosesSession, report: number): Promise<unknown> {
  return session.postJson("/Report/GetFilter", { report });
}

/** The Kreloses locations (branches) this session's login can see, from the Sale List's Location filter. */
export async function listLocations(session: KrelosesSession): Promise<KrelosesLocation[]> {
  return parseLocations(await fetchFilterTemplate(session, SALE_LIST_REPORT));
}

// The exact JSON of GetFilter has not been recorded yet (see src/kreloses/__fixtures__/README.md),
// so the parser accepts the usual ASP.NET spellings for each part and fails loudly otherwise.
const WRAPPER_KEYS = ["Data", "data", "Result", "result"];
const FILTER_LIST_KEYS = ["Filters", "filters", "Items", "items", "Fields", "fields"];
const FILTER_LABEL_KEYS = ["Name", "name", "Title", "title", "Label", "label", "DisplayName", "displayName", "Caption", "caption", "FieldName", "fieldName"];
const OPTION_LIST_KEYS = ["Options", "options", "Items", "items", "Values", "values", "Choices", "choices"];
const OPTION_ID_KEYS = ["Id", "id", "Value", "value", "Key", "key", "LocationId", "locationId"];
const OPTION_NAME_KEYS = ["Name", "name", "Text", "text", "Label", "label", "DisplayName", "displayName"];
const LOCATION_LABEL = /\blocations?\b/i;
const ALL_OPTION = /^\s*all(\s+locations?)?\s*$/i;

/** Extracts the Location filter's options from a GetFilter response. Raises `LayoutChanged` if absent. */
export function parseLocations(payload: unknown): KrelosesLocation[] {
  const fail = (message: string): never => {
    throw new LayoutChanged(`GetFilter: ${message}`, { shape: describeJsonShape(payload) });
  };

  // Unwrap `{data: …}`-style envelopes once.
  let root = payload;
  if (isRecord(payload) && !firstArray(payload, FILTER_LIST_KEYS)) {
    const wrapped = WRAPPER_KEYS.map((key) => payload[key]).find((inner) => isRecord(inner) || Array.isArray(inner));
    if (wrapped !== undefined) root = wrapped;
  }
  const filters = Array.isArray(root) ? root : isRecord(root) ? firstArray(root, FILTER_LIST_KEYS) : null;
  if (!filters) return fail("no list of filters in the response");

  const location = filters.find((filter) => isRecord(filter) && LOCATION_LABEL.test(firstString(filter, FILTER_LABEL_KEYS) ?? ""));
  if (!isRecord(location)) return fail("no Location filter");
  const options = firstArray(location, OPTION_LIST_KEYS);
  if (!options) return fail("the Location filter has no options");

  const seen = new Set<string>();
  const locations: KrelosesLocation[] = [];
  for (const option of options) {
    if (!isRecord(option)) return fail("a Location option is not an object");
    const id = firstIdentifier(option, OPTION_ID_KEYS);
    const name = firstString(option, OPTION_NAME_KEYS)?.trim();
    if (id === null || !name) return fail("a Location option has no id or name");
    if (id === "" || ALL_OPTION.test(name) || seen.has(id)) continue;
    seen.add(id);
    locations.push({ id, name });
  }
  // A working login always sees at least one location; none means the filter is not what we think.
  if (locations.length === 0) return fail("the Location filter lists no locations");
  return locations;
}

const SCHEMA_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,40}$/;
const MAX_SCHEMA_KEYS = 20;

/**
 * The structure of a JSON value — keys and value types, never the values — for error reports
 * and the live diagnostic (which the owner pastes into a public issue). Arrays show their first
 * element and their length. An object is shown key by key only if it looks like a schema
 * (identifier-like keys, at most 20); anything else is a dictionary whose keys may be data —
 * staff, customer or branch names, emails, ids — and is shown as `{<n keys>: <shape of first value>}`.
 */
export function describeJsonShape(value: unknown, depth = 0): string {
  if (depth > 8) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${describeJsonShape(value[0], depth + 1)}] (${value.length})`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > MAX_SCHEMA_KEYS || entries.some(([key]) => !SCHEMA_KEY.test(key))) {
      const first = entries[0];
      const count = `<${entries.length} ${entries.length === 1 ? "key" : "keys"}>`;
      return `{${count}${first ? `: ${describeJsonShape(first[1], depth + 1)}` : ""}}`;
    }
    return `{${entries.map(([key, inner]) => `${key}: ${describeJsonShape(inner, depth + 1)}`).join(", ")}}`;
  }
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstArray(record: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) if (typeof record[key] === "string") return record[key] as string;
  return null;
}

function firstIdentifier(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}
