import { describe, expect, it } from "vitest";

import { describeKpiChange } from "./kpi-change";

describe("describeKpiChange", () => {
  it("shows the change and percentage, with its direction", () => {
    expect(describeKpiChange({ base: "2300.00", change: "3555.40", changePercent: 154.6 }, "money", "previousPeriod")).toEqual({
      direction: "up",
      text: "+RM 3,555.40 (+154.6%) vs previous period",
    });
    expect(describeKpiChange({ base: 3, change: -1, changePercent: -33.3 }, "count", "lastYear")).toEqual({
      direction: "down",
      text: "−1 (−33.3%) vs last year",
    });
    expect(describeKpiChange({ base: 3, change: 0, changePercent: 0 }, "count", "lastYear")).toEqual({
      direction: "flat",
      text: "0 (0.0%) vs last year",
    });
  });

  it("says which side is missing when there is no percentage", () => {
    // Nothing sold in the comparison period.
    expect(describeKpiChange({ base: "0.00", change: "13100.00", changePercent: null }, "money", "previousPeriod")).toEqual({
      direction: "none",
      text: "No sales in the previous period",
    });
    expect(describeKpiChange({ base: 0, change: 3, changePercent: null }, "count", "lastYear")).toEqual({
      direction: "none",
      text: "No sales in the same period last year",
    });
    // AOV: no customers in the comparison period / in this period.
    expect(describeKpiChange({ base: null, change: null, changePercent: null }, "money", "lastYear", { value: "6550.00" })).toEqual({
      direction: "none",
      text: "No customers in the same period last year",
    });
    expect(describeKpiChange({ base: "750.00", change: null, changePercent: null }, "money", "previousPeriod", { value: null })).toEqual({
      direction: "none",
      text: "No customers in this period to compare",
    });
  });
});
