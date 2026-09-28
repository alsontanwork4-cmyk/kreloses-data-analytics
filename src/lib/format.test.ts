import { describe, expect, it } from "vitest";

import { formatCount, formatCountChange, formatDuration, formatPercentChange } from "./format";

describe("display formatting", () => {
  it("formats counts, changes and percentages", () => {
    expect(formatCount(12345)).toBe("12,345");
    expect(formatCountChange(6)).toBe("+6");
    expect(formatCountChange(-2)).toBe("−2");
    expect(formatCountChange(0)).toBe("0");
    expect(formatPercentChange(154.6)).toBe("+154.6%");
    expect(formatPercentChange(-55.3)).toBe("−55.3%");
    expect(formatPercentChange(200)).toBe("+200.0%");
    expect(formatPercentChange(0)).toBe("0.0%");
    expect(formatPercentChange(null)).toBe("n/a");
  });

  it("formats durations", () => {
    expect(formatDuration(8_400)).toBe("8 s");
    expect(formatDuration(125_000)).toBe("2 min 05 s");
    expect(formatDuration(3_720_000)).toBe("1 h 02 min");
  });
});
