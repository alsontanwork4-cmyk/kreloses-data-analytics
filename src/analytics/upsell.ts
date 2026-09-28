import type { Sql } from "@/db/sql";
import { clinicToday, type GlobalFilter } from "@/filters";

import { branchScope, factsScope, revenueFacts, staffCondition, staffScope } from "./facts";
import { itemsPerInvoiceSql } from "./items-per-invoice";
import { getPendingLineItems, type PendingLineItems } from "./pending";
import type { DateRange } from "./periods";
import { SERVICE_ITEM_TYPE } from "./service-visits";
import { trendMonths, type TrendMonth } from "./trends";

/**
 * Upsell (spec stories 46–47, #14): how often each doctor's consults include diagnostics, products
 * or a second service (attach rates), and each doctor's average items per invoice per month. Built
 * on `revenueFacts` (credited lines, staff and item groups resolved at query time); definitions in
 * `METRIC_DEFINITIONS` (`UPSELL_DEFINITIONS`, ./upsell-definitions.ts). Counts and percentages are
 * worked out in SQL.
 */

/** Kreloses ItemType of a product line (a service is `SERVICE_ITEM_TYPE`, 4; a discount line 55). */
export const PRODUCT_ITEM_TYPE = 1;

/** One attach rate: how many consult invoices have the add-on, and that as a share of all of them. */
export interface AttachRate {
  /** Consult invoices with at least one such add-on. */
  invoices: number;
  /** invoices ÷ consult invoices × 100, one decimal; null without consult invoices. */
  percent: number | null;
}

/** The attach rates of one set of consult invoices, counting add-ons one way (whole invoice or own lines). */
export interface AttachFigures {
  /** An add-on in the Diagnostics group (`METRIC_DEFINITIONS.diagnosticsAttach`). */
  diagnostics: AttachRate;
  /** A product add-on, ItemType 1 (`productAttach`). */
  products: AttachRate;
  /** A service add-on (ItemType 4) that is not a consult (`secondServiceAttach`). */
  secondService: AttachRate;
  /** Any of the three (`anyAddOnAttach`). */
  anyAddOn: AttachRate;
}

/** Consult invoices and their attach rates, both ways of counting add-ons. */
export interface AttachRateSet {
  /** `METRIC_DEFINITIONS.consultInvoice`. For all doctors: the doctors' consult invoices added up (an invoice with two consulting doctors counts for each). */
  consultInvoices: number;
  /** Add-ons credited to anyone on the invoice: the visit's basket (the default view). */
  wholeInvoice: AttachFigures;
  /** Only add-ons credited to the doctor themselves (for all doctors: to one of the invoice's consulting doctors whose consult it is). */
  ownLines: AttachFigures;
}

export interface DoctorAttachRates extends AttachRateSet {
  staffId: string;
  /** Full Kreloses name, or the line name for alias-only staff. */
  name: string;
  source: "kreloses" | "alias_only";
  active: boolean;
}

export interface ConsultAttachRates {
  period: DateRange;
  /** Doctors (kind doctor, within the doctor filter) with at least one consult invoice, by consult invoices (most first), then name. */
  doctors: DoctorAttachRates[];
  /** Every doctor's consult invoices together in the dates and branches (the doctor filter does not apply): the clinic average. */
  allDoctors: AttachRateSet;
  /** Sales in the dates and branches whose line items are not synced yet: they cannot be classified, so they are left out (the doctor filter does not apply). */
  pendingLineItems: PendingLineItems;
}

/** A result row: a doctor's (or, `staffId` null, all doctors') consult invoices, then per add-on kind the invoices with it and their share (text, 1 dp). */
interface AttachRow {
  staffId: string | null;
  consults: number;
  diagnostics: number;
  diagnosticsPercent: string | null;
  products: number;
  productsPercent: string | null;
  secondService: number;
  secondServicePercent: string | null;
  anyAddOn: number;
  anyAddOnPercent: string | null;
  ownDiagnostics: number;
  ownDiagnosticsPercent: string | null;
  ownProducts: number;
  ownProductsPercent: string | null;
  ownSecondService: number;
  ownSecondServicePercent: string | null;
  ownAnyAddOn: number;
  ownAnyAddOnPercent: string | null;
}

/**
 * Attach rates per doctor over their consult invoices in the global filter
 * (`METRIC_DEFINITIONS.consultInvoice`, `attachRate`, `diagnosticsAttach`, `productAttach`,
 * `secondServiceAttach`, `anyAddOnAttach`):
 *
 * - A **consult invoice** of doctor D: an active sale in the dates and branches whose line items are
 *   synced, with ≥ 1 line credited to D (resolved now: a remap changes it at once) whose item has
 *   the consult flag and whose quantity is above zero (a free consult counts, a returned one not).
 * - An **add-on**: another line of that invoice that is NOT a consult line and charged more than
 *   zero (`invoice_lines.amount`, its own amount after any item discount — so a free add-on, a
 *   returned item and a discount line, which is no credited line at all, never count). Diagnostics
 *   = its item is in the Diagnostics group; product = ItemType 1; second service = ItemType 4 (not
 *   a consult). The three overlap (an X-ray service is diagnostics AND a second service).
 * - **Whole invoice**: add-ons credited to anyone (the visit's basket); **own lines**: only add-ons
 *   credited to D.
 * - Sales whose line items are not synced yet cannot be classified: they are in no figure, and
 *   `pendingLineItems` says how many there are.
 *
 * `allDoctors` pools every doctor's consult invoices (doctor filter ignored), so it is the
 * consult-weighted clinic average the doctors can be compared with.
 */
