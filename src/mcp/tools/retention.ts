import { z } from "zod";

import { FULL_YEAR_HISTORY_BY_DAY, getRetention, LIMITED_HISTORY_DAYS, METRIC_DEFINITIONS, RETURN_WINDOW_DAYS, type Retention } from "@/analytics";
import { formatIsoDate } from "@/filters";

import { defineTool } from "./define";
import { filterInput, filterOutput, resolveFilter, type FilterEcho } from "./filter";
import { definitionExcerpt, describeCoverage, percent, plural } from "./text";

const count = z.number().int();
const rate = z.number().nullable().describe("Percentage, one decimal; null when there is nothing to divide by");
const figures = {
  newVsReturning: z
    .object({ customers: count, newCustomers: count, returningCustomers: count, newPercent: rate, returningPercent: rate })
    .describe("Customers with a service visit in the period: new (first service visit in the synced history) or returning"),
  returns90: z
    .object({
      visits: count.describe("Service visits in the period"),
      notYetMature: count.describe(`Visits whose ${RETURN_WINDOW_DAYS} days have not passed in the synced data yet: left out of the rate`),
      mature: count.describe("visits − notYetMature: what the rate is out of"),
      returned: count.describe(`Mature visits followed by another service visit 1–${RETURN_WINDOW_DAYS} days later (any doctor, any branch)`),
      returnPercent: rate,
    })
    .describe(`The ${RETURN_WINDOW_DAYS}-day return rate over the period's service visits`),
  cohorts: z
    .array(
      z.object({
        year: count,
        accruing: z.boolean().describe("The next year is not over in the synced data yet: more customers may still come back"),
        partialYear: z
          .boolean()
          .describe(`The synced history starts after ${FULL_YEAR_HISTORY_BY_DAY} January of this year: customers seen earlier in it are missing`),
        customers: count.describe("Cohort size"),
        retainedAnyDoctor: count,
        retainedAnyDoctorPercent: rate,
        retainedSameDoctor: count.nullable().describe("null for the whole clinic"),
        retainedSameDoctorPercent: rate,
      }),
    )
    .describe("Yearly cohorts, newest first (ignore the date range)"),
};

const retentionOutput = z.object({
  period: z.object({ dateFrom: z.string(), dateTo: z.string() }),
  historyFrom: z.string().nullable().describe("Earliest clinic day with a synced sale at the branches asked about"),
  syncedThrough: z.string().nullable().describe("Latest clinic day with a synced sale at any branch: returns and cohorts are seen up to this day"),
  matureThrough: z.string().nullable().describe(`syncedThrough − ${RETURN_WINDOW_DAYS} days: later visits are not yet mature`),
  limitedHistory: z
    .boolean()
    .describe(`The period starts less than ${LIMITED_HISTORY_DAYS} days after historyFrom: some "new" customers may have visited before it`),
  pendingInvoices: count.describe("Active sales at the branches (any date) whose line items are not synced yet: not service visits until they are"),
  clinic: z.object(figures).describe("Every service visit at the branches, whoever it is credited to (the doctor filter does not change it)"),
  doctors: z
    .array(
      z.object({
        staffId: z.string(),
        name: z.string(),
        source: z.enum(["kreloses", "alias_only"]).describe("alias_only: known only from invoice lines"),
        ...figures,
      }),
    )
    .describe("Doctors with a service visit in the period or a listed cohort (within the doctor filter), by name"),
}) satisfies z.ZodType<Retention>;

/**
 * `retention`: the Retention page (`getRetention`, the same call with the same filter) as data —
 * new vs returning customers, the return rate within `RETURN_WINDOW_DAYS` and yearly cohorts, counted in service visits.
 */
