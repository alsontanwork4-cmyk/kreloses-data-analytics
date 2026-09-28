import type { GlobalFilter } from "@/filters";
import { formatCount } from "@/lib/format";
import { formatRinggit, moneyToSen, senToMoney, type Money } from "@/lib/money";

/**
 * Columns, display formatting and CSV for `<DataTable>` (./data-table.tsx). Safe on server and
 * client; no React. A table and its CSV are built from the SAME columns and rows, so the export
 * always has exactly the numbers on screen (spec story 55).
 */

/**
 * How a column's values are shown and exported:
 * - `text`    as is (CSV: formula-like text is defused with a leading `'`);
 * - `money`   an exact `Money` string ("1234.50"): shown "RM 1,234.50", exported "1234.50" (header "(RM)");
 * - `count`   an integer: shown "1,234", exported "1234";
 * - `decimal` a number to 2 places: "1.50";
 * - `percent` a percentage already rounded by the Analytics Service: shown "57.2%", exported "57.2" (header "(%)").
 * `null` is shown "—" and exported as an empty cell.
 */
export type ColumnKind = "text" | "money" | "count" | "decimal" | "percent";

export type CellValue = string | number | null;

export interface TableColumn<Row> {
  key: string;
  header: string;
  kind: ColumnKind;
  /** The cell's value (exported to CSV, and shown formatted by `kind` unless `cell` is given). */
  value: (row: Row) => CellValue;
}

/** A cell for display. */
export function formatCell(kind: ColumnKind, value: CellValue): string {
  if (value === null) return "—";
  switch (kind) {
    case "money":
      return formatRinggit(String(value));
    case "count":
      return formatCount(Number(value));
    case "decimal":
      return Number(value).toFixed(2);
    case "percent":
      return `${Number(value).toFixed(1)}%`;
    case "text":
      return String(value);
  }
}

/** A cell for CSV (before quoting): plain decimals, no thousand separators or currency. */
function csvValue(kind: ColumnKind, value: CellValue): string {
  if (value === null) return "";
  switch (kind) {
    case "money":
      // Exact: re-written from integer sen, never through a float (throws on anything else).
      return senToMoney(moneyToSen(String(value) as Money));
    case "count":
      return String(Math.trunc(Number(value)));
    case "decimal":
      return Number(value).toFixed(2);
    case "percent":
      return Number(value).toFixed(1);
    case "text": {
      const text = String(value);
      // Excel runs a cell starting with = + - @ (or a tab/CR) as a formula.
      return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    }
  }
}

const UNIT: Partial<Record<ColumnKind, string>> = { money: " (RM)", percent: " (%)" };

function quote(cell: string): string {
  return /[",\r\n]|^\s|\s$/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * RFC 4180 CSV of `rows`: a header line (money and percent columns say their unit), then one line
 * per row, CRLF line ends, and a UTF-8 byte-order mark so Excel reads names correctly.
 */
export function toCsv<Row>(columns: readonly TableColumn<Row>[], rows: readonly Row[]): string {
  const lines = [
    columns.map((column) => quote(`${column.header}${UNIT[column.kind] ?? ""}`)),
    ...rows.map((row) => columns.map((column) => quote(csvValue(column.kind, column.value(row))))),
  ];
  return `﻿${lines.map((line) => line.join(",")).join("\r\n")}\r\n`;
}

/** `doctors_2026-09-01_to_2026-09-30.csv`: the page (or table) name and the filter's date range. */
export function csvFileName(name: string, filter: Pick<GlobalFilter, "dateFrom" | "dateTo">): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "export";
  const range = filter.dateFrom === filter.dateTo ? filter.dateFrom : `${filter.dateFrom}_to_${filter.dateTo}`;
  return `${slug}_${range}.csv`;
}
