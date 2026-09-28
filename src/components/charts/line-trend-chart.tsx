"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CartesianGrid, LabelList, Line, LineChart, XAxis, YAxis, type DotItemDotProps } from "recharts";

import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";

import { seriesColor } from "./series";

/** One x-axis position: a month (or any period). */
export interface TrendChartPeriod {
  key: string;
  /** Axis and tooltip label, e.g. "Sep 2026". */
  label: string;
  /** Partial figures (e.g. the current month so far): drawn as a hollow point, flagged in the tooltip. */
  partial: boolean;
}

/** One line: its values per period, for geometry, and exactly as people read them. */
export interface TrendChartSeries {
  id: string;
  label: string;
  /** Colour slot 1–8 (`stableSeriesSlots` over the FULL key set); null past the 8th: drawn in a neutral colour. */
  slot: number | null;
  /** Where clicking the line or one of its points goes (e.g. the doctor's detail page). */
  href?: string;
  /** Per period, same order as `periods`: a plain number for the line's geometry (e.g. `Number(revenue)`), null for a gap. */
  values: readonly (number | null)[];
  /** Per period: the exact value as shown, e.g. `formatRinggit(revenue)` or "—". */
  valueLabels: readonly string[];
}

const HEIGHT = 300;
const NEUTRAL = "var(--muted-foreground)";
const COMPACT = new Intl.NumberFormat("en-MY", { notation: "compact", maximumFractionDigits: 1 });
const DECIMAL = new Intl.NumberFormat("en-MY", { maximumFractionDigits: 2 });
const ROUND_STEPS = [0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];

/** Ticks 0, step, 2·step… up to the first multiple of a round step at or above `max`, at most 4 intervals. */
function roundTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const step = ROUND_STEPS.find((candidate) => max / candidate <= 4) ?? Math.ceil(max / 4);
  const intervals = Math.ceil(max / step - 1e-9);
  return Array.from({ length: intervals + 1 }, (_, index) => index * step);
}

/**
 * A line chart over time, one toggleable line per series (e.g. monthly revenue per doctor) — the
 * chart convention of README "Charts": Recharts through shadcn's `ChartContainer`, `--chart-N`
 * colours by stable slot, 2px lines, a recessive grid, a hover tooltip with the exact values, no
 * dual axes. It is a picture of a table the page also shows, so the figure carries an `aria-label`
 * summary. With several series, a legend of toggle buttons (usable on a phone) shows or hides each
 * line; each series links to its `href`, and clicking a line or point opens it. One series: slot 1,
 * no legend, the exact value at the line's end.
 */
