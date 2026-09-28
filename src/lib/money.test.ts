import { describe, expect, it } from "vitest";

import { formatRinggit, formatRinggitChange, moneyToSen, senToMoney } from "./money";

describe("money", () => {
  it("converts between decimal strings and integer sen exactly", () => {
    expect(moneyToSen("1234.50")).toBe(123_450);
    expect(moneyToSen("1234.5")).toBe(123_450);
    expect(moneyToSen("-120.00")).toBe(-12_000);
    expect(moneyToSen("0.00")).toBe(0);
    expect(moneyToSen("-0.00")).toBe(0);
    expect(moneyToSen("9999999999.99")).toBe(999_999_999_999);
    expect(senToMoney(123_450)).toBe("1234.50");
    expect(senToMoney(-12_000)).toBe("-120.00");
    expect(senToMoney(5)).toBe("0.05");
    expect(senToMoney(-5)).toBe("-0.05");
    expect(senToMoney(0)).toBe("0.00");
    expect(() => moneyToSen("1,234.50")).toThrow(TypeError);
    expect(() => senToMoney(1.5)).toThrow(RangeError);
  });

  it("formats ringgit for display", () => {
    expect(formatRinggit("5855.40")).toBe("RM 5,855.40");
    expect(formatRinggit("-120.00")).toBe("−RM 120.00");
    expect(formatRinggit("0.00")).toBe("RM 0.00");
    expect(formatRinggit("1234567.05")).toBe("RM 1,234,567.05");
    expect(formatRinggitChange("3555.40")).toBe("+RM 3,555.40");
    expect(formatRinggitChange("-7244.60")).toBe("−RM 7,244.60");
    expect(formatRinggitChange("0.00")).toBe("RM 0.00");
  });
});
