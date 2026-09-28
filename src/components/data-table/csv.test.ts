import { describe, expect, it } from "vitest";

import { csvFileName, formatCell, toCsv, withByteOrderMark, type TableColumn } from "./csv";

/** The CSV a table exports (spec story 55): the same rows and columns the table shows, for Excel. */
interface Row {
  name: string;
  revenue: string;
  invoices: number;
  items: number | null;
  share: number | null;
}

const COLUMNS: TableColumn<Row>[] = [
  { key: "name", header: "Doctor", kind: "text", value: (row) => row.name },
  { key: "revenue", header: "Revenue", kind: "money", value: (row) => row.revenue },
  { key: "invoices", header: "Invoices", kind: "count", value: (row) => row.invoices },
  { key: "items", header: "Items per invoice", kind: "decimal", value: (row) => row.items },
  { key: "share", header: "Share of revenue", kind: "percent", value: (row) => row.share },
];

describe("toCsv", () => {
  it("writes a header and one line per row: money as plain decimals, units in the header, CRLF, UTF-8 BOM", () => {
    const csv = toCsv(COLUMNS, [
      { name: "Dr Bravo Brown", revenue: "3351.72", invoices: 1234, items: 1.5, share: 57.2 },
      { name: "Dr Delta", revenue: "-120.00", invoices: 2, items: null, share: null },
    ]);
    expect(csv).toBe(
      "﻿Doctor,Revenue (RM),Invoices,Items per invoice,Share of revenue (%)\r\n" +
        "Dr Bravo Brown,3351.72,1234,1.50,57.2\r\n" +
        "Dr Delta,-120.00,2,,\r\n",
    );
  });

  it("quotes cells with commas, quotes, line breaks or edge spaces, and defuses spreadsheet formulas in text", () => {
    const csv = toCsv(COLUMNS.slice(0, 1), [
      { name: 'Dr "Ace", Jr', revenue: "0.00", invoices: 0, items: null, share: null },
      { name: "Line\nbreak", revenue: "0.00", invoices: 0, items: null, share: null },
      { name: " padded ", revenue: "0.00", invoices: 0, items: null, share: null },
      { name: "=HYPERLINK(\"x\")", revenue: "0.00", invoices: 0, items: null, share: null },
      { name: "+1", revenue: "0.00", invoices: 0, items: null, share: null },
      { name: "@SUM", revenue: "0.00", invoices: 0, items: null, share: null },
    ]);
    expect(csv.split("\r\n").slice(1, -1)).toEqual([
      '"Dr ""Ace"", Jr"',
      '"Line\nbreak"',
      '" padded "',
      "\"'=HYPERLINK(\"\"x\"\")\"",
      "'+1",
      "'@SUM",
    ]);
  });

  it("refuses a money value that is not an exact decimal (never a float)", () => {
    expect(() => toCsv(COLUMNS, [{ name: "x", revenue: "1,200.00", invoices: 0, items: null, share: null }])).toThrow(TypeError);
  });
});

describe("formatCell (what the table shows)", () => {
  it("formats by kind for display", () => {
    expect(formatCell("money", "3351.72")).toBe("RM 3,351.72");
    expect(formatCell("money", "-120.00")).toBe("−RM 120.00");
    expect(formatCell("count", 1234)).toBe("1,234");
    expect(formatCell("decimal", 1.5)).toBe("1.50");
    expect(formatCell("percent", 57.2)).toBe("57.2%");
    expect(formatCell("percent", 0)).toBe("0.0%");
    expect(formatCell("text", "Dr Alpha")).toBe("Dr Alpha");
    expect(formatCell("money", null)).toBe("—");
  });
});

describe("csvFileName", () => {
  it("names the file after the page and the date range", () => {
    expect(csvFileName("doctors", { dateFrom: "2026-09-01", dateTo: "2026-09-30" })).toBe("doctors_2026-09-01_to_2026-09-30.csv");
    expect(csvFileName("Doctors by branch!", { dateFrom: "2026-09-01", dateTo: "2026-09-01" })).toBe("doctors-by-branch_2026-09-01.csv");
  });
});

describe("withByteOrderMark", () => {
  // React's RSC transport drops the leading byte-order mark of a long string prop (it arrives as a
  // text chunk decoded on its own), so the download button puts it back: without it, Excel
  // misreads non-ASCII names.
  it("gives the saved file exactly one UTF-8 byte-order mark", () => {
    const csv = toCsv(COLUMNS, [{ name: "Dr Bravo Brown", revenue: "3351.72", invoices: 1234, items: 1.5, share: 57.2 }]);
    expect(withByteOrderMark(csv)).toBe(csv);
    expect(withByteOrderMark(csv.slice(1))).toBe(csv);
    expect(withByteOrderMark("")).toBe("﻿");
  });
});
