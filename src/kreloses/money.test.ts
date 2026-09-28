import { describe, expect, it } from "vitest";

import { parseAmountSen } from "./money";

describe("parseAmountSen", () => {
  it("reads JSON numbers through their decimal text, never as float maths", () => {
    expect(parseAmountSen(1199.5)).toBe(119_950);
    expect(parseAmountSen(-45.1)).toBe(-4_510);
    expect(parseAmountSen(0.07)).toBe(7);
    expect(parseAmountSen(0)).toBe(0);
    expect(parseAmountSen(0.1 + 0.2)).toBeUndefined(); // 0.30000000000000004: not an amount
    expect(parseAmountSen(1e21)).toBeUndefined();
    expect(parseAmountSen(Number.NaN)).toBeUndefined();
  });

  it("reads Kreloses's formatted strings", () => {
    expect(parseAmountSen("1,234.50")).toBe(123_450);
    expect(parseAmountSen("(1,234.50)")).toBe(-123_450);
    expect(parseAmountSen("RM (12.00)")).toBe(-1_200);
    expect(parseAmountSen("-")).toBeNull();
    expect(parseAmountSen("(-12.00)")).toBeUndefined();
    expect(parseAmountSen("12.345")).toBeUndefined();
  });
});