export const retentionTool = defineTool({
  name: "retention",
  title: "Customer retention",
  description: [
    `Customer retention: the dashboard's Retention page as data, per doctor and for the whole clinic, counted in service visits: new vs returning customers in the period, the ${RETURN_WINDOW_DAYS}-day return rate (recent visits whose ${RETURN_WINDOW_DAYS} days have not passed are "not yet mature" and left out), and yearly cohorts retained with any doctor and with the same doctor the next year (flagged accruing while that year is not over, partial year when the synced history starts after ${FULL_YEAR_HISTORY_BY_DAY} January). For a period (clinic days, Asia/Kuala_Lumpur; default month to date; cohorts ignore it) and optionally some branches and doctors (by id or name). Read-only. Every result states data as of per branch, and carries every definition in full.`,
    "Definitions (the dashboard's own; in full in every result):",
    `- ${METRIC_DEFINITIONS.serviceVisit}`,
    `- ${definitionExcerpt("yearlyCohort", 2)}`,
  ].join("\n"),
  input: filterInput,
  output: { covers: filterOutput, retention: retentionOutput },
  definitions: ["serviceVisit", "newVsReturning", "returnRate90", "yearlyCohort", "retentionFilters", "syncedThrough", "doctor", "pendingLineItems"],
  async run(context, input) {
    const { filter, covers } = await resolveFilter(context, input);
    const retention = await getRetention(context.sql, filter);
    return {
      data: { covers, retention },
      summary: summarise(retention, covers),
      // Returns and first visits count at ANY branch, so every branch's freshness matters, whatever the branch filter.
      freshness: { dateFrom: filter.dateFrom, dateTo: filter.dateTo },
    };
  },
});

function summarise(retention: Retention, covers: FilterEcho): string {
  const head = `Retention for ${describeCoverage(covers)}:`;
  if (retention.syncedThrough === null) return `${head} no sales have been synced yet, so there is nothing to measure.`;
  const { newVsReturning: seen, returns90: returns } = retention.clinic;
  const syncedThrough = formatIsoDate(retention.syncedThrough);
  const cohort = retention.clinic.cohorts[0];
  const flags = cohort ? [cohort.partialYear ? "partial year" : null, cohort.accruing ? "still accruing" : null].filter(Boolean) : [];
  return [
    `${head} ${plural(seen.customers, "customer")} had a service visit (whole clinic): ${seen.newCustomers} new (${percent(seen.newPercent)}), ${seen.returningCustomers} returning (${percent(seen.returningPercent)}).`,
    returns.mature > 0
      ? `${RETURN_WINDOW_DAYS}-day return rate ${percent(returns.returnPercent)} (${returns.returned} of ${plural(returns.mature, "visit")} whose ${RETURN_WINDOW_DAYS} days have passed` +
        (returns.notYetMature > 0 ? `; ${returns.notYetMature} more recent ${returns.notYetMature === 1 ? "visit is" : "visits are"} not yet mature and left out).` : ").")
      : returns.visits > 0
        ? `${RETURN_WINDOW_DAYS}-day return rate: not known yet — ${returns.visits === 1 ? "the 1 visit" : `all ${returns.visits} visits`} in the period ${returns.visits === 1 ? "is" : "are"} less than ${RETURN_WINDOW_DAYS} days before the latest synced day (${syncedThrough}).`
        : `No service visits in the period, so no ${RETURN_WINDOW_DAYS}-day return rate.`,
    cohort
      ? `Latest yearly cohort ${cohort.year}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}: ${plural(cohort.customers, "customer")}, ${percent(cohort.retainedAnyDoctorPercent)} came back in ${cohort.year + 1} (any doctor).`
      : `No yearly cohort yet: a year's cohort is listed once the synced data reaches the next year (synced through ${syncedThrough}).`,
    `${plural(retention.doctors.length, "doctor")} listed.`,
    retention.limitedHistory
      ? `The synced history starts ${formatIsoDate(retention.historyFrom!)}, less than ${LIMITED_HISTORY_DAYS} days before the period: some "new" customers may have visited before it.`
      : "",
    retention.pendingInvoices > 0
      ? `${plural(retention.pendingInvoices, "sale")} ${retention.pendingInvoices === 1 ? "has" : "have"} line items not synced yet: ${retention.pendingInvoices === 1 ? "it" : "they"} cannot count as a service visit until the next sync reads ${retention.pendingInvoices === 1 ? "it" : "them"}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
