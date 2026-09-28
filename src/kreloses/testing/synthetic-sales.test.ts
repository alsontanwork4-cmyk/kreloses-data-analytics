import { describe, expect, it } from "vitest";

import { syntheticSales } from "./synthetic-sales";

describe("synthetic sales (test builder)", () => {
  it("writes a line as one unit at its amount, or as quantity × unit price with any item discount", () => {
    const { rows, overviews } = syntheticSales([
      {
        saleId: 810001,
        branch: "north",
        at: "2026-10-05 10:00",
        customer: 7,
        lines: [
          { name: "Consultation", amount: "80.00", staff: "Dr Alpha" },
          { name: "Hospitalisation (per day)", quantity: 3, unitPrice: "350.00", amount: "1000.00", staff: "Dr Bravo" },
          { name: "Return", itemType: 1, quantity: -1, unitPrice: "120.00", amount: "-120.00", staff: null },
        ],
      },
    ]);
    expect(rows[0]).toMatchObject({ SaleId: 810001, NetAmount: "960.00", CustomerId: 90007, SaleDate: `/Date(${Date.UTC(2026, 9, 5, 2, 0)})/` }); // 10:00 KL = 02:00 UTC
    const items = (overviews["810001"] as { Items: Record<string, unknown>[] }).Items;
    expect(items.map((item) => [item.Quantity, item.UnitPrice, item.Amount, item.DiscountAmount])).toEqual([
      ["1", "80.00", "80.00", "0.00"],
      ["3", "350.00", "1,000.00", "50.00"],
      ["(1)", "120.00", "(120.00)", "0.00"],
    ]);
    expect(() => syntheticSales([{ saleId: 1, branch: "north", at: "2026-10-05 10:00", customer: null, lines: [{ name: "x", quantity: 2, amount: "1.00", staff: null }] }])).toThrow(
      /needs a unitPrice/,
    );
  });
});
