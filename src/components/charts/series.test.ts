import { describe, expect, it } from "vitest";

import { seriesColor, stableSeriesSlots } from "./series";

describe("chart series colours", () => {
  it("maps slots 1-8 to the palette tokens and refuses anything else", () => {
    expect(seriesColor(1)).toBe("var(--chart-1)");
    expect(seriesColor(8)).toBe("var(--chart-8)");
    expect(() => seriesColor(0)).toThrow(RangeError);
    expect(() => seriesColor(9)).toThrow(RangeError);
  });

  it("gives each series the same slot whatever subset is shown (colour follows the entity, not its rank)", () => {
    const all = stableSeriesSlots(["12", "3", "7"]);
    expect([...all]).toEqual([
      ["12", 1],
      ["3", 2],
      ["7", 3],
    ]);
    // Slots follow the keys' own order, not the data's: re-sorting the rows changes nothing.
    expect([...stableSeriesSlots(["7", "12", "3"])]).toEqual([...all]);
    // At most 8 colours: the rest fold into "Other".
    const keys = Array.from({ length: 10 }, (_, index) => `k${index}`);
    const slots = stableSeriesSlots(keys);
    expect(slots.get("k0")).toBe(1);
    expect(slots.get("k7")).toBe(8);
    expect(slots.get("k8")).toBeNull(); // fold into "Other"
    expect(slots.get("k9")).toBeNull();
  });
});
