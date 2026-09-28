import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";
import { moneyToSen, type Money } from "@/lib/money";

import { branchScope, factsScope, revenueFacts } from "./facts";
import { getPendingLineItems, type PendingLineItems } from "./pending";
import type { DateRange } from "./periods";

/**
 * Discounts (spec stories 51–52; "Metric definitions → Discount"). Built on the credited lines of
 * `revenueFacts` (#5): what a line was charged is its CREDITED amount — its own amount after any
 * item-level discount plus its share of the invoice's discount lines and of any gap to the invoice
 * net, shared in proportion to what each line charged (ADR 0006). So the discount on an invoice with
 * several doctors is already shared between them by that one spread rule; nothing here re-spreads it.
 *
 * Definitions (wording in `METRIC_DEFINITIONS`: `discount`, `discountRate`, `discountedInvoices`,
 * `discountTypes`):
 *
 * - Per credited line: discount = gross (quantity × unit price, rounded to the sen) − charged.
 * - Per doctor (staff member, group): discount = Σ gross − Σ charged over their credited lines;
 *   discount rate = discount ÷ gross; share of invoices discounted = their invoices on which THEIR
 *   share of the discount is over RM 0.05 ÷ their invoices.
 * - Refunds are NOT discounts: the charged amount is before any refund (today the revenue base
 *   does not deduct refunds at all; if it ever does, discounts must keep using the pre-refund
 *   charged amount — the refund test in discounts.test.ts guards this).
 * - Only credited ITEM lines count: sales whose line items are not synced yet (no gross is known —
 *   reported as `pendingLineItems` instead) and an invoice's "unitemised remainder" (no item, so no
 *   gross) are left out. Cancelled sales never count.
 *
 * Everything is summed in SQL on exact `numeric`; money comes back as `"1234.50"` strings.
 */

/** Discount figures for a doctor, another staff member, a group or everyone, in the filter's period. */
export interface DiscountFigures {
  /** Σ quantity × unit price of the credited lines, before any discount, RM. */
  gross: Money;
  /** Σ what those lines were charged after every discount (their credited amount = their revenue), RM. */
  charged: Money;
  /** gross − charged, RM (`METRIC_DEFINITIONS.discount`). Negative if lines were charged above their price. */
  discount: Money;
  /** discount ÷ gross × 100, one decimal; null when gross is zero (`discountRate`). */
  discountRatePercent: number | null;
  /** Invoices with at least one credited line here. */
  invoices: number;
  /** Of those, the invoices on which this row's share of the discount is over RM 0.05 (`discountedInvoices`). */
  discountedInvoices: number;
  /** discountedInvoices ÷ invoices × 100, one decimal; null without invoices. */
  discountedInvoicesPercent: number | null;
}

/** A staff member's discount figures (a doctor, or a member of the other / generic groups). */
export interface StaffDiscountRow extends DiscountFigures {
  staffId: string;
  /** Full Kreloses name, or the line name for alias-only staff. */
  name: string;
  /** `alias_only`: known only from invoice lines (e.g. a deleted doctor). */
  source: "kreloses" | "alias_only";
  /** False once Kreloses no longer lists them. */
  active: boolean;
}

/** A group of staff (never mixed with doctors) with its members. */
export interface StaffDiscountGroup extends DiscountFigures {
  /** The group's staff, by discount (highest first). */
  members: StaffDiscountRow[];
}

/** Per-doctor discounts for the global filter (`getDoctorDiscounts`). */
export interface DoctorDiscounts {
  period: DateRange;
  /** Every credited line in the filter (with a doctor filter: the selected doctors'). */
  total: DiscountFigures;
  /** Staff of kind doctor with credited lines in the filter, by discount (highest first), then name. */
  doctors: StaffDiscountRow[];
  /** Kept apart from doctors, as on the Doctors page. */
  groups: {
    /** Non-doctor staff (kind `other`). */
    other: StaffDiscountGroup;
    /** Shared accounts (kind `generic`). */
    generic: StaffDiscountGroup;
    /** Lines with no staff name ("No staff on line"). */
    noStaff: DiscountFigures;
  };
  /**
   * Sales in the period and branches whose line items are not synced yet: NOT in any figure above
   * (their lines — so their gross and who gave the discount — are unknown). The doctor filter does
   * not apply (they are credited to nobody yet).
   */
  pendingLineItems: PendingLineItems;
}

/** Where a discount type was applied. */
export type DiscountAppliedTo =
  /** A line's own discount (`DiscountName` / `DiscountAmount` on an item line). */
  | "item"
  /** A discount line (Kreloses ItemType 55) taking money off the whole invoice. */
  | "invoice"
  /** The same name used both ways. */
  | "both"
  /** Lines adding up to more (or less) than the invoice net with no discount line saying why. */
  | "difference";

