import { LayoutChanged } from "./errors";
import { describeJsonShape, firstArray, firstIdentifier, firstString, isRecord } from "./json";
import type { KrelosesSession } from "./session";

export { describeJsonShape } from "./json";

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
