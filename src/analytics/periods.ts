import { addDays, addYears, daysBetween, type GlobalFilter, type IsoDate } from "@/filters";

/** An inclusive range of clinic days. */
export interface DateRange {
  dateFrom: IsoDate;
  dateTo: IsoDate;
}

/**
 * The two comparison periods every KPI is shown against (spec story 28):
 *
 * - **Previous period**: the same number of days, ending the day before the period starts
 *   (1–30 Sep → 2–31 Aug; month to date on 28 Sep → 4–31 Aug).
 * - **Same period last year**: the same calendar dates one year earlier (29 Feb → 28 Feb).
 */
export function comparisonPeriods(period: Pick<GlobalFilter, "dateFrom" | "dateTo">): {
  previousPeriod: DateRange;
  lastYear: DateRange;
} {
  const length = daysBetween(period.dateFrom, period.dateTo) + 1;
  return {
    previousPeriod: { dateFrom: addDays(period.dateFrom, -length), dateTo: addDays(period.dateFrom, -1) },
    lastYear: { dateFrom: addYears(period.dateFrom, -1), dateTo: addYears(period.dateTo, -1) },
  };
}
