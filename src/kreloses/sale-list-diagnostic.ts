import { addDays, clinicToday, startOfMonth } from "../filters/dates";

import { clinicHour, parseClinicInstant } from "./dates";

import { AuthFailed, isKrelosesError } from "./errors";
import { describeJsonShape, firstArray, isRecord } from "./json";
import { OPTION_LIST_KEYS, OPTION_NAME_KEYS } from "./locations";
import {
  buildSaleListFilter,
  locateSaleListFilters,
  parseSaleListPage,
  saleListRequestBody,
  saleStatusOf,
  selectionMechanism,
  SALE_GET_PATH,
  SALE_LIST_FIELDS,
  SALE_LIST_PAGE_SIZE,
  type InvoiceDateRange,
} from "./sale-list";
import type { KrelosesSession } from "./session";

/**
 * For the opt-in live smoke test: reads ONE page of the real Sale List and describes its
 * structure — which fields are there, TotalCount, the pattern of `SaleDate`, how amounts are
 * formatted, which status labels occur — so the Reader's unverified assumptions can be checked.
 * It never includes a customer or branch name, an amount, an invoice number or an id: the owner
 * pastes the report into a PUBLIC issue.
 */
export interface SaleListDiagnostic {
  range: InvoiceDateRange;
  /** How the filter template looks to the Reader (status options, selection mechanism, date format). */
  template: string;
  /** Null when the request failed (see `error`). */
  page: SaleListPageStructure | null;
  error?: string;
  /** The first active sale on the page, for the Sale Overview check. NEVER printed. */
  sample?: { saleId: string; netSen: number } | null;
}

export interface SaleListPageStructure {
  responseShape: string;
  totalCount: string;
  rows: number;
  presentFields: string[];
  missingFields: string[];
  otherFields: string[];
  saleDateFormats: string[];
  /** Rows per 3-hour slot of the clinic's day, as the Reader reads `SaleDate` (counts only). */
  saleTimesByHour: string;
  /** Whether the rows come newest first (the Reader's early stop relies on it). */
  newestFirst: "yes" | "no" | "unknown";
  /** Rows whose clinic day is outside the requested range (the server ignoring the date filter). */
  outsideRange: number;
  amounts: string;
  statuses: string[];
  cancelledSeen: boolean;
  paymentStatuses: string[];
  parse: string;
}

/** The default range for the live check: the previous calendar month up to today (clinic days). */
export function defaultDiagnosticRange(now: Date = new Date()): InvoiceDateRange {
  const today = clinicToday(now);
  return { from: startOfMonth(addDays(startOfMonth(today), -1)), to: today };
}

export async function probeSaleList(session: KrelosesSession, template: unknown, range: InvoiceDateRange): Promise<SaleListDiagnostic> {
  const diagnostic: SaleListDiagnostic = { range, template: describeTemplate(template), page: null };
  let payload: unknown;
  try {
    const filter = buildSaleListFilter(template, { dateRange: range, includeCancelled: true });
    payload = await session.postJson(SALE_GET_PATH, saleListRequestBody(1, SALE_LIST_PAGE_SIZE, filter));
  } catch (error) {
    return { ...diagnostic, error: describeDiagnosticError(error) };
  }
  diagnostic.page = describePage(payload, range);
  try {
    const parsed = parseSaleListPage(payload, { page: 1, dateRange: range, includeCancelled: true }, SALE_LIST_PAGE_SIZE);
    const active = parsed.invoices.find((invoice) => invoice.status === "active");
    diagnostic.sample = active ? { saleId: active.saleId, netSen: active.netSen } : null;
  } catch {
    diagnostic.sample = null;
  }
  return diagnostic;
}

