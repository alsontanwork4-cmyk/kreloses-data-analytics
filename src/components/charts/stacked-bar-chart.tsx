"use client";

import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";

/** One series (a stack segment): a stable key, its label and its colour (`seriesColor(slot)`, or a neutral for "Other"-like buckets). */
export interface StackedSeries {
  key: string;
  label: string;
  color: string;
}

/** One bar: a number per series key for geometry, the exact formatted values people read. */
export interface StackedRow {
  id: string;
  label: string;
  /** Plain numbers for the segments' lengths (e.g. `Number(revenue)`); never shown. */
  values: Record<string, number>;
  /** The exact value per series as shown, e.g. `formatRinggit(revenue)`. */
  valueLabels: Record<string, string>;
  /** The bar's total as shown at its tip. */
  totalLabel: string;
}

const ROW_HEIGHT = 40;
const MAX_LABEL = 20;

/**
 * A horizontal stacked bar chart (part-to-whole per row, e.g. revenue by service group per
 * doctor), following the chart convention (README "Charts"): series colours by a STABLE key in
 * fixed order (never by rank), a 2px surface gap between segments, negative values stacked left of
 * zero, the exact total at each bar's tip, a hover tooltip listing every segment, and an HTML
 * legend (always present for two or more series). It is a picture of a table the page also shows,
 * so the figure has an `aria-label` summary.
 */
export function StackedBarChart({
  rows,
  series,
  title,
  testId,
}: {
  rows: readonly StackedRow[];
  series: readonly StackedSeries[];
  /** What the chart shows, e.g. "Revenue by service group" (also the accessible name). */
  title: string;
  testId?: string;
}) {
  const config = Object.fromEntries(series.map((item) => [item.key, { label: item.label, color: item.color }])) satisfies ChartConfig;
  const data = rows.map((row) => ({ id: row.id, label: row.label, totalLabel: row.totalLabel, ...row.values }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  // The total sits at the tip: after the row's last positive segment (else its last segment).
  const tipKey = new Map(
    rows.map((row) => [
      row.id,
      series.findLast((item) => (row.values[item.key] ?? 0) > 0)?.key ?? series.findLast((item) => row.values[item.key])?.key ?? series.at(-1)?.key,
    ]),
  );
  const summary = `${title}: ${rows
    .map((row) => `${row.label} ${row.totalLabel} (${series.filter((item) => row.values[item.key]).map((item) => `${item.label} ${row.valueLabels[item.key]}`).join(", ")})`)
    .join("; ")}`;
  return (
    <figure className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <figcaption className="text-base font-medium">{title}</figcaption>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        {series.map((item) => (
          <li key={item.key} className="flex items-center gap-1.5">
            <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} aria-hidden />
            {item.label}
          </li>
        ))}
      </ul>
      <div role="img" aria-label={summary}>
        <ChartContainer config={config} className="aspect-auto w-full" style={{ height: rows.length * ROW_HEIGHT + 16 }}>
          <BarChart data={data} layout="vertical" stackOffset="sign" margin={{ top: 4, right: 96, bottom: 4, left: 4 }} barCategoryGap={8} accessibilityLayer={false}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="label"
              width={128}
              tickLine={false}
              axisLine={false}
              tickFormatter={(label: string) => (label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label)}
            />
            <ChartTooltip
              cursor={false}
              content={({ active, payload }) => {
                const id = active ? (payload?.[0]?.payload as { id?: string } | undefined)?.id : undefined;
                const row = id ? byId.get(id) : undefined;
                if (!row) return null;
                return (
                  <div className="grid min-w-44 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
                    <span className="flex justify-between gap-3 font-medium">
                      {row.label}
                      <span className="font-mono tabular-nums">{row.totalLabel}</span>
                    </span>
                    {series
                      .filter((item) => row.values[item.key])
                      .map((item) => (
                        <span key={item.key} className="flex items-center gap-2 text-muted-foreground">
                          <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} aria-hidden />
                          {item.label}
                          <span className="ml-auto font-mono font-medium text-foreground tabular-nums">{row.valueLabels[item.key]}</span>
                        </span>
                      ))}
                  </div>
                );
              }}
            />
            {series.map((item) => (
              <Bar
                key={item.key}
                dataKey={item.key}
                stackId="total"
                fill={`var(--color-${item.key})`}
                stroke="var(--card)"
                strokeWidth={2}
                maxBarSize={24}
                isAnimationActive={false}
              >
                <LabelList
                  position="right"
                  className="fill-foreground"
                  fontSize={12}
                  valueAccessor={(entry) => {
                    const id = (entry.payload as { id?: string } | undefined)?.id;
                    return id && tipKey.get(id) === item.key ? byId.get(id)?.totalLabel : "";
                  }}
                />
              </Bar>
            ))}
          </BarChart>
        </ChartContainer>
      </div>
    </figure>
  );
}
