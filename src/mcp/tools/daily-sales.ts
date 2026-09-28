import { z } from "zod";

import {
  DAILY_GROUP_LABELS,
  dailyDayProblem,
  defaultDailyDay,
  EARLIEST_DAILY_DAY,
  getDailySales,
  getPendingLineItems,
  METRIC_DEFINITIONS,
  type DailyGroupRow,
  type DailySales,
  type KpiChange,
  type PendingLineItems,
} from "@/analytics";
import { clinicToday, formatDayWithWeekday, type IsoDate } from "@/filters";
import { formatPercentChange } from "@/lib/format";
import { formatRinggit, formatRinggitChange, moneyToSen, type Money } from "@/lib/money";

import { defineTool, ToolInputError, type McpToolContext } from "./define";
import { branchesInput, doctorsInput, filterOutput, isoDate, resolveFilter, type FilterEcho } from "./filter";
import { money, pendingLineItemsOutput } from "./schemas";
import { describeScope, plural } from "./text";

const GROUPS = ["other", "generic", "noStaff", "pending"] as const satisfies readonly DailyGroupRow["group"][];

const change = <T extends z.ZodType>(value: T) =>
  z.object({
    base: value.describe("The value on the comparison day"),
    change: value.describe("value − base"),
    changePercent: z.number().nullable().describe("change ÷ |base| × 100, one decimal; null when the base is zero (or AOV has no customers on a side)"),
  });
const metric = <T extends z.ZodType>(value: T) =>
  z.object({
    value: value.describe("On the day"),
    lastWeek: change(value).describe("Against the same weekday last week (comparisonDays.lastWeek)"),
    lastYear: change(value).describe("Against the same date last year (comparisonDays.lastYear)"),
  });
const figures = {
  revenue: metric(money),
  invoices: metric(z.number().int()),
  customers: metric(z.number().int()),
  aovPerCustomer: metric(money.nullable()),
};
const source = z.enum(["kreloses", "alias_only"]).describe("alias_only: known only from invoice lines (e.g. a doctor no longer in Kreloses's staff list)");

/** `getDailySales` as is, except that each group also carries its name (the Daily page's). */
type DailySalesAnswer = Omit<DailySales, "groups"> & { groups: (DailyGroupRow & { label: string })[] };

const dailySalesOutput = z.object({
  day: z.string().describe("The clinic day (Asia/Kuala_Lumpur), YYYY-MM-DD"),
  comparisonDays: z.object({ lastWeek: z.string(), lastYear: z.string() }).describe("The same weekday last week and the same date last year"),
  total: z.object(figures).describe("All the branches (and doctors) asked about together; a customer who visited both branches counts once"),
  branches: z.array(z.object({ branchId: z.string(), branchName: z.string(), ...figures })).describe("Every branch asked about, by name (zeros if it had no sales)"),
  doctors: z
    .array(z.object({ staffId: z.string(), name: z.string(), source, ...figures }))
    .describe("Doctors with credited lines on the day or on a comparison day, highest revenue on the day first"),
  groups: z
    .array(z.object({ group: z.enum(GROUPS), label: z.string().describe("The group's name, as on the Daily page"), ...figures }))
    .describe("Revenue never ranked with doctors (other staff, generic accounts, no staff on line, line items not synced yet), when there is any; empty with a doctor filter"),
}) satisfies z.ZodType<DailySalesAnswer>;

/**
 * `daily_sales`: the Daily page (`getDailySales`, the same call for the same day, branches and
 * doctors) as data. Unlike the page it never answers for another day than the one asked for: a day
 * that is not a real date, before 2000 or in the future is refused.
 */
