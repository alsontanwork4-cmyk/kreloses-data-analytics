import { CLINIC_TIME_ZONE } from "@/filters";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: CLINIC_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * An instant as ISO 8601 in clinic time with its offset, e.g. `2026-10-01T10:00:00+08:00`: exact
 * for machines, and the wall-clock time people at the clinic read (a bare UTC `…Z` invites
 * misreading by eight hours).
 */
export function clinicTimestamp(instant: Date): string {
  const part = Object.fromEntries(PARTS.formatToParts(instant).map((p) => [p.type, p.value])) as Record<string, string>;
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  const wallClock = Date.UTC(Number(part.year), Number(part.month) - 1, Number(part.day), Number(part.hour), Number(part.minute), Number(part.second));
  const offsetMinutes = Math.round((wallClock - wholeSeconds) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}${offset}`;
}
