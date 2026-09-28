/**
 * Calendar-date maths in the clinic's time zone. Dates are plain `'YYYY-MM-DD'` strings
 * (`IsoDate`) meaning a clinic-local calendar day — never JS Dates, which carry a time zone.
 */
export const CLINIC_TIME_ZONE = "Asia/Kuala_Lumpur";

/** A clinic-local calendar date, `'YYYY-MM-DD'`. */
export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const clinicDateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: CLINIC_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date at the clinic. */
export function clinicToday(now: Date = new Date()): IsoDate {
  const parts = Object.fromEntries(
    clinicDateFormat.formatToParts(now).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** True for a real calendar date written as `'YYYY-MM-DD'` (rejects e.g. `2026-02-30`). */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = utcDate(y, m - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Midnight UTC of year / month (0-based) / day; out-of-range months and days roll over like
 * `Date.UTC`. Unlike `Date.UTC`, years 0–99 stay themselves (`Date.UTC(99, …)` is 1999).
 */
function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return date;
}

function toUtc(date: IsoDate): Date {
  if (!isIsoDate(date)) throw new RangeError(`Not an ISO date: ${date}`);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return utcDate(y, m - 1, d);
}

function fromUtc(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const utc = toUtc(date);
  utc.setUTCDate(utc.getUTCDate() + days);
  return fromUtc(utc);
}

/** The same calendar date `years` later (negative: earlier); 29 February becomes the 28th in a non-leap year. */
export function addYears(date: IsoDate, years: number): IsoDate {
  const utc = toUtc(date);
  const year = utc.getUTCFullYear() + years;
  const lastDay = utcDate(year, utc.getUTCMonth() + 1, 0).getUTCDate();
  return fromUtc(utcDate(year, utc.getUTCMonth(), Math.min(utc.getUTCDate(), lastDay)));
}

/** Whole days from `from` to `to` (0 for the same date; negative if `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

/** Monday of the date's week (the clinic's weeks run Monday to Sunday). */
export function startOfWeek(date: IsoDate): IsoDate {
  const dayOfWeek = toUtc(date).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dayOfWeek + 6) % 7));
}

export function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: IsoDate): IsoDate {
  const utc = toUtc(startOfMonth(date));
  return fromUtc(utcDate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, 0));
}

export function startOfYear(date: IsoDate): IsoDate {
  return `${date.slice(0, 4)}-01-01`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `'2026-09-28'` → `'28 Sep 2026'`. Deterministic (no locale data), so safe to render on server and client. */
export function formatIsoDate(date: IsoDate): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** `'2026-09-27'` → `'Sunday 27 Sep 2026'` (`short`: `'Sun 27 Sep 2026'`). Deterministic, no locale data. */
export function formatDayWithWeekday(day: IsoDate, style: "long" | "short" = "long"): string {
  if (!isIsoDate(day)) return day;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d); // not Date.UTC: it reads years 0–99 as 19xx
  const weekday = WEEKDAYS[date.getUTCDay()]!;
  return `${style === "short" ? weekday.slice(0, 3) : weekday} ${formatIsoDate(day)}`;
}

/** `'1 Sep 2026 – 28 Sep 2026'`, or a single date when both ends match. */
export function formatDateRange(dateFrom: IsoDate, dateTo: IsoDate): string {
  return dateFrom === dateTo
    ? formatIsoDate(dateFrom)
    : `${formatIsoDate(dateFrom)} – ${formatIsoDate(dateTo)}`;
}

const clinicTimeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: CLINIC_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** An instant (e.g. a `timestamptz`) as clinic-local `'28 Sep 2026, 09:05'` (24-hour). */
export function formatClinicDateTime(instant: Date): string {
  const parts = Object.fromEntries(
    clinicTimeFormat.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return `${formatIsoDate(clinicToday(instant))}, ${parts.hour}:${parts.minute}`;
}
