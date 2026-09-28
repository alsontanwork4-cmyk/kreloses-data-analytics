import { isIsoDate, type IsoDate } from "../filters/dates";

import { detectTemplateDateFormat, parseClinicInstant, writeTemplateDate } from "./dates";
import { LayoutChanged } from "./errors";
import { describeJsonShape, firstArray, firstIdentifier, firstString, isRecord } from "./json";
import { findFilterList, saleListFilterTemplate, FILTER_LABEL_KEYS, LOCATION_LABEL, OPTION_ID_KEYS, OPTION_LIST_KEYS } from "./locations";
import { parseAmountSen } from "./money";
import type { KrelosesSession } from "./session";

/**
 * The Sale List: Kreloses's invoice list (`POST /Sale/Get`), one page at a time.
 *
 * The request is the one the Kreloses web UI sends: `{request: {…, PageSize, RequestingPage},
 * filter}`, where `filter` is the Sale List filter template (`POST /Report/GetFilter {report: 14}`,
 * fetched once per session) passed back with selections set:
 *
 * - **Sale status**: every status when `includeCancelled` (the template pre-selects only "Active",
 *   so cancellations would otherwise never be seen); left as the template has it otherwise.
 * - **Location**: every location the login can see (the template's options are already narrowed
 *   to those), in case the template pre-selects fewer.
 * - **Date**: the requested range, written in the template's own date format.
 *
 * UNVERIFIED (no real traffic recorded yet — the live smoke test prints what to check): how the
 * real template expresses selections and dates, and the listing's sort order. So the Reader does
 * not rely on the server-side date filter: it drops rows outside the range itself and, because
 * the list comes newest first, reports `hasMore: false` once a whole page is older than the range.
 */

/** Rows per page the Kreloses web UI asks for. */
export const SALE_LIST_PAGE_SIZE = 500;
export const SALE_GET_PATH = "/Sale/Get";

/** Every field a Sale List row must have (a missing one means the layout changed). */
export const SALE_LIST_FIELDS = [
  "SaleId",
  "SaleName",
  "Location",
  "LocationId",
  "CustomerId",
  "CustomerName",
  "SaleDate",
  "SaleStatusName",
  "GrossAmount",
  "Discounts",
  "NetAmount",
  "TaxAmount",
  "Total",
  "PaymentStatusName",
  "TotalPayments",
  "TotalRefunds",
] as const;

/** Whether a sale counts (`active`) or was cancelled/voided in Kreloses. */
export type SaleStatus = "active" | "cancelled";

/**
 * One invoice (a Kreloses "sale") as the Sale List shows it: no line items, no staff. Money is in
 * integer sen with Kreloses's sign (a negative total stays negative); ids are strings.
 */
export interface KrelosesInvoice {
  saleId: string;
  /** The invoice number shown to people (Kreloses's `SaleName`), if any. */
  saleNumber: string | null;
  /** Kreloses location id of the branch. */
  locationId: string;
  locationName: string;
  /** Null for a sale without a customer (a walk-in: no id, or id 0). */
  customerId: string | null;
  customerName: string | null;
  /** When the sale happened. */
  saleAt: Date;
  /** The clinic-local calendar date of `saleAt` (Asia/Kuala_Lumpur). */
  saleDate: IsoDate;
  status: SaleStatus;
  /** Kreloses's own status label (e.g. "Active", "Cancelled"). */
  statusName: string;
  grossSen: number;
  discountsSen: number;
  netSen: number;
  taxSen: number;
  totalSen: number;
  paymentStatus: string | null;
  totalPaymentsSen: number;
  totalRefundsSen: number;
  /** The row exactly as Kreloses sent it. */
  raw: Record<string, unknown>;
}

export interface InvoiceDateRange {
  /** Inclusive clinic-local dates. */
  from: IsoDate;
  to: IsoDate;
}

export interface InvoiceListQuery {
  /** 1-based page number. */
  page: number;
  /** Only sales on these clinic days. Absent = every date. */
  dateRange?: InvoiceDateRange;
  /** Also list cancelled sales (the Sale List hides them by default). */
  includeCancelled: boolean;
  /** Rows per page (1–500). Default 500, what the Kreloses UI uses; tests use small pages. */
  pageSize?: number;
}