export function formatSaleListDiagnostic(diagnostic: SaleListDiagnostic): string[] {
  const { range, page } = diagnostic;
  if (!page) return [`Sale List: FAILED — ${diagnostic.error ?? "unknown error"}`, `  Filter template: ${diagnostic.template}`];
  const list = (values: string[]) => (values.length > 0 ? values.join(", ") : "none");
  return [
    `Sale List (POST /Sale/Get, one page of ${range.from}..${range.to}, all statuses):`,
    `  Filter template: ${diagnostic.template}`,
    `  Response shape: ${page.responseShape}`,
    `  TotalCount: ${page.totalCount}; rows on the page: ${page.rows}`,
    `  Expected fields present: ${list(page.presentFields)}`,
    `  Expected fields missing: ${list(page.missingFields)}`,
    `  Other fields: ${list(page.otherFields)}`,
    `  SaleDate formats: ${list(page.saleDateFormats)}`,
    `  Sale times by KL hour (as the Reader reads SaleDate): ${page.saleTimesByHour} (clinic hours are about 09-21; most sales at 17-05 instead would mean SaleDate holds KL wall-clock time labelled as UTC, read 8 hours late)`,
    `  Rows newest first: ${page.newestFirst}`,
    `  Rows outside ${range.from}..${range.to}: ${page.outsideRange}`,
    `  Amounts: ${page.amounts}`,
    `  Sale statuses seen: ${list(page.statuses)} (cancelled sales present: ${page.cancelledSeen ? "yes" : "no"})`,
    `  Payment statuses seen: ${list(page.paymentStatuses)}`,
    `  Reader parse: ${page.parse}`,
  ];
}

const AMOUNT_FIELDS = ["GrossAmount", "Discounts", "NetAmount", "TaxAmount", "Total", "TotalPayments", "TotalRefunds"] as const;
const SCHEMA_KEY = /^[A-Za-z_$][A-Za-z0-9_$]{0,40}$/;
/** Status labels are short words; anything else is not printed. */
const LABEL = /^[A-Za-z][A-Za-z .&/-]{0,29}$/;
/** Letter runs kept in a date pattern (anything else becomes `a`): format words, not data. */
const DATE_WORDS = new Set([
  "date", "t", "z", "am", "pm",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
]);

function describePage(payload: unknown, range: InvoiceDateRange): SaleListPageStructure {
  const results = isRecord(payload) ? (firstArray(payload, ["Results", "results"]) ?? []) : [];
  const rows = results.filter(isRecord);
  const total = isRecord(payload) ? (payload.TotalCount ?? payload.totalCount) : undefined;
  const inEveryRow = (key: string) => rows.length > 0 && rows.every((row) => Object.hasOwn(row, key));
  const expected = new Set<string>(SALE_LIST_FIELDS);
  const otherKeys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => !expected.has(key) && inEveryRow(key));
  const unprintable = otherKeys.filter((key) => !SCHEMA_KEY.test(key)).length;

  const labels = (field: string) =>
    [...new Set(rows.map((row) => row[field]).filter((value): value is string => typeof value === "string" && value.trim() !== ""))]
      .map((value) => (LABEL.test(value.trim()) ? value.trim() : "<unexpected value>"))
      .filter((value, index, all) => all.indexOf(value) === index)
      .sort();

  const instants = rows.map((row) => parseClinicInstant(row.SaleDate));
  const readable = instants.filter((instant) => instant !== null);
  const slots = Array.from({ length: 8 }, () => 0);
  for (const { instant } of readable) slots[Math.floor(clinicHour(instant) / 3)]! += 1;
  const hour = (value: number) => String(value).padStart(2, "0");
  const saleTimesByHour = `${slots.map((count, slot) => `${hour(slot * 3)}-${hour(slot * 3 + 3)} ${count}`).join(", ")}; unreadable ${instants.length - readable.length}`;
  const newestFirst =
    readable.length < instants.length
      ? "unknown"
      : readable.every((current, index) => index === 0 || current.instant <= readable[index - 1]!.instant)
        ? "yes"
        : "no";

  let parse: string;
  try {
    const page = parseSaleListPage(payload, { page: 1, dateRange: range, includeCancelled: true }, SALE_LIST_PAGE_SIZE);
    parse = `OK (${page.invoices.length} invoices)`;
  } catch (error) {
    parse = `FAILED — ${describeDiagnosticError(error)}`;
  }

  return {
    responseShape: describeJsonShape(payload),
    totalCount: typeof total === "number" ? String(total) : total === undefined ? "missing" : `not a number (${typeof total})`,
    rows: results.length,
    presentFields: SALE_LIST_FIELDS.filter(inEveryRow),
    missingFields: SALE_LIST_FIELDS.filter((field) => !inEveryRow(field)),
    otherFields: [...otherKeys.filter((key) => SCHEMA_KEY.test(key)).sort(), ...(unprintable > 0 ? [`<${unprintable} unprintable>`] : [])],
    saleDateFormats: [...new Set(rows.map((row) => datePattern(row.SaleDate)))].slice(0, 5),
    saleTimesByHour,
    newestFirst,
    outsideRange: readable.filter(({ clinicDate }) => clinicDate < range.from || clinicDate > range.to).length,
    amounts: describeAmounts(rows),
    statuses: labels("SaleStatusName"),
    cancelledSeen: rows.some((row) => typeof row.SaleStatusName === "string" && saleStatusOf(row.SaleStatusName) === "cancelled"),
    paymentStatuses: labels("PaymentStatusName"),
    parse,
  };
}

