import { z } from "zod";

import { getDoctorRanking, getPendingLineItems, METRIC_DEFINITIONS, type DoctorRanking } from "@/analytics";
import { formatRinggit } from "@/lib/money";

import { defineTool } from "./define";
import { filterInput, filterOutput, resolveFilter } from "./filter";
import { money, pendingLineItemsOutput } from "./schemas";
import { describeCoverage, plural } from "./text";

const figures = {
  revenue: money,
  invoices: z.number().int(),
  customers: z.number().int(),
  aovPerCustomer: money.nullable(),
  itemsPerInvoice: z.number().nullable(),
  sharePercent: z.number().nullable(),
};
const staffRow = z.object({
  staffId: z.string(),
  name: z.string(),
  source: z.enum(["kreloses", "alias_only"]).describe("alias_only: known only from invoice lines (e.g. a doctor no longer in Kreloses's staff list)"),
  active: z.boolean(),
  ...figures,
});
const staffGroup = z.object({ ...figures, members: z.array(staffRow) });
const doctorRanking = z.object({
  period: z.object({ dateFrom: z.string(), dateTo: z.string() }),
  totalRevenue: money.describe("ALL revenue in the period and branches: what shares are a share of (the doctor filter does not change it)"),
  doctors: z
    .array(staffRow.extend({ branches: z.array(z.object({ branchId: z.string(), branchName: z.string(), ...figures })).optional() }))
    .describe("Doctors, highest revenue first; `branches` only with splitByBranch"),
  groups: z.object({
    other: staffGroup.describe("Other staff (nurses, groomers…)"),
    generic: staffGroup.describe("Generic (shared) accounts"),
    noStaff: z.object(figures).describe("No staff on line"),
    pending: z.object(figures).describe("Line items not synced yet"),
  }),
}) satisfies z.ZodType<DoctorRanking>;

/**
 * `doctor_performance`: the Doctors page (`getDoctorRanking`, the same call with the same filter)
 * as data, plus the sales not credited to anyone yet.
 */
export const doctorPerformanceTool = defineTool({
  name: "doctor_performance",
  title: "Doctor performance",
  description: [
    "Doctor ranking: the dashboard's Doctors page as data. For a period (clinic days, Asia/Kuala_Lumpur; default month to date) and optionally some branches and doctors (by id or name): each doctor's revenue, AOV per customer, invoices, customers, average items per invoice and share of all revenue, highest revenue first; with splitByBranch also per branch. Other staff, generic accounts, lines with no staff and sales whose line items are not synced yet are separate groups, never ranked with doctors. Read-only. Every result states data as of per branch, and carries every definition in full.",
    "Definitions (the dashboard's own):",
    `- ${METRIC_DEFINITIONS.revenue}`,
    `- ${METRIC_DEFINITIONS.aovPerCustomer}`,
    `- ${METRIC_DEFINITIONS.itemsPerInvoice}`,
  ].join("\n"),
  input: {
    ...filterInput,
    splitByBranch: z.boolean().optional().describe("true: also each doctor's figures per branch (AOV per customer counted per branch)."),
  },
  output: {
    covers: filterOutput,
    ranking: doctorRanking,
    pendingLineItems: pendingLineItemsOutput,
  },
  definitions: [
    "doctorRanking",
    "revenue",
    "creditedLine",
    "aovPerCustomer",
    "invoices",
    "customers",
    "itemsPerInvoice",
    "sharePercent",
    "doctor",
    "otherStaff",
    "genericAccounts",
    "noStaffOnLine",
    "pendingLineItems",
  ],
  async run(context, input) {
    const { filter, covers } = await resolveFilter(context, input);
    const [ranking, pendingLineItems] = await Promise.all([
      getDoctorRanking(context.sql, filter, { splitByBranch: input.splitByBranch ?? false }),
      getPendingLineItems(context.sql, filter),
    ]);
    const top = ranking.doctors[0];
    const summary = [
      `Doctor ranking for ${describeCoverage(covers)}: ${plural(ranking.doctors.length, "doctor")} with revenue` +
        (top ? `; highest ${top.name} ${formatRinggit(top.revenue)} (${top.sharePercent ?? 0}% of all revenue).` : "."),
      `All revenue in the period${covers.branches === "all" ? "" : " and branches"}: ${formatRinggit(ranking.totalRevenue)}.`,
      pendingLineItems.invoices > 0
        ? `${plural(pendingLineItems.invoices, "sale")} (${formatRinggit(pendingLineItems.revenue)}) ${pendingLineItems.invoices === 1 ? "has" : "have"} line items not synced yet: counted in all revenue but not credited to any doctor yet.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      data: { covers, ranking, pendingLineItems },
      summary,
      freshness: { dateFrom: filter.dateFrom, dateTo: filter.dateTo, branchIds: filter.branchIds },
    };
  },
});
