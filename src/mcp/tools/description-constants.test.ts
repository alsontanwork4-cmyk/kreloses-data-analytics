import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { MCP_TOOLS } from "./index";
import type { AnyMcpTool } from "./registry";

/**
 * Tool and field descriptions name thresholds the Analytics Service decides (the mix comparison's
 * ± points, a cohort's partial-year cut-off day, the discounted-invoice threshold). They must be
 * generated from the service's constants, never retyped: with the constants changed here, every
 * description follows.
 */
vi.mock("@/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/analytics")>()),
  MIX_COMPARISON_THRESHOLD_POINTS: 7.5,
  FULL_YEAR_HISTORY_BY_DAY: 9,
  DISCOUNTED_INVOICE_THRESHOLD: "0.10",
}));

const tool = (name: string): AnyMcpTool => MCP_TOOLS.find((candidate) => candidate.name === name)!;
/** Every description in a tool's input or output fields. */
const fields = (shape: z.ZodRawShape) => JSON.stringify(z.toJSONSchema(z.object(shape)));

describe("descriptions follow the Analytics Service's constants", () => {
  it("item_mix: above / below the clinic average at ± MIX_COMPARISON_THRESHOLD_POINTS", () => {
    const { description } = tool("item_mix");
    expect(description).toContain("above / below at ±7.5 points");
    expect(description).not.toContain("±5 points");
  });

  it("retention: a partial year starts after FULL_YEAR_HISTORY_BY_DAY January", () => {
    const retention = tool("retention");
    expect(retention.description).toContain("partial year when the synced history starts after 9 January");
    expect(fields(retention.output)).toContain("The synced history starts after 9 January of this year");
    expect(`${retention.description}${fields(retention.output)}`).not.toContain("7 January");
  });

  it("discounts: an invoice is discounted over DISCOUNTED_INVOICE_THRESHOLD", () => {
    const output = fields(tool("discounts").output);
    expect(output).toContain("share of the discount is over RM 0.10");
    expect(output).not.toContain("RM 0.05");
  });
});