export async function getConsultAttachRates(sql: Sql, filter: GlobalFilter): Promise<ConsultAttachRates> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const addOn = sql`x.amount > 0 and not x.is_consult`;
  const diagnostics = sql`x.mix_group = 'diagnostics'`;
  const product = sql`x.item_type = ${PRODUCT_ITEM_TYPE}::int`;
  const service = sql`x.item_type = ${SERVICE_ITEM_TYPE}::int`;
  const own = sql`x.staff_id = c.staff_id`;
  /** Consult invoices with the flag, and that as a percentage of them (one decimal; null without any). */
  const counted = (flag: ReturnType<Sql>, name: string) =>
    sql`count(*) filter (where ${flag})::int as ${sql(name)}, round(100.0 * count(*) filter (where ${flag}) / nullif(count(*), 0), 1)::text as ${sql(`${name}_percent`)}`;

  const [rows, pendingLineItems] = await Promise.all([
    sql<AttachRow[]>`
      with facts as (${revenueFacts(sql, { branches: branchScope(filter), staff: { all: true } })}),
      lines as (
        select f.invoice_id, f.staff_id, f.credit_group, f.is_consult, f.mix_group, f.item_type, l.amount, l.quantity
        from facts f
        join invoice_lines l on l.id = f.invoice_line_id
        where f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date
      ),
      consults as (
        select distinct c.staff_id, c.invoice_id from lines c
        where c.credit_group = 'doctor' and c.is_consult and c.quantity > 0
      ),
      per_consult as (
        select c.staff_id, c.invoice_id,
          coalesce(bool_or(${diagnostics}), false) as diagnostics,
          coalesce(bool_or(${product}), false) as products,
          coalesce(bool_or(${service}), false) as second_service,
          coalesce(bool_or(${diagnostics} or ${product} or ${service}), false) as any_add_on,
          coalesce(bool_or(${own} and ${diagnostics}), false) as own_diagnostics,
          coalesce(bool_or(${own} and ${product}), false) as own_products,
          coalesce(bool_or(${own} and ${service}), false) as own_second_service,
          coalesce(bool_or(${own} and (${diagnostics} or ${product} or ${service})), false) as own_any_add_on
        from consults c
        left join lines x on x.invoice_id = c.invoice_id and ${addOn}
        group by c.staff_id, c.invoice_id
      )
      select
        case when grouping(p.staff_id) = 0 then p.staff_id::text end as staff_id,
        count(*)::int as consults,
        ${counted(sql`p.diagnostics`, "diagnostics")},
        ${counted(sql`p.products`, "products")},
        ${counted(sql`p.second_service`, "second_service")},
        ${counted(sql`p.any_add_on`, "any_add_on")},
        ${counted(sql`p.own_diagnostics`, "own_diagnostics")},
        ${counted(sql`p.own_products`, "own_products")},
        ${counted(sql`p.own_second_service`, "own_second_service")},
        ${counted(sql`p.own_any_add_on`, "own_any_add_on")}
      from per_consult p
      group by grouping sets ((), (p.staff_id))
      having grouping(p.staff_id) = 1 or ${staffCondition(sql, staffScope(filter), sql`p.staff_id`)}
    `,
    getPendingLineItems(sql, filter),
  ]);

  const staff = await staffById(sql, rows.flatMap((row) => (row.staffId ? [row.staffId] : [])));
  const total = rows.find((row) => row.staffId === null)!;
  const doctors = rows
    .filter((row) => row.staffId !== null)
    .map((row): DoctorAttachRates => {
      const member = staff.get(row.staffId!)!;
      return { staffId: member.id, name: member.name, source: member.source, active: member.active, ...rateSet(row) };
    })
    .sort((a, b) => b.consultInvoices - a.consultInvoices || compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.staffId, b.staffId));
  return { period, doctors, allDoctors: rateSet(total), pendingLineItems };
}

/** A result row as an `AttachRateSet` (the `()` grouping set always has a row, even without consults). */
function rateSet(row: AttachRow): AttachRateSet {
  const rate = (invoices: number, percent: string | null): AttachRate => ({ invoices, percent: percent === null ? null : Number(percent) });
  return {
    consultInvoices: row.consults,
    wholeInvoice: {
      diagnostics: rate(row.diagnostics, row.diagnosticsPercent),
      products: rate(row.products, row.productsPercent),
      secondService: rate(row.secondService, row.secondServicePercent),
      anyAddOn: rate(row.anyAddOn, row.anyAddOnPercent),
    },
    ownLines: {
      diagnostics: rate(row.ownDiagnostics, row.ownDiagnosticsPercent),
      products: rate(row.ownProducts, row.ownProductsPercent),
      secondService: rate(row.ownSecondService, row.ownSecondServicePercent),
      anyAddOn: rate(row.ownAnyAddOn, row.ownAnyAddOnPercent),
    },
  };
}

