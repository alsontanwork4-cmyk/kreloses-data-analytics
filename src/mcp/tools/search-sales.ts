import { z } from "zod";

import {
  getPendingLineItems,
  METRIC_DEFINITIONS,
  SALES_SEARCH_DEFAULT_PAGE_SIZE,
  SALES_SEARCH_MAX_PAGE_SIZE,
  searchSales,
  type SalesSearchResult,
  type SalesSearchSort,
} from "@/analytics";
import { formatRinggit, moneyToSen, type Money } from "@/lib/money";

import { defineTool, ToolInputError } from "./define";
import { filterInput, filterOutput, resolveFilter } from "./filter";
import { money, pendingLineItemsOutput } from "./schemas";
import { describeCoverage, plural } from "./text";

const SORTS = ["newest", "oldest", "largest", "smallest"] as const satisfies readonly SalesSearchSort[];
const SORT_LABELS: Record<SalesSearchSort, string> = {
  newest: "newest first",
  oldest: "oldest first",
  largest: "largest first",
  smallest: "smallest first",
};

const salesSearchOutput = z.object({
  period: z.object({ dateFrom: z.string(), dateTo: z.string() }),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalMatches: z.number().int().describe("Matching sales on all pages"),
  totalPages: z.number().int(),
  totalRevenue: money.describe("Revenue of every matching sale (whole sales, all pages)"),
  sales: z.array(
    z.object({
      invoiceId: z.string(),
      saleNumber: z.string().nullable().describe("The invoice number people see"),
      saleDate: z.string().describe("Clinic day, YYYY-MM-DD"),
      branchId: z.string(),
      branchName: z.string(),
      customerName: z.string().nullable().describe("null = walk-in"),
      revenue: money.describe("The sale's revenue: its net amount less refunds"),
      lineItemsSynced: z.boolean(),
      credits: z
        .array(
          z.object({
            staffId: z.string().nullable(),
            name: z.string(),
            creditGroup: z.enum(["doctor", "other", "generic", "no_staff", "pending"]),
            revenue: money,
            lines: z.number().int().describe("Credited item lines"),
          }),
        )
        .describe("The whole sale's revenue by who it is credited to, largest first; adds up to `revenue`"),
    }),
  ),
}) satisfies z.ZodType<SalesSearchResult>;