export interface InvoicePage {
  /** The page's invoices within `dateRange` (and active only unless `includeCancelled`), newest first. */
  invoices: KrelosesInvoice[];
  /** Kreloses's count of sales matching the filter it applied. */
  totalCount: number;
  page: number;
  /** Rows Kreloses returned on this page, before the Reader's own date/status check. */
  rowCount: number;
  /** False on the last page, or when this whole page is older than `dateRange.from`. */
  hasMore: boolean;
}

/** Used when no date range is asked for, so a template's default range (e.g. month to date) never applies. */
const ALL_DATES: InvoiceDateRange = { from: "2000-01-01", to: "2099-12-31" };

/**
 * One page of the Sale List. Raises `LayoutChanged` for any response it does not fully
 * understand (missing fields, unreadable numbers or dates, an unknown sale status),
 * `AuthFailed("session_expired")` if the session has expired, and `RateLimited` / `Transient`
 * for Kreloses's own trouble. `RangeError` for a bad query (a caller bug).
 */
export async function listInvoices(session: KrelosesSession, query: InvoiceListQuery): Promise<InvoicePage> {
  const pageSize = query.pageSize ?? SALE_LIST_PAGE_SIZE;
  if (!Number.isInteger(query.page) || query.page < 1) throw new RangeError(`page must be 1 or more (got ${query.page})`);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > SALE_LIST_PAGE_SIZE) {
    throw new RangeError(`pageSize must be 1-${SALE_LIST_PAGE_SIZE} (got ${pageSize})`);
  }
  if (query.dateRange) {
    const { from, to } = query.dateRange;
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw new RangeError(`bad date range ${from}..${to}`);
  }

  const template = await saleListFilterTemplate(session);
  const filter = buildSaleListFilter(template, query);
  const payload = await session.postJson(SALE_GET_PATH, saleListRequestBody(query.page, pageSize, filter));
  return parseSaleListPage(payload, query, pageSize);
}

/** The body the Kreloses web UI posts to `/Sale/Get`: newest first, one page. */
export function saleListRequestBody(page: number, pageSize: number, filter: unknown): unknown {
  return {
    request: {
      BasicSearchQuery: null,
      IsBasicQuery: true,
      IsOrderDesc: true,
      PageSize: pageSize,
      RequestingPage: page,
      SortByColumn: null,
    },
    filter,
  };
}

// ---------------------------------------------------------------------------------------------
// The filter

const STATUS_LABEL = /^\s*(sale\s*)?status(es)?\s*$/i;
const DATE_LABEL = /date/i;
const MAIN_DATE_LABEL = /^\s*(sale\s*)?date(\s*range)?\s*$/i;
/** Option-level selection flags seen in ASP.NET/React filter models. */
const SELECTED_FLAG_KEYS = ["Selected", "selected", "IsSelected", "isSelected", "Checked", "checked"];
/** Filter-level lists of selected option ids. */
const SELECTED_LIST_KEYS = ["SelectedValues", "selectedValues", "SelectedIds", "selectedIds", "Selected", "selected"];
const DATE_RANGE_KEYS: [string, string][] = [
  ["From", "To"],
  ["from", "to"],
  ["DateFrom", "DateTo"],
  ["dateFrom", "dateTo"],
  ["FromDate", "ToDate"],
  ["fromDate", "toDate"],
  ["StartDate", "EndDate"],
  ["startDate", "endDate"],
  ["Start", "End"],
  ["start", "end"],
];

/** The Sale List template's filters that `listInvoices` sets (references into the template). */
export interface SaleListFilters {
  status: Record<string, unknown> | null;
  location: Record<string, unknown> | null;
  date: Record<string, unknown> | null;
  /** The Date filter's range fields, e.g. `["From", "To"]`; null if not recognised. */
  dateKeys: [string, string] | null;
}

