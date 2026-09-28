import { z } from "zod";

import { getDataFreshness } from "@/analytics";
import type { Sql } from "@/db/sql";
import { formatClinicDateTime, formatDateRange, type IsoDate } from "@/filters";

import { clinicTimestamp } from "./clinic-time";

/**
 * "Data as of" in EVERY tool result (spec story 65: Claude must never present stale numbers as
 * current). The registry adds it; tools only say which period and branches they answered for.
 */
export interface FreshnessScope {
  dateFrom?: IsoDate;
  /** The period's last day; absent = "now". */
  dateTo?: IsoDate;
  /** Absent = every branch. */
  branchIds?: string[];
}

export const dataFreshnessOutput = z.object({
  summary: z.string().describe("The same in one sentence, for people."),
  checkedAt: z.string().describe("When this answer was worked out: ISO 8601 in clinic time (+08:00)."),
  branches: z
    .array(
      z.object({
        branchId: z.string(),
        branchName: z.string(),
        dataAsOf: z
          .string()
          .nullable()
          .describe(
            "When the latest sync that read this branch's whole sale list up to the period's last day finished (ISO 8601, clinic time); null = no such sync yet, so the figures may be incomplete.",
          ),
      }),
    )
    .describe("Per branch in the answer's scope, by name."),
});

export type DataFreshness = z.output<typeof dataFreshnessOutput>;

export async function describeFreshness(sql: Sql, scope: FreshnessScope, now: Date): Promise<DataFreshness> {
  const branches = await getDataFreshness(sql, scope);
  const period = scope.dateFrom && scope.dateTo ? ` for ${formatDateRange(scope.dateFrom, scope.dateTo)}` : "";
  const parts = branches.map((branch) =>
    branch.dataAsOf
      ? `${branch.branchName} ${formatClinicDateTime(branch.dataAsOf)}`
      : `${branch.branchName} — no complete sync${period} yet, so its figures may be incomplete`,
  );
  const summary =
    branches.length === 0
      ? "No sales have been synced from Kreloses yet, so there is no data."
      : `Data as of (clinic time, Asia/Kuala_Lumpur): ${parts.join("; ")}.` +
        (branches.some((branch) => branch.dataAsOf) ? " Sales changed in Kreloses after that are not included." : "");
  return {
    summary,
    checkedAt: clinicTimestamp(now),
    branches: branches.map((branch) => ({
      branchId: branch.branchId,
      branchName: branch.branchName,
      dataAsOf: branch.dataAsOf ? clinicTimestamp(branch.dataAsOf) : null,
    })),
  };
}
