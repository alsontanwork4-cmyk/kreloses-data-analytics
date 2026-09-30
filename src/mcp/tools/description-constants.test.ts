import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { NinetyDayReturns, Retention } from "@/analytics";
import type { Sql } from "@/db/sql";

import { MCP_TOOLS } from "./index";
import type { AnyMcpTool } from "./registry";

/**
 * Tool and field descriptions and summaries name thresholds the Analytics Service decides (the mix
 * comparison's ± points, a cohort's partial-year cut-off day, the discounted-invoice threshold, the
 * return window and the limited-history window). They must be generated from the service's
 * constants, never retyped: with the constants changed here, every description and summary follows.
 */
const { getRetention } = vi.hoisted(() => ({ getRetention: vi.fn<() => Promise<Retention>>() }));
vi.mock("@/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/analytics")>()),
  MIX_COMPARISON_THRESHOLD_POINTS: 7.5,
  FULL_YEAR_HISTORY_BY_DAY: 9,
  DISCOUNTED_INVOICE_THRESHOLD: "0.10",
  RETURN_WINDOW_DAYS: 60,
  LIMITED_HISTORY_DAYS: 45,
  getRetention,
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

  it("retention: the return window is RETURN_WINDOW_DAYS, a limited history LIMITED_HISTORY_DAYS", () => {
    const retention = tool("retention");
    const output = fields(retention.output);
    expect(retention.description).toContain('the 60-day return rate (recent visits whose 60 days have not passed are "not yet mature"');
    expect(output).toContain("Visits whose 60 days have not passed in the synced data yet");
    expect(output).toContain("another service visit 1–60 days later");
    expect(output).toContain("The 60-day return rate over the period's service visits");
    expect(output).toContain("syncedThrough − 60 days: later visits are not yet mature");
    expect(output).toContain("The period starts less than 45 days after historyFrom");
    // The field `returns90` keeps its name; no hand-typed "90 days" / "90-day" is left.
    expect(`${retention.description}${output}`).not.toMatch(/\b90[- ]day/);
  });

  it("retention's summaries say the same windows", async () => {
    const answer = (returns90: NinetyDayReturns, limitedHistory: boolean): Retention => ({
      period: { dateFrom: "2026-09-01", dateTo: "2026-09-30" },
      historyFrom: "2026-08-01",
      syncedThrough: "2026-09-30",
      matureThrough: "2026-08-01",
      limitedHistory,
      pendingInvoices: 0,
      clinic: { newVsReturning: { customers: 4, newCustomers: 1, returningCustomers: 3, newPercent: 25, returningPercent: 75 }, returns90, cohorts: [] },
      doctors: [],
    });
    const summary = async (value: Retention) => {
      getRetention.mockResolvedValueOnce(value);
      const context = { sql: {} as Sql, now: () => new Date("2026-10-01T03:00:00Z") };
      return (await tool("retention").run(context, { dateFrom: "2026-09-01", dateTo: "2026-09-30" })).summary;
    };
    const mature = await summary(answer({ visits: 5, notYetMature: 1, mature: 4, returned: 2, returnPercent: 50 }, true));
    expect(mature).toContain("60-day return rate 50.0% (2 of 4 visits whose 60 days have passed; 1 more recent visit is not yet mature and left out).");
    expect(mature).toContain("The synced history starts 1 Aug 2026, less than 45 days before the period:");
    const recent = await summary(answer({ visits: 3, notYetMature: 3, mature: 0, returned: 0, returnPercent: null }, false));
    expect(recent).toContain("60-day return rate: not known yet — all 3 visits in the period are less than 60 days before the latest synced day (30 Sep 2026).");
    const none = await summary(answer({ visits: 0, notYetMature: 0, mature: 0, returned: 0, returnPercent: null }, false));
    expect(none).toContain("No service visits in the period, so no 60-day return rate.");
    expect(`${mature}${recent}${none}`).not.toMatch(/\b90\b/);
  });

  it("discounts: an invoice is discounted over DISCOUNTED_INVOICE_THRESHOLD", () => {
    const output = fields(tool("discounts").output);
    expect(output).toContain("share of the discount is over RM 0.10");
    expect(output).not.toContain("RM 0.05");
  });
});
