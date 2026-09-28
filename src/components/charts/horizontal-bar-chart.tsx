"use client";

import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";

import { seriesColor } from "./series";

/** One bar: `value` sets its length only; `valueLabel` (exact, pre-formatted) is what people read. */
export interface BarDatum {
  id: string;
  label: string;
  /** A plain number for the bar's length (e.g. `Number(revenue)`); never shown. */
  value: number;
  /** The exact value as shown, e.g. `formatRinggit(revenue)`. */
  valueLabel: string;
}

const ROW_HEIGHT = 36;
const MAX_LABEL = 20;

/**
 * A ranked, single-series horizontal bar chart (e.g. revenue by doctor) — the chart convention for
 * every page (README "Charts"): Recharts through shadcn's `ChartContainer`, colours from the
 * `--chart-N` tokens (`seriesColor`; theme-aware), bars ≤ 24px with a rounded data end, the exact
 * value at each bar's tip, a hover tooltip, recessive grid, no legend for one series. It is a
 * picture of a table the page also shows (the accessible, exportable view), so the figure carries
 * an `aria-label` summary and the numbers stay in the table. Height grows with the rows, width with
 * the container, so it fits a phone.
 */
export function HorizontalBarChart({
  data,
  title,
  valueName,
  slot = 1,
  testId,
}: {
  data: readonly BarDatum[];
  /** What the chart shows, e.g. "Revenue by doctor" (also the accessible name). */
  title: string;
  /** The measure's name in the tooltip, e.g. "Revenue". */
  valueName: string;
  /** Categorical slot 1–8 (single series: 1). */
  slot?: number;
  testId?: string;
}) {
  const config = { value: { label: valueName, color: seriesColor(slot) } } satisfies ChartConfig;
  const summary = `${title}: ${data.map((datum) => `${datum.label} ${datum.valueLabel}`).join("; ")}`;
  return (
    <figure className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <figcaption className="text-base font-medium">{title}</figcaption>
      <div role="img" aria-label={summary}>
        <ChartContainer config={config} className="aspect-auto w-full" style={{ height: data.length * ROW_HEIGHT + 16 }}>
          <BarChart data={[...data]} layout="vertical" margin={{ top: 4, right: 96, bottom: 4, left: 4 }} barCategoryGap={8} accessibilityLayer={false}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" hide domain={[(min: number) => Math.min(0, min), "auto"]} />
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
                const datum = active ? (payload?.[0]?.payload as BarDatum | undefined) : undefined;
                if (!datum) return null;
                return (
                  <div className="grid min-w-32 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
                    <span className="font-medium">{datum.label}</span>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: seriesColor(slot) }} aria-hidden />
                      {valueName}
                      <span className="ml-auto font-mono font-medium text-foreground tabular-nums">{datum.valueLabel}</span>
                    </span>
                  </div>
                );
              }}
            />
            <Bar dataKey="value" fill="var(--color-value)" radius={[0, 4, 4, 0]} maxBarSize={24} isAnimationActive={false}>
              <LabelList dataKey="valueLabel" position="right" className="fill-foreground" fontSize={12} />
            </Bar>
          </BarChart>
        </ChartContainer>
      </div>
    </figure>
  );
}
