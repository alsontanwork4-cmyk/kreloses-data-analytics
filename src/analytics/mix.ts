import { MIX_GROUP_LABELS, MIX_GROUPS, type MixGroup } from "@/attribution";
import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";
import { moneyToSen, type Money } from "@/lib/money";

import { branchScope, revenueFacts, staffScope, type StaffScope } from "./facts";
import type { DateRange } from "./periods";

/**
 * Service mix (spec stories 40–42, #9): revenue per service-mix group per doctor, each doctor's mix
 * compared with all doctors together, each doctor's top items, and revenue per item for Settings.
 * Built on `revenueFacts` (its `mix_group` / `item_key` columns: item groups are resolved at query
 * time, so a rule or assignment change shows at once). Definitions in `METRIC_DEFINITIONS`.
 */

/** A doctor's revenue is in one of these: the eight groups, or `unmapped` (no rule knows the item). */
export const MIX_BUCKETS = [...MIX_GROUPS, "unmapped"] as const;
export type MixBucket = MixGroup | "unmapped";

/**
 * The whole clinic's revenue is in one of these: a doctor's buckets, `no_item` (an invoice's
 * unitemised remainder: no sold line to put it on) or `pending` (line items not synced yet). Every
 * credited sen is in exactly one.
 */
export const CLINIC_MIX_BUCKETS = [...MIX_BUCKETS, "no_item", "pending"] as const;
export type ClinicMixBucket = (typeof CLINIC_MIX_BUCKETS)[number];

export const MIX_BUCKET_LABELS: Record<ClinicMixBucket, string> = {
  ...MIX_GROUP_LABELS,
  unmapped: "Unmapped",
  no_item: "No item on invoice",
  pending: "Line items not synced yet",
};

/**
 * A doctor's group share is "above" / "below" the clinic average when it differs by at least this
 * many percentage points (either way); otherwise "in line".
 */
export const MIX_COMPARISON_THRESHOLD_POINTS = 5;

export interface MixShare {
  /** Revenue in the bucket, RM (a return can make it negative). */
  revenue: Money;
  /** Bucket revenue ÷ the row's total revenue × 100, one decimal; null when the total is zero or less. */
  sharePercent: number | null;
}

export type MixComparisonResult = "above" | "below" | "in_line";

export interface MixComparison extends MixShare {
  /** The same bucket's share for all doctors together (the clinic average). */
  averageSharePercent: number | null;
  /** sharePercent − averageSharePercent, percentage points (one decimal); null if either is null. */
  differencePoints: number | null;
  /** above / below when |difference| ≥ MIX_COMPARISON_THRESHOLD_POINTS, else in_line; null without a difference. */
  comparison: MixComparisonResult | null;
}

export interface DoctorMix {
  staffId: string;
  name: string;
  source: "kreloses" | "alias_only";
  /** The doctor's revenue in the filter (= the doctor ranking's revenue). */
  revenue: Money;
  groups: Record<MixBucket, MixComparison>;
}

export interface ServiceMix {
  period: DateRange;
  /** `MIX_COMPARISON_THRESHOLD_POINTS`. */
  thresholdPoints: number;
  /** Doctors (kind doctor) with credited lines in the filter, by revenue (highest first), then name. */
  doctors: DoctorMix[];
  /** The clinic average: every doctor together in the dates and branches (the doctor filter does not apply). */
  allDoctors: { revenue: Money; groups: Record<MixBucket, MixShare> };
  /** All revenue in the dates and branches — every staff group, no staff, not synced yet (the doctor filter does not apply). */
  clinic: { revenue: Money; groups: Record<ClinicMixBucket, MixShare> };
}

interface SumRow {
  level: "clinic" | "all_doctors" | "doctor";
  staffId: string | null;
  mixGroup: ClinicMixBucket;
  revenue: string;
  total: string;
  share: string | null;
}

/**
 * Revenue per service-mix group: per doctor (the filter's doctors), for all doctors together (the
 * comparison baseline) and for the whole clinic, with each doctor's share per group compared with
 * the all-doctors share (percentage points; above / below at ±`MIX_COMPARISON_THRESHOLD_POINTS`).
 */
