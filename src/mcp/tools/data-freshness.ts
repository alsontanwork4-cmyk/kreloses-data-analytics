import { z } from "zod";

import { getConnectionSyncStatus, METRIC_DEFINITIONS, type LastSyncRun } from "@/analytics";
import { formatClinicDateTime, formatDateRange } from "@/filters";

import { clinicTimestamp } from "./clinic-time";
import { defineTool } from "./define";
import { branchesInput, filterOutput, periodInput, resolveFilter } from "./filter";

const OUTCOMES = ["running", "succeeded", "stopped_at_time_limit", "invoice_pages_missing", "failed"] as const satisfies readonly LastSyncRun["outcome"][];

const timestamp = z.string().describe("ISO 8601, clinic time (+08:00)");

/**
 * `data_freshness`: data as of per branch (added to every result by the registry, for the period
 * asked about) and, per Kreloses connection, its login status and latest sync run
 * (`getConnectionSyncStatus`) — why a branch may be stale.
 */
export const dataFreshnessTool = defineTool({
  name: "data_freshness",
  title: "Data freshness",
  description: [
    "How current the data is. Per branch: when its sales were last synced completely from Kreloses (data as of) for a period (clinic days, Asia/Kuala_Lumpur; default month to date, i.e. up to today). Per Kreloses connection: whether its login works and what happened to its latest sync (succeeded, stopped at its time limit, some invoice pages missing, failed with the reason, or still running). Use it when the user asks how up to date the numbers are or when a branch has no data-as-of time. Read-only; Kreloses itself is never contacted.",
    "Definitions (the dashboard's own):",
    `- ${METRIC_DEFINITIONS.dataAsOf}`,
    `- ${METRIC_DEFINITIONS.lastSyncRun}`,
  ].join("\n"),
  input: { ...periodInput, ...branchesInput },
  output: {
    covers: filterOutput,
    connections: z
      .array(
        z.object({
          connectionId: z.string(),
          label: z.string().describe("What the owner calls this Kreloses login"),
          loginStatus: z.enum(["untested", "ok", "failed"]),
          loginError: z.string().nullable(),
          lastTestedAt: timestamp.nullable(),
          lastRun: z
            .object({
              mode: z.enum(["nightly", "backfill", "manual"]).describe("manual = the owner's Sync now"),
              outcome: z.enum(OUTCOMES),
              dateFrom: z.string().describe("First clinic day the run read"),
              dateTo: z.string().describe("Last clinic day the run read"),
              startedAt: timestamp,
              finishedAt: timestamp.nullable(),
              error: z.string().nullable(),
              warnings: z.array(z.string()),
            })
            .nullable()
            .describe("The connection's latest sync run; null = never synced"),
        }),
      )
      .describe("Every Kreloses connection, by name"),
  },
  definitions: ["lastSyncRun"],
  async run(context, input) {
    const { filter, covers } = await resolveFilter(context, input);
    const statuses = await getConnectionSyncStatus(context.sql);
    const connections = statuses.map((connection) => ({
      ...connection,
      lastTestedAt: connection.lastTestedAt ? clinicTimestamp(connection.lastTestedAt) : null,
      lastRun: connection.lastRun
        ? {
            ...connection.lastRun,
            startedAt: clinicTimestamp(connection.lastRun.startedAt),
            finishedAt: connection.lastRun.finishedAt ? clinicTimestamp(connection.lastRun.finishedAt) : null,
          }
        : null,
    }));
    const summary =
      statuses.length === 0
        ? "No Kreloses connections have been added yet, so nothing is synced."
        : `Kreloses connections: ${statuses.map((status) => `${status.label} — ${describeRun(status.lastRun)}${status.loginStatus === "failed" ? `; login failing: ${status.loginError}` : ""}`).join("; ")}.`;
    return {
      data: { covers, connections },
      summary,
      freshness: { dateFrom: filter.dateFrom, dateTo: filter.dateTo, branchIds: filter.branchIds },
    };
  },
});

function describeRun(run: LastSyncRun | null): string {
  if (!run) return "never synced";
  const dates = formatDateRange(run.dateFrom, run.dateTo);
  const finished = run.finishedAt ? `, finished ${formatClinicDateTime(run.finishedAt)}` : "";
  switch (run.outcome) {
    case "running":
      return `a sync of ${dates} is running (started ${formatClinicDateTime(run.startedAt)})`;
    case "succeeded":
      return `last sync succeeded (${dates}${finished})`;
    case "stopped_at_time_limit":
      return `last sync stopped at its time limit (${dates}${finished}); the next sync carries on`;
    case "invoice_pages_missing":
      return `last sync read everything except some invoice pages (${dates}${finished})`;
    case "failed":
      return `last sync failed (${dates}${finished}): ${run.error ?? "no reason recorded"}`;
  }
}
