import { LayoutChanged } from "./errors";
import { describeJsonShape, firstArray, firstIdentifier, firstString, isRecord } from "./json";
import { findFilterList, FILTER_LABEL_KEYS, OPTION_ID_KEYS, OPTION_LIST_KEYS, OPTION_NAME_KEYS, saleListFilterTemplate } from "./locations";
import type { KrelosesSession } from "./session";

/** A Kreloses staff member as the Sale List's Staff filter lists them (full name). */
export interface KrelosesStaffMember {
  /** Kreloses's own staff id, as a string. */
  id: string;
  /** The full name, e.g. "Dr Alpha Anderson" (invoice lines show a short form such as "Dr Alpha"). */
  name: string;
}

const STAFF_LABEL = /^\s*(staff|staffs|employees?)\s*$/i;
const ALL_OPTION = /^\s*all(\s+(staff|staffs|employees?))?\s*$/i;

/**
 * The staff the login can see, from the Staff filter of the Sale List's filter template
 * (`POST /Report/GetFilter {report: 14}`, fetched once per session and shared with
 * `listLocations` / `listInvoices`). Used to match the short names on invoice lines to full names.
 *
 * Raises `LayoutChanged` when the template has no Staff filter, or an option has no id or name.
 * A Staff filter without options (e.g. one that loads its choices on demand) lists nobody: names on
 * lines then stay unmatched (still credited, to alias-only staff) until the owner maps them.
 */
export async function listStaff(session: KrelosesSession): Promise<KrelosesStaffMember[]> {
  return parseStaff(await saleListFilterTemplate(session));
}

export function parseStaff(template: unknown): KrelosesStaffMember[] {
  const fail = (message: string): never => {
    throw new LayoutChanged(`GetFilter: ${message}`, { shape: describeJsonShape(template) });
  };
  const filters = findFilterList(template);
  if (!filters) return fail("no list of filters in the response");
  const staff = filters.find((filter) => isRecord(filter) && STAFF_LABEL.test(firstString(filter, FILTER_LABEL_KEYS) ?? ""));
  if (!isRecord(staff)) return fail("no Staff filter");

  const seen = new Set<string>();
  const members: KrelosesStaffMember[] = [];
  for (const option of firstArray(staff, OPTION_LIST_KEYS) ?? []) {
    if (!isRecord(option)) return fail("a Staff option is not an object");
    const id = firstIdentifier(option, OPTION_ID_KEYS);
    const name = firstString(option, OPTION_NAME_KEYS)?.replace(/\s+/g, " ").trim();
    if (id === null || !name) return fail("a Staff option has no id or name");
    if (id === "" || ALL_OPTION.test(name) || seen.has(id)) continue;
    seen.add(id);
    members.push({ id, name });
  }
  return members;
}