export async function getServiceMix(sql: Sql, filter: GlobalFilter): Promise<ServiceMix> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const rows = await sql<SumRow[]>`
    with facts as (${revenueFacts(sql, { branches: branchScope(filter), staff: { all: true } })}),
    scoped as (
      select f.staff_id, f.credit_group = 'doctor' as doctor, f.mix_group, f.revenue
      from facts f
      where f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date
    ),
    sums as (
      select 'clinic' as level, null::bigint as staff_id, s.mix_group, sum(s.revenue) as revenue from scoped s group by s.mix_group
      union all
      select 'all_doctors', null, s.mix_group, sum(s.revenue) from scoped s where s.doctor group by s.mix_group
      union all
      select 'doctor', s.staff_id, s.mix_group, sum(s.revenue) from scoped s
      where s.doctor and ${staffIn(sql, staffScope(filter))} group by s.staff_id, s.mix_group
    )
    select level, staff_id::text as staff_id, mix_group, revenue::text as revenue, (sum(revenue) over w)::text as total,
      case when sum(revenue) over w > 0 then round(100 * revenue / sum(revenue) over w, 1)::text end as share
    from sums
    window w as (partition by level, staff_id)
  `;
  const doctorIds = [...new Set(rows.flatMap((row) => (row.level === "doctor" && row.staffId ? [row.staffId] : [])))];
  const names = await staffNames(sql, doctorIds);

  const totalOf = (level: SumRow["level"], staffId: string | null) =>
    rows.find((row) => row.level === level && row.staffId === staffId)?.total ?? "0.00";
  const sharesOf = <Bucket extends ClinicMixBucket>(buckets: readonly Bucket[], level: SumRow["level"], staffId: string | null): Record<Bucket, MixShare> => {
    const total = totalOf(level, staffId);
    const positive = Number(total) > 0;
    return Object.fromEntries(
      buckets.map((bucket) => {
        const row = rows.find((candidate) => candidate.level === level && candidate.staffId === staffId && candidate.mixGroup === bucket);
        return [bucket, row ? { revenue: row.revenue, sharePercent: row.share === null ? null : Number(row.share) } : { revenue: "0.00", sharePercent: positive ? 0 : null }];
      }),
    ) as Record<Bucket, MixShare>;
  };

  const allDoctors = { revenue: totalOf("all_doctors", null), groups: sharesOf(MIX_BUCKETS, "all_doctors", null) };
  const doctors = doctorIds
    .map((staffId): DoctorMix => {
      const shares = sharesOf(MIX_BUCKETS, "doctor", staffId);
      const groups = Object.fromEntries(
        MIX_BUCKETS.map((bucket) => [bucket, compare(shares[bucket], allDoctors.groups[bucket].sharePercent)]),
      ) as Record<MixBucket, MixComparison>;
      const member = names.get(staffId)!;
      return { staffId, name: member.name, source: member.source, revenue: totalOf("doctor", staffId), groups };
    })
    .sort(byRevenueThenName);

  return {
    period,
    thresholdPoints: MIX_COMPARISON_THRESHOLD_POINTS,
    doctors,
    allDoctors,
    clinic: { revenue: totalOf("clinic", null), groups: sharesOf(CLINIC_MIX_BUCKETS, "clinic", null) },
  };
}

/** A doctor's share vs the clinic average; worked out in tenths of a point, so what is shown adds up. */
function compare(share: MixShare, averageSharePercent: number | null): MixComparison {
  if (share.sharePercent === null || averageSharePercent === null) {
    return { ...share, averageSharePercent, differencePoints: null, comparison: null };
  }
  const tenths = Math.round(share.sharePercent * 10) - Math.round(averageSharePercent * 10);
  const threshold = MIX_COMPARISON_THRESHOLD_POINTS * 10;
  return {
    ...share,
    averageSharePercent,
    differencePoints: tenths / 10,
    comparison: tenths >= threshold ? "above" : tenths <= -threshold ? "below" : "in_line",
  };
}

/** One of a doctor's top items. */
export interface TopItem {
  /** The item's identity (`itemKey`). */
  itemKey: string;
  /** Its name as most often written on the doctor's lines. */
  name: string;
  group: MixBucket;
  revenue: Money;
  /** Item revenue ÷ the doctor's revenue × 100, one decimal; null when theirs is zero or less. */
  sharePercent: number | null;
  /** Credited lines with this item. */
  lines: number;
  /** Invoices with those lines. */
  invoices: number;
}

export interface DoctorTopItems {
  staffId: string;
  name: string;
  revenue: Money;
  items: TopItem[];
}

export const DEFAULT_TOP_ITEMS = 5;
export const MAX_TOP_ITEMS = 50;

/**
 * Each doctor's top items by revenue in the filter (items with positive revenue only; ties by
 * name), at most `limit` per doctor (default `DEFAULT_TOP_ITEMS`, capped at `MAX_TOP_ITEMS`).
 * Doctors in the same order as the mix (revenue, then name).
 *
 * `groups` (the MCP `item_mix` tool's group filter): rank only items in these buckets — a doctor's
 * top diagnostics items, say. Each item's share is still of the doctor's WHOLE revenue, and every
 * doctor with revenue is still listed (with no items if they sold nothing in the groups).
 */
