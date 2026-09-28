/**
 * Small helpers for reading Kreloses's JSON defensively. Its exact key spellings have not all been
 * recorded yet (see `__fixtures__/README.md`), so parsers accept the usual ASP.NET spellings for a
 * field and fail loudly (`LayoutChanged`) when none is present.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function firstArray(record: Record<string, unknown>, keys: readonly string[]): unknown[] | null {
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  return null;
}

export function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) if (typeof record[key] === "string") return record[key] as string;
  return null;
}

/** The first key of `keys` present on `record` (whatever its value), or null. */
export function firstKey(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) if (Object.hasOwn(record, key)) return key;
  return null;
}

/** A string or finite number, as a trimmed string (ids are sometimes numbers, sometimes strings). */
export function firstIdentifier(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

const SCHEMA_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,40}$/;
const MAX_SCHEMA_KEYS = 20;

/**
 * The structure of a JSON value — keys and value types, never the values — for error reports
 * and the live diagnostic (which the owner pastes into a public issue). Arrays show their first
 * element and their length.
 *
 * An object is shown key by key only if it looks like a schema: identifier-like keys, at most 20,
 * and values of more than one shape. Anything else may be a dictionary whose keys are data —
 * staff, customer or branch names (even single words such as `{Ong: 1}`), emails, ids — and is
 * shown as `{<n keys>: <shape of first value>}`. The price is that a genuine schema whose values
 * all share one shape (e.g. `{From: string, To: string}`) is collapsed too.
 */
export function describeJsonShape(value: unknown, depth = 0): string {
  if (depth > 8) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${describeJsonShape(value[0], depth + 1)}] (${value.length})`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const shapes = entries.map(([, inner]) => describeJsonShape(inner, depth + 1));
    const uniform = shapes.every((shape) => shape === shapes[0]);
    if (uniform || entries.length > MAX_SCHEMA_KEYS || entries.some(([key]) => !SCHEMA_KEY.test(key))) {
      return `{<${entries.length} ${entries.length === 1 ? "key" : "keys"}>: ${shapes[0]}}`;
    }
    return `{${entries.map(([key], index) => `${key}: ${shapes[index]}`).join(", ")}}`;
  }
  return typeof value;
}
