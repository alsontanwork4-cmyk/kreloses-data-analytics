import type { ReactNode } from "react";

import type { GlobalFilter } from "@/filters";
import { cn } from "@/lib/utils";

import { CsvDownloadButton } from "./csv-download-button";
import { csvFileName, formatCell, toCsv, type TableColumn } from "./csv";

export type { CellValue, ColumnKind, TableColumn } from "./csv";

/** A column of a `<DataTable>`: a `TableColumn` (value + kind, exported to CSV) plus how to show it. */
export interface DataTableColumn<Row> extends TableColumn<Row> {
  /** A custom cell (e.g. a link). The CSV still exports `value`. Default: `value` formatted by `kind`. */
  cell?: (row: Row) => ReactNode;
  /** `secondary` columns are hidden on phones (below the `sm` breakpoint); the CSV always has them. */
  priority?: "primary" | "secondary";
}

/**
 * THE table for analytics data (spec story 55: "export any table to CSV"). Renders `rows` as an
 * accessible table (caption, column headers, numbers right-aligned in tabular figures, the first
 * column sticky when it scrolls sideways on a phone) with an "Export CSV" button whose file is
 * built from the same `columns` and `rows` (`toCsv`): money as plain decimals, named after the
 * page and the filter's dates (`csvFileName`).
 *
 * Server-renderable: pass `columns` with functions from a Server Component; only the CSV text
 * reaches the browser. Rows arrive computed by the Analytics Service — no maths here.
 *
 *   <DataTable caption="Doctor ranking" columns={columns} rows={ranking.doctors}
 *     rowKey={(row) => row.staffId} export={{ name: "doctors", filter }} />
 */
export function DataTable<Row>({
  caption,
  description,
  columns,
  rows,
  rowKey,
  export: exportAs,
  empty = "Nothing to show for this filter.",
  testId,
  rowClassName,
  headingLevel = 2,
}: {
  caption: string;
  /** The caption's heading level (2 on a page, 3 inside a Settings section). */
  headingLevel?: 2 | 3;
  description?: ReactNode;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row, index: number) => string;
  /** CSV file name parts; omit to hide the button. */
  export?: { name: string; filter: Pick<GlobalFilter, "dateFrom" | "dateTo"> };
  empty?: ReactNode;
  testId?: string;
  rowClassName?: (row: Row) => string | undefined;
}) {
  const numeric = (column: DataTableColumn<Row>) => column.kind !== "text";
  const hidden = (column: DataTableColumn<Row>) => (column.priority === "secondary" ? "hidden sm:table-cell" : undefined);
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <Heading className="text-base font-medium">{caption}</Heading>
          {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
        </div>
        {exportAs && rows.length > 0 ? (
          <CsvDownloadButton csv={toCsv(columns, rows)} fileName={csvFileName(exportAs.name, exportAs.filter)} />
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="border-b bg-muted/40">
                {columns.map((column, index) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      "px-3 py-2 text-xs font-medium whitespace-nowrap text-muted-foreground",
                      numeric(column) ? "text-right" : "text-left",
                      index === 0 && "sticky left-0 z-10 bg-muted",
                      hidden(column),
                    )}
                  >
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowKey(row, rowIndex)} data-testid="data-table-row" className={cn("border-b last:border-b-0", rowClassName?.(row))}>
                  {columns.map((column, index) => {
                    const content = column.cell ? column.cell(row) : formatCell(column.kind, column.value(row));
                    const className = cn(
                      "px-3 py-2",
                      numeric(column) ? "text-right tabular-nums" : "text-left",
                      // The sticky first column may wrap on a phone so the figures stay in view.
                      index === 0
                        ? "sticky left-0 z-10 max-w-36 min-w-28 bg-card break-words sm:max-w-none sm:whitespace-nowrap"
                        : "whitespace-nowrap",
                      hidden(column),
                    );
                    return index === 0 ? (
                      <th key={column.key} scope="row" data-column={column.key} className={cn(className, "font-medium")}>
                        {content}
                      </th>
                    ) : (
                      <td key={column.key} data-column={column.key} className={className}>
                        {content}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