/** Finds the Sale status, Location and Date filters in a Sale List template. Null if it has no filter list. */
export function locateSaleListFilters(template: unknown): SaleListFilters | null {
  const filters = findFilterList(template);
  if (!filters) return null;
  const records = filters.filter(isRecord);
  const labelOf = (filter: Record<string, unknown>) => firstString(filter, FILTER_LABEL_KEYS) ?? "";
  const dates = records.filter((filter) => DATE_LABEL.test(labelOf(filter)));
  const date = (dates.length === 1 ? dates[0] : dates.find((filter) => MAIN_DATE_LABEL.test(labelOf(filter)))) ?? null;
  return {
    status: records.find((filter) => STATUS_LABEL.test(labelOf(filter))) ?? null,
    location: records.find((filter) => LOCATION_LABEL.test(labelOf(filter))) ?? null,
    date,
    dateKeys: date ? (DATE_RANGE_KEYS.find(([from, to]) => Object.hasOwn(date, from) && Object.hasOwn(date, to)) ?? null) : null,
  };
}

/**
 * The Sale List filter template with the query's selections set (a copy; the cached template is
 * never changed). Raises `LayoutChanged` when a selection that matters cannot be made: no Sale
 * status filter (cancelled sales would be missed), or a Date filter whose range fields are not
 * recognised (its default range would silently apply).
 */
export function buildSaleListFilter(template: unknown, query: Pick<InvoiceListQuery, "dateRange" | "includeCancelled">): unknown {
  const fail = (message: string): never => {
    throw new LayoutChanged(`GetFilter (Sale List): ${message}`, { shape: describeJsonShape(template) });
  };
  const copy = structuredClone(template);
  const filters = locateSaleListFilters(copy);
  if (!filters) return fail("no list of filters in the template");

  if (query.includeCancelled) {
    if (!filters.status) return fail("no Sale status filter, so cancelled sales cannot be requested");
    selectEveryOption(filters.status, "Sale status", fail);
  }
  if (filters.location) selectEveryOption(filters.location, "Location", fail);
  if (filters.date) {
    if (!filters.dateKeys) return fail("the Date filter's range fields are not recognised, so its default range would apply");
    const [fromKey, toKey] = filters.dateKeys;
    const format = detectTemplateDateFormat([filters.date[fromKey], filters.date[toKey]]);
    const range = query.dateRange ?? ALL_DATES;
    filters.date[fromKey] = writeTemplateDate(range.from, format, false);
    filters.date[toKey] = writeTemplateDate(range.to, format, true);
  }
  return copy;
}

/**
 * How a filter records which options are selected: an option-level flag (`Selected: true`) or a
 * filter-level list of ids (`SelectedValues: [...]`). Null if neither is recognisable.
 */
export function selectionMechanism(filter: Record<string, unknown>): { kind: "option flag" | "list"; key: string } | null {
  const records = (firstArray(filter, OPTION_LIST_KEYS) ?? []).filter(isRecord);
  const flag = SELECTED_FLAG_KEYS.find((key) => records.some((option) => Object.hasOwn(option, key)));
  if (flag) return { kind: "option flag", key: flag };
  const list = SELECTED_LIST_KEYS.find((key) => Array.isArray(filter[key]));
  return list ? { kind: "list", key: list } : null;
}

/** Selects every real option of a filter (not an "All …" pseudo-option with an empty value). */
function selectEveryOption(filter: Record<string, unknown>, name: string, fail: (message: string) => never): void {
  const options = firstArray(filter, OPTION_LIST_KEYS);
  if (!options || options.length === 0) return fail(`the ${name} filter has no options`);
  const records = options.filter(isRecord);
  const isReal = (option: Record<string, unknown>) => {
    const id = firstIdentifier(option, OPTION_ID_KEYS);
    return id !== null && id !== "";
  };
  const mechanism = selectionMechanism(filter);
  if (!mechanism) return fail(`cannot tell how the ${name} filter records a selection`);
  if (mechanism.kind === "option flag") {
    for (const option of records) option[mechanism.key] = isReal(option);
  } else {
    filter[mechanism.key] = records.filter(isReal).map((option) => option[OPTION_ID_KEYS.find((key) => Object.hasOwn(option, key))!]);
  }
}

// ---------------------------------------------------------------------------------------------
// The response

const ACTIVE = /^\s*active\s*$/i;
const CANCELLED = /^\s*(cancell?ed|void(ed)?)\s*$/i;

