import type { Sql } from "@/db/sql";
import type { GlobalFilter } from "@/filters";

import { branchCondition, branchScope } from "./facts";

export interface BranchFreshness {
  branchId: string;
  branchName: string;
  /**
   * When the latest successful sync that read this branch finished; null if none has yet.
   * See `METRIC_DEFINITIONS.dataAsOf`.
   */
  dataAsOf: Date | null;
}

/**
 * "Data as of <time>" per branch (spec story 15): the finish time of the latest SUCCEEDED sync run
 * that covered the branch's Kreloses location (`sync_runs.covered_location_ids`), whichever
 * connection ran it. Partial and failed runs never make data look fresher. Branches in the filter
 * (all when none is selected), by name.
 */
export async function getDataFreshness(sql: Sql, filter: Pick<GlobalFilter, "branchIds"> = {}): Promise<BranchFreshness[]> {
  return sql<BranchFreshness[]>`
    select
      b.id::text as branch_id,
      b.name as branch_name,
      (
        select max(r.finished_at) from sync_runs r
        where r.status = 'succeeded' and b.kreloses_location_id = any(r.covered_location_ids)
      ) as data_as_of
    from branches b
    where ${branchCondition(sql, branchScope(filter), sql`b.id`)}
    order by lower(b.name), b.id
  `;
}
