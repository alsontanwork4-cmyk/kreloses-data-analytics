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
const MAX_DEPTH = 8;

/**
 * Single-word keys known to be field names (of Kreloses or of the usual ASP.NET/JSON shapes),
 * compared case-insensitively. A single-word key NOT in this list could be a name (`{Ong: 1}`), so
 * an object with one is never shown key by key. Compound identifiers (`SaleId`, `isRequired`,
 * `Address1`) are shown. Values are never shown, whatever the key.
 */
const KNOWN_FIELD_WORDS = new Set(
  `
  id ids key keys name names value values text label title caption type types kind code description
  status state selected checked disabled enabled visible hidden required active inactive deleted default
  order sort index page pages size count total totals sum subtotal amount amounts quantity qty price prices
  cost discount discounts tax taxes net gross balance paid due deposit rounding change points currency rate
  percent percentage date dates time from to start end created modified updated month year day week
  options option items item lines line rows row columns column fields field filters filter data result
  results success message messages error errors warning warnings report reports sale sales invoice invoices
  customer customers client clients patient patients pet pets staff doctor doctors vet vets employee employees
  user users location locations branch branches clinic category categories group groups service services
  product products package packages payment payments transaction transactions refund refunds credit
  notes note remarks remark reason reference source email phone mobile address city country postcode
  visits visit sections section heading controls control number width height format sortable url link href
  action method token version settings config model meta info summary details detail children parent level
  unit units stock sku barcode brand supplier tags tag flag flags color colour icon image gender species
  breed weight age owner is has net gross refund refunds payment payments method info note credit balance
  `
    .trim()
    .split(/\s+/),
);

/** A key that is one plain word (no inner capital, digit or underscore): it may be a name. */
const SINGLE_WORD = /^(?:[A-Za-z][a-z]*|[A-Z]+)$/;

/** The lower-case words of an identifier: `NetAmount` → net, amount; `SaleID` → sale, id. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_$\d]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

type Shape =
  | { kind: "null" }
  | { kind: "deep" }
  | { kind: "primitive"; type: string }
  | { kind: "array"; element: Shape | null; length: number }
  | { kind: "object"; entries: [string, Shape][] };

/**
 * The structure of a JSON value — keys and value types, never the values — for error reports
 * and the live diagnostic (which the owner pastes into a PUBLIC issue). Arrays show their first
 * element and their length.
 *
 * An object is shown key by key only if it looks like a schema: at most 20 keys, every key an
 * identifier that is a known field word or a compound identifier (`SaleId`), and values of more
 * than one shape. Anything else may be a dictionary whose keys are data — staff, customer or
 * branch names (even single words such as `{Ong: 1}`), emails, ids — and is shown as
 * `{<n keys>: <shape of the values>}` (several shapes joined by `|`). When comparing shapes a null
 * matches anything, at any depth (`{Ong: {Phone: "1"}, Tan: {Phone: null}}` is a dictionary). The
 * price is that a genuine schema whose values all share one shape (e.g. `{From: string, To:
 * string}`) is collapsed too.
 */
export function describeJsonShape(value: unknown): string {
  return render(shapeOf(value, 0));
}

function shapeOf(value: unknown, depth: number): Shape {
  if (depth > MAX_DEPTH) return { kind: "deep" };
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) {
    return { kind: "array", element: value.length === 0 ? null : shapeOf(value[0], depth + 1), length: value.length };
  }
  if (isRecord(value)) return { kind: "object", entries: Object.entries(value).map(([key, inner]) => [key, shapeOf(inner, depth + 1)]) };
  return { kind: "primitive", type: typeof value };
}

/** Whether two shapes could describe the same kind of value (null and "too deep" match anything). */
function compatible(a: Shape, b: Shape): boolean {
  if (a.kind === "null" || b.kind === "null" || a.kind === "deep" || b.kind === "deep") return true;
  if (a.kind === "primitive" && b.kind === "primitive") return a.type === b.type;
  if (a.kind === "array" && b.kind === "array") return a.element === null || b.element === null || compatible(a.element, b.element);
  if (a.kind === "object" && b.kind === "object") {
    if (a.entries.length !== b.entries.length) return false;
    const other = new Map(b.entries);
    return a.entries.every(([key, shape]) => other.has(key) && compatible(shape, other.get(key)!));
  }
  return false;
}

/** One shape for two compatible ones, filling nulls and empty arrays from the other. */
function merge(a: Shape, b: Shape): Shape {
  if (a.kind === "null" || a.kind === "deep") return b;
  if (b.kind === "null" || b.kind === "deep") return a;
  if (a.kind === "array" && b.kind === "array") {
    if (a.element === null) return b;
    if (b.element === null) return a;
    return { ...a, element: merge(a.element, b.element) };
  }
  if (a.kind === "object" && b.kind === "object") {
    const other = new Map(b.entries);
    return { kind: "object", entries: a.entries.map(([key, shape]) => [key, other.has(key) ? merge(shape, other.get(key)!) : shape]) };
  }
  return a;
}

function render(shape: Shape): string {
  switch (shape.kind) {
    case "null":
      return "null";
    case "deep":
      return "…";
    case "primitive":
      return shape.type;
    case "array":
      return shape.element === null ? "[]" : `[${render(shape.element)}] (${shape.length})`;
    case "object":
      return renderObject(shape.entries);
  }
}

function renderObject(entries: [string, Shape][]): string {
  if (entries.length === 0) return "{}";
  const nonNull: Shape[] = entries.map(([, shape]) => shape).filter((shape) => shape.kind !== "null");
  const uniform = nonNull.every((shape, index) => nonNull.slice(0, index).every((earlier) => compatible(earlier, shape)));
  // Values of mixed shapes: a schema unless a key is an unknown single word (maybe a name).
  // Values all of one shape: a dictionary unless every key is made only of known field words
  // (`NetAmount`, `TotalRefunds`, `From`/`To`), which names never are.
  const mayBeData = uniform
    ? entries.some(([key]) => !SCHEMA_KEY.test(key) || !keyWords(key).every((word) => KNOWN_FIELD_WORDS.has(word)))
    : entries.some(([key]) => !SCHEMA_KEY.test(key) || (SINGLE_WORD.test(key) && !KNOWN_FIELD_WORDS.has(key.toLowerCase())));
  if (!mayBeData && entries.length <= MAX_SCHEMA_KEYS) {
    return `{${entries.map(([key, shape]) => `${key}: ${render(shape)}`).join(", ")}}`;
  }
  const values = uniform
    ? nonNull.length === 0
      ? "null"
      : render(nonNull.reduce(merge))
    : [...new Set(nonNull.map(render))].join(" | ");
  return `{<${entries.length} ${entries.length === 1 ? "key" : "keys"}>: ${values}}`;
}