export const dailySalesTool = defineTool({
  name: "daily_sales",
  title: "Daily sales",
  description: [
    "One clinic day's sales: the dashboard's Daily page as data. Revenue, invoices, customers and AOV per customer in total, per branch and per doctor (other staff, generic accounts, lines with no staff and sales whose line items are not synced yet as separate groups), each compared with the same weekday last week and the same date last year (value, base, change and change %). day: a clinic day (Asia/Kuala_Lumpur), YYYY-MM-DD, up to today (so far); default yesterday; a future day is refused. Optionally some branches and doctors (by id or name). Read-only. Every result states data as of per branch, and carries every definition in full.",
    "Definitions (the dashboard's own):",
    `- ${METRIC_DEFINITIONS.revenue}`,
    `- ${METRIC_DEFINITIONS.aovPerCustomer}`,
  ].join("\n"),
  input: {
    day: isoDate
      .optional()
      .describe(`The clinic day (Asia/Kuala_Lumpur), YYYY-MM-DD, from ${EARLIEST_DAILY_DAY} up to today (today = so far). Default: yesterday.`),
    ...branchesInput,
    ...doctorsInput,
  },
  output: {
    covers: filterOutput,
    daily: dailySalesOutput,
    pendingLineItems: pendingLineItemsOutput,
  },
  definitions: [
    "dailySales",
    "sameWeekdayLastWeek",
    "sameDateLastYear",
    "revenue",
    "creditedLine",
    "invoices",
    "customers",
    "aovPerCustomer",
    "change",
    "doctor",
    "otherStaff",
    "genericAccounts",
    "noStaffOnLine",
    "pendingLineItems",
  ],
  async run(context, input) {
    const now = context.now();
    const day = input.day ?? defaultDailyDay(now);
    const { filter, covers } = await resolveDay(context, day, input);
    const [daily, pendingLineItems] = await Promise.all([
      getDailySales(context.sql, day, { branchIds: filter.branchIds, doctorIds: filter.doctorIds }),
      getPendingLineItems(context.sql, { dateFrom: day, dateTo: day, branchIds: filter.branchIds }),
    ]);
    const answer: DailySalesAnswer = { ...daily, groups: daily.groups.map((group) => ({ ...group, label: DAILY_GROUP_LABELS[group.group] })) };
    return {
      data: { covers, daily: answer, pendingLineItems },
      summary: summarise(answer, covers, pendingLineItems, Boolean(filter.doctorIds)),
      freshness: { dateFrom: day, dateTo: day, branchIds: filter.branchIds },
    };
  },
});

/** The branches and doctors (names → ids), and the day checked — every problem reported at once. */
async function resolveDay(context: McpToolContext, day: IsoDate, input: { branches?: string[]; doctors?: string[] }) {
  const now = context.now();
  const problem = dailyDayProblem(day, now);
  const dayProblem =
    problem === "in_the_future"
      ? `day ${day} is in the future: today at the clinic (Asia/Kuala_Lumpur) is ${clinicToday(now)}. Ask for today or an earlier day.`
      : problem === "too_early"
        ? `day ${day} is before ${EARLIEST_DAILY_DAY}, the earliest day daily_sales answers for.`
        : problem === "not_a_date"
          ? `day ${day} is not a clinic day: write it YYYY-MM-DD.`
          : null;
  let resolved: Awaited<ReturnType<typeof resolveFilter>>;
  try {
    // Only the branches and doctors: the day stands in for the period.
    resolved = await resolveFilter(context, { branches: input.branches, doctors: input.doctors });
  } catch (error) {
    if (dayProblem && error instanceof ToolInputError) throw new ToolInputError(`${dayProblem} ${error.message}`);
    throw error;
  }
  if (dayProblem) throw new ToolInputError(dayProblem);
  const covers: FilterEcho = { ...resolved.covers, dateFrom: day, dateTo: day };
  return { filter: resolved.filter, covers };
}

function summarise(daily: DailySalesAnswer, covers: FilterEcho, pending: PendingLineItems, doctorFilter: boolean): string {
  const { total } = daily;
  const aov = total.aovPerCustomer.value === null ? "none (no customers)" : formatRinggit(total.aovPerCustomer.value);
  const top = daily.doctors[0];
  const pendingNote =
    pending.invoices === 0
      ? ""
      : doctorFilter
        ? `${plural(pending.invoices, "sale")} on the day (${formatRinggit(pending.revenue)}) ${pending.invoices === 1 ? "has" : "have"} line items not synced yet: not credited to any doctor yet, so not in these figures.`
        : `${plural(pending.invoices, "sale")} (${formatRinggit(pending.revenue)}) ${pending.invoices === 1 ? "has" : "have"} line items not synced yet: counted in the total as "${DAILY_GROUP_LABELS.pending}", not credited to any doctor yet.`;
  return [
    `Daily sales for ${formatDayWithWeekday(daily.day)}, ${describeScope(covers)}: revenue ${formatRinggit(total.revenue.value)}, ${plural(total.invoices.value, "invoice")}, ${plural(total.customers.value, "customer")}, AOV per customer ${aov}.`,
    `Revenue vs ${formatDayWithWeekday(daily.comparisonDays.lastWeek)} (same weekday last week): ${describeChange(total.revenue.lastWeek)}; ` +
      `vs ${formatDayWithWeekday(daily.comparisonDays.lastYear)} (same date last year): ${describeChange(total.revenue.lastYear)}.`,
    top && moneyToSen(top.revenue.value) !== 0
      ? `Highest doctor: ${top.name} ${formatRinggit(top.revenue.value)}.`
      : "No revenue was credited to a doctor on the day.",
    pendingNote,
  ]
    .filter(Boolean)
    .join(" ");
}

/** "+RM 375.00 (+50.0%)", "+RM 99.90 (none then)", "none on either day". */
function describeChange(change: KpiChange<Money>): string {
  if (change.changePercent !== null) return `${formatRinggitChange(change.change)} (${formatPercentChange(change.changePercent)})`;
  return moneyToSen(change.change) === 0 ? "none on either day" : `${formatRinggitChange(change.change)} (none then)`;
}
