import { addDays, clinicToday, type IsoDate } from "@/filters";

/**
 * The history backfill's politeness settings (#8, spec story 11: "spread over several nights at a
 * gentle request rate, so Kreloses isn't strained and my account isn't flagged"). Pure; safe to
 * import anywhere.
 *
 * The maths behind the defaults (README "History backfill"):
 * - Kreloses holds about 35,000 invoices since 1 Jan 2024 for the two branch logins, so about
 *   17,500 invoice pages per login, plus one Sale List page per 500 invoices.
 * - A chunk runs every 15 minutes during the night window (00:00–06:00 in Kuala Lumpur: 24 chunks a
 *   night), each connection for at most `BACKFILL_CHUNK_BUDGET_MS` (240 s), with a pause of
 *   `requestDelayMs` (2 s) after each answer. At roughly 2.5 s a request that is ≤ 96 requests a
 *   chunk, ≤ ~2,300 a night per login — and never more than `maxRequestsPerNight` (2,500).
 * - 17,500 ÷ ~2,300 ≈ 7.6: about a week (8 nights) for the whole history, more if GitHub delays or
 *   skips scheduled runs (it may, under load). On average that is one request every ~9 s per login
 *   over the night, at most one every ~2.5 s.
 */

/** The first clinic day the backfill loads (spec: history from 1 Jan 2024). */
export const BACKFILL_FROM: IsoDate = "2024-01-01";

/** Pause after each Kreloses answer before the next request of a backfill session. Nightly: 1 s. */
export const DEFAULT_BACKFILL_REQUEST_DELAY_MS = 2_000;
/** Kreloses requests one connection's backfill may send per night (every chunk of that night together). */
export const DEFAULT_BACKFILL_MAX_REQUESTS_PER_NIGHT = 2_500;
/** Kuala Lumpur wall-clock times; outside them the backfill does nothing. */
export const DEFAULT_BACKFILL_NIGHT_WINDOW = "00:00-06:00";
/**
 * One chunk's time budget per connection (connections run side by side, each with its own
 * Kreloses login): the endpoint's `maxDuration` is 300 s, and one in-flight request (20 s timeout)
 * plus the final writes must still fit.
 */
export const BACKFILL_CHUNK_BUDGET_MS = 240_000;

/** Minutes after midnight, Kuala Lumpur time: `start` inclusive, `end` exclusive (1440 = 24:00). */
export interface NightWindow {
  startMinute: number;
  endMinute: number;
}

export interface BackfillConfig {
  requestDelayMs: number;
  maxRequestsPerNight: number;
  nightWindow: NightWindow;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * - `BACKFILL_REQUEST_DELAY_SECONDS` (0.5–30, default 2): pause between two Kreloses requests.
 * - `BACKFILL_MAX_REQUESTS_PER_NIGHT` (50–50,000, default 2,500): per connection per night.
 * - `BACKFILL_NIGHT_WINDOW` (`HH:MM-HH:MM` in Kuala Lumpur time, default `00:00-06:00`; may wrap past
 *   midnight, e.g. `22:00-05:00`; `24:00` = midnight at the end). Keep the GitHub Actions schedule
 *   (`.github/workflows/backfill.yml`, in UTC) inside it.
 * Unreadable values fall back to the default; out-of-range numbers are clamped.
 */
export function backfillConfigFromEnv(env: Env = process.env): BackfillConfig {
  return {
    requestDelayMs: Math.round(clamp(number(env.BACKFILL_REQUEST_DELAY_SECONDS) ?? DEFAULT_BACKFILL_REQUEST_DELAY_MS / 1000, 0.5, 30) * 1000),
    maxRequestsPerNight: Math.round(clamp(number(env.BACKFILL_MAX_REQUESTS_PER_NIGHT) ?? DEFAULT_BACKFILL_MAX_REQUESTS_PER_NIGHT, 50, 50_000)),
    nightWindow: parseNightWindow(env.BACKFILL_NIGHT_WINDOW) ?? parseNightWindow(DEFAULT_BACKFILL_NIGHT_WINDOW)!,
  };
}

/** `"00:00-06:00"` → minutes; null when unreadable or empty (start = end). */
export function parseNightWindow(value: string | undefined): NightWindow | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(value ?? "");
  if (!match) return null;
  const [start, end] = [minutes(match[1]!, match[2]!), minutes(match[3]!, match[4]!)];
  if (start === null || end === null || start === end || start === 1440) return null;
  return { startMinute: start, endMinute: end };
}

/** `{startMinute: 0, endMinute: 360}` → `"00:00–06:00"`. */
export function formatNightWindow(window: NightWindow): string {
  return `${clock(window.startMinute)}–${clock(window.endMinute)}`;
}

/**
 * The night window around `now`: the one in progress (`inWindow`), else the latest one that has
 * started (its requests are "last night's"). `nextStart` is when the next one starts (the current
 * one's start while inside it). Kuala Lumpur has no daylight saving time (UTC+8 all year).
 */
export function nightWindowAt(now: Date, window: NightWindow): { start: Date; end: Date; inWindow: boolean; nextStart: Date } {
  const today = clinicToday(now);
  const minute = clinicMinute(now);
  const wraps = window.startMinute > window.endMinute;
  // The day the relevant window instance started on.
  const startDay = minute >= window.startMinute ? today : addDays(today, -1);
  const start = clinicInstant(startDay, window.startMinute);
  const end = clinicInstant(wraps ? addDays(startDay, 1) : startDay, window.endMinute);
  const inWindow = now >= start && now < end;
  const nextStart = inWindow ? start : clinicInstant(addDays(startDay, 1), window.startMinute);
  return { start, end, inWindow, nextStart };
}

/** Whole nights needed for `invoicesLeft` invoice pages at `perNight` requests a night (at least 1 while any are left). */
export function estimatedNights(invoicesLeft: number, perNight: number): number {
  if (invoicesLeft <= 0) return 0;
  return Math.max(1, Math.ceil(invoicesLeft / Math.max(1, perNight)));
}

const minuteFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** Minutes after midnight on the clinic's clock. */
function clinicMinute(instant: Date): number {
  const parts = Object.fromEntries(minuteFormat.formatToParts(instant).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/** `minute` minutes after midnight of clinic day `day` (1440 = the next midnight). */
function clinicInstant(day: IsoDate, minute: number): Date {
  return new Date(new Date(`${day}T00:00:00+08:00`).getTime() + minute * 60_000);
}

function minutes(hours: string, mins: string): number | null {
  const [h, m] = [Number(hours), Number(mins)];
  if (m > 59 || h > 24 || (h === 24 && m !== 0)) return null;
  return h * 60 + m;
}

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function number(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