export function LineTrendChart({
  title,
  valueName,
  periods,
  series,
  testId,
  axisFormat = "ringgit",
}: {
  /** What the chart shows, e.g. "Monthly revenue by doctor" (also the start of the accessible summary). */
  title: string;
  /** The measure's name in the tooltip, e.g. "Revenue". */
  valueName: string;
  periods: readonly TrendChartPeriod[];
  series: readonly TrendChartSeries[];
  testId?: string;
  /** The value axis's tick labels: `ringgit` (default) "RM 1.2K"; `decimal` plain numbers ("1.5"), e.g. items per invoice. */
  axisFormat?: "ringgit" | "decimal";
}) {
  const router = useRouter();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const single = series.length === 1;
  const key = (id: string) => `s${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const color = (item: TrendChartSeries) => (single ? seriesColor(1) : item.slot === null ? NEUTRAL : seriesColor(item.slot));
  const visible = series.filter((item) => !hidden.has(item.id));
  // A decimal axis (e.g. items per invoice) gets round ticks from 0 over EVERY series, so hiding a line never rescales it.
  const decimalTicks = axisFormat === "decimal" ? roundTicks(Math.max(0, ...series.flatMap((item) => item.values.filter((value) => value !== null)))) : undefined;

  const config = Object.fromEntries(series.map((item) => [key(item.id), { label: item.label, color: color(item) }])) satisfies ChartConfig;
  const data = periods.map((period, index) => ({
    index,
    label: period.label,
    ...Object.fromEntries(series.map((item) => [key(item.id), item.values[index] ?? null])),
  }));
  const summary = `${title}${periods.length > 0 ? `, ${periods[0]!.label} to ${periods.at(-1)!.label}` : ""}: ${series
    .map((item) => `${item.label}: ${periods.map((period, index) => `${period.label} ${item.valueLabels[index]}`).join(", ")}`)
    .join("; ")}`;
  const open = (item: TrendChartSeries) => {
    if (item.href) router.push(item.href);
  };
  const toggle = (id: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const lastWithValue = (item: TrendChartSeries) => {
    for (let index = item.values.length - 1; index >= 0; index -= 1) if (item.values[index] !== null) return index;
    return -1;
  };

  return (
    <figure className="flex min-w-0 flex-col gap-3" data-testid={testId}>
      <figcaption className="text-base font-medium">{title}</figcaption>
      {single ? null : (
        <div role="group" aria-label="Show or hide lines" className="flex flex-wrap items-center gap-1.5">
          {series.map((item) => {
            const shown = !hidden.has(item.id);
            return (
              <span key={item.id} className={cn("inline-flex items-center rounded-lg border", shown ? "bg-card" : "bg-muted/40")}>
                <button
                  type="button"
                  aria-pressed={shown}
                  onClick={() => toggle(item.id)}
                  className={cn(
                    "inline-flex min-h-9 items-center gap-2 rounded-l-lg px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    !shown && "text-muted-foreground line-through",
                    !item.href && "rounded-r-lg",
                  )}
                  title={shown ? `Hide ${item.label}` : `Show ${item.label}`}
                >
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-full border-2"
                    style={{ borderColor: color(item), background: shown ? color(item) : "transparent" }}
                  />
                  {item.label}
                </button>
                {item.href ? (
                  <Link
                    href={item.href}
                    aria-label={`Open ${item.label}`}
                    title={`Open ${item.label}`}
                    className="inline-flex size-9 items-center justify-center rounded-r-lg border-l text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <ArrowUpRight className="size-4" aria-hidden />
                  </Link>
                ) : null}
              </span>
            );
          })}
          {hidden.size > 0 ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setHidden(new Set())}>
              Show all
            </Button>
          ) : series.length > 2 ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setHidden(new Set(series.map((item) => item.id)))}>
              Hide all
            </Button>
          ) : null}
        </div>
      )}
      <div role="img" aria-label={summary}>
        <ChartContainer config={config} className="aspect-auto w-full" style={{ height: HEIGHT }}>
          <LineChart data={data} margin={{ top: 16, right: single ? 88 : 16, bottom: 4, left: 4 }} accessibilityLayer={false}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} tickMargin={8} padding={{ left: 16, right: 16 }} />
            <YAxis
              width={76}
              tickLine={false}
              axisLine={false}
              {...(decimalTicks ? { ticks: decimalTicks, domain: [0, decimalTicks.at(-1)!] } : { domain: [(min: number) => Math.min(0, min), "auto"] })}
              tickFormatter={(value: number) => (axisFormat === "decimal" ? DECIMAL.format(value) : `RM ${COMPACT.format(value)}`)}
            />
            <ChartTooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                const index = active ? (payload?.[0]?.payload as { index?: number } | undefined)?.index : undefined;
                if (index === undefined) return null;
                const period = periods[index]!;
                return (
                  <div className="grid min-w-40 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
                    <span className="font-medium">
                      {period.label}
                      {period.partial ? <span className="font-normal text-muted-foreground"> · partial</span> : null}
                    </span>
                    {visible.map((item) => (
                      <span key={item.id} className="flex items-center gap-2 text-muted-foreground">
                        <span className="size-2.5 shrink-0 rounded-[2px]" style={{ background: color(item) }} aria-hidden />
                        {single ? valueName : item.label}
                        <span className="ml-auto pl-3 font-mono font-medium text-foreground tabular-nums">{item.valueLabels[index]}</span>
                      </span>
                    ))}
                  </div>
                );
              }}
            />
            {visible.map((item) => (
              <Line
                key={item.id}
                type="linear"
                dataKey={key(item.id)}
                name={item.label}
                stroke={`var(--color-${key(item.id)})`}
                strokeWidth={2}
                isAnimationActive={false}
                connectNulls={false}
                className={item.href ? "cursor-pointer" : undefined}
                onClick={() => open(item)}
                dot={(props: DotItemDotProps) => <TrendDot key={`${item.id}:${props.index}`} {...props} item={item} partial={periods[props.index]?.partial ?? false} stroke={color(item)} onOpen={open} />}
                activeDot={{ r: 5, pointerEvents: "none" }}
              >
                {single ? (
                  <LabelList
                    dataKey={key(item.id)}
                    content={(props) => {
                      const index = Number(props.index);
                      if (index !== lastWithValue(item) || props.x === undefined || props.y === undefined) return null;
                      return (
                        <text x={Number(props.x) + 10} y={Number(props.y)} dy={4} className="fill-foreground" fontSize={12}>
                          {item.valueLabels[index]}
                        </text>
                      );
                    }}
                  />
                ) : null}
              </Line>
            ))}
          </LineChart>
        </ChartContainer>
      </div>
    </figure>
  );
}

/**
 * A point of a line: hollow for a partial period, with a larger invisible target so it is easy to
 * click (it opens the series' `href`).
 */
function TrendDot({
  cx,
  cy,
  index,
  item,
  partial,
  stroke,
  onOpen,
}: DotItemDotProps & { item: TrendChartSeries; partial: boolean; stroke: string; onOpen: (item: TrendChartSeries) => void }) {
  if (cx === undefined || cy === undefined || cx === null || cy === null || item.values[index] === null) return <g />;
  return (
    <g
      data-testid="trend-point"
      data-series={item.id}
      data-period={index}
      className={item.href ? "cursor-pointer" : undefined}
      onClick={() => onOpen(item)}
    >
      <circle cx={cx} cy={cy} r={12} fill="transparent" />
      <circle cx={cx} cy={cy} r={3.5} stroke={stroke} strokeWidth={2} fill={partial ? "var(--background)" : stroke} />
    </g>
  );
}
