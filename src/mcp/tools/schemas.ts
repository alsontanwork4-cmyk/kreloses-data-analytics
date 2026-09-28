import { z } from "zod";

import type { PendingLineItems } from "@/analytics";

/**
 * Output schema pieces shared by the tools. Each mirrors an Analytics Service type (checked with
 * `satisfies z.ZodType<…>`), so a tool's structured result is the service's result as is.
 */

/** RM as an exact decimal string with two places, e.g. "1234.50" or "-120.00". */
export const money = z.string().describe('RM, exact, two decimals (e.g. "1234.50"; negative for returns)');

export const pendingLineItemsOutput = z
  .object({
    invoices: z.number().int(),
    revenue: money,
  })
  .describe(
    "Sales in the period and branches whose line items are not synced yet (the doctor filter does not apply): their revenue is credited to nobody yet, so doctor and item figures cannot include them.",
  ) satisfies z.ZodType<PendingLineItems>;
