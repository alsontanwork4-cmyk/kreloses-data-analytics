import { ChevronLeft, ChevronRight } from "lucide-react";
import Form from "next/form";
import Link from "next/link";

import { EARLIEST_DAILY_DAY } from "@/analytics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addDays, withSearchParams, type IsoDate } from "@/filters";

import { formatDayWithWeekday } from "./format";

/**
 * Chooses the Daily page's day (`?day=YYYY-MM-DD`; none = yesterday at the clinic). A plain GET
 * form (`next/form`: client-side navigation, works without JavaScript) plus previous / next day
 * links. `params` are the page's other search params (the global filter's branch and doctor, …),
 * carried along unchanged.
 */
export function DayPicker({ day, today, yesterday, params }: { day: IsoDate; today: IsoDate; yesterday: IsoDate; params: URLSearchParams }) {
  const hrefFor = (target: IsoDate | null) => {
    const next = new URLSearchParams(params);
    if (target === null) next.delete("day");
    else next.set("day", target);
    return withSearchParams("/daily", next);
  };
  const previous = addDays(day, -1);
  const next = addDays(day, 1);
  const hidden = [...params].filter(([key]) => key !== "day");

  return (
    <section aria-label="Day" className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Button asChild variant="outline" size="icon-lg">
          <Link href={hrefFor(previous)} scroll={false} aria-label={`Previous day, ${formatDayWithWeekday(previous)}`}>
            <ChevronLeft aria-hidden />
          </Link>
        </Button>
        <Form action="/daily" scroll={false} aria-label="Choose a day" className="flex items-end gap-2">
          {hidden.map(([key, value], index) => (
            <input key={`${key}:${index}`} type="hidden" name={key} value={value} />
          ))}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Day
            <Input key={day} type="date" name="day" required defaultValue={day} min={EARLIEST_DAILY_DAY} max={today} className="h-9 w-40" />
          </label>
          <Button type="submit" size="sm" className="h-9">
            Show
          </Button>
        </Form>
        {next <= today ? (
          <Button asChild variant="outline" size="icon-lg">
            <Link href={hrefFor(next)} scroll={false} aria-label={`Next day, ${formatDayWithWeekday(next)}`}>
              <ChevronRight aria-hidden />
            </Link>
          </Button>
        ) : null}
        {day !== yesterday ? (
          <Button asChild variant="ghost" size="sm" className="h-9">
            <Link href={hrefFor(null)} scroll={false}>
              Yesterday
            </Link>
          </Button>
        ) : null}
      </div>
      <p data-testid="daily-range-note" className="text-xs text-muted-foreground">
        This page shows one day at a time, so the date range in the filter bar does not apply here; its branch and doctor
        choices do.
      </p>
    </section>
  );
}
