import { CLINIC_TIME_ZONE, clinicToday, isIsoDate, type IsoDate } from "../filters/dates";

/**
 * Kreloses dates → an instant plus the clinic-local calendar date (Asia/Kuala_Lumpur).
 *
 * Accepted, because the exact format of the Sale List's `SaleDate` is not recorded yet (the live
 * smoke test prints its pattern — verify there):
 *
 * - ASP.NET's `/Date(1788193800000)/` (optionally `+0800`): milliseconds since the epoch, UTC. The
 *   offset suffix only says which zone the server displayed it in, so it is ignored.
 * - ISO 8601 with `Z` or an offset: that instant.
 * - ISO 8601 without a zone, `dd/MM/yyyy [hh:mm[:ss] [AM|PM]]`, `d MMM yyyy [hh:mm]`,
 *   `dd-MMM-yyyy [hh:mm]`: a wall-clock time AT THE CLINIC (a date alone is midnight there).
 *   Slashed dates are read day-first (Malaysian convention).
 */
export interface ClinicInstant {
  instant: Date;
  clinicDate: IsoDate;
}

const ASPNET_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const TIME = String.raw`(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp][Mm]))?)?`;
const DAY_FIRST = new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})${TIME}$`);
const MONTH_NAME = new RegExp(String.raw`^(\d{1,2})[ -]([A-Za-z]{3,9})[ ,-]+(\d{4})${TIME}$`);
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** 1-12 for "Sep", "Sept" or "September" (any case); 0 otherwise. */
function monthNumber(name: string): number {
  const lower = name.toLowerCase();
  return MONTHS.findIndex((month) => month.startsWith(lower)) + 1;
}

export function parseClinicInstant(value: unknown): ClinicInstant | null {
  if (typeof value !== "string") return null;
  const text = value.trim();

  const aspnet = ASPNET_DATE.exec(text);
  if (aspnet) return fromInstant(new Date(Number(aspnet[1])));

  const iso = ISO.exec(text);
  if (iso) {
    const [, y, mo, d, h = "0", mi = "0", s = "0", zone] = iso;
    if (zone) {
      if (!validDate(Number(y), Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
      const offset = zone.toUpperCase() === "Z" ? "Z" : zone.includes(":") ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
      return fromInstant(new Date(`${y}-${mo}-${d}T${h.padStart(2, "0")}:${mi.padStart(2, "0")}:${s.padStart(2, "0")}${offset}`));
    }
    return wallTime(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s));
  }

  const dayFirst = DAY_FIRST.exec(text);
  if (dayFirst) {
    const [, d, mo, y, h, mi, s, meridiem] = dayFirst;
    return wallTime(Number(y), Number(mo), Number(d), ...clock(h, mi, s, meridiem));
  }

  const named = MONTH_NAME.exec(text);
  if (named) {
    const [, d, monthName, y, h, mi, s, meridiem] = named;
    const month = monthNumber(monthName!);
    if (month === 0) return null;
    return wallTime(Number(y), month, Number(d), ...clock(h, mi, s, meridiem));
  }
  return null;
}

/** The clinic-local date of an instant, and the instant. */
function fromInstant(instant: Date): ClinicInstant | null {
  return Number.isNaN(instant.getTime()) ? null : { instant, clinicDate: clinicToday(instant) };
}

/** Hours/minutes/seconds from a matched time (24-hour, or 12-hour with AM/PM); NaN hour if invalid. */
function clock(h?: string, mi?: string, s?: string, meridiem?: string): [number, number, number] {
  let hour = h === undefined ? 0 : Number(h);
  if (meridiem) {
    if (hour < 1 || hour > 12) return [NaN, 0, 0];
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  return [hour, mi === undefined ? 0 : Number(mi), s === undefined ? 0 : Number(s)];
}

function validDate(y: number, mo: number, d: number): boolean {
  return isIsoDate(`${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
}

/** A wall-clock time at the clinic → the instant. Null for an impossible date or time. */
function wallTime(y: number, mo: number, d: number, h: number, mi: number, s: number): ClinicInstant | null {
  if (!validDate(y, mo, d) || !(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59) || !(s >= 0 && s <= 59)) return null;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // The clinic's UTC offset at (about) that time; Asia/Kuala_Lumpur has been a fixed UTC+8 since 1982.
  const instant = new Date(asUtc - clinicOffsetMs(asUtc));
  return { instant, clinicDate: clinicToday(instant) };
}

const offsetFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: CLINIC_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function clinicOffsetMs(at: number): number {
  const parts = Object.fromEntries(offsetFormat.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return local - Math.floor(at / 1000) * 1000;
}

/** How a filter template writes dates, detected from an example value it already holds. */
export type TemplateDateFormat =
  | { kind: "iso"; withTime: boolean }
  | { kind: "day-first" }
  | { kind: "month-first" }
  | { kind: "aspnet" };

/**
 * Detects the date format of a filter template from its example values (e.g. the Sale List's
 * default `From`/`To`). `dd/MM/yyyy` vs `MM/dd/yyyy` is settled by any component above 12, and
 * otherwise assumed day-first (Malaysian convention). No usable example → ISO `yyyy-MM-dd`, which
 * .NET parses the same way in every culture.
 */
export function detectTemplateDateFormat(examples: unknown[]): TemplateDateFormat {
  const strings = examples.filter((example): example is string => typeof example === "string" && example.trim() !== "");
  for (const example of strings) {
    if (ASPNET_DATE.test(example.trim())) return { kind: "aspnet" };
    const iso = ISO.exec(example.trim());
    if (iso) return { kind: "iso", withTime: iso[4] !== undefined };
  }
  const slashed = strings.map((example) => /^(\d{1,2})\/(\d{1,2})\/\d{4}/.exec(example.trim())).filter((match) => match !== null);
  if (slashed.length > 0) {
    if (slashed.some((match) => Number(match[2]) > 12)) return { kind: "month-first" };
    return { kind: "day-first" };
  }
  return { kind: "iso", withTime: false };
}

/** A clinic date written for a template: the start of the day, or (for `to`) its last second. */
export function writeTemplateDate(date: IsoDate, format: TemplateDateFormat, end: boolean): string {
  const [y, m, d] = date.split("-") as [string, string, string];
  switch (format.kind) {
    case "iso":
      return format.withTime ? `${date}T${end ? "23:59:59" : "00:00:00"}` : date;
    case "day-first":
      return `${d}/${m}/${y}`;
    case "month-first":
      return `${m}/${d}/${y}`;
    case "aspnet": {
      const start = wallTime(Number(y), Number(m), Number(d), end ? 23 : 0, end ? 59 : 0, end ? 59 : 0)!;
      return `/Date(${start.instant.getTime()})/`;
    }
  }
}