/** One discount type (`METRIC_DEFINITIONS.discountTypes`). */
export interface DiscountTypeRow {
  /**
   * Stable grouping key: `name:<name trimmed, inner spaces collapsed, lower case>`, or
   * `unnamed-item` / `unnamed-line` for discounts without a name, or `difference`.
   */
  key: string;
  /** The name as written most often (trimmed); a description for unnamed discounts and the difference. */
  label: string;
  appliedTo: DiscountAppliedTo;
  /** Item lines discounted with it plus discount lines of it; null for the difference (not a line). */
  lines: number | null;
  /** Invoices it was used on. */
  invoices: number;
  /**
   * RM taken off: an item discount's gross − the line's charged amount; a discount line's amount
   * (sign flipped: a (50.00) line is 50.00); the difference = the invoice's lines − its net. With a
   * doctor filter: the share that fell on the selected doctors' lines (see `getDiscountTypes`).
   */
  amount: Money;
  /** amount ÷ total × 100, one decimal; null when the total is zero. */
  sharePercent: number | null;
}

/** The discount types used in the global filter (`getDiscountTypes`). */
export interface DiscountTypes {
  period: DateRange;
  /** Σ amount of the rows — without a doctor filter exactly the total discount of `getDoctorDiscounts`. */
  total: Money;
  /** By amount (highest first), the difference last. */
  types: DiscountTypeRow[];
}

/** An invoice counts as discounted for someone when their share of its discount is over this (RM 0.05). */
export const DISCOUNTED_INVOICE_THRESHOLD: Money = "0.05";

const NO_FIGURES: DiscountFigures = {
  gross: "0.00",
  charged: "0.00",
  discount: "0.00",
  discountRatePercent: null,
  invoices: 0,
  discountedInvoices: 0,
  discountedInvoicesPercent: null,
};

interface FigureRow {
  level: "total" | "group" | "staff";
  creditGroup: "doctor" | "other" | "generic" | "no_staff" | null;
  staffId: string | null;
  gross: string;
  charged: string;
  discount: string;
  discountRate: string | null;
  invoices: number;
  discountedInvoices: number;
  discountedShare: string | null;
}

/**
 * Per doctor: discount total, discount rate and share of invoices discounted for the global filter
 * (dates, branches, doctors), from credited lines. Non-doctor staff, generic accounts and "No staff
 * on line" come back as separate groups (as on the Doctors page); `total` covers every credited line
 * in the filter. Sales whose line items are not synced yet are left out and counted in
 * `pendingLineItems`. Kinds and names are resolved now, so a remap shows at once.
 */
export async function getDoctorDiscounts(sql: Sql, filter: GlobalFilter): Promise<DoctorDiscounts> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const [rows, pendingLineItems] = await Promise.all([
    sql<FigureRow[]>`
      with facts as (${revenueFacts(sql, factsScope(filter))}),
      lines as (
        -- Credited ITEM lines only: pending rows and unitemised remainders have no gross.
        select f.credit_group, f.staff_id, f.invoice_id, f.gross_amount as gross, f.revenue as charged
        from facts f
        where f.invoice_line_id is not null and f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date
      ),
      -- Per invoice, at each level, so "discounted" means THIS row's share of that invoice's discount.
      per_invoice as (
        select 'staff' as level, credit_group, staff_id, invoice_id, sum(gross) as gross, sum(charged) as charged
        from lines group by credit_group, staff_id, invoice_id
        union all
        select 'group', credit_group, null, invoice_id, sum(gross), sum(charged)
        from lines group by credit_group, invoice_id
        union all
        select 'total', null, null, invoice_id, sum(gross), sum(charged)
        from lines group by invoice_id
      )
      select
        level, credit_group, staff_id::text as staff_id,
        sum(gross)::text as gross,
        sum(charged)::text as charged,
        (sum(gross) - sum(charged))::text as discount,
        round(100 * (sum(gross) - sum(charged)) / nullif(sum(gross), 0), 1)::text as discount_rate,
        count(*)::int as invoices,
        count(*) filter (where gross - charged > ${DISCOUNTED_INVOICE_THRESHOLD}::numeric)::int as discounted_invoices,
        round(100.0 * count(*) filter (where gross - charged > ${DISCOUNTED_INVOICE_THRESHOLD}::numeric) / nullif(count(*), 0), 1)::text as discounted_share
      from per_invoice
      group by level, credit_group, staff_id
    `,
    getPendingLineItems(sql, filter),
  ]);

  const staff = await sql<{ id: string; name: string; source: StaffDiscountRow["source"]; active: boolean }[]>`
    select id::text as id, full_name as name, source, active from staff
    where id = any(${[...new Set(rows.flatMap((row) => (row.level === "staff" && row.staffId ? [row.staffId] : [])))]}::bigint[])
  `;
  const staffById = new Map(staff.map((member) => [member.id, member]));

  const figures = (row: FigureRow | undefined): DiscountFigures =>
    row
      ? {
          gross: row.gross,
          charged: row.charged,
          discount: row.discount,
          discountRatePercent: row.discountRate === null ? null : Number(row.discountRate),
          invoices: row.invoices,
          discountedInvoices: row.discountedInvoices,
          discountedInvoicesPercent: row.discountedShare === null ? null : Number(row.discountedShare),
        }
      : { ...NO_FIGURES };
  const staffRows = (group: "doctor" | "other" | "generic"): StaffDiscountRow[] =>
    rows
      .filter((row) => row.level === "staff" && row.creditGroup === group)
      .map((row) => {
        const member = staffById.get(row.staffId!)!;
        return { staffId: row.staffId!, name: member.name, source: member.source, active: member.active, ...figures(row) };
      })
      .sort(
        (a, b) =>
          moneyToSen(b.discount) - moneyToSen(a.discount) || compareText(a.name.toLowerCase(), b.name.toLowerCase()) || compareText(a.staffId, b.staffId),
      );
  const group = (creditGroup: FigureRow["creditGroup"]) => figures(rows.find((row) => row.level === "group" && row.creditGroup === creditGroup));

  return {
    period,
    total: figures(rows.find((row) => row.level === "total")),
    doctors: staffRows("doctor"),
    groups: {
      other: { ...group("other"), members: staffRows("other") },
      generic: { ...group("generic"), members: staffRows("generic") },
      noStaff: group("no_staff"),
    },
    pendingLineItems,
  };
}

