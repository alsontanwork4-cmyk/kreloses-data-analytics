import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";
import { moneyToSen, type Money } from "@/lib/money";
import { getStaffMember } from "@/staff/store";

import { getDoctorRanking, type BranchFigures, type StaffFigures } from "./doctors";
import { getPendingLineItems, type PendingLineItems } from "./pending";
import type { DateRange } from "./periods";
import { emptyTrendFigures, getMonthlyTrends, type TrendMonth, type TrendPoint } from "./trends";

/** One doctor's detail view (spec story 36), or why there is none. */
export type DoctorDetail =
  /** No staff member has this id. */
  | { status: "not_found" }
  /** A staff member of another kind (other staff or a generic account): they have no doctor figures. */
  | { status: "not_a_doctor"; staff: { staffId: string; name: string; kind: "other" | "generic" } }
  | {
      status: "ok";
      doctor: { staffId: string; name: string; source: "kreloses" | "alias_only"; active: boolean };
      period: DateRange;
      /** All revenue in the period and branches (the share denominator, as in the doctor ranking). */
      totalRevenue: Money;
      /** The doctor's figures in the filter: exactly their doctor-ranking row (zeros without credited lines). */
      figures: StaffFigures;
      /** Per branch they have credited lines at, by branch name (AOV per customer counted per branch). */
      branches: BranchFigures[];
      /** The months of the period (`trendMonths`) and the doctor's figures in each (same order). */
      months: TrendMonth[];
      monthly: TrendPoint[];
      /** Sales in the period and branches whose line items are not synced yet: credited to nobody, so not in these figures. */
      pendingLineItems: PendingLineItems;
    };

/**
 * Everything the doctor detail page shows for one staff member, for the global filter's dates and
 * branches. The filter's own doctor selection is ignored: the view is for `staffId`. Composes the
 * doctor ranking (`getDoctorRanking`, split by branch) and the monthly trend (`getMonthlyTrends`),
 * so the numbers are the ranking's and the Trends page's to the sen. `options.now` sets "today".
 */
export async function getDoctorDetail(sql: Sql, staffId: string, filter: GlobalFilter, options: { now?: Date } = {}): Promise<DoctorDetail> {
  const member = await getStaffMember(sql, staffId);
  if (!member) return { status: "not_found" };
  if (member.kind !== "doctor") return { status: "not_a_doctor", staff: { staffId: member.id, name: member.name, kind: member.kind } };

  const rest: GlobalFilter = { dateFrom: filter.dateFrom, dateTo: filter.dateTo, ...(filter.branchIds ? { branchIds: filter.branchIds } : {}) };
  const forDoctor: GlobalFilter = { ...rest, doctorIds: [member.id] };
  const [ranking, trends, pendingLineItems] = await Promise.all([
    getDoctorRanking(sql, forDoctor, { splitByBranch: true }),
    getMonthlyTrends(sql, forDoctor, options),
    getPendingLineItems(sql, rest),
  ]);
  const row = ranking.doctors.find((doctor) => doctor.staffId === member.id);
  const trend = trends.doctors.find((doctor) => doctor.staffId === member.id);
  const figures: StaffFigures = row
    ? {
        revenue: row.revenue,
        invoices: row.invoices,
        customers: row.customers,
        aovPerCustomer: row.aovPerCustomer,
        itemsPerInvoice: row.itemsPerInvoice,
        sharePercent: row.sharePercent,
      }
    : { revenue: "0.00", invoices: 0, customers: 0, aovPerCustomer: null, itemsPerInvoice: null, sharePercent: moneyToSen(ranking.totalRevenue) === 0 ? null : 0 };

  return {
    status: "ok",
    doctor: { staffId: member.id, name: member.name, source: member.source, active: member.active },
    period: ranking.period,
    totalRevenue: ranking.totalRevenue,
    figures,
    branches: row?.branches ?? [],
    months: trends.months,
    monthly: trend?.points ?? trends.months.map(({ month }) => ({ month, ...emptyTrendFigures() })),
    pendingLineItems,
  };
}