/** `active` / `cancelled` for a Kreloses sale status label; null for a status the Reader does not know. */
export function saleStatusOf(label: string): SaleStatus | null {
  return ACTIVE.test(label) ? "active" : CANCELLED.test(label) ? "cancelled" : null;
}

/** Parses one `/Sale/Get` response (exported for the live diagnostic). */
export function parseSaleListPage(payload: unknown, query: InvoiceListQuery, pageSize: number): InvoicePage {
  const fail = (message: string): never => {
    throw new LayoutChanged(`Sale/Get: ${message}`, { shape: describeJsonShape(payload) });
  };
  if (!isRecord(payload)) return fail("the response is not a JSON object");
  const results = firstArray(payload, ["Results", "results"]);
  if (!results) return fail("no Results list in the response");
  const totalCount = readCount(payload.TotalCount ?? payload.totalCount);
  if (totalCount === null) return fail("no TotalCount in the response");

  const invoices = results.map((row, index) => parseSaleRow(row, index + 1));
  const range = query.dateRange;
  const lastPage = results.length === 0 || results.length < pageSize || query.page * pageSize >= totalCount;
  const olderThanRange = range !== undefined && invoices.length > 0 && invoices.every((invoice) => invoice.saleDate < range.from);
  return {
    invoices: invoices.filter(
      (invoice) =>
        (!range || (invoice.saleDate >= range.from && invoice.saleDate <= range.to)) &&
        (query.includeCancelled || invoice.status === "active"),
    ),
    totalCount,
    page: query.page,
    rowCount: results.length,
    hasMore: !lastPage && !olderThanRange,
  };
}

function readCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d{1,9}$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** One Sale List row → an invoice. Messages name the row and field, never a value (except a status label). */
function parseSaleRow(row: unknown, number: number): KrelosesInvoice {
  const where = `row ${number}`;
  const fail = (message: string): never => {
    throw new LayoutChanged(`Sale/Get ${message}`, { shape: describeJsonShape(row) });
  };
  if (!isRecord(row)) return fail(`${where} is not an object`);
  for (const field of SALE_LIST_FIELDS) if (!Object.hasOwn(row, field)) fail(`${where}: no ${field}`);

  const saleId = identifier(row.SaleId) ?? fail(`${where}: no SaleId`);
  const locationId = identifier(row.LocationId) ?? fail(`${where}: no LocationId`);
  const locationName = text(row.Location) ?? fail(`${where}: no Location name`);
  const customerId = identifier(row.CustomerId);
  const when = parseClinicInstant(row.SaleDate) ?? fail(`${where}: SaleDate is not a date Kreloses is known to send`);
  const statusName = text(row.SaleStatusName) ?? fail(`${where}: no SaleStatusName`);
  const status = saleStatusOf(statusName) ?? fail(`${where}: unknown sale status "${statusName.slice(0, 40)}"`);

  const amount = (field: (typeof SALE_LIST_FIELDS)[number], required: boolean): number => {
    const sen = parseAmountSen(row[field]);
    if (sen === undefined) return fail(`${where}: ${field} is not an amount in a format Kreloses is known to send`);
    if (sen === null) return required ? fail(`${where}: ${field} is empty`) : 0;
    return sen;
  };

  return {
    saleId,
    saleNumber: identifier(row.SaleName),
    locationId,
    locationName,
    customerId: customerId === "0" ? null : customerId,
    customerName: customerId === null || customerId === "0" ? null : text(row.CustomerName),
    saleAt: when.instant,
    saleDate: when.clinicDate,
    status,
    statusName: statusName.trim(),
    grossSen: amount("GrossAmount", true),
    discountsSen: amount("Discounts", false),
    netSen: amount("NetAmount", true),
    taxSen: amount("TaxAmount", false),
    totalSen: amount("Total", true),
    paymentStatus: text(row.PaymentStatusName),
    totalPaymentsSen: amount("TotalPayments", false),
    totalRefundsSen: amount("TotalRefunds", false),
    raw: row,
  };
}

/** A non-empty string or a finite number, as a trimmed string; otherwise null. */
function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
