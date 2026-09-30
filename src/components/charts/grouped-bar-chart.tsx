"use client";

import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";

/** One series (a bar in every group): a stable key, its label and its colour (`seriesColor(slot)`). */
export interface GroupedSeries {
  key: string;
  label: string;
  color: string;
}

/** One group (a row, e.g. a doctor): a number per series key for geometry, the exact values people read. */
export interface GroupedRow {
  id: string;
  label: string;
  /** Plain numbers for the bars' lengths (e.g. a percentage); never shown. */
  values: Record<string, number>;
  /** The exact value per series as shown, e.g. "28.6%". */
  valueLabels: Record<string, string>;
}

const BAR = 12;
const GAP = 2;
const GROUP_PADDING = 20;
const MAX_LABEL = 20;

/**
 * A horizontal grouped bar chart: per row (e.g. a doctor) one bar per series (e.g. attach rates for
 * diagnostics, products and a second service), following the chart convention (README "Charts"):
 * series colours by a STABLE key in fixed order (never by rank), thin bars with a 4px rounded data
 * end and a 2px gap between the bars of a group, the exact value at each bar's tip, a hover tooltip
 * listing the row's values, an HTML legend (always present for two or more series) and a recessive
 * grid. `domain` fixes the value axis (e.g. `[0, 100]` for percentages, so rows compare at a
 * glance). It is a picture of a table the page also shows, so the figure has an `aria-label` summary.
 */
export function GroupedBarChart({
  rows,
  series,
  title,
  domain,
  testId,
}: {
  rows: readonly GroupedRow[];
  series: readonly GroupedSeries[];
  /** What the chart shows, e.g. "Attach rates on consult invoices" (also the accessible name). */
  title: string;
  /** The value axis's range; default from zero to the largest value. */
  domain?: [number, number];
  testId?: string;
}) {
  const config = Object.fromEntries(series.map((item) => [item.key, { label: item.label, color: item.color }])) satisfies ChartConfig;
  const data = rows.map((row) => ({ id: row.id, label: row.label, ...row.values }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const rowHeight = series.length * BAR + (series.length - 1) * GAP + GROUP_PADDING;
  const summary = `${title}: ${rows.map((row) => `${row.label}: ${series.map((item) => `${item.label} ${row.valueLabels[item.key]}`).join(", ")}`).join("; ")}`;
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
        <ChartContainer config={config} className="aspect-auto w-full" style={{ height: rows.length * rowHeight + 16 }}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, bottom: 4, left: 4 }} barGap={GAP} barCategoryGap={GROUP_PADDING / 2} accessibilityLayer={false}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" hide domain={domain ?? [0, "auto"]} />
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
                    <span className="font-medium">{row.label}</span>
                    {series.map((item) => (
                      <span key={item.key} className="flex items-center gap-2 text-muted-foreground">
                        <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} aria-hidden />
                        {item.label}
                        <span className="ml-auto pl-3 font-mono font-medium text-foreground tabular-nums">{row.valueLabels[item.key]}</span>
                      </span>
                    ))}
                  </div>
                );
              }}
            />
            {series.map((item) => (
              // minPointSize: Recharts drops a zero-value bar AND its label; a 2px stub keeps "0.0%" visible.
              <Bar key={item.key} dataKey={item.key} fill={`var(--color-${item.key})`} radius={[0, 4, 4, 0]} barSize={BAR} minPointSize={2} isAnimationActive={false}>
                <LabelList
                  position="right"
                  className="fill-foreground"
                  fontSize={11}
                  valueAccessor={(entry) => {
                    const id = (entry.payload as { id?: string } | undefined)?.id;
                    return id ? (byId.get(id)?.valueLabels[item.key] ?? "") : "";
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