/** Labels of the rows that have no discount name of their own. */
export const DISCOUNT_TYPE_LABELS = {
  unnamedItem: "Item discount (no name)",
  unnamedLine: "Discount line (no name)",
  difference: "Difference to the invoice net (no discount line)",
} as const;

interface TypeRow {
  key: string;
  label: string;
  appliedTo: DiscountAppliedTo;
  lines: number | null;
  invoices: number;
  amount: string;
  sharePercent: string | null;
  total: string;
}

/**
 * The discount types used in the global filter, with how many lines and invoices used each and the
 * RM they took off (`METRIC_DEFINITIONS.discountTypes`):
 *
 * - an **item discount** (a `DiscountName` / `DiscountAmount` on an item line, or any line charged
 *   other than quantity × unit price): gross − the line's charged amount;
 * - a **discount line** (ItemType 55, named by its `DiscountName`, else its item name): its amount;
 * - the **difference** between an invoice's lines and its net amount that no discount line
 *   explains (one row for all invoices).
 *
 * Names are grouped ignoring case and spaces and shown as written most often (ties: the first in
 * byte order). Without a doctor filter the amounts add up exactly to the total discount of
 * `getDoctorDiscounts`. With one, each type shows the part that fell on the selected doctors' lines:
 * an item discount counts for the doctor on its line; a discount line or difference counts in the
 * proportion #5's spread gave the doctors of that invoice's discount lines and difference together
 * (the invoice's discount is shared by what each line charged), rounded to the sen per type — so
 * the rows can differ from the doctors' discount total by a few sen when one invoice had several
 * discount lines shared between doctors.
 */
