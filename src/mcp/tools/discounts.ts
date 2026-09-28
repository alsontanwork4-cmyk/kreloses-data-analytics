import { z } from "zod";

import {
  getDiscountTypes,
  getDoctorDiscounts,
  METRIC_DEFINITIONS,
  type DiscountAppliedTo,
  type DiscountTypes,
  type DoctorDiscounts,
} from "@/analytics";
import { formatRinggit } from "@/lib/money";

import { defineTool } from "./define";
import { filterInput, filterOutput, resolveFilter, type FilterEcho } from "./filter";
import { money, pendingLineItemsOutput } from "./schemas";
import { describeCoverage, percent, plural } from "./text";

const APPLIED_TO = ["item", "invoice", "both", "difference"] as const satisfies readonly DiscountAppliedTo[];

const figures = {
  gross: money.describe("Σ quantity × unit price of the sold lines, before any discount"),
  charged: money.describe("Σ what those lines were charged after every discount, before refunds"),
  discount: money.describe("gross − charged"),
  discountRatePercent: z.number().nullable().describe("discount ÷ gross × 100, one decimal; null when gross ≤ 0"),
  invoices: z.number().int().describe("Invoices with at least one sold line credited here"),
  discountedInvoices: z.number().int().describe("Of those, the invoices where this row's share of the discount is over RM 0.05"),
  discountedInvoicesPercent: z.number().nullable(),
};
const staffRow = z.object({
  staffId: z.string(),
  name: z.string(),
  source: z.enum(["kreloses", "alias_only"]).describe("alias_only: known only from invoice lines (e.g. a doctor no longer in Kreloses's staff list)"),
  active: z.boolean(),
  ...figures,
});
const staffGroup = z.object({ ...figures, members: z.array(staffRow) });

const doctorDiscountsOutput = z.object({
  period: z.object({ dateFrom: z.string(), dateTo: z.string() }),
  total: z.object(figures).describe("Every sold line in the filter (with a doctor filter: the selected doctors')"),
  doctors: z.array(staffRow).describe("Doctors, largest discount first"),
  groups: z.object({
    other: staffGroup.describe("Other staff (nurses, groomers…)"),
    generic: staffGroup.describe("Generic (shared) accounts"),
    noStaff: z.object(figures).describe("No staff on line"),
  }),
  pendingLineItems: pendingLineItemsOutput,
}) satisfies z.ZodType<DoctorDiscounts>;

const discountTypesOutput = z.object({
  period: z.object({ dateFrom: z.string(), dateTo: z.string() }),
  total: money.describe("Σ amount: without a doctor filter exactly the total discount"),
  types: z
    .array(
      z.object({
        key: z.string().describe("Stable key: name:<name without spaces, lower case>, unnamed-item, unnamed-line or difference"),
        label: z.string().describe("The name as written most often (a description for unnamed discounts and the difference)"),
        appliedTo: z.enum(APPLIED_TO).describe("item: a line's own discount; invoice: a discount line on the whole invoice; both; difference: the rest of the gap to the invoice net"),
        lines: z.number().int().nullable(),
        invoices: z.number().int(),
        amount: money.describe("RM taken off (with a doctor filter: the part on the selected doctors' lines)"),
        sharePercent: z.number().nullable().describe("amount ÷ total × 100, one decimal"),
      }),
    )
    .describe("Largest amount first, the difference last"),
}) satisfies z.ZodType<DiscountTypes>;

/**
 * `discounts`: the Discounts page (`getDoctorDiscounts` + `getDiscountTypes`, the same calls with the
 * same filter) as data.
 */
export const discountsTool = defineTool({
  name: "discounts",
  title: "Discounts",
  description: [
    "Discounts per doctor: the dashboard's Discounts page as data. For a period (clinic days, Asia/Kuala_Lumpur; default month to date) and optionally some branches and doctors (by id or name): each doctor's discount total, discount rate and share of invoices discounted (other staff, generic accounts and lines with no staff as separate groups, never ranked with doctors), and the discount types used (e.g. \"5% DISCOUNT\") with their lines, invoices and amounts. Read-only. Every result states data as of per branch, and carries every definition in full.",
    "Definitions (the dashboard's own):",
    `- ${METRIC_DEFINITIONS.discount}`,
    `- ${METRIC_DEFINITIONS.discountRate}`,
    `- ${METRIC_DEFINITIONS.discountedInvoices}`,
  ].join("\n"),
  input: filterInput,
  output: {
    covers: filterOutput,
    discounts: doctorDiscountsOutput,
    types: discountTypesOutput,
  },
  definitions: [
    "discount",
    "discountRate",
    "discountedInvoices",
    "discountTypes",
    "creditedLine",
    "doctor",
    "otherStaff",
    "genericAccounts",
    "noStaffOnLine",
    "pendingLineItems",
  ],
  async run(context, input) {
    const { filter, covers } = await resolveFilter(context, input);
    const [discounts, types] = await Promise.all([getDoctorDiscounts(context.sql, filter), getDiscountTypes(context.sql, filter)]);
    return {
      data: { covers, discounts, types },
      summary: summarise(discounts, types, covers),
      freshness: { dateFrom: filter.dateFrom, dateTo: filter.dateTo, branchIds: filter.branchIds },
    };
  },
});

function summarise(discounts: DoctorDiscounts, types: DiscountTypes, covers: FilterEcho): string {
  const { total, pendingLineItems: pending } = discounts;
  const top = discounts.doctors[0];
  const type = types.types[0];
  return [
    `Discounts for ${describeCoverage(covers)}: ${formatRinggit(total.discount)} off ${formatRinggit(total.gross)} gross (discount rate ${percent(total.discountRatePercent)}); ` +
      `${total.discountedInvoices} of ${plural(total.invoices, "invoice")} discounted (${percent(total.discountedInvoicesPercent)}).`,
    top
      ? `Largest doctor discount: ${top.name} ${formatRinggit(top.discount)} (${percent(top.discountRatePercent)} of gross; ${top.discountedInvoices} of ${plural(top.invoices, "invoice")} discounted).`
      : "",
    type
      ? `Largest discount type: ${type.label} ${formatRinggit(type.amount)} (${percent(type.sharePercent)} of discounts, ${plural(type.invoices, "invoice")}).`
      : "",
    pending.invoices > 0
      ? `${plural(pending.invoices, "sale")} (${formatRinggit(pending.revenue)}) ${pending.invoices === 1 ? "has" : "have"} line items not synced yet: ${pending.invoices === 1 ? "its" : "their"} discounts are not in these figures until they are read.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}
