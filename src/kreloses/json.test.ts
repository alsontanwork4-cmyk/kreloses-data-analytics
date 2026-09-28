import { describe, expect, it } from "vitest";

import { describeJsonShape } from "./json";

/**
 * `describeJsonShape` goes into error reports and the live diagnostic, which the owner pastes into
 * a PUBLIC issue: it must show structure (keys and types) without ever printing a key that could be
 * data — a staff, customer or branch name used as a dictionary key.
 */
const NAMES = ["Ong", "Tan", "Lim", "Wong"];
const noNames = (shape: string) => {
  for (const name of NAMES) expect(shape, name).not.toContain(name);
};

describe("describeJsonShape", () => {
  it("shows a schema key by key: known Kreloses field names and compound identifiers", () => {
    expect(describeJsonShape({ SaleId: 1, Name: "x", Items: [], Notes: null, IsRequired: true })).toBe(
      "{SaleId: number, Name: string, Items: [], Notes: null, IsRequired: boolean}",
    );
    expect(describeJsonShape({ Items: [{ Name: "a", Quantity: "1", ItemType: 4 }] })).toBe("{Items: [{Name: string, Quantity: string, ItemType: number}] (1)}");
  });

  it("collapses a dictionary even when a null value sits deep inside one of its entries (null matches any shape)", () => {
    const shape = describeJsonShape({ Ong: { Phone: "1", Visits: 2 }, Tan: { Phone: null, Visits: 3 } });
    expect(shape).toBe("{<2 keys>: {Phone: string, Visits: number}}");
    noNames(shape);
    const deeper = describeJsonShape({ Ong: { Contact: { Phone: "1", Visits: 1 } }, Tan: { Contact: { Phone: null, Visits: 2 } }, Lim: { Contact: null } });
    expect(deeper).toBe("{<3 keys>: {<1 key>: {Phone: string, Visits: number}}}");
    noNames(deeper);
    const inArrays = describeJsonShape({ Ong: [{ Phone: "1" }], Tan: [], Wong: [{ Phone: null }] });
    expect(inArrays).toBe("{<3 keys>: [{Phone: string}] (1)}");
    noNames(inArrays);
  });

  it("collapses objects keyed by unknown single words even when their values differ in type", () => {
    const mixed = describeJsonShape({ Ong: "a", Tan: 2 });
    expect(mixed).toBe("{<2 keys>: string | number}");
    noNames(mixed);
    // One name among real field names is enough: the key never prints.
    const partly = describeJsonShape({ SaleId: 5, Ong: "a", Visits: true });
    expect(partly).toBe("{<3 keys>: number | string | boolean}");
    noNames(partly);
    const lower = describeJsonShape({ ong: 1, tan: "x" });
    expect(lower).toBe("{<2 keys>: number | string}");
  });

  it("shows a schema whose values all share one shape only when every key is made of known field words", () => {
    expect(describeJsonShape({ NetAmount: "1,200.00", TotalRefunds: "0.00", GrossAmount: "1,250.00" })).toBe(
      "{NetAmount: string, TotalRefunds: string, GrossAmount: string}",
    );
    expect(describeJsonShape({ From: "01/09/2026", To: "30/09/2026" })).toBe("{From: string, To: string}");
    // A compound key that is really a name (or has any unknown word) collapses the object.
    const named = describeJsonShape({ DrOng: 1, NetAmount: 2 });
    expect(named).toBe("{<2 keys>: number}");
    noNames(named);
    expect(describeJsonShape({ reportDefinition: { id: 1 } })).toBe("{<1 key>: {id: number}}");
  });

  it("still collapses what it did before: non-identifier keys, too many keys, uniform values", () => {
    expect(describeJsonShape({ "Dr Real Person": 5, "owner@clinic.example": 1 })).toBe("{<2 keys>: number}");
    expect(describeJsonShape(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Customer${i}`, { Visits: i }])))).toBe(
      "{<30 keys>: {Visits: number}}",
    );
    expect(describeJsonShape({ Ong: 1, Tan: null })).toBe("{<2 keys>: number}");
    expect(describeJsonShape({ Chua: null })).toBe("{<1 key>: null}");
    expect(describeJsonShape([])).toBe("[]");
    expect(describeJsonShape(null)).toBe("null");
  });
});