export async function getDiscountTypes(sql: Sql, filter: GlobalFilter): Promise<DiscountTypes> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const rows = await sql<TypeRow[]>`
    with scoped as (${revenueFacts(sql, factsScope(filter))}),
    everyone as (${revenueFacts(sql, { branches: branchScope(filter), staff: { all: true } })}),
    -- The credited item lines in the filter (with a doctor filter: the selected doctors' lines).
    scoped_lines as (
      select f.invoice_id, f.invoice_line_id, f.gross_amount, f.revenue
      from scoped f
      where f.invoice_line_id is not null and f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date
    ),
    -- Per invoice: the invoice-level discount (discount lines + difference) that #5's spread put on
    -- ALL its item lines (whole) and on the lines in the filter (scoped): line amount − credited.
    scoped_share as (
      select s.invoice_id, sum(l.amount - s.revenue) as scoped, count(*) as scoped_lines
      from scoped_lines s join invoice_lines l on l.id = s.invoice_line_id
      group by s.invoice_id
    ),
    shares as (
      select e.invoice_id, sum(l.amount - e.revenue) as whole, count(*) as whole_lines, min(sc.scoped) as scoped, min(sc.scoped_lines) as scoped_lines
      from everyone e
      join invoice_lines l on l.id = e.invoice_line_id
      join scoped_share sc on sc.invoice_id = e.invoice_id
      group by e.invoice_id
    ),
    discount_lines as (
      select l.invoice_id, l.id as line_id, ${cleanName(sql, sql`coalesce(nullif(btrim(l.discount_name), ''), l.item_name)`)} as name,
        case when l.amount is not null then -l.amount else l.discount_amount end as amount
      from invoice_lines l join shares sh on sh.invoice_id = l.invoice_id
      where l.item_type = 55
    ),
    -- What the discount lines do not explain of the invoice-level discount (lines ≠ invoice net).
    differences as (
      select sh.invoice_id, sh.whole - coalesce(d.amount, 0) as amount
      from shares sh
      left join (select invoice_id, sum(amount) as amount from discount_lines group by invoice_id) d on d.invoice_id = sh.invoice_id
    ),
    -- Every use of a discount, with the part of its amount that falls in the filter.
    uses as (
      select s.invoice_id, s.invoice_line_id as line_id, ${cleanName(sql, sql`l.discount_name`)} as name, 'item' as applied_to,
        s.gross_amount - l.amount as amount, true as counted
      from scoped_lines s join invoice_lines l on l.id = s.invoice_line_id
      where s.gross_amount <> l.amount or nullif(btrim(l.discount_name), '') is not null or l.discount_amount <> 0
      union all
      select d.invoice_id, d.line_id, d.name, 'invoice', ${shareOf(sql, sql`d.amount`)}, ${hasShare(sql)}
      from discount_lines d join shares sh on sh.invoice_id = d.invoice_id
      union all
      select x.invoice_id, null, null, 'difference', ${shareOf(sql, sql`x.amount`)}, ${hasShare(sql)}
      from differences x join shares sh on sh.invoice_id = x.invoice_id
      where x.amount <> 0
    ),
    keyed as (
      select u.*,
        case
          when u.applied_to = 'difference' then 'difference'
          when u.name is null then case u.applied_to when 'item' then 'unnamed-item' else 'unnamed-line' end
          else 'name:' || lower(u.name)
        end as key
      from uses u
      where u.counted
    ),
    types as (
      select
        key,
        coalesce(mode() within group (order by name collate "C"), case key
          when 'unnamed-item' then ${DISCOUNT_TYPE_LABELS.unnamedItem}
          when 'unnamed-line' then ${DISCOUNT_TYPE_LABELS.unnamedLine}
          else ${DISCOUNT_TYPE_LABELS.difference} end) as label,
        case
          when key = 'difference' then 'difference'
          when bool_and(applied_to = 'item') then 'item'
          when bool_and(applied_to = 'invoice') then 'invoice'
          else 'both'
        end as applied_to,
        case when key = 'difference' then null else count(line_id)::int end as lines,
        count(distinct invoice_id)::int as invoices,
        round(sum(amount), 2) as amount
      from keyed
      group by key
    )
    select key, label, applied_to, lines, invoices, amount::text as amount,
      round(100 * amount / nullif(sum(amount) over (), 0), 1)::text as share_percent,
      coalesce(sum(amount) over (), 0)::numeric(14, 2)::text as total
    from types
    order by types.key = 'difference', types.amount desc, lower(types.label), types.key
  `;
  return {
    period,
    total: rows[0]?.total ?? "0.00",
    types: rows.map((row) => ({
      key: row.key,
      label: row.label,
      appliedTo: row.appliedTo,
      lines: row.lines,
      invoices: row.invoices,
      amount: row.amount,
      sharePercent: row.sharePercent === null ? null : Number(row.sharePercent),
    })),
  };
}

/** A discount name trimmed with inner whitespace collapsed; null when empty. */
function cleanName(sql: Sql, name: ReturnType<Sql>) {
  return sql`nullif(regexp_replace(btrim(${name}), '[[:space:]]+', ' ', 'g'), '')`;
}

/**
 * The part of an invoice-level `amount` that falls on the lines in the filter (`sh` = the invoice's
 * row of `shares`): all of it when the filter covers every item line of the invoice; otherwise in
 * the proportion #5's spread gave those lines of the invoice's whole invoice-level discount
 * (none when that is zero). Exact `numeric`; rounded once per type.
 */
function shareOf(sql: Sql, amount: ReturnType<Sql>) {
  return sql`case when sh.scoped_lines = sh.whole_lines then ${amount} when sh.whole = 0 then 0 else ${amount} * sh.scoped / sh.whole end`;
}

/** Whether any of an invoice-level discount falls on the lines in the filter (a use to count). */
function hasShare(sql: Sql) {
  return sql`(sh.scoped_lines = sh.whole_lines or (sh.whole <> 0 and sh.scoped <> 0))`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