/** `search_sales`: individual invoices (`searchSales`), each with its credited split per staff. */
export const searchSalesTool = defineTool({
  name: "search_sales",
  title: "Search sales",
  description: [
    `Find individual sales (invoices): a customer's visits, sales that included an item, a doctor's sales, the largest sales… For a period (clinic days, Asia/Kuala_Lumpur; default month to date) and optionally some branches and doctors (by id or name). Each sale comes with its number, date, branch, customer, revenue and the revenue credited to each staff member on it. Paged (${SALES_SEARCH_DEFAULT_PAGE_SIZE} per page by default, at most ${SALES_SEARCH_MAX_PAGE_SIZE}); the totals cover every match. Read-only. Every result states data as of per branch, and carries every definition in full.`,
    "Definition (the dashboard's own):",
    `- ${METRIC_DEFINITIONS.salesSearch}`,
  ].join("\n"),
  input: {
    ...filterInput,
    customer: z.string().trim().min(1).max(200).optional().describe("Part of the customer's name (any case)."),
    item: z.string().trim().min(1).max(200).optional().describe('Part of the name of an item sold on the sale (any case), e.g. "x-ray".'),
    minAmount: z.number().optional().describe("Only sales whose revenue is at least this many RM (inclusive), e.g. 250 or 99.9."),
    maxAmount: z.number().optional().describe("Only sales whose revenue is at most this many RM (inclusive)."),
    sort: z.enum(SORTS).optional().describe("newest (default), oldest, largest or smallest revenue first."),
    page: z.number().int().min(1).max(100_000).optional().describe("Page number, from 1 (default 1)."),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(SALES_SEARCH_MAX_PAGE_SIZE)
      .optional()
      .describe(`Sales per page (default ${SALES_SEARCH_DEFAULT_PAGE_SIZE}, at most ${SALES_SEARCH_MAX_PAGE_SIZE}).`),
  },
  output: {
    covers: filterOutput,
    criteria: z
      .object({
        customer: z.string().nullable(),
        item: z.string().nullable(),
        minAmount: money.nullable(),
        maxAmount: money.nullable(),
        sort: z.enum(SORTS),
      })
      .describe("The search criteria applied (null = not used)"),
    search: salesSearchOutput,
    pendingLineItems: pendingLineItemsOutput,
  },
  definitions: ["salesSearch", "revenue", "creditedLine", "doctor", "otherStaff", "genericAccounts", "noStaffOnLine", "pendingLineItems"],
  async run(context, input) {
    const minAmount = input.minAmount === undefined ? null : toMoney(input.minAmount, "minAmount");
    const maxAmount = input.maxAmount === undefined ? null : toMoney(input.maxAmount, "maxAmount");
    if (minAmount !== null && maxAmount !== null && moneyToSen(minAmount) > moneyToSen(maxAmount)) {
      throw new ToolInputError(`minAmount (${minAmount}) is more than maxAmount (${maxAmount}).`);
    }
    const { filter, covers } = await resolveFilter(context, input);
    const criteria = {
      customer: input.customer ?? null,
      item: input.item ?? null,
      minAmount,
      maxAmount,
      sort: input.sort ?? "newest",
    };
    const [search, pendingLineItems] = await Promise.all([
      searchSales(context.sql, filter, {
        customer: criteria.customer ?? undefined,
        item: criteria.item ?? undefined,
        minRevenue: minAmount ?? undefined,
        maxRevenue: maxAmount ?? undefined,
        sort: criteria.sort,
        page: input.page,
        pageSize: input.pageSize,
      }),
      getPendingLineItems(context.sql, filter),
    ]);

    const looking = describeCriteria(criteria);
    const found =
      search.totalMatches === 0
        ? `No sales found for ${describeCoverage(covers)}${looking}.`
        : `Found ${plural(search.totalMatches, "sale")} (${formatRinggit(search.totalRevenue)} in total) for ${describeCoverage(covers)}${looking}; ` +
          (search.sales.length === 0
            ? `page ${search.page} is past the last page (${search.totalPages}).`
            : `showing ${(search.page - 1) * search.pageSize + 1}–${(search.page - 1) * search.pageSize + search.sales.length}, ${SORT_LABELS[criteria.sort]} (page ${search.page} of ${search.totalPages}).` +
              (search.page < search.totalPages ? ` Ask for page ${search.page + 1} for more.` : ""));
    const pendingNote =
      pendingLineItems.invoices > 0 && (filter.doctorIds || criteria.item)
        ? ` ${plural(pendingLineItems.invoices, "sale")} in the period ${pendingLineItems.invoices === 1 ? "has" : "have"} line items not synced yet, so a doctor or item search cannot find ${pendingLineItems.invoices === 1 ? "it" : "them"} yet.`
        : "";
    return {
      data: { covers, criteria, search, pendingLineItems },
      summary: found + pendingNote,
      freshness: { dateFrom: filter.dateFrom, dateTo: filter.dateTo, branchIds: filter.branchIds },
    };
  },
});

/** A JSON number of RM → an exact money string; refuses more than two decimals (or a float artefact). */
function toMoney(value: number, field: string): Money {
  const text = String(value);
  if (!Number.isFinite(value) || !/^-?\d+(\.\d{1,2})?$/.test(text)) {
    throw new ToolInputError(`${field} must be an amount in RM with at most two decimals (e.g. 250 or 99.9).`);
  }
  const [whole, fraction = ""] = text.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function describeCriteria(criteria: { customer: string | null; item: string | null; minAmount: Money | null; maxAmount: Money | null }): string {
  const parts = [
    criteria.customer ? `customer "${criteria.customer}"` : null,
    criteria.item ? `item "${criteria.item}"` : null,
    criteria.minAmount !== null ? `revenue at least ${formatRinggit(criteria.minAmount)}` : null,
    criteria.maxAmount !== null ? `revenue at most ${formatRinggit(criteria.maxAmount)}` : null,
  ].filter(Boolean);
  return parts.length === 0 ? "" : `, matching ${parts.join(", ")}`;
}