/** `SaleDate`'s format with every digit as 9 and every non-format word as `a`. */
function datePattern(value: unknown): string {
  if (typeof value !== "string") return value === null ? "null" : typeof value;
  return value.replace(/[A-Za-z]+|\d/g, (token) => (/\d/.test(token) ? "9" : DATE_WORDS.has(token.toLowerCase()) ? token : "a"));
}

function describeAmounts(rows: Record<string, unknown>[]): string {
  const values = rows.flatMap((row) => AMOUNT_FIELDS.map((field) => row[field]));
  const kinds = new Set(values.map((value) => (value === null || value === "" ? "empty" : typeof value === "string" ? "strings" : typeof value === "number" ? "numbers" : "other")));
  const strings = values.filter((value): value is string => typeof value === "string");
  const yesNo = (test: (value: string) => boolean) => (strings.some(test) ? "yes" : "no");
  const order = ["strings", "numbers", "empty", "other"] as const;
  return [
    order.filter((kind) => kinds.has(kind)).join(", ") || "none",
    `thousand separators: ${yesNo((value) => /\d,\d{3}/.test(value))}`,
    `negatives in parentheses: ${yesNo((value) => /\(.*\d.*\)/.test(value))}`,
    `minus signs: ${yesNo((value) => /-\s*(RM\s*)?\d/i.test(value))}`,
    `currency prefix: ${yesNo((value) => /RM|MYR/i.test(value))}`,
  ].join("; ");
}

function describeTemplate(template: unknown): string {
  const filters = locateSaleListFilters(template);
  if (!filters) return "no list of filters";
  const parts: string[] = [];
  if (filters.status) {
    const options = (firstArray(filters.status, OPTION_LIST_KEYS) ?? []).filter(isRecord);
    const names = options.map((option) => {
      const name = OPTION_NAME_KEYS.map((key) => option[key]).find((value) => typeof value === "string") as string | undefined;
      return name && LABEL.test(name.trim()) ? name.trim() : "<unexpected value>";
    });
    const mechanism = selectionMechanism(filters.status);
    parts.push(
      `Sale status options ${names.join(", ") || "none"} (${mechanism ? `selected via ${mechanism.kind} ${mechanism.key}` : "selection mechanism NOT recognised"})`,
    );
  } else {
    parts.push("NO Sale status filter");
  }
  if (!filters.date) parts.push("no Date filter");
  else if (!filters.dateKeys) parts.push(`Date filter with unrecognised range fields ${describeJsonShape(filters.date)}`);
  else parts.push(`Date filter ${filters.dateKeys.join("/")} like ${datePattern(filters.date[filters.dateKeys[0]])}`);
  return parts.join("; ");
}

export function describeDiagnosticError(error: unknown): string {
  if (error instanceof AuthFailed) {
    return `AuthFailed (${error.reason}${error.step ? `: ${error.step}` : ""})${error.detail && error.reason !== "bad_credentials" ? ` — ${error.detail}` : ""}`;
  }
  if (isKrelosesError(error)) return `${error.name} — ${error.message}`;
  return `Unexpected ${error instanceof Error ? error.name : "error"}`;
}
