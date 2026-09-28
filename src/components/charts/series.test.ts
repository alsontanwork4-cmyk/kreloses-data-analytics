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
    // Give it the FULL key set (e.g. every doctor), not the rows a filter left: then a doctor keeps
    // their colour when others are filtered out. Filtered keys would shift the survivors.
    const everyDoctor = ["d1", "d2", "d3"];
    const shownAfterFilter = ["d2", "d3"];
    const fromFullSet = stableSeriesSlots(everyDoctor);
    expect(shownAfterFilter.map((key) => fromFullSet.get(key))).toEqual([2, 3]);
    const fromFiltered = stableSeriesSlots(shownAfterFilter);
    expect(shownAfterFilter.map((key) => fromFiltered.get(key))).toEqual([1, 2]); // repainted: the mistake to avoid
    // At most 8 colours: the rest fold into "Other".
    const keys = Array.from({ length: 10 }, (_, index) => `k${index}`);
    const slots = stableSeriesSlots(keys);
    expect(slots.get("k0")).toBe(1);
    expect(slots.get("k7")).toBe(8);
    expect(slots.get("k8")).toBeNull(); // fold into "Other"
    expect(slots.get("k9")).toBeNull();
  });
});