/** A doctor's items per invoice in a month (or over the whole range). */
export interface ItemsPerInvoiceFigures {
  /** Credited item lines of the doctor (the numerator). */
  itemLines: number;
  /** Invoices with at least one line credited to the doctor (the denominator). */
  invoices: number;
  /** itemLines ÷ invoices, 2 decimals; null without invoices (`METRIC_DEFINITIONS.itemsPerInvoice`). */
  itemsPerInvoice: number | null;
}

export interface ItemsPerInvoicePoint extends ItemsPerInvoiceFigures {
  /** `'YYYY-MM'` (clinic calendar month). */
  month: string;
}

export interface DoctorItemsPerInvoiceTrend {
  staffId: string;
  name: string;
  source: "kreloses" | "alias_only";
  active: boolean;
  /** The whole range (the same figure as the Doctors page's items per invoice for these dates). */
  total: ItemsPerInvoiceFigures;
  /** One point per `ItemsPerInvoiceTrend.months`, same order (0 lines / 0 invoices / null where the doctor had none). */
  points: ItemsPerInvoicePoint[];
}

export interface ItemsPerInvoiceTrend {
  period: DateRange;
  /** The clinic months the range overlaps up to the current one (`trendMonths`, #10): partial ones flagged. */
  months: TrendMonth[];
  /** Doctors (kind doctor, within the doctor filter) with at least one credited line in the range, by invoices (most first), then name. */
  doctors: DoctorItemsPerInvoiceTrend[];
}

const NO_ITEMS: ItemsPerInvoiceFigures = { itemLines: 0, invoices: 0, itemsPerInvoice: null };

/**
 * Each doctor's average items per invoice (`METRIC_DEFINITIONS.itemsPerInvoice`, the Doctors page's
 * definition via `itemsPerInvoiceSql`) per clinic month of the global filter's dates, within its
 * branches and doctors (`METRIC_DEFINITIONS.itemsPerInvoiceTrend`). Months come from #10's
 * `trendMonths` (up to the current month; partial ones flagged). `options.now` sets "today".
 */
export async function getItemsPerInvoiceTrend(sql: Sql, filter: GlobalFilter, options: { now?: Date } = {}): Promise<ItemsPerInvoiceTrend> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const months = trendMonths(period, clinicToday(options.now));
  if (months.length === 0) return { period, months, doctors: [] };

  const rows = await sql<{ staffId: string; month: string | null; itemLines: number; invoices: number; itemsPerInvoice: string | null }[]>`
    with facts as (${revenueFacts(sql, factsScope(filter))}),
    f as (
      select facts.*, to_char(facts.sale_date, 'YYYY-MM') as month
      from facts
      where facts.credit_group = 'doctor' and facts.sale_date between ${months[0]!.dateFrom}::date and ${months.at(-1)!.dateTo}::date
    )
    select
      f.staff_id::text as staff_id,
      case when grouping(f.month) = 0 then f.month end as month,
      count(f.invoice_line_id)::int as item_lines,
      count(distinct f.invoice_id)::int as invoices,
      ${itemsPerInvoiceSql(sql)}::text as items_per_invoice
    from f
    group by grouping sets ((f.staff_id), (f.staff_id, f.month))
  `;
  const staff = await staffById(sql, rows.map((row) => row.staffId));
  const figures = (row: (typeof rows)[number]): ItemsPerInvoiceFigures => ({
    itemLines: row.itemLines,
    invoices: row.invoices,
    itemsPerInvoice: row.itemsPerInvoice === null ? null : Number(row.itemsPerInvoice),
  });

  const doctors = [...staff.values()]
    .map((member): DoctorItemsPerInvoiceTrend => {
      const own = rows.filter((row) => row.staffId === member.id);
      const byMonth = new Map(own.filter((row) => row.month !== null).map((row) => [row.month!, figures(row)]));
      return {
        staffId: member.id,
        name: member.name,
        source: member.source,
        active: member.active,
        total: figures(own.find((row) => row.month === null)!),
        points: months.map(({ month }) => ({ month, ...(byMonth.get(month) ?? NO_ITEMS) })),
      };
    })
    .sort((a, b) => b.total.invoices - a.total.invoices || compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.staffId, b.staffId));
  return { period, months, doctors };
}

interface StaffMember {
  id: string;
  name: string;
  source: "kreloses" | "alias_only";
  active: boolean;
}

async function staffById(sql: Sql, ids: string[]): Promise<Map<string, StaffMember>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const members = await sql<StaffMember[]>`
    select id::text as id, full_name as name, source, active from staff where id = any(${unique}::bigint[])
  `;
  return new Map(members.map((member) => [member.id, member]));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
