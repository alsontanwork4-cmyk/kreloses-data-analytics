import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";
import type { Money } from "@/lib/money";

import { factsScope, revenueFacts } from "./facts";
import { byRevenueThenName, staffNames } from "./mix";
import type { DateRange } from "./periods";

/**
 * Vaccine and dental-scaling revenue per doctor (spec story 45, #15): revenue of credited lines
 * whose item has the vaccine / dental-scaling flag (`revenueFacts.is_vaccine` /
 * `is_dental_scaling`, from the item rules and the owner's assignments, resolved at query time).
 * Definitions: `METRIC_DEFINITIONS.vaccineRevenue`, `dentalScalingRevenue`.
 */

export interface VaccineDentalFigures {
  /** All revenue in the row's scope, RM (the share denominator). */
  revenue: Money;
  vaccineRevenue: Money;
  /** vaccineRevenue ÷ revenue × 100, one decimal; null when revenue is zero or less. */
  vaccineSharePercent: number | null;
  dentalScalingRevenue: Money;
  /** dentalScalingRevenue ÷ revenue × 100, one decimal; null when revenue is zero or less. */
  dentalScalingSharePercent: number | null;
}

export interface DoctorVaccineDental extends VaccineDentalFigures {
  staffId: string;
  name: string;
  source: "kreloses" | "alias_only";
}

export interface VaccineDentalRevenue {
  period: DateRange;
  /** Every credited line in the filter (with a doctor filter, theirs); sales not synced yet are in `revenue` only. */
  total: VaccineDentalFigures;
  /** Doctors (kind doctor now) with credited lines in the filter, by revenue (highest first), then name. */
  doctors: DoctorVaccineDental[];
}

/** Vaccine and dental-scaling revenue per doctor and in total for the global filter (dates, branches, doctors). */
export async function getVaccineDentalRevenue(sql: Sql, filter: GlobalFilter): Promise<VaccineDentalRevenue> {
  const period: DateRange = { dateFrom: filter.dateFrom, dateTo: filter.dateTo };
  const rows = await sql<{ staffId: string | null; revenue: string; vaccine: string; vaccineShare: string | null; dental: string; dentalShare: string | null }[]>`
    with facts as (${revenueFacts(sql, factsScope(filter))}),
    sums as (
      select case when grouping(f.staff_id) = 0 then f.staff_id end as staff_id,
        coalesce(sum(f.revenue), 0) as revenue,
        coalesce(sum(f.revenue) filter (where f.is_vaccine), 0) as vaccine,
        coalesce(sum(f.revenue) filter (where f.is_dental_scaling), 0) as dental
      from facts f
      where f.sale_date between ${period.dateFrom}::date and ${period.dateTo}::date
      group by grouping sets ((), (f.credit_group, f.staff_id))
      having grouping(f.staff_id) = 1 or f.credit_group = 'doctor'
    )
    select staff_id::text as staff_id, revenue::numeric(14, 2)::text as revenue,
      vaccine::numeric(14, 2)::text as vaccine, dental::numeric(14, 2)::text as dental,
      case when revenue > 0 then round(100 * vaccine / revenue, 1)::text end as vaccine_share,
      case when revenue > 0 then round(100 * dental / revenue, 1)::text end as dental_share
    from sums
  `;
  const figures = (row: (typeof rows)[number] | undefined): VaccineDentalFigures =>
    row
      ? {
          revenue: row.revenue,
          vaccineRevenue: row.vaccine,
          vaccineSharePercent: row.vaccineShare === null ? null : Number(row.vaccineShare),
          dentalScalingRevenue: row.dental,
          dentalScalingSharePercent: row.dentalShare === null ? null : Number(row.dentalShare),
        }
      : { revenue: "0.00", vaccineRevenue: "0.00", vaccineSharePercent: null, dentalScalingRevenue: "0.00", dentalScalingSharePercent: null };
  const doctorRows = rows.filter((row) => row.staffId !== null);
  const names = await staffNames(
    sql,
    doctorRows.map((row) => row.staffId!),
  );
  return {
    period,
    total: figures(rows.find((row) => row.staffId === null)),
    doctors: doctorRows
      .map((row): DoctorVaccineDental => {
        const member = names.get(row.staffId!)!;
        return { staffId: row.staffId!, name: member.name, source: member.source, ...figures(row) };
      })
      .sort(byRevenueThenName),
  };
}