export async function getTopItemsByDoctor(
  sql: Sql,
  filter: GlobalFilter,
  options: { limit?: number; groups?: readonly MixBucket[] } = {},
): Promise<{ period: DateRange; limit: number; doctors: DoctorTopItems[] }> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const limit = Math.min(MAX_TOP_ITEMS, Math.max(1, Math.trunc(options.limit ?? DEFAULT_TOP_ITEMS)));
  const inGroups = options.groups ? sql`i.mix_group = any(${[...options.groups]}::text[])` : sql`true`;
  const rows = await sql<
    { staffId: string; itemKey: string; name: string; mixGroup: MixBucket; revenue: string; doctorRevenue: string; share: string | null; lines: number; invoices: number }[]
  >`
    with facts as (${revenueFacts(sql, { branches: branchScope(filter), staff: staffScope(filter) })}),
    items as (
      select f.staff_id, f.item_key, mode() within group (order by f.item_name) as name, min(f.mix_group) as mix_group,
        sum(f.revenue) as revenue, count(*)::int as lines, count(distinct f.invoice_id)::int as invoices
      from facts f
      where f.credit_group = 'doctor' and f.item_key is not null
        and f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date
      group by f.staff_id, f.item_key
    ),
    totals as (
      select i.staff_id, sum(i.revenue) as doctor_revenue from items i group by i.staff_id
    ),
    ranked as (
      select i.*, t.doctor_revenue,
        row_number() over (partition by i.staff_id order by i.revenue desc, lower(i.name), i.item_key) as rank
      from items i
      join totals t on t.staff_id = i.staff_id
      where ${inGroups}
    )
    select staff_id::text as staff_id, item_key, name, mix_group, revenue::text as revenue, doctor_revenue::text as doctor_revenue,
      case when doctor_revenue > 0 then round(100 * revenue / doctor_revenue, 1)::text end as share, lines, invoices
    from ranked
    where rank <= ${limit} and revenue > 0
    order by staff_id, rank
  `;
  const doctorRevenue = await sql<{ staffId: string; revenue: string }[]>`
    with facts as (${revenueFacts(sql, { branches: branchScope(filter), staff: staffScope(filter) })})
    select f.staff_id::text as staff_id, sum(f.revenue)::text as revenue from facts f
    where f.credit_group = 'doctor' and f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date
    group by f.staff_id
  `;
  const names = await staffNames(
    sql,
    doctorRevenue.map((row) => row.staffId),
  );
  const doctors = doctorRevenue
    .map((doctor): DoctorTopItems => ({
      staffId: doctor.staffId,
      name: names.get(doctor.staffId)!.name,
      revenue: doctor.revenue,
      items: rows
        .filter((row) => row.staffId === doctor.staffId)
        .map((row) => ({
          itemKey: row.itemKey,
          name: row.name,
          group: row.mixGroup,
          revenue: row.revenue,
          sharePercent: row.share === null ? null : Number(row.share),
          lines: row.lines,
          invoices: row.invoices,
        })),
    }))
    .sort(byRevenueThenName);
  return { period, limit, doctors };
}

/**
 * Revenue per item (`itemKey` → RM) in the filter's dates and branches — the doctor filter does
 * not apply (unmapped items are often credited to no one) — for Settings → Items. Items with no
 * credited line in the period are absent.
 */
export async function getItemRevenue(sql: Sql, filter: GlobalFilter): Promise<Record<string, Money>> {
  const rows = await sql<{ itemKey: string; revenue: string }[]>`
    with facts as (${revenueFacts(sql, { branches: branchScope(filter), staff: { all: true } })})
    select f.item_key, sum(f.revenue)::text as revenue
    from facts f
    where f.item_key is not null and f.sale_date between ${filter.dateFrom}::date and ${filter.dateTo}::date
    group by f.item_key
  `;
  return Object.fromEntries(rows.map((row) => [row.itemKey, row.revenue]));
}

/** `true`, or the staff id restricted to the scope (for a `staff_id` column named `s.staff_id`). */
function staffIn(sql: Sql, scope: StaffScope) {
  if (scope.all) return sql`true`;
  if (scope.ids.length === 0) return sql`false`;
  return sql`s.staff_id = any(${scope.ids}::bigint[])`;
}

export async function staffNames(sql: Sql, ids: readonly string[]): Promise<Map<string, { name: string; source: "kreloses" | "alias_only" }>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<{ id: string; name: string; source: "kreloses" | "alias_only" }[]>`
    select id::text as id, full_name as name, source from staff where id = any(${[...ids]}::bigint[])
  `;
  return new Map(rows.map((row) => [row.id, { name: row.name, source: row.source }]));
}

/** Highest revenue first (exact, via integer sen), then name, then id. */
export function byRevenueThenName(a: { revenue: Money; name: string; staffId: string }, b: { revenue: Money; name: string; staffId: string }): number {
  const difference = moneyToSen(b.revenue) - moneyToSen(a.revenue);
  if (difference !== 0) return difference;
  const nameA = a.name.toLowerCase();
  const nameB = b.name.toLowerCase();
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  return a.staffId < b.staffId ? -1 : a.staffId > b.staffId ? 1 : 0;
}
