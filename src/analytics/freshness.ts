import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";

import { branchCondition, branchScope } from "./facts";

export interface BranchFreshness {
  branchId: string;
  branchName: string;
  /**
   * When the latest successful sync that read this branch up to the period's last day finished;
   * null if none has. See `METRIC_DEFINITIONS.dataAsOf`.
   */
  dataAsOf: Date | null;
}

/**
 * "Data as of <time>" per branch (spec story 15), for the period being looked at: the finish time
 * of the latest SUCCEEDED sync run that
 *
 * - covered the branch's Kreloses location (`sync_runs.covered_location_ids`), whichever connection
 *   ran it, and
 * - read the period's last day, as far as it could: its date range includes
 *   least(`filter.dateTo`, the clinic day the run started). A run cannot have seen sales after it
 *   started, and a run of an old month says nothing about the current one.
 *
 * Without `dateTo` the period is "now": runs that read the day they ran. Partial and failed runs
 * never make data look fresher. Branches in the filter (all when none is selected), by name.
 */
export async function getDataFreshness(
  sql: Sql,
  filter: Partial<Pick<GlobalFilter, "dateFrom" | "dateTo" | "branchIds">> = {},
): Promise<BranchFreshness[]> {
  const periodEnd = filter.dateTo ?? null;
  return sql<BranchFreshness[]>`
    select
      b.id::text as branch_id,
      b.name as branch_name,
      (
        select max(r.finished_at) from sync_runs r
        where r.status = 'succeeded'
          and b.kreloses_location_id = any(r.covered_location_ids)
          and least(
            coalesce(${periodEnd}::date, (r.started_at at time zone 'Asia/Kuala_Lumpur')::date),
            (r.started_at at time zone 'Asia/Kuala_Lumpur')::date
          ) between r.date_from and r.date_to
      ) as data_as_of
    from branches b
    where ${branchCondition(sql, branchScope(filter), sql`b.id`)}
    order by lower(b.name), b.id
  `;
}
