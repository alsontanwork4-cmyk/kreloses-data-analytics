import {
  addDays,
  clinicToday,
  endOfMonth,
  startOfMonth,
  startOfWeek,
  startOfYear,
  type IsoDate,
} from "./dates";

export const DATE_PRESETS = [
  "today",
  "this-week",
  "month-to-date",
  "last-month",
  "year-to-date",
] as const;

/** A named, relative date range. Stored in the URL by name so bookmarks stay relative. */
export type DatePreset = (typeof DATE_PRESETS)[number];

/** Every option in the date picker: a preset or an explicit custom range. */
export type DateRangeKey = DatePreset | "custom";

export const DEFAULT_DATE_PRESET: DatePreset = "month-to-date";

export const DATE_RANGE_LABELS: Record<DateRangeKey, string> = {
  today: "Today",
  "this-week": "This week",
  "month-to-date": "Month to date",
  "last-month": "Last month",
  "year-to-date": "Year to date",
  custom: "Custom",
};

export function isDatePreset(value: unknown): value is DatePreset {
  return typeof value === "string" && (DATE_PRESETS as readonly string[]).includes(value);
}

/**
 * The inclusive clinic-local date range a preset covers at `now`. Weeks start on Monday; every
 * range ends today except "last month", which is the whole previous calendar month.
 */
export function resolveDatePreset(
  preset: DatePreset,
  now: Date = new Date(),
): { dateFrom: IsoDate; dateTo: IsoDate } {
  const today = clinicToday(now);
  switch (preset) {
    case "today":
      return { dateFrom: today, dateTo: today };
    case "this-week":
      return { dateFrom: startOfWeek(today), dateTo: today };
    case "month-to-date":
      return { dateFrom: startOfMonth(today), dateTo: today };
    case "last-month": {
      const lastDayOfLastMonth = addDays(startOfMonth(today), -1);
      return { dateFrom: startOfMonth(lastDayOfLastMonth), dateTo: endOfMonth(lastDayOfLastMonth) };
    }
    case "year-to-date":
      return { dateFrom: startOfYear(today), dateTo: today };
  }
}
